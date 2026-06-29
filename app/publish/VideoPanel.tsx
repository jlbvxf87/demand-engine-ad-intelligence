"use client";

import { useState } from "react";
import { Zap, Sparkles, Wand2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import DraftPanel from "./DraftPanel";
import ReplicatePanel from "./ReplicatePanel";

const ACCENT = "var(--color-publish)";

type Budget = "draft" | "motion" | "cinematic";

const BUDGETS: {
  id: Budget;
  label: string;
  cost: string;
  blurb: string;
  icon: LucideIcon;
  disabled?: boolean;
}[] = [
  { id: "draft", label: "Draft", cost: "$0.05–0.25", blurb: "Templates + captions, no AI credits", icon: Zap },
  { id: "motion", label: "Motion", cost: "$0.40–1.00", blurb: "AI motion on key scenes only", icon: Wand2 },
  { id: "cinematic", label: "Cinematic", cost: "$3–10", blurb: "Full AI video — upgrade winners", icon: Sparkles },
];

/** Video tab: pick a render budget (how cheap), not a model. */
export default function VideoPanel() {
  const [budget, setBudget] = useState<Budget>("draft");

  return (
    <div>
      <p className="mb-2 text-[13px] font-bold text-[var(--color-ink-muted)]">Render budget</p>
      <div className="mb-4 grid grid-cols-3 gap-2">
        {BUDGETS.map((b) => {
          const on = b.id === budget;
          return (
            <button
              key={b.id}
              onClick={() => !b.disabled && setBudget(b.id)}
              disabled={b.disabled}
              className="flex flex-col items-start gap-1 rounded-2xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55"
              style={{
                borderColor: on ? ACCENT : "var(--color-line)",
                background: on ? "var(--color-publish-soft)" : "var(--color-surface)",
              }}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className="grid h-5 w-5 place-items-center rounded-full border-2"
                  style={{ borderColor: on ? ACCENT : "var(--color-line)" }}
                >
                  {on && <span className="h-2 w-2 rounded-full" style={{ background: ACCENT }} />}
                </span>
                <b.icon size={15} style={{ color: on ? ACCENT : "var(--color-ink-muted)" }} />
                <span className="text-[13.5px] font-bold" style={{ color: on ? ACCENT : "var(--color-ink)" }}>
                  {b.label}
                </span>
              </span>
              <span className="text-[11px] font-bold tabular-nums text-[var(--color-ink-muted)]">{b.cost}</span>
              <span className="text-[10.5px] leading-tight text-[var(--color-ink-muted)]">{b.blurb}</span>
            </button>
          );
        })}
      </div>

      {budget === "draft" ? (
        <DraftPanel tier="draft" />
      ) : budget === "motion" ? (
        <DraftPanel tier="motion" />
      ) : budget === "cinematic" ? (
        <ReplicatePanel />
      ) : null}
    </div>
  );
}
