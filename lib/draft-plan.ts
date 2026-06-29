import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import {
  DRAFT_FPS,
  methodCost,
  planTotalCents,
  type DraftRenderPlan,
  type DraftScene,
  type SceneMotion,
  type SceneRole,
} from "../remotion/types";

export type { DraftRenderPlan, DraftScene } from "../remotion/types";

/** What buildDraftPlan can be seeded from: an existing creative's copy, or a raw brief. */
export type DraftPlanInput = {
  hook?: string | null;
  bridge?: string | null;
  cta?: string | null;
  image?: string | null;
  /** Freeform brief — only used (one cheap Sonnet call) when structured copy is absent. */
  brief?: string | null;
};

const SECONDS: Record<SceneRole, number> = {
  hook: 2.5,
  problem: 2.5,
  product: 3,
  benefit: 2.5,
  cta: 2.5,
};

const MOTION: Record<SceneRole, SceneMotion> = {
  hook: "push_in",
  problem: "pan",
  product: "product_float",
  benefit: "zoom",
  cta: "push_in",
};

const DEFAULT_VISUAL: Record<SceneRole, string> = {
  hook: "Attention-grabbing opener",
  problem: "The problem, felt",
  product: "Product shown in use",
  benefit: "The payoff / result",
  cta: "Call to action",
};

function scene(role: SceneRole, text: string, image?: string | null, visual?: string): DraftScene {
  // Drafts default every scene to the cheapest live method; the user can change
  // a scene's method in the recipe editor before rendering.
  return {
    role,
    duration: SECONDS[role],
    text: text.trim(),
    visual: (visual || DEFAULT_VISUAL[role]).trim(),
    image: image ?? undefined,
    motion: MOTION[role],
    renderMethod: "template_motion",
    estimatedCostCents: methodCost("template_motion"),
  };
}

/** Roll a list of scenes into a full plan (computes total frames + cost). */
function assemble(scenes: DraftScene[]): DraftRenderPlan {
  const totalSeconds = scenes.reduce((s, sc) => s + sc.duration, 0);
  return {
    format: "9:16",
    fps: DRAFT_FPS,
    durationInFrames: Math.max(1, Math.round(totalSeconds * DRAFT_FPS)),
    scenes,
    estimatedCostCents: planTotalCents({ scenes }),
  };
}

/**
 * Build a 3–5 scene draft plan. Deterministic when structured copy exists
 * (hook / bridge / cta) — no LLM. Only a raw brief with no structured copy
 * triggers ONE cheap Sonnet call to split it into scene texts.
 */
export async function buildDraftPlan(input: DraftPlanInput): Promise<DraftRenderPlan> {
  const hook = (input.hook || "").trim();
  const bridge = (input.bridge || "").trim();
  const cta = (input.cta || "").trim();
  const image = input.image || undefined;

  // Deterministic path: we already have structured copy.
  if (hook || bridge || cta) {
    const scenes: DraftScene[] = [];
    scenes.push(scene("hook", hook || "Watch this.", null));
    // Product scene carries the reference/product image (the visual centerpiece).
    scenes.push(scene("product", bridge || hook || "Meet the product.", image));
    if (bridge && hook) scenes.push(scene("benefit", bridge));
    scenes.push(scene("cta", cta || "Try it today"));
    return assemble(scenes.slice(0, 5));
  }

  // Pull a {text, visual} pair for a role out of the Sonnet response, tolerating
  // either a flat string or a {text, visual} object.
  const pick = (v: unknown): { text: string; visual?: string } => {
    if (typeof v === "string") return { text: v };
    if (v && typeof v === "object") {
      const o = v as { text?: string; visual?: string };
      return { text: o.text ?? "", visual: o.visual };
    }
    return { text: "" };
  };

  // Brief-only path: one cheap Sonnet call to produce 4 scene lines.
  const brief = (input.brief || "").trim();
  if (!brief) {
    // Nothing to work with — minimal valid plan so the renderer never crashes.
    return assemble([scene("hook", "Watch this."), scene("cta", "Try it today")]);
  }

  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system:
        "You are a direct-response ad writer. Return JSON only. No banned CTAs (Get Started/Sign Up/Learn More), no therapeutic or guaranteed-outcome claims. Keep each line punchy and on-screen-friendly (<= 9 words).",
      messages: [
        {
          role: "user",
          content: `Turn this brief into a 4-scene short ad. For each scene give the on-screen caption ("text", <= 9 words) and a one-line "visual" describing the shot. Return JSON: {"hook":{"text":"","visual":""},"problem":{"text":"","visual":""},"benefit":{"text":"","visual":""},"cta":{"text":"3-5 words","visual":""}}\nBRIEF: ${brief}`,
        },
      ],
    });
    const raw = msg.content[0]?.type === "text" ? msg.content[0].text : "{}";
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;
    const hk = pick(parsed.hook);
    const pr = pick(parsed.problem);
    const bn = pick(parsed.benefit);
    const ct = pick(parsed.cta);
    return assemble([
      scene("hook", hk.text || brief.slice(0, 60), null, hk.visual),
      scene("problem", pr.text || "", null, pr.visual),
      scene("benefit", bn.text || "", null, bn.visual),
      scene("cta", ct.text || "Try it today", null, ct.visual),
    ].filter((s) => s.text.length > 0));
  } catch {
    // LLM unavailable — degrade to a deterministic single-line plan.
    return assemble([scene("hook", brief.slice(0, 60)), scene("cta", "Try it today")]);
  }
}
