"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, Download, Share2, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui";
import { providerLabel } from "@/lib/video";
import { deleteCreative } from "@/app/actions";

export type HomeVideo = {
  id: string;
  video_url: string | null;
  video_provider: string | null;
  hook_text: string;
};

function ShareButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  async function share() {
    try {
      if (navigator.share) await navigator.share({ url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {}
  }
  return (
    <button
      onClick={share}
      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3.5 py-2.5 text-[13px] font-semibold"
    >
      <Share2 size={14} /> {copied ? "Copied" : "Share"}
    </button>
  );
}

export default function LatestVideos({ videos }: { videos: HomeVideo[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<HomeVideo | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [deleting, startDelete] = useTransition();
  const playable = videos.filter((v) => !!v.video_url && !removed.has(v.id));

  function onDelete(v: HomeVideo) {
    if (!confirm("Delete this video permanently? This can't be undone.")) return;
    startDelete(async () => {
      const r = await deleteCreative(v.id);
      if (r.ok) {
        setRemoved((s) => new Set(s).add(v.id));
        setOpen(null);
        router.refresh(); // re-sync server data + Home stats
      } else {
        alert(r.error || "Delete failed");
      }
    });
  }

  if (playable.length === 0) return null;

  return (
    <>
      <div className="no-scrollbar -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
        {playable.map((v) => (
          <button key={v.id} onClick={() => setOpen(v)} className="shrink-0">
            <div className="relative aspect-[9/16] w-28 overflow-hidden rounded-xl bg-[#10151B]">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                src={`${v.video_url}#t=0.1`}
                muted
                playsInline
                preload="metadata"
                className="h-full w-full object-cover"
              />
              <span className="absolute inset-0 grid place-items-center bg-black/25">
                <Play size={20} className="text-white" fill="currentColor" />
              </span>
              <span className="absolute inset-x-1 bottom-1 truncate rounded bg-black/55 px-1 py-0.5 text-[9px] font-bold text-white">
                {providerLabel(v.video_provider)}
              </span>
            </div>
          </button>
        ))}
      </div>

      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        accent="var(--color-publish)"
        title={<span className="truncate">{open ? providerLabel(open.video_provider) : "Video"}</span>}
      >
        {open && (
          <div className="flex flex-col gap-3">
            <div className="mx-auto w-full max-w-[320px] overflow-hidden rounded-2xl bg-black">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                src={open.video_url || ""}
                controls
                autoPlay
                loop
                playsInline
                className="aspect-[9/16] w-full bg-black object-contain"
              />
            </div>
            {open.hook_text && (
              <p className="text-[13.5px] font-semibold leading-snug">{open.hook_text}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <a
                href={open.video_url || "#"}
                download
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3.5 py-2.5 text-[13px] font-semibold"
              >
                <Download size={14} /> Download
              </a>
              {open.video_url && <ShareButton url={open.video_url} />}
              <button
                onClick={() => onDelete(open)}
                disabled={deleting}
                className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-danger-soft)] px-3.5 py-2.5 text-[13px] font-semibold text-[var(--color-danger)] disabled:opacity-50"
              >
                <Trash2 size={14} /> {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
