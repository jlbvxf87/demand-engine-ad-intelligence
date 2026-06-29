"use client";

import { useState, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Play,
  Download,
  Clapperboard,
  Loader2,
  CheckCircle2,
  Film,
  Trash2,
  Zap,
} from "lucide-react";
import { ScreenHeader, Badge, EmptyState, Modal, Tabs } from "@/components/ui";
import AdThumb from "@/components/AdThumb";
import { verticalLabel } from "@/lib/format";
import { VIDEO_PROVIDERS, providerLabel, type VideoProvider } from "@/lib/video";
import { renderVideo, pollVideoJobs, deleteCreative, generateDraftVideo } from "@/app/actions";
import CopyPanel from "./CopyPanel";
import VideoPanel from "./VideoPanel";
import StoryboardPanel from "./StoryboardPanel";
import StoriesList from "./StoriesList";
import PublishPanel from "./PublishPanel";
import type { Creative, Storyboard } from "@/lib/data";

const ACCENT = "var(--color-publish)";

const TABS = [
  { id: "copy", label: "Copy" },
  { id: "video", label: "Video" },
  { id: "stories", label: "Stories" },
  { id: "publish", label: "Publish" },
];

function isRendering(c: Creative) {
  return (
    c.video_status === "queued" ||
    c.video_status === "rendering" ||
    c.video_status === "compositing"
  );
}

/** Cinematic = a real AI-model (KIE) video. Tests = cheap Remotion drafts/motion,
 *  stills, and anything not yet promoted to a paid model render. */
function isCinematic(c: Creative) {
  return !!c.video_provider && c.video_provider !== "remotion";
}

/** Short tier label for a tile badge. */
function tierLabel(c: Creative): string {
  if (c.render_mode === "motion") return "Motion";
  if (c.render_mode === "draft" || c.video_provider === "remotion") return "Draft";
  if (c.video_provider) return providerLabel(c.video_provider);
  return c.video_url ? "Video" : "Still";
}

function fmtElapsed(secs: number) {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** Seconds a clip has been rendering. Anchored to the row's created_at (server
 *  truth) so it shows REAL elapsed time and survives reloads — a stuck render
 *  then reads its true age (e.g. 46:00) instead of resetting to 0:07. */
function useRenderElapsed(active: boolean, sinceIso?: string): number {
  const [secs, setSecs] = useState(0);
  const startRef = useRef<number>(0);
  if (active && startRef.current === 0) {
    const t = sinceIso ? new Date(sinceIso).getTime() : NaN;
    startRef.current = Number.isFinite(t) ? t : Date.now();
  }
  if (!active && startRef.current !== 0) startRef.current = 0;
  useEffect(() => {
    if (!active) {
      setSecs(0);
      return;
    }
    const tick = () => setSecs(Math.max(0, Math.floor((Date.now() - startRef.current) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [active]);
  return secs;
}

export default function PublishClient({
  creatives,
  storyboards,
}: {
  creatives: Creative[];
  storyboards: Storyboard[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState("video");
  const [model, setModel] = useState<VideoProvider>("kling");
  const [review, setReview] = useState<Creative | null>(null);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [outFilter, setOutFilter] = useState<"all" | "tests" | "cinematic">("all");

  const anyRendering = creatives.some(isRendering);
  const stills = creatives.filter((c) => !c.video_url && !isRendering(c));
  // Scene clips belong to a Story (shown in the Stories tab), so keep them out of
  // the standalone reel grid — otherwise the same footage shows twice.
  const standalone = creatives.filter((c) => c.creative_type !== "scene");
  const cinematic = standalone.filter(isCinematic);
  const tests = standalone.filter((c) => !isCinematic(c));
  const shown = outFilter === "tests" ? tests : outFilter === "cinematic" ? cinematic : standalone;
  const anyStoryboardActive = storyboards.some((s) =>
    ["scripting", "generating", "stitching"].includes(s.status)
  );
  const polling = anyRendering || anyStoryboardActive;

  // A brief handed over from Decode goes straight to Video ▸ Draft.
  useEffect(() => {
    try {
      if (sessionStorage.getItem("brief:scratch")) setTab("video");
    } catch {}
  }, []);

  // Drive kie polling from the client while clips render or stories stitch.
  useEffect(() => {
    if (!polling) return;
    let alive = true;
    const tick = async () => {
      await pollVideoJobs();
      if (alive) router.refresh();
    };
    const iv = setInterval(tick, 6000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [polling, router]);

  function render(id: string, m: VideoProvider) {
    setBusyId(id);
    setNote(null);
    startTransition(async () => {
      const r = await renderVideo(id, m);
      setBusyId(null);
      if (!r.ok) setNote(r.error || "Render failed");
      else router.refresh();
    });
  }

  // Cheap Draft render (Remotion + FFmpeg, no KIE credits).
  function draft(id: string) {
    setBusyId(id);
    setNote(null);
    startTransition(async () => {
      const r = await generateDraftVideo(id);
      setBusyId(null);
      if (!r.ok) setNote(r.error || "Draft render failed");
      else router.refresh();
    });
  }

  function renderAll() {
    if (!stills.length) return;
    setNote(null);
    startTransition(async () => {
      for (const c of stills) {
        await renderVideo(c.id, model);
      }
      router.refresh();
    });
  }

  function del(id: string) {
    if (!confirm("Delete this creative permanently? This can't be undone.")) return;
    setBusyId(id);
    setNote(null);
    startTransition(async () => {
      const r = await deleteCreative(id);
      setBusyId(null);
      if (!r.ok) setNote(r.error || "Delete failed");
      else {
        setReview(null);
        router.refresh();
      }
    });
  }

  return (
    <div>
      <ScreenHeader
        title="Create"
        subtitle="Build ad-ready drafts for cents, then upgrade only the winners."
        badge={creatives.length ? "ready" : "empty"}
        badgeTone={creatives.length ? "publish" : "neutral"}
      />

      {/* Production console: Copy → Video → Stories → Publish */}
      <div className="mb-4">
        <Tabs accent={ACCENT} active={tab} onChange={setTab} tabs={TABS} />
      </div>

      {tab === "copy" && <CopyPanel />}
      {tab === "video" && <VideoPanel />}
      {tab === "stories" && (
        <>
          <StoryboardPanel />
          <StoriesList storyboards={storyboards} />
        </>
      )}
      {tab === "publish" && <PublishPanel publishableCount={standalone.length} />}

      {/* ── Outputs (persistent across tabs) ───────────────────────────────── */}
      <div className="mt-6 border-t border-[var(--color-line)] pt-5">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[15px] font-bold">Outputs</p>
          {standalone.length > 0 && (
            <div className="inline-flex items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] p-0.5">
              {([
                ["all", "All", standalone.length],
                ["tests", "Tests", tests.length],
                ["cinematic", "Cinematic", cinematic.length],
              ] as const).map(([id, label, count]) => {
                const on = outFilter === id;
                return (
                  <button
                    key={id}
                    onClick={() => setOutFilter(id)}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-bold transition-colors"
                    style={{
                      background: on ? ACCENT : "transparent",
                      color: on ? "#fff" : "var(--color-ink-muted)",
                    }}
                  >
                    {label}
                    <span
                      className="rounded-full px-1.5 text-[10.5px] font-extrabold tabular-nums"
                      style={{
                        background: on ? "rgba(255,255,255,0.25)" : "var(--color-surface-2)",
                        color: on ? "#fff" : "var(--color-ink-muted)",
                      }}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Model picker + render-all stills (KIE batch) */}
        {stills.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[13px]">
              <Film size={15} className="text-[var(--color-ink-muted)]" />
              <span className="font-semibold text-[var(--color-ink-muted)]">Model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value as VideoProvider)}
                className="bg-transparent text-[13px] font-bold outline-none"
              >
                {VIDEO_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={renderAll}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-bold text-white disabled:opacity-50"
              style={{ background: ACCENT }}
            >
              {pending ? <Loader2 size={14} className="animate-spin" /> : <Clapperboard size={14} />}
              Render {stills.length} still{stills.length > 1 ? "s" : ""}
            </button>
          </div>
        )}

        {/* Reel grid (filtered by tier) */}
        {standalone.length === 0 ? (
          <EmptyState
            icon={Play}
            title="Nothing here yet"
            hint="Generate copy or a draft above — your outputs queue here."
          />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={Play}
            title={outFilter === "cinematic" ? "No cinematic finals yet" : "No tests yet"}
            hint={
              outFilter === "cinematic"
                ? "Upgrade a winning draft to Cinematic and it lands here."
                : "Generate a Draft or Motion above — your cheap tests queue here."
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {shown.map((c) => (
              <ReelTile key={c.id} c={c} onClick={() => setReview(c)} />
            ))}
          </div>
        )}

        {note && (
          <p className="mt-3 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
            {note}
          </p>
        )}
      </div>

      {/* ── Creative review ─────────────────────────────────────────────── */}
      <Modal
        open={!!review}
        onClose={() => setReview(null)}
        accent={ACCENT}
        title={<span className="truncate">Creative review</span>}
      >
        {review && (
          <div className="flex flex-col gap-4">
            {/* Visual */}
            <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[#10151B]">
              {review.video_url ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  src={review.video_url}
                  controls
                  autoPlay
                  loop
                  playsInline
                  className="aspect-[9/16] w-full bg-black object-contain"
                />
              ) : review.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={review.image_url}
                  alt={review.hook_text}
                  className="aspect-[9/16] w-full object-cover"
                />
              ) : (
                <div className="grid aspect-[9/16] place-items-center text-[13px] text-white/60">
                  {isRendering(review) ? "Rendering…" : "No still generated yet"}
                </div>
              )}
            </div>

            {/* Status + meta chips */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="win">
                <CheckCircle2 size={12} /> Compliant
              </Badge>
              {review.video_url ? (
                <Badge tone="publish">Video · {providerLabel(review.video_provider)}</Badge>
              ) : isRendering(review) ? (
                <Badge tone="decode">Rendering · {providerLabel(review.video_provider)}</Badge>
              ) : review.video_status === "failed" ? (
                <Badge tone="danger">Render failed</Badge>
              ) : (
                <Badge tone="neutral">Still</Badge>
              )}
              {review.brand_slug && <Badge tone="rebuild">{review.brand_slug}</Badge>}
              {review.vertical && <Badge tone="neutral">{verticalLabel(review.vertical)}</Badge>}
            </div>

            {/* Copy blocks */}
            <div className="flex flex-col gap-2.5">
              <CopyBlock label="Hook" text={review.hook_text} />
              {review.bridge_text && <CopyBlock label="Bridge" text={review.bridge_text} />}
              {review.cta_text && <CopyBlock label="CTA" text={review.cta_text} />}
            </div>

            {review.image_prompt && (
              <div>
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-muted)]">
                  Image prompt
                </p>
                <p className="rounded-xl bg-[var(--color-surface-2)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--color-ink-muted)]">
                  {review.image_prompt}
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              {!review.video_url && (
                <>
                  {/* Cheap-first: render a 9:16 draft with Remotion for cents — no KIE credits. */}
                  <button
                    onClick={() => draft(review.id)}
                    disabled={(pending && busyId === review.id) || isRendering(review)}
                    className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2.5 text-[13px] font-bold text-white disabled:opacity-60"
                    style={{ background: ACCENT }}
                    title="Render a 9:16 draft with Remotion — no AI-video credits"
                  >
                    {pending && busyId === review.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Zap size={14} />
                    )}
                    Generate Draft Video
                  </button>
                  {/* Expensive AI-video path (KIE), demoted to secondary. */}
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value as VideoProvider)}
                    className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-2.5 py-2.5 text-[13px] font-bold outline-none"
                  >
                    {VIDEO_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => render(review.id, model)}
                    disabled={(pending && busyId === review.id) || isRendering(review)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3.5 py-2.5 text-[13px] font-bold disabled:opacity-60"
                    style={{ color: ACCENT }}
                  >
                    {(pending && busyId === review.id) || isRendering(review) ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Clapperboard size={14} />
                    )}
                    {isRendering(review) ? "Rendering…" : "Render AI video"}
                  </button>
                </>
              )}
              {(review.image_url || review.video_url) && (
                <a
                  href={review.video_url || review.image_url || "#"}
                  target="_blank"
                  rel="noreferrer"
                  download
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3.5 py-2.5 text-[13px] font-semibold"
                >
                  <Download size={14} /> Download
                </a>
              )}
              <button
                onClick={() => del(review.id)}
                disabled={pending && busyId === review.id}
                className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-danger-soft)] px-3.5 py-2.5 text-[13px] font-semibold text-[var(--color-danger)] disabled:opacity-50"
              >
                <Trash2 size={14} /> {pending && busyId === review.id ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* One vertical reel tile in the outputs grid. */
function ReelTile({ c, onClick }: { c: Creative; onClick: () => void }) {
  const rendering = isRendering(c);
  const elapsed = useRenderElapsed(rendering, c.created_at);
  return (
    <button
      onClick={onClick}
      className="group relative aspect-[9/16] overflow-hidden rounded-xl bg-[#10151B] text-left"
    >
      {c.video_url ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={`${c.video_url}#t=0.1`}
          muted
          loop
          playsInline
          preload="metadata"
          onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
          onMouseLeave={(e) => {
            e.currentTarget.pause();
            e.currentTarget.currentTime = 0;
          }}
          className="h-full w-full object-cover"
        />
      ) : c.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={c.image_url} alt={c.hook_text} className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center p-3">
          <AdThumb src={null} name={c.hook_text} size={44} />
        </div>
      )}

      {/* Rendering "alive" overlay: diagonal sweep + pulsing brand glow */}
      {rendering && (
        <span className="de-render-sweep pointer-events-none absolute inset-0">
          <span className="absolute inset-x-0 bottom-0 h-1/3 animate-pulse bg-gradient-to-t from-[rgba(23,46,215,0.45)] to-transparent" />
        </span>
      )}

      {/* Top badges */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-1">
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-bold"
          style={{
            background: isCinematic(c) ? "rgba(23,46,215,0.85)" : "rgba(0,0,0,0.55)",
            color: "#fff",
          }}
        >
          {tierLabel(c)}
        </span>
        {rendering && (
          <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold tabular-nums" style={{ background: "rgba(23,46,215,0.85)", color: "#fff" }}>
            <Loader2 size={9} className="animate-spin" /> Rendering {fmtElapsed(elapsed)}
          </span>
        )}
        {c.video_status === "failed" && (
          <span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: "rgba(220,38,38,0.85)", color: "#fff" }}>
            Failed
          </span>
        )}
        {c.video_url && (
          <span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: "rgba(240,255,65,0.9)", color: "#10151B" }}>
            Video
          </span>
        )}
      </div>

      {/* Rendering shimmer */}
      {rendering && !c.image_url && (
        <div className="absolute inset-0 grid place-items-center">
          <Loader2 size={22} className="animate-spin text-white/70" />
        </div>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/85 via-black/10 to-transparent p-2.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        {c.video_url && (
          <span className="absolute left-1/2 top-1/2 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--color-publish)]">
            <Play size={18} className="text-white" fill="currentColor" />
          </span>
        )}
        <p className="line-clamp-2 text-[11.5px] font-bold leading-snug text-white">{c.hook_text}</p>
        <p className="mt-0.5 text-[10px] text-white/70">
          {c.video_provider ? providerLabel(c.video_provider) : c.brand_slug || "draft"}
        </p>
      </div>
    </button>
  );
}

/* Labelled copy block for the review modal. */
function CopyBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-muted)]">
        {label}
      </p>
      <p className="whitespace-pre-wrap rounded-xl bg-[var(--color-surface-2)] px-3.5 py-3 text-[13.5px] font-semibold leading-relaxed">
        {text}
      </p>
    </div>
  );
}
