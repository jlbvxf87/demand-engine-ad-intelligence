import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin-auth";
import { isMachineAuthed } from "@/lib/machine-auth";
import { getServiceClient } from "@/lib/supabase/server";
import { buildDraftPlan, type DraftRenderPlan } from "@/lib/draft-plan";
import { renderDraftVideo, draftWorkerConfigured, dispatchToWorker } from "@/lib/draft-render";
import { uploadLocalVideo } from "@/lib/persist";
import { submitKieVideo, isVideoProvider } from "@/lib/kie";
import { PROVIDER_DURATIONS, type VideoProvider } from "@/lib/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Remotion bundle + headless render can take a while; give it room. (On Vercel
// serverless this may still exceed limits — the failure path below handles that.)
export const maxDuration = 300;

// Default KIE model for AI-motion scenes — the cheapest talking-head option.
const MOTION_PROVIDER: VideoProvider = "seedance";

type Body = { creativeId?: string; brief?: string; image?: string; plan?: DraftRenderPlan };

/** Make the two live template methods render differently: still_zoom → a zoom. */
function normalizeMotion(plan: DraftRenderPlan): DraftRenderPlan {
  return {
    ...plan,
    scenes: plan.scenes.map((s) =>
      s.renderMethod === "still_zoom" ? { ...s, motion: "zoom" as const } : s,
    ),
  };
}

function hasAiMotion(plan: DraftRenderPlan): boolean {
  return Array.isArray(plan.scenes) && plan.scenes.some((s) => s.renderMethod === "ai_motion");
}

/** Smallest allowed clip duration >= want for a provider (else its max). */
function clampDuration(provider: VideoProvider, want: number): number {
  const allowed = PROVIDER_DURATIONS[provider];
  return allowed.find((d) => d >= want) ?? allowed[allowed.length - 1];
}

/**
 * Cheap "Draft" / hybrid "Motion" render. Never calls KIE for template scenes.
 *   - { creativeId }    — render an existing creative's copy + image (sync)
 *   - { brief, image? } — build a recipe from a brief, render (sync)
 *   - { plan }          — render an edited recipe; if it has ai_motion scenes,
 *                          submit KIE per AI scene and finish async via reconcile.
 * Rows are render_mode='draft'|'motion', video_provider='remotion' (no t2v_job_id),
 * so the KIE creative-poller ignores them.
 */
export async function POST(req: Request) {
  if (!(await isAdminAuthed()) && !isMachineAuthed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sb = getServiceClient();

  // ── Motion path: a recipe with AI scenes renders asynchronously ──────────
  if (body.plan && Array.isArray(body.plan.scenes) && body.plan.scenes.length > 0 && hasAiMotion(body.plan)) {
    try {
      return await startMotionDraft(sb, normalizeMotion(body.plan));
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Failed to start motion draft" },
        { status: 500 },
      );
    }
  }

  // ── Synchronous draft path ───────────────────────────────────────────────
  let creativeId = body.creativeId;
  let plan: DraftRenderPlan;

  try {
    if (body.plan && Array.isArray(body.plan.scenes) && body.plan.scenes.length > 0) {
      plan = normalizeMotion(body.plan);
      const hook = plan.scenes.find((s) => s.role === "hook")?.text || "Draft";
      const image = plan.scenes.find((s) => s.image)?.image ?? null;
      creativeId = await insertDraft(sb, hook, image, plan, "draft");
    } else if (creativeId) {
      const { data: c } = await sb
        .from("ad_creatives")
        .select("id, hook_text, bridge_text, cta_text, image_url")
        .eq("id", creativeId)
        .single();
      if (!c) return NextResponse.json({ error: "Creative not found" }, { status: 404 });
      const cr = c as { hook_text: string; bridge_text: string | null; cta_text: string | null; image_url: string | null };
      plan = normalizeMotion(
        await buildDraftPlan({ hook: cr.hook_text, bridge: cr.bridge_text, cta: cr.cta_text, image: cr.image_url }),
      );
      await sb
        .from("ad_creatives")
        .update({ render_mode: "draft", video_provider: "remotion", video_status: "rendering", render_plan_json: plan })
        .eq("id", creativeId);
    } else if (body.brief && body.brief.trim()) {
      plan = normalizeMotion(await buildDraftPlan({ brief: body.brief, image: body.image }));
      const hook = plan.scenes.find((s) => s.role === "hook")?.text || body.brief.slice(0, 80);
      creativeId = await insertDraft(sb, hook, body.image ?? null, plan, "draft");
    } else {
      return NextResponse.json({ error: "creativeId, brief, or plan required" }, { status: 400 });
    }

    // Prod: offload the render to the worker (Vercel can't run Remotion). The
    // worker renders + uploads + POSTs /api/renders/draft-callback to flip it ready.
    if (draftWorkerConfigured()) {
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
      const proto = req.headers.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
      try {
        await dispatchToWorker(plan, creativeId, `${proto}://${host}`);
        return NextResponse.json({ ok: true, id: creativeId, status: "rendering", dispatched: true });
      } catch (e) {
        await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", creativeId);
        return NextResponse.json({ error: e instanceof Error ? e.message : "Dispatch failed" }, { status: 502 });
      }
    }

    // No worker + on Vercel: inline Remotion can't run here — fail fast & clearly
    // instead of hanging the function until it times out.
    if (process.env.VERCEL) {
      await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", creativeId);
      return NextResponse.json(
        { error: "Draft rendering is being set up — the render worker isn't connected yet." },
        { status: 503 },
      );
    }

    // Local: render inline.
    const rendered = await renderDraftVideo(plan, creativeId);
    if (!rendered.ok || !rendered.localPath) {
      await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", creativeId);
      return NextResponse.json({ error: rendered.error || "Render failed" }, { status: 500 });
    }
    const url = await uploadLocalVideo(rendered.localPath, creativeId);
    if (!url) {
      await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", creativeId);
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
    await sb.from("ad_creatives").update({ video_url: url, video_status: "ready" }).eq("id", creativeId);
    return NextResponse.json({ ok: true, id: creativeId, video_url: url, scenes: plan.scenes.length });
  } catch (e) {
    if (creativeId) {
      await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", creativeId);
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "Draft render failed" }, { status: 500 });
  }
}

/**
 * Kick off a Motion draft: submit a KIE clip per ai_motion scene, store the jobs
 * in render_plan_json, and return immediately. reconcileMotionDrafts (driven by
 * the client poll loop) polls the clips and fires the composite render when ready.
 */
async function startMotionDraft(sb: ReturnType<typeof getServiceClient>, plan: DraftRenderPlan) {
  const scenes = await Promise.all(
    plan.scenes.map(async (s) => {
      if (s.renderMethod !== "ai_motion") return s;
      const provider = MOTION_PROVIDER;
      try {
        const { taskId } = await submitKieVideo({
          provider,
          prompt: (s.visual || s.text || "").trim() || "cinematic product b-roll",
          mode: s.image ? "image-to-video" : "text-to-video",
          referenceImageUrls: s.image ? [s.image] : null,
          duration: clampDuration(provider, Math.ceil(s.duration)),
        });
        return { ...s, aiProvider: provider, aiJobId: taskId, aiStatus: "pending" as const, aiAttempts: 1 };
      } catch {
        // Couldn't submit (e.g. no KIE_API_KEY) — mark failed; reconcile downgrades it.
        return { ...s, aiProvider: provider, aiStatus: "failed" as const, aiAttempts: 1 };
      }
    }),
  );
  const planWithJobs: DraftRenderPlan = { ...plan, scenes };
  const hook = planWithJobs.scenes.find((s) => s.role === "hook")?.text || "Motion draft";
  const image = planWithJobs.scenes.find((s) => s.image)?.image ?? null;
  const id = await insertDraft(sb, hook, image, planWithJobs, "motion");
  const submitted = scenes.filter((s) => s.renderMethod === "ai_motion" && s.aiStatus === "pending").length;
  return NextResponse.json({ ok: true, id, status: "rendering", motion: true, aiScenes: submitted });
}

/** Insert a fresh draft/motion creative (rendering) and return its id; throws on error. */
async function insertDraft(
  sb: ReturnType<typeof getServiceClient>,
  hook: string,
  image: string | null,
  plan: DraftRenderPlan,
  mode: "draft" | "motion",
): Promise<string> {
  const { data: row, error } = await sb
    .from("ad_creatives")
    .insert({
      hook_text: hook,
      image_url: image,
      hook_type: mode,
      platform: "meta",
      creative_type: mode,
      render_mode: mode,
      video_provider: "remotion",
      video_status: "rendering",
      render_plan_json: plan,
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(error?.message || "Failed to create draft");
  return (row as { id: string }).id;
}
