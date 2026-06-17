"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Play,
  Download,
  Upload,
  FolderInput,
  RotateCcw,
  Lock,
  Clapperboard,
  Loader2,
  CheckCircle2,
  Film,
} from "lucide-react";
import { ScreenHeader, Card, Badge, EmptyState, Modal, Stat, Tabs } from "@/components/ui";
import AdThumb from "@/components/AdThumb";
import { verticalLabel } from "@/lib/format";
import { VIDEO_PROVIDERS, providerLabel, type VideoProvider } from "@/lib/video";
import { renderVideo, pollVideoJobs } from "@/app/actions";
import ReplicatePanel from "./ReplicatePanel";
import StoryboardPanel from "./StoryboardPanel";
import type { Creative, Storyboard } from "@/lib/data";

const ACCENT = "var(--color-publish)";

const TARGETS = [
  { id: "meta", label: "Meta Ads Direct", icon: Upload },
  { id: "export", label: "Manual Ad Account Export", icon: FolderInput },
  { id: "download", label: "Download Files", icon: Download },
];

function isRendering(c: Creative) {
  return c.video_status === "queued" || c.video_status === "rendering";
}

export default function PublishClient({
  creatives,
  storyboards,
}: {
  creatives: Creative[];
  storyboards: Storyboard[];
}) {
  const router = useRouter();
  const [target, setTarget] = useState("meta");
  const [model, setModel] = useState<VideoProvider>("seedance");
  const [review, setReview] = useState<Creative | null>(null);
  const [mode, setMode] = useState("replicate");
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const anyRendering = creatives.some(isRendering);
  const stills = creatives.filter((c) => !c.video_url && !isRendering(c));
  const anyStoryboardActive = storyboards.some((s) =>
    ["scripting", "generating", "stitching"].includes(s.status)
  );
  const polling = anyRendering || anyStoryboardActive;

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

  function render(id: string, provider: VideoProvider) {
    setBusyId(id);
    setNote(null);
    startTransition(async () => {
      const r = await renderVideo(id, provider);
      setBusyId(null);
      if (!r.ok) setNote(r.error || "Render failed");
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

  return (
    <div>
      <ScreenHeader
        title="Publish"
        subtitle="Generated creatives — render to video, review, publish."
        badge={creatives.length ? "ready" : "empty"}
        badgeTone={creatives.length ? "publish" : "neutral"}
      />

      {/* Create: replicate a single clip, or build a multi-scene story */}
      <div className="mb-4">
        <Tabs
          accent={ACCENT}
          active={mode}
          onChange={setMode}
          tabs={[
            { id: "replicate", label: "Replicate" },
            { id: "story", label: "Multi-scene" },
          ]}
        />
      </div>
      {mode === "replicate" ? <ReplicatePanel /> : <StoryboardPanel />}

      {/* Stories — multi-scene, with the stitched final */}
      {storyboards.length > 0 && (
        <div className="mb-5">
          <p className="mb-2 text-[15px] font-bold">Stories</p>
          <div className="flex flex-col gap-3">
            {storyboards.map((s) => (
              <Card key={s.id} className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="line-clamp-1 text-[13.5px] font-bold">{s.prompt}</p>
                    <p className="text-[11.5px] text-[var(--color-ink-muted)]">
                      {s.clip_count} scenes · {providerLabel(s.provider)}
                    </p>
                  </div>
                  <StoryStatus s={s} />
                </div>
                {s.final_video_url && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-3">
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video
                      src={s.final_video_url}
                      controls
                      playsInline
                      className="max-h-[280px] w-auto rounded-xl bg-black"
                    />
                    <a
                      href={s.final_video_url}
                      target="_blank"
                      rel="noreferrer"
                      download
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3 py-2 text-[12.5px] font-semibold"
                    >
                      <Download size={14} /> Download story
                    </a>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Model picker + render-all */}
      {creatives.length > 0 && (
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
          {stills.length > 0 && (
            <button
              onClick={renderAll}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-bold text-white disabled:opacity-50"
              style={{ background: ACCENT }}
            >
              {pending ? <Loader2 size={14} className="animate-spin" /> : <Clapperboard size={14} />}
              Render {stills.length} still{stills.length > 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}

      {/* Reel grid */}
      {creatives.length === 0 ? (
        <EmptyState
          icon={Play}
          title="Nothing to publish yet"
          hint="Generate creatives in Rebuild, then they queue here."
        />
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {creatives.map((c) => (
            <ReelTile key={c.id} c={c} onClick={() => setReview(c)} />
          ))}
        </div>
      )}

      {note && (
        <p className="mt-3 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
          {note}
        </p>
      )}

      {/* Publish targets */}
      <p className="mb-2 mt-7 text-[15px] font-bold">Publish To</p>
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
          Connect the Meta Marketing API to stream live CTR, CPC, spend & leads.
        </div>
      </Card>

      {/* Winner loop */}
      <Card className="mt-4 p-4">
        <p className="text-[14px] font-bold text-[var(--color-publish)]">Winner Loop</p>
        <p className="mt-0.5 text-[12.5px] text-[var(--color-ink-muted)]">
          Top performers re-enter Source as new reference material.
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
        disabled={creatives.length === 0}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-4 text-[16px] font-bold text-white disabled:opacity-40 active:scale-[0.99]"
        style={{ background: ACCENT }}
      >
        <Play size={18} /> Publish {creatives.length || ""} Creatives
      </button>

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
                    className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2.5 text-[13px] font-bold text-white disabled:opacity-60"
                    style={{ background: ACCENT }}
                  >
                    {(pending && busyId === review.id) || isRendering(review) ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Clapperboard size={14} />
                    )}
                    {isRendering(review) ? "Rendering…" : "Render video"}
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
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* One vertical reel tile in the Studio grid. */
function ReelTile({ c, onClick }: { c: Creative; onClick: () => void }) {
  const rendering = isRendering(c);
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

      {/* Top badges */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-1">
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-bold"
          style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
        >
          {(c.video_provider && providerLabel(c.video_provider)) ||
            (c.video_url ? "Video" : "Still")}
        </span>
        {rendering && (
          <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: "rgba(23,46,215,0.85)", color: "#fff" }}>
            <Loader2 size={9} className="animate-spin" /> Rendering
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

/* Status pill for a storyboard row. */
function StoryStatus({ s }: { s: Storyboard }) {
  if (s.final_video_url) return <Badge tone="publish">Story ready</Badge>;
  if (s.status === "stitching") return <Badge tone="decode">Stitching…</Badge>;
  if (s.status === "failed" || s.final_status === "failed") return <Badge tone="danger">Failed</Badge>;
  if (s.status === "scripting") return <Badge tone="warn">Scripting…</Badge>;
  return <Badge tone="decode">Rendering scenes…</Badge>;
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
