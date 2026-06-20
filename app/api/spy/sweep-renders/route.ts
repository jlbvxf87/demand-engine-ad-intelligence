import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin-auth";
import { isMachineAuthed } from "@/lib/machine-auth";
import { getServiceClient } from "@/lib/supabase/server";
import { pollKieVideo, isVideoProvider } from "@/lib/kie";
import { persistVideoToStorage } from "@/lib/persist";
import { reconcileStoryboards } from "@/lib/storyboard-reconcile";

/** Public origin for the stitch callback, from the proxied request headers. */
function originOf(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_BATCH = 40;
const MAX_BATCH = 40;
const CONCURRENCY = 4;

// A render that's still "processing" after this long is treated as dead and
// marked failed, so a silently-lost kie job can't pin a row to 'rendering'
// forever.
const STALE_RENDER_MS = 2 * 60 * 60 * 1000; // 2 hours

// A landing-page crawl stuck on 'crawling' past this is treated as dead (the
// crawl function was killed mid-run) and reset to 'pending' so it can re-run.
const STALE_CRAWL_MS = 15 * 60 * 1000; // 15 minutes

/** Vercel cron hits this with `Authorization: Bearer <CRON_SECRET>`. */
function isCronAuthed(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type SweepRow = {
  id: string;
  t2v_job_id: string;
  video_provider: string | null;
  video_status: string;
  created_at: string;
};

type RowOutcome = "ready" | "failed" | "failed-stale" | "noop";

/**
 * Server-side sweep that finishes what the Studio's client-side pollVideoJobs
 * loop can't: when the user closes the tab, the kie job still completes on
 * kie.ai but nothing flips ad_creatives.video_status off 'rendering'/'queued'.
 * This cron polls every still-in-progress row, persists finished clips to
 * permanent storage, marks failures, and times out renders stuck past
 * STALE_RENDER_MS — so no row hangs forever. Cron-driven; also runnable on
 * demand (admin cookie or machine key).
 */
async function run(req: Request) {
  if (!isCronAuthed(req) && !isMachineAuthed(req) && !(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_BATCH));

  const sb = getServiceClient();

  // ── Unstick dead landing-page crawls ──────────────────────────────────────
  // If the crawl route died after marking 'crawling' but before writing
  // 'done'/'error', the row hangs on 'crawling' forever. Reset any older than
  // the cutoff (or with a null start stamp from before this was tracked) back to
  // 'pending' so Decode/recreate can re-attempt.
  let crawlReset = 0;
  try {
    const crawlCutoff = new Date(Date.now() - STALE_CRAWL_MS).toISOString();
    const { data: reset } = await sb
      .from("spy_ads")
      .update({ crawl_status: "pending" })
      .eq("crawl_status", "crawling")
      .or(`crawled_at.is.null,crawled_at.lt.${crawlCutoff}`)
      .select("id");
    crawlReset = reset?.length ?? 0;
  } catch {
    crawlReset = 0;
  }

  const { data, error } = await sb
    .from("ad_creatives")
    .select("id, t2v_job_id, video_provider, video_status, created_at")
    .in("video_status", ["queued", "rendering"])
    .not("t2v_job_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as SweepRow[];
  if (rows.length === 0) {
    // No in-progress clips, but storyboards may still need a failed scene
    // re-rendered (self-heal) or a final stitch.
    try {
      await reconcileStoryboards(sb, originOf(req));
    } catch {}
    return NextResponse.json({ checked: 0, updated: 0, failedStale: 0, crawlReset });
  }

  const now = Date.now();

  const outcomes = await mapLimit(rows, CONCURRENCY, async (row): Promise<RowOutcome> => {
    if (!row.video_provider || !isVideoProvider(row.video_provider)) return "noop";
    try {
      const r = await pollKieVideo(row.video_provider, row.t2v_job_id);

      if (r.state === "completed" && r.videoUrl) {
        // kie's videoUrl is a temporary CDN link that expires — download and
        // re-upload to permanent Supabase Storage. Fall back to the temp URL
        // if persistence fails, so the clip is never lost.
        const permanent = (await persistVideoToStorage(r.videoUrl, row.id)) ?? r.videoUrl;
        const { data: flipped } = await sb
          .from("ad_creatives")
          .update({ video_url: permanent, video_status: "ready" })
          .eq("id", row.id)
          .in("video_status", ["queued", "rendering"])
          .select("id");
        return flipped && flipped.length > 0 ? "ready" : "noop";
      }

      if (r.state === "failed") {
        const { data: flipped } = await sb
          .from("ad_creatives")
          .update({ video_status: "failed" })
          .eq("id", row.id)
          .in("video_status", ["queued", "rendering"])
          .select("id");
        return flipped && flipped.length > 0 ? "failed" : "noop";
      }

      // Still queued/processing on kie's side. Leave it — UNLESS it's been
      // stuck past the timeout, in which case treat it as a dead render so it
      // doesn't hang on 'rendering' forever.
      const ageMs = now - new Date(row.created_at).getTime();
      if (Number.isFinite(ageMs) && ageMs > STALE_RENDER_MS) {
        const { data: flipped } = await sb
          .from("ad_creatives")
          .update({ video_status: "failed" })
          .eq("id", row.id)
          .in("video_status", ["queued", "rendering"])
          .select("id");
        return flipped && flipped.length > 0 ? "failed-stale" : "noop";
      }

      return "noop";
    } catch {
      // transient kie/network error — leave the row, retry next sweep.
      return "noop";
    }
  });

  const updated = outcomes.filter((o) => o !== "noop").length;
  const failedStale = outcomes.filter((o) => o === "failed-stale").length;

  // Self-heal failed storyboard scenes + stitch when ready — works even when the
  // Studio tab is closed and the client poll loop isn't running.
  try {
    await reconcileStoryboards(sb, originOf(req));
  } catch {}

  return NextResponse.json({ checked: rows.length, updated, failedStale, crawlReset });
}

export async function GET(req: Request) {
  return run(req);
}

export async function POST(req: Request) {
  return run(req);
}
