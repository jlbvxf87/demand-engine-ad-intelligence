"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X, type LucideIcon } from "lucide-react";

/* ── Screen header ─────────────────────────────────────────────────────── */
export function ScreenHeader({
  title,
  subtitle,
  badge,
  badgeTone = "neutral",
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  badgeTone?: Tone;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div>
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight md:text-[30px]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-[14px] text-[var(--color-ink-muted)]">
            {subtitle}
          </p>
        )}
      </div>
      {badge && (
        <Badge tone={badgeTone} className="mt-1.5 shrink-0">
          {badge}
        </Badge>
      )}
    </div>
  );
}

/* ── Card ──────────────────────────────────────────────────────────────── */
export function Card({
  children,
  className = "",
  onClick,
  as: As = "div",
  accent,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  as?: "div" | "button";
  accent?: string;
}) {
  return (
    <As
      onClick={onClick}
      className={`w-full rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] text-left shadow-[0_1px_2px_rgba(16,21,27,0.03),0_10px_28px_-16px_rgba(16,21,27,0.12)] ${
        onClick
          ? "cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(16,21,27,0.04),0_18px_40px_-20px_rgba(16,21,27,0.20)]"
          : ""
      } ${className}`}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
    >
      {children}
    </As>
  );
}

/* ── Badge ─────────────────────────────────────────────────────────────── */
export type Tone =
  | "neutral"
  | "win"
  | "warn"
  | "danger"
  | "source"
  | "decode"
  | "rebuild"
  | "publish";

const TONE: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: "var(--color-surface-2)", fg: "var(--color-ink-muted)" },
  win: { bg: "var(--color-win-soft)", fg: "var(--color-win)" },
  warn: { bg: "var(--color-warn-soft)", fg: "var(--color-warn)" },
  danger: { bg: "var(--color-danger-soft)", fg: "var(--color-danger)" },
  source: { bg: "var(--color-source-soft)", fg: "var(--color-source)" },
  decode: { bg: "var(--color-decode-soft)", fg: "var(--color-decode)" },
  rebuild: { bg: "var(--color-rebuild-soft)", fg: "var(--color-rebuild)" },
  publish: { bg: "var(--color-publish-soft)", fg: "var(--color-publish)" },
};

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2.5 py-1 text-[11.5px] font-bold ${className}`}
      style={{ background: t.bg, color: t.fg }}
    >
      {children}
    </span>
  );
}

/* ── Winner badge (Dominant / Proven / Scaling / Testing) ──────────────── */
export function WinnerBadge({ badge }: { badge?: string | null }) {
  const map: Record<string, Tone> = {
    dominant: "win",
    proven: "source",
    scaling: "warn",
    testing: "neutral",
  };
  const key = (badge || "testing").toLowerCase();
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return <Badge tone={map[key] ?? "neutral"}>{label}</Badge>;
}

/* ── Button ────────────────────────────────────────────────────────────── */
export function Button({
  children,
  onClick,
  accent = "var(--color-source)",
  variant = "primary",
  full = true,
  disabled = false,
  icon: Icon,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  accent?: string;
  variant?: "primary" | "outline";
  full?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  type?: "button" | "submit";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-[15px] font-bold transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed";
  const style =
    variant === "primary"
      ? { background: accent, color: "#fff", boxShadow: "0 6px 18px -6px rgba(23,46,215,0.45)" }
      : { background: "transparent", color: accent, border: `1.5px solid ${accent}` };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${full ? "w-full" : ""} active:scale-[0.98]`}
      style={style}
    >
      {Icon && <Icon size={18} strokeWidth={2.4} />}
      {children}
    </button>
  );
}

/* ── Segmented tabs ────────────────────────────────────────────────────── */
export function Tabs({
  tabs,
  active,
  onChange,
  accent = "var(--color-source)",
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  accent?: string;
}) {
  return (
    <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className="shrink-0 rounded-[var(--radius-pill)] border px-4 py-2 text-[13.5px] font-semibold transition-all duration-150 active:scale-[0.97]"
            style={{
              background: on ? accent : "var(--color-surface)",
              color: on ? "#fff" : "var(--color-ink-muted)",
              borderColor: on ? accent : "var(--color-line)",
              boxShadow: on ? "0 4px 12px -4px rgba(23,46,215,0.40)" : "none",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Filter pill (dropdown-style) ──────────────────────────────────────── */
export function FilterPill({
  label,
  value,
  onClick,
}: {
  label?: string;
  value: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--color-ink)]"
    >
      {label && <span className="text-[var(--color-ink-muted)]">{label}:</span>}
      {value}
      <ChevronDown size={13} className="text-[var(--color-ink-muted)]" />
    </button>
  );
}

/* ── Status chip (factory line stations) ───────────────────────────────── */
export type StationStatus =
  | "built"
  | "ready"
  | "review"
  | "running"
  | "complete"
  | "locked";

const STATION: Record<StationStatus, { label: string; tone: Tone }> = {
  built: { label: "Built", tone: "source" },
  ready: { label: "Ready", tone: "win" },
  review: { label: "Needs review", tone: "warn" },
  running: { label: "Running", tone: "decode" },
  complete: { label: "Complete", tone: "win" },
  locked: { label: "Not built", tone: "neutral" },
};

export function StatusChip({ status }: { status: StationStatus }) {
  const s = STATION[status];
  return (
    <Badge tone={s.tone}>
      {status === "running" && (
        <span className="mr-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {s.label}
    </Badge>
  );
}

/* ── Skeleton ──────────────────────────────────────────────────────────── */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} />;
}

/* ── Section label ─────────────────────────────────────────────────────── */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2.5 mt-6 text-[15px] font-bold tracking-tight">
      {children}
    </h2>
  );
}

/* ── Modal / detail sheet ──────────────────────────────────────────────────
   Bottom-sheet on mobile, centered dialog on desktop. Backdrop + Esc close. */
export function Modal({
  open,
  onClose,
  title,
  accent,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  accent?: string;
  children: React.ReactNode;
}) {
  // Portal to <body> so position:fixed is resolved against the viewport, not a
  // transformed ancestor. Several page wrappers use the `.de-in` animation,
  // whose resting `transform: translateY(0)` still establishes a containing
  // block — which would otherwise trap this overlay inside the content column
  // (leaving the sidebar bright and the dialog visually off-center).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-[rgba(16,21,27,0.55)]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[0_-8px_40px_rgba(16,27,22,0.18)] sm:max-h-[88vh] sm:max-w-lg sm:rounded-[var(--radius-card)] sm:shadow-[0_20px_60px_rgba(16,27,22,0.25)]"
        style={accent ? { borderTop: `3px solid ${accent}` } : undefined}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
          <div className="min-w-0 text-[14px] font-bold">{title}</div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1 text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-2)]"
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Stat (label over value) ───────────────────────────────────────────── */
export function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
      <p className="text-[10.5px] font-bold uppercase tracking-wide text-[var(--color-ink-muted)]">
        {label}
      </p>
      <p
        className="mt-0.5 text-[16px] font-extrabold tabular-nums"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </p>
    </div>
  );
}

/* ── Empty / hint state ────────────────────────────────────────────────── */
export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-[var(--color-line)] bg-[var(--color-surface)] px-6 py-12 text-center">
      {Icon && <Icon size={26} className="text-[var(--color-ink-muted)]" />}
      <p className="text-[15px] font-semibold">{title}</p>
      {hint && (
        <p className="max-w-xs text-[13px] text-[var(--color-ink-muted)]">{hint}</p>
      )}
    </div>
  );
}
