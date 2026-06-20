"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, ImagePlus, Clapperboard } from "lucide-react";
import { Card } from "@/components/ui";
import { VIDEO_PROVIDERS, PROVIDER_DURATIONS, VOICES, DEFAULT_VOICE, type VideoProvider } from "@/lib/video";
import { uploadReference, createStoryboard } from "@/app/actions";

const ACCENT = "var(--color-publish)";

export default function StoryboardPanel() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<VideoProvider>("kling");
  const [duration, setDuration] = useState(5);
  const [sceneCount, setSceneCount] = useState(4);
  const [spokesperson, setSpokesperson] = useState(false);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const durations = PROVIDER_DURATIONS[model];
  // Reference frames (if added) drive the scene count; otherwise use the picker.
  // In spokesperson mode one face is reused, so the picker always drives count.
  const usingImages = images.length >= 2;
  const scenes = spokesperson ? sceneCount : usingImages ? images.length : sceneCount;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    setNote(null);
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f);
      const r = await uploadReference(fd);
      if (r.ok && r.url) setImages((prev) => [...prev, r.url as string]);
      else setNote(r.error || "Upload failed");
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function setModelSafe(m: VideoProvider) {
    setModel(m);
    if (!PROVIDER_DURATIONS[m].includes(duration)) setDuration(PROVIDER_DURATIONS[m][0]);
  }

  function generate() {
    if (!prompt.trim()) return setNote("Add a story brief");
    if (spokesperson) {
      if (images.length < 1)
        return setNote("Spokesperson needs a reference face — add at least one frame of the person.");
    } else if (images.length === 1) {
      return setNote("Add a 2nd frame (one per scene), or remove it to generate scenes from your brief.");
    }
    setNote(null);
    startTransition(async () => {
      const r = await createStoryboard({
        imageUrls: spokesperson ? images : usingImages ? images : [],
        sceneCount: spokesperson ? sceneCount : usingImages ? undefined : sceneCount,
        prompt,
        provider: model,
        durationPerClip: duration,
        spokesperson,
        voice: spokesperson ? voice : undefined,
      });
      if (!r.ok) {
        setNote(r.error || "Storyboard failed");
        return;
      }
      setImages([]);
      setPrompt("");
      router.refresh();
    });
  }

  return (
    <Card className="mb-5 p-4" accent={ACCENT}>
      <p className="text-[15px] font-bold">Multi-scene story</p>
      <p className="mb-3 text-[12.5px] text-[var(--color-ink-muted)]">
        Pick how many scenes + write a story brief → Sonnet writes a master script, each scene renders
        as a clip, and they&apos;re stitched into one video. Optionally drop a reference frame per scene
        to lock the look.
      </p>

      {/* Spokesperson toggle + voice picker */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setSpokesperson((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border px-3 py-1.5 text-[12.5px] font-bold"
          style={
            spokesperson
              ? { background: ACCENT, color: "white", borderColor: ACCENT }
              : { borderColor: "var(--color-line)", color: "var(--color-ink-muted)" }
          }
        >
          🎤 {spokesperson ? "Spokesperson on" : "Spokesperson"}
        </button>
        {spokesperson && (
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            title="Voice that reads your script"
            className="rounded-[var(--radius-pill)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] font-bold outline-none"
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        )}
        {spokesperson && (
          <span className="w-full text-[11px] text-[var(--color-ink-muted)]">
            Each scene = your reference person speaking that scene&apos;s line (lip-synced). Add one clear
            face below; the chosen voice reads the script.
          </span>
        )}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {images.map((url, i) => (
          <div
            key={url}
            className="relative h-20 w-20 overflow-hidden rounded-xl border border-[var(--color-line)]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={`scene ${i + 1}`} className="h-full w-full object-cover" />
            <span className="absolute left-1 top-1 rounded bg-[var(--color-publish)] px-1 py-0.5 text-[8px] font-bold text-white">
              {i + 1}
            </span>
            <button
              onClick={() => setImages(images.filter((u) => u !== url))}
              className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/60 text-white"
            >
              <X size={10} />
            </button>
          </div>
        ))}
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="grid h-20 w-20 place-items-center gap-1 rounded-xl border border-dashed border-[var(--color-line)] text-[var(--color-ink-muted)] disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <>
              <ImagePlus size={18} />
              <span className="text-[9px] font-semibold leading-tight">
                {spokesperson ? <>Add face<br />(required)</> : <>Add frames<br />(optional)</>}
              </span>
            </>
          )}
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPick} />
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="Story brief — e.g. 'A woman's GLP-1 journey: skeptical → trying it → confident transformation, UGC handheld style'"
        className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 text-[13px] outline-none focus:border-[var(--color-publish)]"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={model}
          onChange={(e) => setModelSafe(e.target.value as VideoProvider)}
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-2.5 py-2 text-[13px] font-bold outline-none"
        >
          {VIDEO_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-2.5 py-2 text-[13px] font-bold outline-none"
        >
          {durations.map((d) => (
            <option key={d} value={d}>
              {d}s / scene
            </option>
          ))}
        </select>
        <select
          value={usingImages ? images.length : sceneCount}
          onChange={(e) => setSceneCount(Number(e.target.value))}
          disabled={usingImages}
          title={usingImages ? "Scene count = your uploaded frames" : "How many scenes to generate"}
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-2.5 py-2 text-[13px] font-bold outline-none disabled:opacity-60"
        >
          {[2, 3, 4, 5, 6, 8].map((n) => (
            <option key={n} value={n}>
              {n} scenes
            </option>
          ))}
        </select>
        <span className="text-[12px] text-[var(--color-ink-muted)]">
          ~{scenes * duration}s total{usingImages ? " · from frames" : " · from brief"}
        </span>
        <button
          onClick={generate}
          disabled={pending || uploading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[14px] font-bold text-white disabled:opacity-60"
          style={{ background: ACCENT }}
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Clapperboard size={15} />}
          Generate story
        </button>
      </div>

      {note && (
        <p className="mt-2 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
          {note}
        </p>
      )}
    </Card>
  );
}
