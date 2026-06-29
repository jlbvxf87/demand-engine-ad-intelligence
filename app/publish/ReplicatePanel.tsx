"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { X, Sparkles, Loader2, ImagePlus } from "lucide-react";
import { Card } from "@/components/ui";
import { VIDEO_PROVIDERS, type VideoProvider } from "@/lib/video";
import { uploadReference, replicate } from "@/app/actions";

const ACCENT = "var(--color-publish)";

export default function ReplicatePanel() {
  const router = useRouter();
  const params = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);
  // Arriving from "Recreate"? Pre-load the winning ad's creative as the reference.
  const [images, setImages] = useState<string[]>(() => {
    const ref = params.get("ref");
    return ref ? [ref] : [];
  });
  const [prompt, setPrompt] = useState(() => params.get("prompt") || "");
  const [model, setModel] = useState<VideoProvider>("seedance");
  const [count, setCount] = useState(3);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  // Re-sync when a NEW recreate navigation lands while the panel is already mounted
  // (e.g. router.push("/publish?ref=...&prompt=...")). The lazy initializers above
  // only run on first mount, so without this the new ref/prompt would be ignored.
  // Keyed on the actual param values so unrelated re-renders don't clobber an
  // in-progress upload or what the user is typing.
  const ref = params.get("ref");
  const promptParam = params.get("prompt");
  useEffect(() => {
    if (ref) setImages([ref]);
    if (promptParam) setPrompt(promptParam);
  }, [ref, promptParam]);

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

  function generate() {
    if (!images.length) return setNote("Add a reference image first");
    if (!prompt.trim()) return setNote("Add an instruction prompt");
    setNote(null);
    startTransition(async () => {
      const r = await replicate({ referenceUrls: images, prompt, provider: model, count });
      if (!r.ok) {
        setNote(r.error || "Generation failed");
        return;
      }
      setPrompt("");
      setImages([]);
      router.refresh();
    });
  }

  return (
    <Card className="mb-5 p-4" accent={ACCENT}>
      <p className="text-[15px] font-bold">Cinematic — rebuild from reference</p>
      <p className="mb-3 text-[12.5px] text-[var(--color-ink-muted)]">
        Drop a creative you liked (an image, or a frame from a video), add instructions, and generate
        full AI-video variations. The premium tier — reach for it to upgrade a proven winner.
      </p>

      {/* Reference strip */}
      <div className="mb-3 flex flex-wrap gap-2">
        {images.map((url, i) => (
          <div
            key={url}
            className="relative h-20 w-20 overflow-hidden rounded-xl border border-[var(--color-line)]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="reference" className="h-full w-full object-cover" />
            {i === 0 && (
              <span className="absolute left-1 top-1 rounded bg-[var(--color-publish)] px-1 py-0.5 text-[8px] font-bold text-white">
                REF
              </span>
            )}
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
        placeholder="Instructions — e.g. 'Recreate this fridge-reveal with our vial and a $XX/mo overlay, same handheld UGC style'"
        className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 text-[13px] outline-none focus:border-[var(--color-publish)]"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-2.5 py-2 text-[13px] font-bold outline-none"
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n} video{n > 1 ? "s" : ""}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-[var(--color-ink-muted)]">Est. $3–10 each</span>
        <button
          onClick={generate}
          disabled={pending || uploading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[14px] font-bold text-white disabled:opacity-60"
          style={{ background: ACCENT }}
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          Render AI video
        </button>
      </div>

      {/* Model selection is an advanced concern — most users just pick a budget. */}
      <details className="mt-2.5">
        <summary className="cursor-pointer text-[12px] font-semibold text-[var(--color-ink-muted)]">
          Advanced — model
        </summary>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value as VideoProvider)}
          className="mt-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-2.5 py-2 text-[13px] font-bold outline-none"
        >
          {VIDEO_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </details>

      {note && (
        <p className="mt-2 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
          {note}
        </p>
      )}
    </Card>
  );
}
