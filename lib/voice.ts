import "server-only";
import { getServiceClient } from "@/lib/supabase/server";
import { persistVideoToStorage } from "@/lib/persist";

/* ──────────────────────────────────────────────────────────────────────────
   Spokesperson voice layer. Turns the copy we already generate into a real
   talking clip in two Kie jobs:
     1) TTS  — elevenlabs/text-to-dialogue-v3  → an mp3 of the exact script.
     2) LIP-SYNC — kling/ai-avatar-standard (image + that audio) → a video of
        the person speaking the script with synced lips.
   Both jobs use Kie's unified jobs API and the same poll/result shape as video.
   The two stages are driven asynchronously by advanceSpokesperson(), called
   from the client poll loop AND the sweep cron (so it advances tab-closed too).
   ────────────────────────────────────────────────────────────────────────── */

type SB = ReturnType<typeof getServiceClient>;

const KIE_BASE = (process.env.KIE_API_BASE_URL || "https://api.kie.ai").replace(/\/$/, "");
const TTS_MODEL = "elevenlabs/text-to-dialogue-v3";
const LIPSYNC_MODEL = "kling/ai-avatar-standard"; // ≤5min audio, 720p — robust to script length
// A natural, energetic default narration voice (one of Kie's supported voice ids).
export const DEFAULT_VOICE = "EkK5I93UQWFDigLMpZcX";

async function createTask(model: string, input: Record<string, unknown>): Promise<{ taskId: string }> {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error("KIE_API_KEY not set — add it to env to enable voice render.");
  const res = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  const j = (await res.json().catch(() => ({}))) as {
    msg?: string; message?: string; data?: { taskId?: string };
  };
  const taskId = j?.data?.taskId;
  if (!taskId) throw new Error(j?.msg || j?.message || `Kie HTTP ${res.status}`);
  return { taskId };
}

/** Submit a TTS job for `text`. Returns the Kie taskId to poll. */
export async function submitTTS(text: string, voice: string = DEFAULT_VOICE): Promise<{ taskId: string }> {
  const t = (text || "").replace(/\s+/g, " ").trim().slice(0, 4800);
  if (!t) throw new Error("No script to voice");
  return createTask(TTS_MODEL, { dialogue: [{ voice, text: t }] });
}

/** Submit a lip-sync job: image + audio → talking video. Returns the taskId. */
export async function submitLipsync(
  imageUrl: string,
  audioUrl: string,
  prompt = "",
): Promise<{ taskId: string }> {
  return createTask(LIPSYNC_MODEL, {
    image_url: imageUrl,
    audio_url: audioUrl,
    prompt: (prompt || "").slice(0, 4800),
  });
}

type JobResult = { state: "processing" | "completed" | "failed"; url?: string; error?: string };

/** Poll a Kie unified job (TTS or lip-sync). Result URL is resultJson.resultUrls[0]. */
export async function pollKieJob(taskId: string): Promise<JobResult> {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error("KIE_API_KEY not set");
  const r = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as {
    data?: { state?: string; resultJson?: string; failMsg?: string };
  };
  const d = j?.data ?? {};
  if (d.state === "success") {
    let url: string | undefined;
    try {
      url = (JSON.parse(d.resultJson || "{}") as { resultUrls?: string[] })?.resultUrls?.[0];
    } catch {}
    return url ? { state: "completed", url } : { state: "failed", error: "no result url" };
  }
  if (d.state === "fail") return { state: "failed", error: d.failMsg || "failed" };
  return { state: "processing" };
}

type SpokesRow = {
  id: string;
  render_stage: string | null;
  tts_job_id: string | null;
  t2v_job_id: string | null;
  image_url: string | null;
  video_status: string;
};

/**
 * Advance every in-flight spokesperson render. Stage 1 (tts): when the voice is
 * ready, kick off the lip-sync with the clip's still + that audio. Stage 2
 * (lipsync): when the talking video is ready, persist it and mark ready. Each
 * transition is a compare-and-swap so the client loop and the cron can both call
 * this safely. Returns how many rows advanced.
 */
export async function advanceSpokesperson(sb: SB): Promise<number> {
  let advanced = 0;
  const { data } = await sb
    .from("ad_creatives")
    .select("id, render_stage, tts_job_id, t2v_job_id, image_url, video_status")
    .eq("video_provider", "spokesperson")
    .eq("video_status", "rendering")
    .in("render_stage", ["tts", "lipsync"]);
  const rows = (data || []) as SpokesRow[];

  for (const r of rows) {
    try {
      // ── Stage 1: TTS → kick off lip-sync ──────────────────────────────────
      if (r.render_stage === "tts" && r.tts_job_id) {
        const j = await pollKieJob(r.tts_job_id);
        if (j.state === "completed" && j.url) {
          if (!r.image_url) {
            // No face to drive the lip-sync — can't finish as a spokesperson clip.
            await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", r.id);
            advanced++;
            continue;
          }
          const { taskId } = await submitLipsync(r.image_url, j.url);
          const { data: cas } = await sb
            .from("ad_creatives")
            .update({ render_stage: "lipsync", t2v_job_id: taskId, vo_audio_url: j.url })
            .eq("id", r.id)
            .eq("render_stage", "tts")
            .select("id");
          if (cas && cas.length > 0) advanced++;
        } else if (j.state === "failed") {
          await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", r.id);
          advanced++;
        }
        continue;
      }

      // ── Stage 2: lip-sync → persist + ready ───────────────────────────────
      if (r.render_stage === "lipsync" && r.t2v_job_id) {
        const j = await pollKieJob(r.t2v_job_id);
        if (j.state === "completed" && j.url) {
          const permanent = (await persistVideoToStorage(j.url, r.id)) ?? j.url;
          const { data: cas } = await sb
            .from("ad_creatives")
            .update({ video_url: permanent, video_status: "ready", render_stage: null })
            .eq("id", r.id)
            .eq("video_status", "rendering")
            .select("id");
          if (cas && cas.length > 0) advanced++;
        } else if (j.state === "failed") {
          await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", r.id);
          advanced++;
        }
      }
    } catch {
      // transient kie/network error — leave it, retry next tick.
    }
  }
  return advanced;
}
