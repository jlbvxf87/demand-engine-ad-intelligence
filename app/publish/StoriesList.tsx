"use client";

import { Download } from "lucide-react";
import { Card, Badge } from "@/components/ui";
import { providerLabel } from "@/lib/video";
import type { Storyboard } from "@/lib/data";

const ACCENT = "var(--color-publish)";

/** Multi-scene stories with their stitched finals (Stories tab). */
export default function StoriesList({ storyboards }: { storyboards: Storyboard[] }) {
  if (storyboards.length === 0) return null;
  return (
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
                {!isStoryFinished(s) && (
                  <div className="mt-1.5 max-w-[210px]">
                    <p className="text-[10.5px] font-bold tabular-nums text-[var(--color-ink-muted)]">
                      {s.scenesReady} of {s.clip_count} scenes ready
                    </p>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{
                          width: `${Math.round((s.scenesReady / Math.max(1, s.clip_count)) * 100)}%`,
                          background: ACCENT,
                        }}
                      />
                    </div>
                  </div>
                )}
                {isStoryFinished(s) && s.scenesReady < s.clip_count && (
                  <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-[var(--color-warn-soft)] px-1.5 py-0.5 text-[10.5px] font-bold text-[var(--color-warn)]">
                    ⚠ {s.scenesReady} of {s.clip_count} scenes rendered ({s.clip_count - s.scenesReady} failed)
                  </span>
                )}
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
  );
}

/* A story is "finished" once it's done rendering/stitching — i.e. it has a
   stitched final OR is no longer actively scripting/generating/stitching. */
function isStoryFinished(s: Storyboard) {
  if (s.final_video_url) return true;
  return !["scripting", "generating", "stitching"].includes(s.status);
}

/* Status pill for a storyboard row. */
function StoryStatus({ s }: { s: Storyboard }) {
  if (s.final_video_url) return <Badge tone="publish">Story ready</Badge>;
  if (s.status === "stitching") return <Badge tone="decode">Stitching…</Badge>;
  if (s.status === "failed" || s.final_status === "failed") return <Badge tone="danger">Failed</Badge>;
  if (s.status === "scripting") return <Badge tone="warn">Scripting…</Badge>;
  return <Badge tone="decode">Rendering scenes…</Badge>;
}
