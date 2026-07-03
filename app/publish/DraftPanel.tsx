"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Zap, Loader2, ImagePlus, X, Sparkles, RotateCcw } from "lucide-react";
import { Card } from "@/components/ui";
import { uploadReference, buildDraftRecipe, renderDraftFromPlan } from "@/app/actions";
import { compressImage } from "@/lib/compress-image";
import SceneRecipe from "./SceneRecipe";
import type { DraftRenderPlan } from "@/remotion/types";

const ACCENT = "var(--color-publish)";

/** Video ▸ Draft/Motion: brief (+ optional image) → editable scene recipe → render.
 *  In the Motion tier, scenes can be flipped to AI Motion (per-scene KIE clips). */
export default function DraftPanel({ tier = "draft" }: { tier?: "draft" | "motion" }) {
  const router = useRouter();
  const isMotion = tier === "motion";
  const fileRef = useRef<HTMLInputElement>(null);
  const [brief, setBrief] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [plan, setPlan] = useState<DraftRenderPlan | null>(null);
  const [uploading, setUploading] = useState(false);
  const [building, startBuild] = useTransition();
  const [rendering, startRender] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  // Pick up a brief handed over from Decode / Copy.
  useEffect(() => {
    try {
      const s = sessionStorage.getItem("brief:scratch");
      if (s) setBrief(s);
    } catch {}
  }, []);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setUploading(true);
    setNote(null);
    const file = await compressImage(picked);
    const fd = new FormData();
    fd.append("file", file);
    const r = await uploadReference(fd);
    if (r.ok && r.url) setImage(r.url);
    else setNote(r.error || "Upload failed");
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function build() {
    if (!brief.trim()) {
      setNote("Write a brief first");
      return;
    }
    setNote(null);
    startBuild(async () => {
      const r = await buildDraftRecipe({ brief, image });
      if (!r.ok) {
        setNote(r.error || "Failed to build recipe");
        return;
      }
      setPlan(r.data as DraftRenderPlan);
    });
  }

  function generate() {
    if (!plan) return;
    setNote(null);
    startRender(async () => {
      const r = await renderDraftFromPlan(plan);
      if (!r.ok) {
        setNote(r.error || "Draft render failed");
        return;
      }
      try {
        sessionStorage.removeItem("brief:scratch");
      } catch {}
      setPlan(null);
      setBrief("");
      setImage(null);
      router.refresh();
    });
  }

  return (
    <>
      <Card className="mb-4 p-4" accent={ACCENT}>
        <p className="text-[15px] font-bold">
          {isMotion ? "Motion video — templates + AI on key scenes" : "Draft video — render for cents"}
        </p>
        <p className="mb-3 text-[12.5px] text-[var(--color-ink-muted)]">
          {isMotion
            ? "Build the recipe, then flip your highest-impact scenes to AI Motion. AI scenes render in the background and composite into one video."
            : "Brief (or arrive from Decode/Copy) + an optional product image → a scene recipe you can edit, then a 9:16 draft. No AI-video credits."}
        </p>

        {/* Optional product image */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {image ? (
            <div className="relative h-16 w-16 sm:h-20 sm:w-20 overflow-hidden rounded-xl border border-[var(--color-line)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt="product" className="h-full w-full object-cover" />
              <button
                onClick={() => setImage(null)}
                className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/60 text-white"
              >
                <X size={10} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="grid h-16 w-16 sm:h-20 sm:w-20 place-items-center gap-1 rounded-xl border border-dashed border-[var(--color-line)] text-[var(--color-ink-muted)] disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <>
                  <ImagePlus size={18} />
                  <span className="text-[9px] font-semibold leading-tight">Product<br />(optional)</span>
                </>
              )}
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />
        </div>

        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={4}
          placeholder="Brief — angle, promise, audience, tone, offer…"
          className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 text-[13px] outline-none focus:border-[var(--color-publish)]"
        />

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={build}
            disabled={building || uploading}
            className="ml-auto inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[14px] font-bold text-white disabled:opacity-60"
            style={{ background: ACCENT }}
          >
            {building ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {plan ? "Rebuild recipe" : "Build recipe"}
          </button>
        </div>

        {note && (
          <p className="mt-2 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
            {note}
          </p>
        )}
      </Card>

      {/* Step 2: the editable recipe + render */}
      {plan && (
        <>
          <SceneRecipe plan={plan} onChange={setPlan} aiEnabled={isMotion} />
          <div className="mb-5 flex items-center gap-2">
            <button
              onClick={() => {
                setPlan(null);
                setNote(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3.5 py-2.5 text-[13px] font-semibold"
            >
              <RotateCcw size={14} /> Start over
            </button>
            <button
              onClick={generate}
              disabled={rendering}
              className="ml-auto inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[14px] font-bold text-white disabled:opacity-60"
              style={{ background: ACCENT }}
            >
              {rendering ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
              Generate Draft Video
            </button>
          </div>
        </>
      )}
    </>
  );
}
