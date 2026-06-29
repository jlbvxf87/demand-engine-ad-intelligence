/* Client-safe video-model constants (no secrets, no server-only import) so the
   Studio UI and the server-only kie client can share one source of truth. */

export type VideoProvider = "seedance" | "kling" | "sora" | "veo";
export type VideoMode = "text-to-video" | "image-to-video";

// Talking-head video models, ordered by native-voice reliability (Kling default).
// Each renders a person speaking the copy in the MODEL'S OWN voice — no TTS.
export const VIDEO_PROVIDERS: { id: VideoProvider; label: string; maxDuration: number }[] = [
  { id: "kling", label: "Kling 3.0 — talking head + voice", maxDuration: 15 },
  { id: "veo", label: "Veo 3.1 — talking head + voice", maxDuration: 8 },
  { id: "sora", label: "Sora 2 — talking head + voice", maxDuration: 15 },
  { id: "seedance", label: "Seedance 2.0 — talking head, voice varies", maxDuration: 15 },
];

/** Allowed clip durations (seconds) per model — drives the duration picker. */
export const PROVIDER_DURATIONS: Record<VideoProvider, number[]> = {
  seedance: [4, 5, 8, 10, 12, 15],
  kling: [5, 10, 15],
  sora: [10, 15],
  veo: [5, 8],
};

const LABELS: Record<VideoProvider, string> = {
  seedance: "Seedance 2.0",
  kling: "Kling 3.0",
  sora: "Sora 2",
  veo: "Veo 3.1",
};

export function providerLabel(p: string | null | undefined): string {
  if (p === "remotion") return "Draft"; // cheap Remotion render, not a KIE model
  return (p && LABELS[p as VideoProvider]) || "—";
}

export function isVideoProvider(p: string): p is VideoProvider {
  return p === "seedance" || p === "kling" || p === "sora" || p === "veo";
}
