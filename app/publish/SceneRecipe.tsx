"use client";

import { ArrowUp, ArrowDown, X } from "lucide-react";
import { Card } from "@/components/ui";
import {
  RENDER_METHODS,
  methodCost,
  planTotalCents,
  fmtCents,
  DRAFT_FPS,
  type DraftRenderPlan,
  type DraftScene,
  type RenderMethod,
} from "@/remotion/types";

const ACCENT = "var(--color-publish)";

const ROLE_LABEL: Record<string, string> = {
  hook: "Hook",
  problem: "Problem",
  product: "Product",
  benefit: "Benefit",
  cta: "CTA",
};

/** Editable scene recipe: per-scene caption, render method (+ cost), reorder/remove. */
export default function SceneRecipe({
  plan,
  onChange,
  aiEnabled = false,
}: {
  plan: DraftRenderPlan;
  onChange: (p: DraftRenderPlan) => void;
  /** Motion tier unlocks the ai_motion method. */
  aiEnabled?: boolean;
}) {
  // Rebuild the plan from an edited scene list, re-stamping per-scene cost,
  // total cost, and total frames.
  function commit(scenes: DraftScene[]) {
    const fixed = scenes.map((s) => ({ ...s, estimatedCostCents: methodCost(s.renderMethod) }));
    const fps = plan.fps || DRAFT_FPS;
    const totalSeconds = fixed.reduce((sum, s) => sum + s.duration, 0);
    onChange({
      ...plan,
      scenes: fixed,
      durationInFrames: Math.max(1, Math.round(totalSeconds * fps)),
      estimatedCostCents: planTotalCents({ scenes: fixed }),
    });
  }

  function patch(i: number, p: Partial<DraftScene>) {
    commit(plan.scenes.map((s, idx) => (idx === i ? { ...s, ...p } : s)));
  }
  function changeMethod(i: number, method: RenderMethod) {
    // AI clips run ~5s; give the scene room so the full clip plays.
    const p: Partial<DraftScene> =
      method === "ai_motion" && plan.scenes[i].duration < 5
        ? { renderMethod: method, duration: 5 }
        : { renderMethod: method };
    patch(i, p);
  }
  function methodDisabled(m: RenderMethod, live: boolean): boolean {
    if (!live) return true; // full_ai_video — not built yet
    if (m === "ai_motion" && !aiEnabled) return true; // Draft tier: template only
    return false;
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= plan.scenes.length) return;
    const next = plan.scenes.slice();
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  }
  function remove(i: number) {
    if (plan.scenes.length <= 1) return;
    commit(plan.scenes.filter((_, idx) => idx !== i));
  }

  return (
    <Card className="mb-4 p-4" accent={ACCENT}>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[15px] font-bold">Scene recipe</p>
        <span className="rounded-full bg-[var(--color-publish-soft)] px-2.5 py-1 text-[12px] font-extrabold tabular-nums text-[var(--color-publish)]">
          Total ~{fmtCents(plan.estimatedCostCents)}
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {plan.scenes.map((s, i) => (
          <div key={i} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="rounded-md bg-[var(--color-publish-soft)] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-[var(--color-publish)]">
                  {i + 1} · {ROLE_LABEL[s.role] || s.role}
                </span>
                <span className="text-[11px] font-bold tabular-nums text-[var(--color-ink-muted)]">
                  ~{fmtCents(s.estimatedCostCents)}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <button
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="grid h-6 w-6 place-items-center rounded-md border border-[var(--color-line)] text-[var(--color-ink-muted)] disabled:opacity-30"
                  title="Move up"
                >
                  <ArrowUp size={12} />
                </button>
                <button
                  onClick={() => move(i, 1)}
                  disabled={i === plan.scenes.length - 1}
                  className="grid h-6 w-6 place-items-center rounded-md border border-[var(--color-line)] text-[var(--color-ink-muted)] disabled:opacity-30"
                  title="Move down"
                >
                  <ArrowDown size={12} />
                </button>
                <button
                  onClick={() => remove(i)}
                  disabled={plan.scenes.length <= 1}
                  className="grid h-6 w-6 place-items-center rounded-md border border-[var(--color-danger-soft)] text-[var(--color-danger)] disabled:opacity-30"
                  title="Remove scene"
                >
                  <X size={12} />
                </button>
              </span>
            </div>

            {s.visual && (
              <p className="mb-1.5 text-[11.5px] italic text-[var(--color-ink-muted)]">Visual: {s.visual}</p>
            )}

            <input
              value={s.text}
              onChange={(e) => patch(i, { text: e.target.value })}
              placeholder="On-screen caption…"
              className="mb-2 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-2 text-[13px] font-semibold outline-none focus:border-[var(--color-publish)]"
            />

            <label className="flex items-center gap-2 text-[12px]">
              <span className="font-semibold text-[var(--color-ink-muted)]">Render</span>
              <select
                value={s.renderMethod}
                onChange={(e) => changeMethod(i, e.target.value as RenderMethod)}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-[12.5px] font-bold outline-none"
              >
                {RENDER_METHODS.map((m) => (
                  <option key={m.id} value={m.id} disabled={methodDisabled(m.id, m.live)}>
                    {m.label} · {fmtCents(m.costCents)}
                    {!m.live ? " (soon)" : m.id === "ai_motion" && !aiEnabled ? " (Motion)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
      </div>
    </Card>
  );
}
