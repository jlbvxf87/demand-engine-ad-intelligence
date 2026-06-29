import React from "react";
import { Composition } from "remotion";
import { DraftAd } from "./DraftAd";
import {
  DRAFT_COMPOSITION_ID,
  DRAFT_FPS,
  DRAFT_HEIGHT,
  DRAFT_WIDTH,
  type DraftRenderPlan,
} from "./types";

// Placeholder shown in the Remotion Studio preview; the real plan is passed as
// inputProps at render time and the duration is derived in calculateMetadata.
const defaultPlan: DraftRenderPlan = {
  format: "9:16",
  fps: DRAFT_FPS,
  durationInFrames: DRAFT_FPS * 4,
  estimatedCostCents: 2,
  scenes: [
    { role: "hook", duration: 2, text: "Sore after every lift?", motion: "push_in", renderMethod: "template_motion", estimatedCostCents: 1 },
    { role: "cta", duration: 2, text: "Try it today", motion: "push_in", renderMethod: "template_motion", estimatedCostCents: 1 },
  ],
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id={DRAFT_COMPOSITION_ID}
      component={DraftAd}
      width={DRAFT_WIDTH}
      height={DRAFT_HEIGHT}
      fps={DRAFT_FPS}
      durationInFrames={defaultPlan.durationInFrames}
      defaultProps={defaultPlan}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.round(props.durationInFrames)),
        fps: props.fps || DRAFT_FPS,
      })}
    />
  );
};
