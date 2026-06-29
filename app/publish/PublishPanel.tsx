"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Download, Upload, FolderInput, RotateCcw, Lock } from "lucide-react";
import { Card } from "@/components/ui";

const ACCENT = "var(--color-publish)";

const TARGETS = [
  { id: "meta", label: "Meta Ads Direct", icon: Upload },
  { id: "export", label: "Manual Ad Account Export", icon: FolderInput },
  { id: "download", label: "Download Files", icon: Download },
];

/** Publish tab: where outputs go, run performance, and the winner loop. */
export default function PublishPanel({ publishableCount }: { publishableCount: number }) {
  const router = useRouter();
  const [target, setTarget] = useState("meta");

  return (
    <div>
      {/* Publish targets */}
      <p className="mb-2 text-[15px] font-bold">Publish To</p>
      <div className="flex flex-col gap-2.5">
        {TARGETS.map((t) => {
          const on = t.id === target;
          return (
            <button
              key={t.id}
              onClick={() => setTarget(t.id)}
              className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors"
              style={{
                borderColor: on ? ACCENT : "var(--color-line)",
                background: on ? "var(--color-publish-soft)" : "var(--color-surface)",
              }}
            >
              <span
                className="grid h-6 w-6 place-items-center rounded-full border-2"
                style={{ borderColor: on ? ACCENT : "var(--color-line)" }}
              >
                {on && <span className="h-2.5 w-2.5 rounded-full" style={{ background: ACCENT }} />}
              </span>
              <t.icon size={17} style={{ color: on ? ACCENT : "var(--color-ink-muted)" }} />
              <span className="text-[14px] font-semibold" style={{ color: on ? ACCENT : "var(--color-ink)" }}>
                {t.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Run performance */}
      <p className="mb-2 mt-6 text-[15px] font-bold">Run Performance</p>
      <Card className="p-4">
        <div className="grid grid-cols-4 gap-2">
          {[
            ["CTR", "—"],
            ["CPC", "—"],
            ["Spend", "—"],
            ["Leads", "—"],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="text-[11px] font-semibold uppercase text-[var(--color-ink-muted)]">{k}</p>
              <p className="text-[18px] font-extrabold tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-[12px] text-[var(--color-ink-muted)]">
          <Lock size={13} />
          Connect the Meta Marketing API to stream live CTR, CPC, spend &amp; leads.
        </div>
      </Card>

      {/* Winner loop */}
      <Card className="mt-4 p-4">
        <p className="text-[14px] font-bold text-[var(--color-publish)]">Winner Loop</p>
        <p className="mt-0.5 text-[12.5px] text-[var(--color-ink-muted)]">
          Test cheap drafts → rank winners → rebuild winners → upgrade the best to cinematic.
        </p>
        <div className="mt-3 flex gap-2">
          <button className="flex items-center gap-1.5 rounded-xl bg-[var(--color-publish-soft)] px-3 py-2 text-[12.5px] font-bold text-[var(--color-publish)]">
            Rank winners
          </button>
          <button
            onClick={() => router.push("/source")}
            className="flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3 py-2 text-[12.5px] font-bold"
          >
            <RotateCcw size={13} /> Back to library
          </button>
        </div>
      </Card>

      <button
        disabled={publishableCount === 0}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-4 text-[16px] font-bold text-white disabled:opacity-40 active:scale-[0.99]"
        style={{ background: ACCENT }}
      >
        <Play size={18} /> Publish {publishableCount || ""} Creatives
      </button>
    </div>
  );
}
