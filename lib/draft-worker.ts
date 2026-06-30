import "server-only";

import type { DraftRenderPlan } from "../remotion/types";

/**
 * Worker-dispatch helpers — deliberately FREE of any `@remotion/*` import so this
 * module loads on Vercel (where `@remotion/renderer`'s native binary can't load).
 * The heavy inline renderer (`lib/draft-render.ts`) is only `await import()`-ed on
 * a real Node host (local), never at module scope on Vercel.
 */

/** True when an external render worker is configured (prod offloads to it). */
export function draftWorkerConfigured(): boolean {
  return !!process.env.DRAFT_WORKER_URL;
}

/**
 * Hand a render-plan to the external draft-render-worker. It renders + uploads to
 * Supabase and POSTs back to `${origin}/api/renders/draft-callback`. Mirrors the
 * stitch-worker dispatch. Throws if the worker rejects the job.
 */
export async function dispatchToWorker(
  plan: DraftRenderPlan,
  creativeId: string,
  origin: string,
): Promise<void> {
  const base = process.env.DRAFT_WORKER_URL;
  if (!base) throw new Error("DRAFT_WORKER_URL not set");
  const secret = process.env.DRAFT_WEBHOOK_SECRET || "";
  const callbackUrl = `${origin}/api/renders/draft-callback${secret ? `?key=${encodeURIComponent(secret)}` : ""}`;
  const res = await fetch(`${base.replace(/\/$/, "")}/render`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": secret },
    body: JSON.stringify({ plan, creativeId, callbackUrl }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`render worker HTTP ${res.status}`);
}
