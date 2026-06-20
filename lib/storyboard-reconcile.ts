import "server-only";
import { getServiceClient } from "@/lib/supabase/server";
import { submitKieVideo, isVideoProvider } from "@/lib/kie";

type SB = ReturnType<typeof getServiceClient>;

// A scene clip gets at most this many render attempts (1 initial + retries)
// before it's considered permanently failed.
const MAX_SCENE_ATTEMPTS = 3;

type SceneRow = {
  id: string;
  scene_index: number;
  video_url: string | null;
  video_status: string;
  image_prompt: string | null;
  image_url: string | null;
  video_provider: string | null;
  video_attempts: number | null;
};

/**
 * Keep multi-scene storyboards healthy. Every scene clip is an independent
 * ad_creatives row (usable on its own); this reconciler makes the SET coherent:
 *
 *   1. Self-heal — re-render any FAILED scene that still has attempts left, so a
 *      single bad clip doesn't ruin the story or ship a gappy stitch. Each scene
 *      re-renders from its own stored prompt + reference frame.
 *   2. Stitch — only once EVERY scene is ready, hand the clips to the stitch
 *      worker. If a scene is permanently failed (attempts exhausted), fall back
 *      to stitching whatever did render (>=2) so the story still produces a video
 *      rather than hanging forever.
 *
 * Idempotent and concurrency-safe: scenes and storyboards are claimed atomically
 * (compare-and-swap), so it's safe to call from BOTH the client poll loop and the
 * sweep cron — whichever runs first wins, the other no-ops.
 */
export async function reconcileStoryboards(sb: SB, origin: string): Promise<void> {
  const { data: stories } = await sb
    .from("storyboards")
    .select("id, clip_count, provider, duration_per_clip")
    .eq("status", "generating");

  for (const s of (stories || []) as {
    id: string;
    clip_count: number;
    provider: string | null;
    duration_per_clip: number | null;
  }[]) {
    const { data: clips } = await sb
      .from("ad_creatives")
      .select(
        "id, scene_index, video_url, video_status, image_prompt, image_url, video_provider, video_attempts",
      )
      .eq("storyboard_id", s.id)
      .order("scene_index", { ascending: true });
    const rows = (clips || []) as SceneRow[];
    if (rows.length < s.clip_count) continue; // scenes still being inserted

    // ── 1. Self-heal failed scenes that still have attempts left ──────────────
    let reRendered = 0;
    for (const r of rows) {
      const attempts = r.video_attempts ?? 1;
      if (r.video_status !== "failed" || attempts >= MAX_SCENE_ATTEMPTS) continue;
      const provider = r.video_provider || s.provider || "seedance";
      if (!isVideoProvider(provider)) continue;

      // Claim atomically (failed → rendering) BEFORE submitting, so two ticks
      // can't double-submit (and double-bill) the same scene.
      const { data: claimed } = await sb
        .from("ad_creatives")
        .update({ video_status: "rendering", video_url: null, video_attempts: attempts + 1 })
        .eq("id", r.id)
        .eq("video_status", "failed")
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      try {
        const { taskId } = await submitKieVideo({
          provider,
          prompt: r.image_prompt || "",
          mode: r.image_url ? "image-to-video" : "text-to-video",
          referenceImageUrls: r.image_url ? [r.image_url] : null,
          duration: s.duration_per_clip || 5,
        });
        await sb.from("ad_creatives").update({ t2v_job_id: taskId }).eq("id", r.id);
        reRendered++;
      } catch {
        // Submit still failing — revert to failed (the attempt was counted) so a
        // later tick retries until attempts are exhausted.
        await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", r.id);
      }
    }
    if (reRendered > 0) continue; // wait for the re-renders before stitching

    // ── 2. Stitch when settled ────────────────────────────────────────────────
    const allReady = rows.every((r) => r.video_status === "ready" && r.video_url);
    const settled = rows.every(
      (r) =>
        (r.video_status === "ready" && r.video_url) ||
        (r.video_status === "failed" && (r.video_attempts ?? 1) >= MAX_SCENE_ATTEMPTS),
    );
    if (!allReady && !settled) continue; // still rendering / retrying

    const worker = process.env.STITCH_WORKER_URL;
    if (!worker) continue; // no stitcher configured — scenes remain usable individually

    const urls = rows.filter((r) => r.video_url).map((r) => r.video_url as string);
    if (urls.length < 2) {
      await sb.from("storyboards").update({ status: "failed", final_status: "failed" }).eq("id", s.id);
      continue;
    }

    // Claim the storyboard atomically so two ticks can't both fire the worker.
    const { data: claimedStory } = await sb
      .from("storyboards")
      .update({ status: "stitching", final_status: "stitching" })
      .eq("id", s.id)
      .eq("status", "generating")
      .select("id");
    if (!claimedStory || claimedStory.length === 0) continue;

    try {
      const res = await fetch(`${worker.replace(/\/$/, "")}/stitch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          storyboard_id: s.id,
          clip_urls: urls,
          callback_url: `${origin}/api/storyboards/stitch-callback`,
        }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`stitch worker HTTP ${res.status}`);
    } catch {
      // worker unreachable / non-2xx — revert so a later tick retries.
      await sb.from("storyboards").update({ status: "generating", final_status: "none" }).eq("id", s.id);
    }
  }
}
