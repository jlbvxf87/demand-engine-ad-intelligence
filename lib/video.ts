/* Client-safe video-model constants (no secrets, no server-only import) so the
   Studio UI and the server-only kie client can share one source of truth. */

export type VideoProvider = "seedance" | "kling" | "sora" | "veo" | "runway";
export type VideoMode = "text-to-video" | "image-to-video";

// Talking-head video models, ordered by native-voice reliability (Kling default).
// Runway dropped (not a talking-head / silent). Seedance kept but flagged — it
// renders the talking-head look but its audio is unreliable. Backend types below
// still include them for any legacy rows; this is just the selectable list.
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

/* ── Spokesperson voices (Kie elevenlabs/text-to-dialogue-v3 voice ids) ──────
   A curated set from Kie's supported list, picked for natural ad/UGC narration —
   female-first since most of these creatives feature a female presenter. */
export type Voice = { id: string; label: string };
export const VOICES: Voice[] = [
  { id: "hpp4J3VqNfWAUOO0d1Us", label: "Bella — bright & warm (F)" },
  { id: "kPzsL2i3teMYv0FxEYQ6", label: "Brittney — fun, youthful UGC (F)" },
  { id: "Sm1seazb4gs7RSlUVw7c", label: "Anika — friendly & engaging (F)" },
  { id: "lcMyyd2HUfFzxdCaC4Ta", label: "Lucy — fresh & casual (F)" },
  { id: "BZgkqPqms7Kj9ulSkVzn", label: "Eve — energetic & happy (F)" },
  { id: "6aDn1KB0hjpdcocrUkmq", label: "Tiffany — natural & welcoming (F)" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", label: "Liam — energetic creator (M)" },
  { id: "UgBBYS2sOqTuMpoF3BR0", label: "Mark — natural conversation (M)" },
  { id: "nPczCjzI2devNBz1zQrb", label: "Brian — deep & comforting (M)" },
  { id: "EkK5I93UQWFDigLMpZcX", label: "James — husky & bold (M)" },
];
export const DEFAULT_VOICE = VOICES[0].id;
