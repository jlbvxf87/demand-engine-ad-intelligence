/* Client-safe video-model constants (no secrets, no server-only import) so the
   Studio UI and the server-only kie client can share one source of truth. */

export type VideoProvider = "seedance" | "kling" | "sora" | "veo" | "runway";
export type VideoMode = "text-to-video" | "image-to-video";

export const VIDEO_PROVIDERS: { id: VideoProvider; label: string; maxDuration: number }[] = [
  { id: "seedance", label: "Seedance 2.0", maxDuration: 15 },
  { id: "kling", label: "Kling 3.0", maxDuration: 15 },
  { id: "sora", label: "Sora 2", maxDuration: 15 },
  { id: "veo", label: "Veo 3.1", maxDuration: 8 },
  { id: "runway", label: "Runway Gen-4", maxDuration: 10 },
];

/** Allowed clip durations (seconds) per model — drives the duration picker. */
export const PROVIDER_DURATIONS: Record<VideoProvider, number[]> = {
  seedance: [4, 5, 8, 10, 12, 15],
  kling: [5, 10, 15],
  sora: [10, 15],
  veo: [5, 8],
  runway: [5, 10],
};

const LABELS: Record<VideoProvider, string> = {
  seedance: "Seedance 2.0",
  kling: "Kling 3.0",
  sora: "Sora 2",
  veo: "Veo 3.1",
  runway: "Runway Gen-4",
};

// "spokesperson" is a render MODE (TTS → lip-sync), not a base video model, so
// it's intentionally NOT a VideoProvider (the video poll loop skips it; the
// voice pipeline owns it). It still needs a display label.
export const SPOKESPERSON = "spokesperson";

export function providerLabel(p: string | null | undefined): string {
  if (p === SPOKESPERSON) return "Spokesperson";
  return (p && LABELS[p as VideoProvider]) || "—";
}

export function isVideoProvider(p: string): p is VideoProvider {
  return p === "seedance" || p === "kling" || p === "sora" || p === "veo" || p === "runway";
}
