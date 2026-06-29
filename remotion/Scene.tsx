import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, interpolate, useCurrentFrame } from "remotion";
import type { DraftScene } from "./types";

// Brand palette (global CLAUDE.md): ink #10151B, blue #172ED7, yellow #F0FF41.
const INK = "#10151B";
const ACCENT = "#172ED7";
const HILITE = "#F0FF41";

const FONT = "Helvetica, Arial, sans-serif";

/** One full-screen 9:16 scene: optional Ken-Burns image + animated caption. */
export const Scene: React.FC<{ scene: DraftScene; durationInFrames: number }> = ({
  scene,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  // An ai_motion scene whose KIE clip has landed plays the clip as its backdrop.
  const hasClip = scene.renderMethod === "ai_motion" && Boolean(scene.aiClipUrl);
  const hasImage = !hasClip && Boolean(scene.image);
  const hasMedia = hasClip || hasImage;
  const isCta = scene.role === "cta";
  const isHook = scene.role === "hook";

  // Cross-dissolve: fade in over 8f, hold, fade out over the last 8f.
  const fade = interpolate(
    frame,
    [0, 8, Math.max(9, durationInFrames - 8), durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Caption entrance: slide up + fade.
  const enter = interpolate(frame, [4, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const translateY = interpolate(enter, [0, 1], [44, 0]);

  // Image motion.
  const p = durationInFrames > 1 ? frame / durationInFrames : 0;
  let imgScale = 1;
  let imgX = 0;
  let imgY = 0;
  switch (scene.motion) {
    case "push_in":
      imgScale = interpolate(p, [0, 1], [1.0, 1.12]);
      break;
    case "zoom":
      imgScale = interpolate(p, [0, 1], [1.12, 1.0]);
      break;
    case "pan":
      imgScale = 1.1;
      imgX = interpolate(p, [0, 1], [-40, 40]);
      break;
    case "product_float":
      imgScale = 1.06;
      imgY = Math.sin(p * Math.PI * 2) * 18;
      break;
  }

  return (
    <AbsoluteFill style={{ opacity: fade }}>
      {/* Background */}
      <AbsoluteFill
        style={{ background: `radial-gradient(circle at 50% 32%, #1b2330 0%, ${INK} 68%, #000 100%)` }}
      />

      {/* AI clip layer (ai_motion scenes) — the KIE clip plays full-bleed. */}
      {hasClip ? (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <OffthreadVideo
            src={scene.aiClipUrl as string}
            muted
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
          <AbsoluteFill
            style={{ background: "linear-gradient(to top, rgba(0,0,0,0.82) 16%, rgba(0,0,0,0) 56%)" }}
          />
        </AbsoluteFill>
      ) : hasImage ? (
        /* Image layer (cover, with motion) */
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <Img
            src={scene.image as string}
            onError={() => {}}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `scale(${imgScale}) translate(${imgX}px, ${imgY}px)`,
            }}
          />
          <AbsoluteFill
            style={{ background: "linear-gradient(to top, rgba(0,0,0,0.82) 16%, rgba(0,0,0,0) 56%)" }}
          />
        </AbsoluteFill>
      ) : null}

      {/* Caption */}
      <AbsoluteFill
        style={{
          justifyContent: hasMedia ? "flex-end" : "center",
          alignItems: "center",
          padding: hasMedia ? "0 88px 230px" : "0 88px",
          textAlign: "center",
        }}
      >
        <div style={{ transform: `translateY(${translateY}px)`, opacity: enter, width: "100%" }}>
          {isCta ? (
            <div
              style={{
                display: "inline-block",
                background: ACCENT,
                color: "#fff",
                fontFamily: FONT,
                fontWeight: 800,
                fontSize: 62,
                padding: "30px 72px",
                borderRadius: 26,
                boxShadow: "0 12px 44px rgba(23,46,215,0.55)",
              }}
            >
              {scene.text}
            </div>
          ) : (
            <div
              style={{
                fontFamily: FONT,
                color: isHook ? HILITE : "#fff",
                fontWeight: 800,
                lineHeight: 1.08,
                fontSize: scene.text.length > 40 ? 76 : 94,
                textShadow: "0 4px 24px rgba(0,0,0,0.65)",
              }}
            >
              {scene.text}
            </div>
          )}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
