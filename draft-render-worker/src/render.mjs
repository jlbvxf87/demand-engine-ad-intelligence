import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";

const COMPOSITION_ID = "DraftAd";
const DEFAULT_FPS = 30;

// Bundle the Remotion composition once per process — bundling is the slow part.
let bundlePromise = null;
function getServeUrl() {
  if (!bundlePromise) {
    const entryPoint = path.join(process.cwd(), "remotion", "index.ts");
    bundlePromise = bundle({ entryPoint }).catch((e) => {
      bundlePromise = null; // let a later call retry a failed bundle
      throw e;
    });
  }
  return bundlePromise;
}

// Re-encode for web (faststart, yuv420p) with ffmpeg; fall back to the raw file
// (already valid H.264) if ffmpeg isn't available or fails.
function normalize(input, output) {
  return new Promise((resolve) => {
    const args = [
      "-y", "-i", input,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      output,
    ];
    let proc;
    try {
      proc = spawn("ffmpeg", args, { stdio: "ignore" });
    } catch {
      return resolve(input);
    }
    proc.on("error", () => resolve(input));
    proc.on("close", (code) => resolve(code === 0 ? output : input));
  });
}

/** Extract frame 0 of a rendered MP4 as a JPG poster (first-frame thumbnail).
 *  Non-fatal: resolves null if ffmpeg is missing/fails. */
export function extractPoster(videoPath, id) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `poster-${id}.jpg`);
    // Seek ~1s in, past the scene fade-in (frame 0 is transparent → dark bg).
    const args = ["-y", "-ss", "1", "-i", videoPath, "-frames:v", "1", "-q:v", "3", out];
    let proc;
    try {
      proc = spawn("ffmpeg", args, { stdio: "ignore" });
    } catch {
      return resolve(null);
    }
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => resolve(code === 0 ? out : null));
  });
}

/** Render a DraftRenderPlan to a local MP4 (template scenes + any ai_motion clips). */
export async function renderPlan(plan, id) {
  await ensureBrowser();
  const serveUrl = await getServeUrl();
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps: plan });
  const tmp = os.tmpdir();
  const raw = path.join(tmp, `draft-${id}-raw.mp4`);
  await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: raw, inputProps: plan });
  return normalize(raw, path.join(tmp, `draft-${id}.mp4`));
}

/**
 * Capture one clean (captionless) still per scene that has media — the image-to-video
 * seed used when the draft is upgraded to Cinematic. Renders the scene's mid-frame with
 * captions/overlays hidden. Returns { [sceneIndex]: localPngPath } for image-bearing scenes.
 */
export async function renderSeedFrames(plan, id) {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  const fps = plan?.fps || DEFAULT_FPS;
  const serveUrl = await getServeUrl();
  const captionlessPlan = { ...plan, captionless: true };
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps: captionlessPlan,
  });
  const tmp = os.tmpdir();
  const out = {};
  let from = 0;
  for (let i = 0; i < scenes.length; i++) {
    const dur = Math.max(1, Math.round((scenes[i].duration || 1) * fps));
    const mid = from + Math.floor(dur / 2);
    from += dur;
    // Only image-bearing scenes have a "look" worth seeding; text-only scenes
    // upgrade via text-to-video, so skip them.
    if (!scenes[i].image) continue;
    const file = path.join(tmp, `seed-${id}-s${i}.png`);
    try {
      await renderStill({
        composition,
        serveUrl,
        frame: mid,
        output: file,
        imageFormat: "png",
        inputProps: captionlessPlan,
      });
      out[i] = file;
    } catch {
      // A failed seed just means that scene upgrades via text-to-video — non-fatal.
    }
  }
  return out;
}
