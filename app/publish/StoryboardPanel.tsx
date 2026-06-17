"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, ImagePlus, Clapperboard } from "lucide-react";
import { Card } from "@/components/ui";
import { VIDEO_PROVIDERS, PROVIDER_DURATIONS, type VideoProvider } from "@/lib/video";
import { uploadReference, createStoryboard } from "@/app/actions";

const ACCENT = "var(--color-publish)";

export default function StoryboardPanel() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<VideoProvider>("seedance");
  const [duration, setDuration] = useState(5);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const durations = PROVIDER_DURATIONS[model];

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
    if (images.length < 2) return setNote("Add at least 2 images — one per scene");
    if (!prompt.trim()) return setNote("Add a story brief");
    setNote(null);
    startTransition(async () => {
      const r = await createStoryboard({
        imageUrls: images,
        prompt,
        provider: model,
        durationPerClip: duration,
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
        Add 2/4/6/8 reference frames (one per scene) + a story brief. Sonnet writes a master script,
        each scene renders as a clip, and they&apos;re stitched into one video.
      </p>

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
          className="grid h-20 w-20 place-items-center rounded-xl border border-dashed border-[var(--color-line)] text-[var(--color-ink-muted)] disabled:opacity-50"
        >
          {uploading ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
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
        <span className="text-[12px] text-[var(--color-ink-muted)]">
          {images.length || 0} scene{images.length === 1 ? "" : "s"}
          {images.length >= 2 ? ` · ~${images.length * duration}s total` : ""}
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
