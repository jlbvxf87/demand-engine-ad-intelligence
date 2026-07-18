"use client";

/**
 * SimpleCreate — the whole Create flow on ONE screen:
 *   1. Write a script, pick how many videos (scenes) it needs, pick a model, Generate.
 *   2. Every clip ever rendered shows in the grid below until deleted.
 *   3. Select finished clips to stitch into one video or download them.
 * (The old tabbed console lives on in PublishClient.tsx if it's ever needed again.)
 */

import { useState, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Play,
  Download,
  Clapperboard,
  Loader2,
  Trash2,
  Sparkles,
  X,
  Film,
  RefreshCw,
  ImagePlus,
  Timer,
  Mic,
  Video,
} from "lucide-react";
import { ScreenHeader, Badge, EmptyState } from "@/components/ui";
import { posterFor } from "@/lib/format";
import { withDownload } from "@/lib/download";
import { splitScriptVerbatim } from "@/lib/split-script";
import { fitDuration } from "@/lib/duration";
import { compressImage } from "@/lib/compress-image";
import { VIDEO_PROVIDERS, PROVIDER_DURATIONS, providerLabel, type VideoProvider } from "@/lib/video";
import {
  createStoryboard,
  renderVideo,
  pollVideoJobs,
  deleteCreative,
  deleteCreatives,
  deleteStoryboard,
  stitchClips,
  uploadReference,
} from "@/app/actions";
import type { Creative, Storyboard } from "@/lib/data";

const ACCENT = "var(--color-publish)";
const SCENE_CHOICES = [1, 2, 3, 4, 5, 6];

function isRendering(c: Creative) {
  return (
    c.video_status === "queued" ||
    c.video_status === "rendering" ||
    c.video_status === "compositing"
  );
}

function fmtElapsed(secs: number) {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** Seconds a clip has been rendering, anchored to the row's created_at. */
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

export default function SimpleCreate({
  creatives,
  storyboards,
}: {
  creatives: Creative[];
  storyboards: Storyboard[];
}) {
  const router = useRouter();
  const [script, setScript] = useState("");
  const [sceneCount, setSceneCount] = useState(1);
  const [model, setModel] = useState<VideoProvider>("kling");
  // "talking" = a person speaks each line aloud (talking head + voice).
  // "action"  = silent action footage of what each line describes — no person,
  //             no voice. This is the "just a video of action" path.
  const [voiceMode, setVoiceMode] = useState<"talking" | "action">("talking");
  const [duration, setDuration] = useState<"auto" | number>("auto");
  const [images, setImages] = useState<string[]>([]); // image N seeds video N (i2v)
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; caption?: string | null } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const anyRendering = creatives.some(isRendering);
  const anyStitching = storyboards.some((s) =>
    ["scripting", "generating", "stitching"].includes(s.status)
  );
  const finished = creatives.filter((c) => c.video_url && !isRendering(c));
  const stitched = storyboards.filter((s) => s.final_video_url);

  // Live preview of exactly what Generate will submit — no spend, no surprises.
  const plannedLines = script.trim() ? splitScriptVerbatim(script, sceneCount) : [];
  const plannedDurations = plannedLines.map((l) =>
    duration === "auto" ? fitDuration(l, PROVIDER_DURATIONS[model] ?? [10]) : duration
  );

  // Esc closes the fullscreen player.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // Poll KIE + refresh while anything is in flight.
  useEffect(() => {
    if (!anyRendering && !anyStitching) return;
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
  }, [anyRendering, anyStitching, router]);

  async function addImages(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setNote(null);
    const urls: string[] = [];
    for (const raw of Array.from(files)) {
      // Compress client-side: phone photos (2–15MB, often HEIC) blow past
      // Vercel's ~4.5MB body cap → bare "Bad Request". This resizes to ≤1600px
      // JPEG (~0.5MB) and normalizes HEIC, so uploads and KIE both accept it.
      const file = await compressImage(raw);
      const fd = new FormData();
      fd.append("file", file);
      const r = await uploadReference(fd);
      if (r.ok && r.url) urls.push(r.url);
      else setNote(`Image upload failed (${raw.name}): ${r.error || "unknown error"}`);
    }
    setUploading(false);
    if (urls.length) {
      setImages((prev) => {
        const next = [...prev, ...urls].slice(0, SCENE_CHOICES[SCENE_CHOICES.length - 1]);
        // Each image seeds one video — keep the count at least as big.
        setSceneCount((c) => Math.max(c, next.length));
        return next;
      });
    }
  }

  function removeImage(i: number) {
    setImages((prev) => prev.filter((_, idx) => idx !== i));
  }

  function generate() {
    const prompt = script.trim();
    if (!prompt) {
      setNote("Write a script first");
      return;
    }
    setNote(null);
    startTransition(async () => {
      // VERBATIM: split the script ourselves and pass exact lines — the backend
      // skips its AI rewrite entirely and the model speaks precisely these words.
      const lines = splitScriptVerbatim(prompt, sceneCount);
      const allowed = PROVIDER_DURATIONS[model] ?? [10];
      const talking = voiceMode === "talking";
      const r = await createStoryboard({
        prompt,
        provider: model,
        durationPerClip: duration === "auto" ? allowed[allowed.length - 1] : duration,
        // Image N seeds video N (image-to-video); scenes without an image are text-to-video.
        imageUrls: images,
        // Line i drives clip i — the mapping the user counts on: script A → video 1,
        // script B → video 2, and so on. splitScriptVerbatim preserves order.
        scenes: lines.map((voiceover) => ({
          voiceover,
          // Talking head speaks the line; Action renders the line as silent visuals.
          shot_type: talking ? ("talking_head" as const) : ("broll" as const),
          // Auto: size each clip to its own line — cheapest length that still
          // finishes the sentence. Fixed: same length for every clip.
          duration: duration === "auto" ? fitDuration(voiceover, allowed) : duration,
        })),
        sound: talking, // Action mode = silent (no voice / no talking head)
        autoStitch: false, // clips land individually in the grid; stitch by hand below
      });
      if (!r.ok) setNote(r.error || "Generation failed");
      else {
        setScript("");
        setImages([]);
        router.refresh();
      }
    });
  }

  function retry(id: string) {
    setBusyId(id);
    setNote(null);
    startTransition(async () => {
      const r = await renderVideo(id, model);
      setBusyId(null);
      if (!r.ok) setNote(r.error || "Render failed");
      else router.refresh();
    });
  }

  function delStory(id: string) {
    if (!confirm("Delete this stitched video permanently?")) return;
    setBusyId(id);
    setNote(null);
    startTransition(async () => {
      const r = await deleteStoryboard(id);
      setBusyId(null);
      if (!r.ok) setNote(r.error || "Delete failed");
      else router.refresh();
    });
  }

  function del(id: string) {
    if (!confirm("Delete this clip permanently? This can't be undone.")) return;
    setBusyId(id);
    setNote(null);
    startTransition(async () => {
      const r = await deleteCreative(id);
      setBusyId(null);
      if (!r.ok) setNote(r.error || "Delete failed");
      else {
        setSelected((s) => s.filter((x) => x !== id));
        router.refresh();
      }
    });
  }

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (
      !confirm(
        `Delete ${ids.length} selected clip${ids.length > 1 ? "s" : ""} permanently? This can't be undone.`
      )
    )
      return;
    setNote(null);
    startTransition(async () => {
      const r = await deleteCreatives(ids);
      if (!r.ok) setNote(r.error || "Delete failed");
      else {
        setSelected([]);
        router.refresh();
      }
    });
  }

  function stitchSelected() {
    const urls = selected
      .map((id) => finished.find((c) => c.id === id)?.video_url)
      .filter(Boolean) as string[];
    if (urls.length < 2) {
      setNote("Select at least 2 finished clips to stitch");
      return;
    }
    setNote(null);
    startTransition(async () => {
      const r = await stitchClips({ clipUrls: urls, title: "Stitched video" });
      if (!r.ok) setNote(r.error || "Stitch failed");
      else {
        setSelected([]);
        router.refresh();
      }
    });
  }

  function downloadSelected() {
    selected.forEach((id, i) => {
      const c = finished.find((x) => x.id === id);
      if (!c?.video_url) return;
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = withDownload(c.video_url as string, `clip-${i + 1}-${id.slice(0, 6)}.mp4`);
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 600); // stagger so the browser doesn't swallow downloads
    });
  }

  return (
    <div>
      <ScreenHeader
        title="Create"
        subtitle="Script → videos. Everything you render stays in the grid until you delete it."
        badge={creatives.length ? "ready" : "empty"}
        badgeTone={creatives.length ? "publish" : "neutral"}
      />

      {/* ── 1 · Script → videos ─────────────────────────────────────────── */}
      <div className="mb-5 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
        <textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={4}
          placeholder="Write your script — it's spoken word-for-word, no AI rewriting. Multiple videos? Separate scenes with blank lines (or sentences are split evenly across them)."
          className="w-full resize-y rounded-xl border border-[var(--color-line)] bg-transparent p-3 text-[14px] outline-none"
        />
        {/* Reference images — image N seeds video N (image-to-video). */}
        {images.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {images.map((url, i) => (
              <div key={url} className="relative">
                <div className="relative aspect-[9/16] w-16 overflow-hidden rounded-lg border border-[var(--color-line)] bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`Scene ${i + 1}`} className="h-full w-full object-cover" />
                  <span
                    className="absolute left-1 top-1 grid h-4 w-4 place-items-center rounded-full text-[9px] font-extrabold text-white"
                    style={{ background: ACCENT }}
                  >
                    {i + 1}
                  </span>
                  <button
                    onClick={() => removeImage(i)}
                    title="Remove image"
                    className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white"
                  >
                    <X size={9} />
                  </button>
                </div>
                <p className="mt-0.5 text-center text-[9.5px] font-bold text-[var(--color-ink-muted)]">
                  Video {i + 1}
                </p>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label
            className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-[var(--color-line)] px-3 py-2 text-[13px] font-semibold text-[var(--color-ink-muted)]"
            title="Upload images — image 1 seeds video 1, image 2 seeds video 2, and so on. Scenes without an image are generated from text alone."
          >
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
            {uploading ? "Uploading…" : images.length ? "Add image" : "Add images (i2v)"}
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                void addImages(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-[var(--color-line)] px-3 py-2 text-[13px]">
            <Clapperboard size={15} className="text-[var(--color-ink-muted)]" />
            <span className="font-semibold text-[var(--color-ink-muted)]">Videos</span>
            <select
              value={sceneCount}
              onChange={(e) => setSceneCount(Number(e.target.value))}
              className="bg-transparent text-[13px] font-bold outline-none"
            >
              {SCENE_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-[var(--color-line)] px-3 py-2 text-[13px]">
            <Film size={15} className="text-[var(--color-ink-muted)]" />
            <span className="font-semibold text-[var(--color-ink-muted)]">Model</span>
            <select
              value={model}
              onChange={(e) => {
                const next = e.target.value as VideoProvider;
                setModel(next);
                // Each model allows a different set of lengths — drop a fixed
                // value the new model can't honor back to Auto.
                setDuration((d) =>
                  d === "auto" || (PROVIDER_DURATIONS[next] ?? []).includes(d) ? d : "auto"
                );
              }}
              className="bg-transparent text-[13px] font-bold outline-none"
            >
              {VIDEO_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label
            className="flex items-center gap-2 rounded-xl border border-[var(--color-line)] px-3 py-2 text-[13px]"
            title="Talking head: a person speaks each line aloud (voice on). Action only: silent footage of what each line describes — no person, no voice."
          >
            {voiceMode === "talking" ? (
              <Mic size={15} className="text-[var(--color-ink-muted)]" />
            ) : (
              <Video size={15} className="text-[var(--color-ink-muted)]" />
            )}
            <span className="font-semibold text-[var(--color-ink-muted)]">Style</span>
            <select
              value={voiceMode}
              onChange={(e) => setVoiceMode(e.target.value as "talking" | "action")}
              className="bg-transparent text-[13px] font-bold outline-none"
            >
              <option value="talking">Talking head + voice</option>
              <option value="action">Action only (no voice)</option>
            </select>
          </label>
          <label
            className="flex items-center gap-2 rounded-xl border border-[var(--color-line)] px-3 py-2 text-[13px]"
            title="Auto sizes each clip to its own line — the cheapest length that still finishes the sentence."
          >
            <Timer size={15} className="text-[var(--color-ink-muted)]" />
            <span className="font-semibold text-[var(--color-ink-muted)]">Length</span>
            <select
              value={String(duration)}
              onChange={(e) =>
                setDuration(e.target.value === "auto" ? "auto" : Number(e.target.value))
              }
              className="bg-transparent text-[13px] font-bold outline-none"
            >
              <option value="auto">Auto-fit</option>
              {(PROVIDER_DURATIONS[model] ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}s
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={generate}
            disabled={pending || !script.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
            style={{ background: ACCENT }}
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            Generate {sceneCount} video{sceneCount > 1 ? "s" : ""}
          </button>
          {note && <span className="text-[12.5px] font-semibold text-[var(--color-danger)]">{note}</span>}
        </div>

        {/* What each clip will actually be, before spending anything. */}
        {plannedLines.length > 0 && (
          <p className="mt-2 text-[11.5px] text-[var(--color-ink-muted)]">
            {voiceMode === "action" ? "Action · silent → " : duration === "auto" ? "Auto-fit → " : "Fixed → "}
            {plannedLines
              .map((l, i) => `#${i + 1} ${plannedDurations[i]}s${images[i] ? " · i2v" : ""}`)
              .join(" · ")}
            {plannedLines.length !== sceneCount && (
              <span className="text-[var(--color-warn)]">
                {" "}
                (script only splits into {plannedLines.length})
              </span>
            )}
          </p>
        )}
      </div>

      {/* ── 2 · Selection bar ───────────────────────────────────────────── */}
      {selected.length > 0 && (
        <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5 shadow-sm">
          <span className="px-1 text-[12.5px] font-bold">{selected.length} selected</span>
          <button
            onClick={stitchSelected}
            disabled={pending || selected.length < 2}
            className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
            style={{ background: ACCENT }}
          >
            {pending ? <Loader2 size={13} className="animate-spin" /> : <Clapperboard size={13} />}
            Stitch into one
          </button>
          <button
            onClick={downloadSelected}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3 py-1.5 text-[12.5px] font-semibold"
          >
            <Download size={13} /> Download
          </button>
          <button
            onClick={deleteSelected}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--color-danger)] disabled:opacity-50"
          >
            {pending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            Delete
          </button>
          <button
            onClick={() => setSelected([])}
            className="inline-flex items-center gap-1 rounded-xl px-2 py-1.5 text-[12.5px] font-semibold text-[var(--color-ink-muted)]"
          >
            <X size={13} /> Clear
          </button>
        </div>
      )}

      {/* ── 3 · All clips ───────────────────────────────────────────────── */}
      {creatives.length === 0 ? (
        <EmptyState
          icon={Play}
          title="No clips yet"
          hint="Write a script above and hit Generate — your videos land here."
        />
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {creatives.map((c) => (
            <ClipTile
              key={c.id}
              c={c}
              selected={selected.includes(c.id)}
              busy={busyId === c.id}
              onOpen={() =>
                c.video_url && setLightbox({ url: c.video_url, caption: c.hook_text })
              }
              onToggle={() => toggle(c.id)}
              onRetry={() => retry(c.id)}
              onDelete={() => del(c.id)}
            />
          ))}
        </div>
      )}

      {/* ── 4 · Stitched videos ─────────────────────────────────────────── */}
      {(stitched.length > 0 || anyStitching) && (
        <div className="mt-6">
          <p className="mb-2 text-[15px] font-bold">Stitched videos</p>
          {anyStitching && (
            <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--color-ink-muted)]">
              <Loader2 size={13} className="animate-spin" /> Stitching in progress…
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {stitched.map((s) => (
              <div
                key={s.id}
                className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5"
              >
                <button
                  onClick={() => setLightbox({ url: s.final_video_url as string, caption: s.prompt })}
                  title="Click to play"
                  className="block"
                >
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    src={s.final_video_url as string}
                    poster={posterFor(s.final_video_url)}
                    playsInline
                    preload="metadata"
                    className="pointer-events-none max-h-[260px] w-auto rounded-xl bg-black"
                  />
                </button>
                <div className="mt-2 flex items-center gap-1.5">
                  <a
                    href={withDownload(s.final_video_url as string, `stitched-${s.id.slice(0, 6)}.mp4`)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3 py-1.5 text-[12.5px] font-semibold"
                  >
                    <Download size={13} /> Download
                  </a>
                  <button
                    onClick={() => delStory(s.id)}
                    disabled={busyId === s.id}
                    title="Delete stitched video"
                    className="grid h-8 w-8 place-items-center rounded-xl border border-[var(--color-line)] text-[var(--color-danger)] disabled:opacity-50"
                  >
                    {busyId === s.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Fullscreen player ───────────────────────────────────────────── */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative flex max-h-full flex-col items-center gap-2"
          >
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={lightbox.url}
              poster={posterFor(lightbox.url)}
              controls
              autoPlay
              playsInline
              className="max-h-[82vh] w-auto rounded-xl bg-black shadow-2xl"
            />
            {lightbox.caption && (
              <p className="max-w-[min(90vw,640px)] text-center text-[12.5px] text-white/80">
                {lightbox.caption}
              </p>
            )}
            <div className="flex items-center gap-2">
              <a
                href={withDownload(lightbox.url, "clip.mp4")}
                className="inline-flex items-center gap-1.5 rounded-xl bg-white/12 px-3 py-1.5 text-[12.5px] font-semibold text-white"
              >
                <Download size={13} /> Download
              </a>
              <button
                onClick={() => setLightbox(null)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-white/12 px-3 py-1.5 text-[12.5px] font-semibold text-white"
              >
                <X size={13} /> Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* One clip in the grid. */
function ClipTile({
  c,
  selected,
  busy,
  onOpen,
  onToggle,
  onRetry,
  onDelete,
}: {
  c: Creative;
  selected: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const rendering = isRendering(c);
  const elapsed = useRenderElapsed(rendering, c.created_at);
  const failed = !c.video_url && !rendering;

  return (
    <div
      className="relative overflow-hidden rounded-2xl border bg-[#10151B]"
      style={{
        borderColor: selected ? ACCENT : "var(--color-line)",
        outline: selected ? `2px solid ${ACCENT}` : "none",
        outlineOffset: "-1px",
      }}
    >
      <div className="relative aspect-[9/16] w-full">
        {c.video_url ? (
          // Click anywhere on the frame → fullscreen player. Hover silently
          // previews; the pointer leaves and it resets.
          <button onClick={onOpen} className="group block h-full w-full" title="Click to play">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={`${c.video_url}#t=0.1`}
              poster={posterFor(c.video_url)}
              muted
              playsInline
              preload="metadata"
              onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
              onMouseLeave={(e) => {
                e.currentTarget.pause();
                e.currentTarget.currentTime = 0;
              }}
              className="pointer-events-none h-full w-full object-cover"
            />
            <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-black/60 backdrop-blur-sm">
                <Play size={18} className="translate-x-[1px] fill-white text-white" />
              </span>
            </span>
          </button>
        ) : c.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.image_url} alt="" className="h-full w-full object-cover opacity-70" />
        ) : (
          <div className="h-full w-full bg-gradient-to-b from-[#10151B] to-[#0A1E4A]" />
        )}

        {/* Status badges */}
        <div className="absolute left-1.5 top-1.5 flex gap-1">
          <Badge tone={rendering ? "decode" : failed ? "danger" : "publish"}>
            {rendering
              ? `Rendering ${fmtElapsed(elapsed)}`
              : failed
                ? "No video"
                : providerLabel(c.video_provider || "") || "Video"}
          </Badge>
        </div>

        {rendering && (
          <div className="absolute inset-0 grid place-items-center bg-black/35">
            <Loader2 size={22} className="animate-spin text-white" />
          </div>
        )}
      </div>

      {/* Hook line + actions */}
      <div className="p-2">
        {c.hook_text && (
          <p className="mb-1.5 line-clamp-2 text-[11px] font-semibold text-white/90">{c.hook_text}</p>
        )}
        <div className="flex items-center gap-1.5">
          {c.video_url && (
            <>
              <button
                onClick={onToggle}
                className="flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold text-white"
                style={{ background: selected ? ACCENT : "rgba(255,255,255,0.12)" }}
              >
                {selected ? "Selected ✓" : "Select"}
              </button>
              <a
                href={withDownload(c.video_url, `clip-${c.id.slice(0, 6)}.mp4`)}
                title="Download"
                className="grid h-7 w-7 place-items-center rounded-lg bg-white/10 text-white"
              >
                <Download size={13} />
              </a>
            </>
          )}
          {failed && (
            <button
              onClick={onRetry}
              disabled={busy}
              title="Render this clip"
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-white/10 px-2 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              Render
            </button>
          )}
          <button
            onClick={onDelete}
            disabled={busy}
            title="Delete clip"
            className="grid h-7 w-7 place-items-center rounded-lg bg-white/10 text-[var(--color-danger)] disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}
