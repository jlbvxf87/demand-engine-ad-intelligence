import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { Scene } from "./Scene";
import { DRAFT_FPS, type DraftRenderPlan } from "./types";

/** Lays each plan scene end-to-end as its own Sequence. */
export const DraftAd: React.FC<DraftRenderPlan> = ({ scenes, fps }) => {
  const f = fps || DRAFT_FPS;
  let from = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#10151B" }}>
      {scenes.map((s, i) => {
        const dur = Math.max(1, Math.round(s.duration * f));
        const node = (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <Scene scene={s} durationInFrames={dur} />
          </Sequence>
        );
        from += dur;
        return node;
      })}
    </AbsoluteFill>
  );
};
