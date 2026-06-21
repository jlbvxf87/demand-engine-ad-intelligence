import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { VideoProvider } from "@/lib/video";

/* ──────────────────────────────────────────────────────────────────────────
   Multi-scene master script. Claude Sonnet writes ONE cohesive story across N
   clips (one per uploaded image); each scene is generated independently by Kie,
   so every scene_prompt must be fully standalone. Output is structured JSON
   (parsed below), NOT HTML — JSON is what reliably drives scene 1..N.
   ────────────────────────────────────────────────────────────────────────── */

export type MasterScene = {
  clip_index: number;
  scene_prompt: string; // full standalone i2v prompt for this scene's image
  scene_summary: string;
  voiceover_lines: string;
  duration: number;
  clip_role: string;
  // "talking_head" = a person speaks to camera (says the voiceover_lines aloud);
  // "broll" = supporting footage, no one speaking to camera. Drives how the clip
  // is rendered (talking-head framing vs plain visual).
  shot_type: "talking_head" | "broll";
};

const MAX_CHARS: Record<VideoProvider, number> = {
  kling: 1000,
  seedance: 2500,
  sora: 10000,
  veo: 5000,
};

const ARC: Record<number, string> = {
  2: "HOOK → PAYOFF",
  3: "HOOK → BRIDGE → PAYOFF",
  4: "HOOK → PROBLEM → SOLUTION → PAYOFF",
  6: "HOOK → PROBLEM → AGITATE → SOLUTION → PROOF → PAYOFF/CTA",
  8: "HOOK → PROBLEM → AGITATE → DISCOVERY → SOLUTION → PROOF → TRANSFORMATION → PAYOFF/CTA",
};

const SYSTEM = `You are an expert direct-response video creative director specializing in multi-clip advertising narratives. You write a MASTER SCRIPT that tells ONE cohesive story across multiple short video clips. Each clip is generated INDEPENDENTLY by an AI video model from a different reference image — the model sees ONLY one clip's prompt at a time and has NO memory of the others. So every scene_prompt must be a FULL, standalone video prompt (subject, action, camera, lighting, environment, emotional tone), never referencing "the previous clip". Keep one consistent character/look across scenes by restating identity details verbatim each time. UGC, authentic, scroll-stopping, conversion-driven. No on-screen text/logos, no medical procedures, no guaranteed-outcome or therapeutic claims.

For EACH scene set shot_type: use "talking_head" when a single person speaks DIRECTLY TO CAMERA and says that scene's voiceover_lines aloud (hooks, reactions, testimonials, CTAs) — write the scene_prompt as a person looking into the camera speaking; use "broll" for supporting footage where NO ONE speaks to camera (product close-ups, results, lifestyle, demonstrations) — write the scene_prompt as the visual only. Default the hook and the CTA to talking_head.

Respond with valid JSON only — no markdown, no code fences, no explanation.`;

function arcFor(n: number): string {
  return ARC[n] || `${n}-beat hook→...→payoff narrative`;
}

export async function buildMasterScript(
  prompt: string,
  provider: VideoProvider,
  clipCount: number,
  durationPerClip: number,
  exemplars = ""
): Promise<MasterScene[]> {
  const maxChars = MAX_CHARS[provider] ?? 2500;
  const user = `BRIEF: ${prompt}
${
  exemplars
    ? `\nSTUDY THESE PROVEN WINNERS from our ad library and model your script on their hook style, emotional triggers, pacing, and structure — ADAPT them to the brief; do NOT copy verbatim. The goal is output that matches or beats these:\n${exemplars}\n`
    : ""
}
Write a master script of EXACTLY ${clipCount} scenes, one per clip, following this arc: ${arcFor(clipCount)}.
Each scene is ~${durationPerClip}s. Each scene_prompt must be a complete standalone prompt, max ${maxChars} characters.

Return ONLY this JSON:
{
  "title": "string",
  "scenes": [
    {
      "clip_index": 0,
      "scene_prompt": "full standalone video prompt for this scene",
      "scene_summary": "one line",
      "voiceover_lines": "2-3 sentences at ~2.5 words/sec",
      "duration": ${durationPerClip},
      "clip_role": "hook|problem|agitate|solution|proof|payoff|cta",
      "shot_type": "talking_head | broll"
    }
  ]
}`;

  const anthropic = new Anthropic();
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  const raw = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "{}";
  let parsed: { scenes?: Partial<MasterScene>[] } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  }

  const scenes: MasterScene[] = (parsed.scenes || []).slice(0, clipCount).map((s, i) => ({
    clip_index: i,
    scene_prompt: String(s.scene_prompt || prompt).slice(0, maxChars),
    scene_summary: String(s.scene_summary || `Scene ${i + 1}`),
    voiceover_lines: String(s.voiceover_lines || ""),
    duration: Number(s.duration) || durationPerClip,
    clip_role: String(s.clip_role || (i === 0 ? "hook" : "scene")),
    shot_type: s.shot_type === "broll" ? "broll" : "talking_head",
  }));

  // Pad if the model under-delivered, so we always get clipCount scenes.
  while (scenes.length < clipCount) {
    const i = scenes.length;
    scenes.push({
      clip_index: i,
      scene_prompt: prompt.slice(0, maxChars),
      scene_summary: `Scene ${i + 1}`,
      voiceover_lines: "",
      duration: durationPerClip,
      clip_role: "scene",
      shot_type: "talking_head",
    });
  }

  return scenes;
}
