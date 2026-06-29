/**
 * Pure, dependency-free types + constants shared by the server-side draft
 * planner (lib/draft-plan.ts) and the Remotion composition (remotion/*). Keep
 * this file import-free so it's safe to pull into Remotion's separate bundle.
 */

export const DRAFT_FPS = 30;
export const DRAFT_WIDTH = 1080;
export const DRAFT_HEIGHT = 1920; // 9:16

export type SceneRole = "hook" | "problem" | "product" | "benefit" | "cta";

export type SceneMotion = "push_in" | "pan" | "zoom" | "product_float";

/** How a scene is rendered — drives both cost and (later) which engine runs it. */
export type RenderMethod = "template_motion" | "still_zoom" | "ai_motion" | "full_ai_video";

/** Per-method metadata: label, estimated cost (cents), and whether it renders today.
 *  AI methods are shown in the recipe (with cost) but disabled until the Motion /
 *  Cinematic PRs wire per-scene KIE routing. */
export const RENDER_METHODS: { id: RenderMethod; label: string; costCents: number; live: boolean }[] = [
  { id: "template_motion", label: "Template Motion", costCents: 1, live: true },
  { id: "still_zoom", label: "Still + Zoom", costCents: 1, live: true },
  { id: "ai_motion", label: "AI Motion", costCents: 20, live: true },
  { id: "full_ai_video", label: "Full AI Video", costCents: 150, live: false },
];

export function methodCost(m: RenderMethod): number {
  return RENDER_METHODS.find((x) => x.id === m)?.costCents ?? 1;
}

export function methodIsLive(m: RenderMethod): boolean {
  return RENDER_METHODS.find((x) => x.id === m)?.live ?? false;
}

export function planTotalCents(plan: { scenes: DraftScene[] }): number {
  return plan.scenes.reduce((sum, s) => sum + (s.estimatedCostCents ?? methodCost(s.renderMethod)), 0);
}

/** Format cents as a short dollar string, e.g. 5 → "$0.05". */
export function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export type DraftScene = {
  role: SceneRole;
  /** Seconds this scene is on screen. */
  duration: number;
  /** On-screen caption text. */
  text: string;
  /** One-line description of the intended visual (shown in the recipe, future still-gen). */
  visual?: string;
  /** Optional product / reference image URL (public, fetchable by Remotion). */
  image?: string;
  motion: SceneMotion;
  /** How this scene renders (drives cost + future engine routing). */
  renderMethod: RenderMethod;
  /** Estimated render cost for this scene, in cents. */
  estimatedCostCents: number;
  // ── AI-clip tracking (ai_motion scenes only; lives in render_plan_json) ──
  /** KIE provider used for this scene's AI clip. */
  aiProvider?: string;
  /** KIE job id for this scene's AI clip. */
  aiJobId?: string;
  /** AI clip lifecycle. */
  aiStatus?: "pending" | "ready" | "failed";
  /** Permanent (Supabase) URL of the rendered AI clip — what the composite plays. */
  aiClipUrl?: string;
  /** KIE submit attempts (for self-heal). */
  aiAttempts?: number;
};

export type DraftRenderPlan = {
  format: "9:16";
  fps: number;
  /** Total length in frames (sum of scene durations * fps). */
  durationInFrames: number;
  scenes: DraftScene[];
  /** Estimated total render cost, in cents (sum of scenes). */
  estimatedCostCents: number;
};

/** The id Remotion's registerRoot binds the composition to. */
export const DRAFT_COMPOSITION_ID = "DraftAd";
