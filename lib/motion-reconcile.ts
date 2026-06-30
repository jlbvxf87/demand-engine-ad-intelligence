import "server-only";
import { getServiceClient } from "@/lib/supabase/server";
import { submitKieVideo, pollKieVideo, isVideoProvider } from "@/lib/kie";
import { persistVideoToStorage, uploadLocalVideo } from "@/lib/persist";
import { draftWorkerConfigured, dispatchToWorker } from "@/lib/draft-worker";
import { PROVIDER_DURATIONS, type VideoProvider } from "@/lib/video";
import { methodCost, type DraftRenderPlan, type DraftScene } from "../remotion/types";

type SB = ReturnType<typeof getServiceClient>;

// An AI scene clip gets at most this many KIE submit attempts before its scene
// downgrades to a cheap template so the composite always completes.
const MAX_AI_ATTEMPTS = 3;

function clampDuration(provider: VideoProvider, want: number): number {
  const allowed = PROVIDER_DURATIONS[provider];
  return allowed.find((d) => d >= want) ?? allowed[allowed.length - 1];
}

function scenePrompt(s: DraftScene): string {
  return (s.visual || s.text || "").trim() || "cinematic product b-roll";
}

/**
 * Keep hybrid "Motion" drafts moving. A Motion draft is one ad_creatives row
 * (render_mode='motion', video_status='rendering') whose ai_motion scenes each
 * have a KIE job tracked inside render_plan_json. This reconciler:
 *
 *   1. Polls each ai scene's KIE job; a finished clip is persisted to storage
 *      and stamped onto the scene (aiClipUrl + aiStatus='ready').
 *   2. Self-heals a failed clip (resubmit up to MAX_AI_ATTEMPTS); once exhausted
 *      the scene downgrades to a cheap template so the video still ships.
 *   3. Once no ai scene is still pending, claims the row atomically
 *      (rendering → compositing) and fires ONE Remotion composite render that
 *      lays the KIE clips + captions into the final MP4.
 *
 * Idempotent: only the composite step is compare-and-swap claimed, so it's safe
 * to call every poll tick (mirrors reconcileStoryboards).
 */
export async function reconcileMotionDrafts(sb: SB, origin: string): Promise<void> {
  const { data } = await sb
    .from("ad_creatives")
    .select("id, render_plan_json")
    .eq("render_mode", "motion")
    .eq("video_status", "rendering");

  const drafts = (data || []) as { id: string; render_plan_json: DraftRenderPlan | null }[];

  for (const d of drafts) {
    const plan = d.render_plan_json;
    if (!plan || !Array.isArray(plan.scenes)) continue;

    let changed = false;
    for (let i = 0; i < plan.scenes.length; i++) {
      const s = plan.scenes[i];
      if (s.renderMethod !== "ai_motion") continue;
      if (s.aiStatus === "ready" && s.aiClipUrl) continue;
      const provider = s.aiProvider;

      // ── Poll an in-flight clip ──────────────────────────────────────────
      if (s.aiStatus === "pending" && s.aiJobId && provider && isVideoProvider(provider)) {
        try {
          const r = await pollKieVideo(provider, s.aiJobId);
          if (r.state === "completed" && r.videoUrl) {
            const permanent = await persistVideoToStorage(r.videoUrl, `${d.id}-s${i}`);
            plan.scenes[i] = { ...s, aiClipUrl: permanent ?? r.videoUrl, aiStatus: "ready" };
            changed = true;
          } else if (r.state === "failed") {
            plan.scenes[i] = { ...s, aiStatus: "failed" };
            changed = true;
          }
          // queued / processing → leave pending for the next tick
        } catch {
          // transient poll error — retry next tick
        }
        continue;
      }

      // ── Self-heal a failed clip: resubmit, or downgrade when exhausted ───
      if (s.aiStatus === "failed") {
        const attempts = s.aiAttempts ?? 1;
        if (provider && isVideoProvider(provider) && attempts < MAX_AI_ATTEMPTS) {
          try {
            const { taskId } = await submitKieVideo({
              provider,
              prompt: scenePrompt(s),
              mode: s.image ? "image-to-video" : "text-to-video",
              referenceImageUrls: s.image ? [s.image] : null,
              duration: clampDuration(provider, Math.ceil(s.duration)),
            });
            plan.scenes[i] = { ...s, aiJobId: taskId, aiStatus: "pending", aiAttempts: attempts + 1 };
          } catch {
            plan.scenes[i] = { ...s, aiStatus: "failed", aiAttempts: attempts + 1 };
          }
        } else {
          // Out of retries (or no usable provider) — render this scene as a
          // cheap template so the final video isn't blocked on KIE.
          plan.scenes[i] = {
            ...s,
            renderMethod: "template_motion",
            estimatedCostCents: methodCost("template_motion"),
          };
        }
        changed = true;
        continue;
      }
    }

    if (changed) {
      await sb.from("ad_creatives").update({ render_plan_json: plan }).eq("id", d.id);
    }

    // Still waiting on a clip? come back next tick.
    const stillPending = plan.scenes.some((s) => s.renderMethod === "ai_motion" && s.aiStatus !== "ready");
    if (stillPending) continue;

    // ── Composite: claim atomically so only one tick renders ──────────────
    const { data: claimed } = await sb
      .from("ad_creatives")
      .update({ video_status: "compositing" })
      .eq("id", d.id)
      .eq("video_status", "rendering")
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    // Prod: offload the composite render to the worker (its callback flips ready).
    if (draftWorkerConfigured()) {
      try {
        await dispatchToWorker(plan, d.id, origin);
      } catch {
        // worker unreachable — revert so a later tick retries.
        await sb.from("ad_creatives").update({ video_status: "rendering" }).eq("id", d.id);
      }
      continue;
    }

    // No worker + on Vercel: can't composite inline here — mark failed (a later
    // deploy with DRAFT_WORKER_URL set will render it via the worker).
    if (process.env.VERCEL) {
      await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", d.id);
      continue;
    }

    // Local: composite inline. Lazy-import so @remotion/* never loads on Vercel.
    try {
      const { renderDraftVideo } = await import("@/lib/draft-render");
      const rendered = await renderDraftVideo(plan, d.id);
      if (!rendered.ok || !rendered.localPath) throw new Error(rendered.error || "Composite failed");
      const url = await uploadLocalVideo(rendered.localPath, d.id);
      if (!url) throw new Error("Upload failed");
      await sb.from("ad_creatives").update({ video_url: url, video_status: "ready" }).eq("id", d.id);
    } catch {
      await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", d.id);
    }
  }
}
