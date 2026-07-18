import "server-only";
import type { VideoProvider, VideoMode } from "@/lib/video";

export { isVideoProvider } from "@/lib/video";
export type { VideoProvider, VideoMode } from "@/lib/video";

/* ──────────────────────────────────────────────────────────────────────────
   Direct kie.ai video client. Ports the T2V engine's provider logic so Demand
   Engine generates video itself — no separate engine, no Redis. kie.ai is
   poll-based (no webhook), so submit returns a taskId and the Studio UI polls
   pollKieVideo() until the clip is ready. KIE_API_KEY stays server-only.
   ────────────────────────────────────────────────────────────────────────── */

const KIE_BASE = (process.env.KIE_API_BASE_URL || "https://api.kie.ai").replace(/\/$/, "");

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SubmitOpts = {
  provider: VideoProvider;
  prompt: string;
  mode: VideoMode;
  /** Primary reference first, then optional guide images. */
  referenceImageUrls?: string[] | null;
  duration?: number; // seconds, default 9
  /** false = render a SILENT clip (no spoken voice / audio track). Default true.
   *  Used by "Action only" mode so a Kling clip is pure visual, no talking head. */
  sound?: boolean;
};

function buildRequest(o: SubmitOpts): { url: string; body: Record<string, unknown> } {
  const imgs = (o.referenceImageUrls || []).filter(Boolean);
  const i2v = o.mode === "image-to-video" && imgs.length > 0;
  const dur = o.duration ?? 9;
  const sound = o.sound !== false; // default on

  switch (o.provider) {
    case "seedance":
      return {
        url: `${KIE_BASE}/api/v1/jobs/createTask`,
        body: {
          // Kie uses one unified slug for both t2v + i2v; i2v is selected by
          // presence of input_urls (not a separate model id).
          model: "bytedance/seedance-2",
          input: {
            prompt: o.prompt.slice(0, 3000),
            aspect_ratio: "9:16",
            duration: String(clamp(dur, 4, 15)),
            resolution: "1080p",
            fixed_lens: false,
            generate_audio: sound,
            ...(i2v ? { input_urls: imgs } : {}),
          },
        },
      };
    case "kling":
      return {
        url: `${KIE_BASE}/api/v1/jobs/createTask`,
        body: {
          model: "kling-3.0/video",
          input: {
            prompt: o.prompt.slice(0, 1000),
            sound,
            aspect_ratio: "9:16",
            duration: String(clamp(dur, 3, 15)),
            mode: "pro",
            multi_shots: false,
            multi_prompt: [],
            ...(i2v ? { image_urls: imgs } : {}),
          },
        },
      };
    case "sora":
      return {
        url: `${KIE_BASE}/api/v1/jobs/createTask`,
        body: {
          model: i2v ? "sora-2-image-to-video" : "sora-2-pro-text-to-video",
          input: {
            prompt: o.prompt.slice(0, 10000),
            aspect_ratio: "portrait",
            n_frames: dur >= 13 ? "15" : "10",
            size: "high",
            remove_watermark: true,
            sound,
            upload_method: "s3",
            ...(i2v ? { image_urls: imgs } : {}),
          },
        },
      };
    case "veo":
      return {
        url: `${KIE_BASE}/api/v1/veo/generate`,
        body: i2v
          ? {
              prompt: o.prompt.slice(0, 5000),
              aspect_ratio: "16:9",
              model: "veo3_fast",
              imageUrls: imgs,
              generationType: "REFERENCE_2_VIDEO",
            }
          : { prompt: o.prompt.slice(0, 5000), aspect_ratio: "9:16", model: "veo3" },
      };
  }
}

/**
 * Submit a video job to kie.ai. Returns the taskId to poll. Throws on failure.
 *
 * Retries TRANSIENT failures (network/timeout, HTTP 429, HTTP 5xx) up to 3 total
 * attempts with backoff. Rationale: a thrown submit marks the ad_creatives row
 * 'failed' with no job to poll — so a momentary Kie blip (common on a burst of
 * variants) would permanently kill an otherwise-valid render until the user
 * manually re-renders. Non-transient errors (4xx validation / content
 * moderation) are surfaced immediately — they won't change on retry, and we want
 * the real reason shown fast rather than buried behind three slow retries.
 */
export async function submitKieVideo(o: SubmitOpts): Promise<{ taskId: string }> {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error("KIE_API_KEY not set — add it to env to enable video render.");

  const { url, body } = buildRequest(o);
  const MAX_ATTEMPTS = 3;
  let lastErr = "Kie submit failed";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        // Bound each attempt so a hung submit can't stall the render action.
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      // Network/timeout: the request didn't reach a verdict, so no job was
      // created — safe to retry.
      lastErr = e instanceof Error ? e.message : "network error";
      if (attempt < MAX_ATTEMPTS) {
        await sleep(700 * attempt);
        continue;
      }
      throw new Error(`Kie submit failed after ${MAX_ATTEMPTS} tries — ${lastErr}`);
    }

    const json = (await res.json().catch(() => ({}))) as {
      code?: number;
      msg?: string;
      message?: string;
      taskId?: string;
      data?: { taskId?: string; task_id?: string; id?: string };
    };

    // The unified jobs endpoint returns {code:200, data:{taskId}}, but the VEO
    // family (/veo/generate) is a different API and may nest the id under a
    // different key or omit the 200 envelope. Accept the first non-empty task id
    // from any known shape rather than relying on code === 200.
    const taskId =
      json?.data?.taskId ||
      json?.data?.task_id ||
      json?.taskId ||
      json?.data?.id ||
      undefined;

    // Got an id → the job is (or will be) billing regardless of envelope shape;
    // return it so the row can be polled instead of being wrongly marked failed.
    if (taskId) return { taskId };

    const msg = json?.msg || json?.message || `Kie HTTP ${res.status}`;
    // Retry only transient server-side rejections (rate-limit / 5xx). A 4xx is a
    // real validation/policy rejection that won't change on retry — surface now.
    const transient = res.status === 429 || res.status >= 500;
    lastErr = msg;
    if (transient && attempt < MAX_ATTEMPTS) {
      await sleep(700 * attempt);
      continue;
    }
    throw new Error(msg);
  }

  throw new Error(lastErr);
}

export type PollResult = {
  state: "queued" | "processing" | "completed" | "failed";
  videoUrl?: string;
  error?: string;
};

/** Pull the final video URL out of seedance/kling/sora's stringified resultJson. */
function extractVideoUrl(resultJson: unknown): string | undefined {
  if (typeof resultJson !== "string" || !resultJson) return undefined;
  if (resultJson.startsWith("http")) return resultJson;
  let r: Record<string, unknown> & {
    resultUrls?: string[];
    videos?: { url?: string }[];
    data?: Record<string, unknown> & { resultUrls?: string[] };
  };
  try {
    r = JSON.parse(resultJson);
  } catch {
    return undefined;
  }
  if (Array.isArray(r)) {
    const a = r as Array<{ url?: string } | string>;
    return (typeof a[0] === "string" ? a[0] : a[0]?.url) || undefined;
  }
  const d = (r.data ?? {}) as Record<string, unknown> & { resultUrls?: string[] };
  return (
    (r.video_url as string) ||
    (r.url as string) ||
    (r.output_url as string) ||
    r.resultUrls?.[0] ||
    r.videos?.[0]?.url ||
    (d.video_url as string) ||
    (d.url as string) ||
    d.resultUrls?.[0] ||
    undefined
  );
}

/** Poll a kie.ai job. Routes to the right endpoint family per provider. */
export async function pollKieVideo(provider: VideoProvider, taskId: string): Promise<PollResult> {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error("KIE_API_KEY not set");
  const headers = { Authorization: `Bearer ${key}` };
  const tid = encodeURIComponent(taskId);

  if (provider === "veo") {
    const r = await fetch(`${KIE_BASE}/api/v1/veo/record-info?taskId=${tid}`, { headers, cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as {
      data?: { successFlag?: number; errorMessage?: string; response?: { resultUrls?: string[]; originUrls?: string[] } };
    };
    const d = j?.data ?? {};
    if (d.successFlag === 1) {
      const u = d.response?.resultUrls?.[0] || d.response?.originUrls?.[0];
      return u ? { state: "completed", videoUrl: u } : { state: "failed", error: "no url" };
    }
    if (d.successFlag === 2 || d.successFlag === 3) return { state: "failed", error: d.errorMessage || "failed" };
    return { state: "processing" };
  }

  // seedance / kling / sora → unified jobs endpoint
  const r = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${tid}`, { headers, cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as {
    data?: { state?: string; resultJson?: unknown; failMsg?: string };
  };
  const d = j?.data ?? {};
  if (d.state === "success") {
    const u = extractVideoUrl(d.resultJson);
    return u ? { state: "completed", videoUrl: u } : { state: "failed", error: "no url in result" };
  }
  if (d.state === "fail") return { state: "failed", error: d.failMsg || "failed" };
  return { state: "processing" };
}
