import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin-auth";
import { isMachineAuthed } from "@/lib/machine-auth";
import { getServiceClient } from "@/lib/supabase/server";
import { scrapeAndStoreCreative } from "@/lib/scrape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_BATCH = 24;
const MAX_BATCH = 40;
const CONCURRENCY = 4;

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

/**
 * Backfill real ad creatives at scale. Picks the top-scoring ads that still lack
 * a creative image/video (and have a snapshot URL), scrapes each, and caches the
 * media on spy_ads. Cron-driven so Home/Source stay image-rich over time; also
 * runnable on demand (admin cookie or machine key).
 */
async function run(req: Request) {
  if (!isCronAuthed(req) && !isMachineAuthed(req) && !(await isAdminAuthed())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_BATCH));

  const sb = getServiceClient();
  // Only ads never attempted: no creative yet AND not already marked "none".
  // Ordered by ad VOLUME (then longevity) — those are the scaled winners shown on
  // Home/Source, so the images people actually see get filled first (winner_score
  // would prioritize big-spend advocacy ads we don't even display).
  const { data, error } = await sb
    .from("spy_ads")
    .select("id")
    .is("creative_media_url", null)
    .is("creative_media_type", null)
    .not("ad_snapshot_url", "is", null)
    .order("brand_ad_count", { ascending: false })
    .order("days_running", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (data ?? []).map((r) => (r as { id: string }).id);
  if (ids.length === 0) {
    return NextResponse.json({ processed: 0, succeeded: 0, remaining: 0, done: true });
  }

  const results = await mapLimit(ids, CONCURRENCY, (id) => scrapeAndStoreCreative(id));
  const succeeded = results.filter((r) => r.ok && r.media_url).length;

  // How many are still missing after this run (for visibility / scheduling).
  const { count: remaining } = await sb
    .from("spy_ads")
    .select("id", { count: "exact", head: true })
    .is("creative_media_url", null)
    .is("creative_media_type", null)
    .not("ad_snapshot_url", "is", null);

  return NextResponse.json({
    processed: ids.length,
    succeeded,
    remaining: remaining ?? null,
    done: (remaining ?? 0) === 0,
  });
}

export async function GET(req: Request) {
  return run(req);
}

export async function POST(req: Request) {
  return run(req);
}
