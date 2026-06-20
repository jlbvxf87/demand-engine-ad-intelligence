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

type SubmitOpts = {
  provider: VideoProvider;
  prompt: string;
  mode: VideoMode;
  /** Primary reference first, then optional guide images. */
  referenceImageUrls?: string[] | null;
  duration?: number; // seconds, default 9
};

function buildRequest(o: SubmitOpts): { url: string; body: Record<string, unknown> } {
  const imgs = (o.referenceImageUrls || []).filter(Boolean);
  const i2v = o.mode === "image-to-video" && imgs.length > 0;
  const dur = o.duration ?? 9;

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
            generate_audio: true,
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
            sound: true,
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
            sound: true,
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
    case "runway":
      return {
        url: `${KIE_BASE}/api/v1/runway/generate`,
        body: {
          prompt: o.prompt.slice(0, 4000),
          duration: dur <= 7 ? 5 : 10,
          quality: "720p",
          aspectRatio: "9:16",
          ...(i2v ? { imageUrl: imgs[0] } : {}),
        },
      };
  }
}

/** Submit a video job to kie.ai. Returns the taskId to poll. Throws on failure. */
export async function submitKieVideo(o: SubmitOpts): Promise<{ taskId: string }> {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error("KIE_API_KEY not set — add it to env to enable video render.");

  const { url, body } = buildRequest(o);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    code?: number;
    msg?: string;
    message?: string;
    taskId?: string;
    data?: { taskId?: string; task_id?: string; id?: string };
  };

  // The unified jobs endpoint returns {code:200, data:{taskId}}, but the VEO and
  // RUNWAY families (/veo/generate, /runway/generate) are a different API and may
  // nest the id under a different key or omit the 200 envelope. Accept the first
  // non-empty task id from any known shape rather than relying on code === 200.
  const taskId =
    json?.data?.taskId ||
    json?.data?.task_id ||
    json?.taskId ||
    json?.data?.id ||
    undefined;

  // Only treat as a failure when there's no task id to poll. If we got an id,
  // the job is (or will be) billing regardless of the envelope shape, so we must
  // return it so the row can be polled instead of being wrongly marked failed.
  if (!taskId) {
    const msg = json?.msg || json?.message;
    if (!res.ok) throw new Error(msg || `Kie HTTP ${res.status}`);
    throw new Error(msg || "Kie returned no taskId");
  }

  return { taskId };
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

  if (provider === "runway") {
    const r = await fetch(`${KIE_BASE}/api/v1/runway/record-detail?taskId=${tid}`, { headers, cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as {
      data?: { state?: string; videoInfo?: { videoUrl?: string } };
    };
    const d = j?.data ?? {};
    if (d.state === "success") {
      const u = d.videoInfo?.videoUrl;
      return u ? { state: "completed", videoUrl: u } : { state: "failed", error: "no url" };
    }
    if (d.state === "fail") return { state: "failed", error: "failed" };
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
