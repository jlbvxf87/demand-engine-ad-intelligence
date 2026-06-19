"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getServiceClient } from "@/lib/supabase/server";
import { getWinningCreatives, type AdRow } from "@/lib/data";
import Anthropic from "@anthropic-ai/sdk";
import { submitKieVideo, pollKieVideo, isVideoProvider } from "@/lib/kie";
import { buildMasterScript } from "@/lib/storyboard";

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return {};
      }
    }
    return {};
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Server actions = the factory's "live" buttons. They call the existing,
   ported /api/spy/* routes server-side (machine-auth, no secrets exposed,
   no logic duplicated). Requires MACHINE_API_KEY in env (present in Vercel).
   Each returns { ok, ... } and never throws to the client.
   ────────────────────────────────────────────────────────────────────────── */

async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

type ActionResult = { ok: boolean; data?: unknown; error?: string };

async function callRoute(path: string, body: unknown): Promise<ActionResult> {
  const key = process.env.MACHINE_API_KEY;
  if (!key) {
    return {
      ok: false,
      error: "MACHINE_API_KEY not set — add it to env to enable live actions.",
    };
  }
  try {
    const res = await fetch(`${await baseUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (json as { error?: string }).error || `HTTP ${res.status}` };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Request failed" };
  }
}

export type SearchFilters = {
  country?: string;
  status?: "ACTIVE" | "ALL" | "INACTIVE";
  media?: "ALL" | "VIDEO" | "IMAGE";
  windowDays?: number; // 0 = any time
  platform?: string; // "" = all, else 'facebook' | 'instagram'
};

/** Source: pull fresh winners from the Meta Ad Library, with advanced filters. */
export async function searchAds(keyword: string, filters: SearchFilters = {}): Promise<ActionResult> {
  const body: Record<string, unknown> = { keyword };
  if (filters.country) body.country = filters.country;
  if (filters.status) body.ad_active_status = filters.status;
  if (filters.media && filters.media !== "ALL") body.media_type = filters.media;
  if (filters.platform) body.publisher_platforms = [filters.platform];
  if (filters.windowDays && filters.windowDays > 0) {
    body.ad_delivery_start_time_min = Math.floor(Date.now() / 1000) - filters.windowDays * 86400;
  }
  const r = await callRoute("/api/spy/search", body);
  if (r.ok) revalidatePath("/source");
  return r;
}

/**
 * Source: page search — pull ALL of one advertiser's ads (up to 1000) into the
 * app by page_id. Exact + complete (vs. fuzzy keyword search). This is how you
 * see a brand's full creative set and spot who's running the most.
 */
export async function searchByPage(pageId: string): Promise<ActionResult> {
  const r = await callRoute("/api/spy/search", { search_page_ids: pageId });
  if (r.ok) revalidatePath("/source");
  return r;
}

/** Source > Creatives: page through every ad in the library ("Load more"). */
export async function loadCreatives(
  offset: number,
  limit = 60
): Promise<{ ok: boolean; rows?: AdRow[] }> {
  try {
    const rows = await getWinningCreatives({ offset, limit });
    return { ok: true, rows };
  } catch {
    return { ok: false };
  }
}

/** Source ONE ad from a pasted Meta Ad Library link → stores it + returns the row. */
export async function sourceFromLink(link: string): Promise<ActionResult> {
  const v = (link || "").trim();
  if (!v) return { ok: false, error: "Paste a Meta Ad Library link first" };
  const r = await callRoute("/api/spy/source-link", { link: v });
  if (r.ok) revalidatePath("/source");
  return r;
}

/** Source: scrape the real ad creative (fbcdn media) for an ad via the scraper. */
export async function fetchCreative(adId: string): Promise<ActionResult> {
  const r = await callRoute("/api/spy/fetch-creative", { ad_id: adId });
  if (r.ok) revalidatePath("/source");
  return r;
}

/** Decode: crawl a winning ad's destination page (fills page_* + hook patterns). */
export async function decodeAd(adId: string): Promise<ActionResult> {
  const r = await callRoute("/api/spy/crawl", { ad_id: adId });
  if (r.ok) revalidatePath("/decode");
  return r;
}

/** Rebuild: generate original copy in the same angle (hooks / ugc_script). */
export async function generateCopy(
  adId: string,
  generationType: "hooks" | "ugc_script" = "hooks"
): Promise<ActionResult> {
  return callRoute("/api/spy/generate", { ad_id: adId, generation_type: generationType });
}

/** Rebuild: generate an on-brand still and persist it to ad_creatives. */
export async function generateImage(adId: string): Promise<ActionResult> {
  const r = await callRoute("/api/spy/generate-image", { ad_id: adId });
  if (r.ok) {
    revalidatePath("/rebuild");
    revalidatePath("/publish");
  }
  return r;
}

type Hook = { hook?: string; bridge?: string; cta?: string };

/**
 * Rebuild — the real loop. The /api/spy/generate + /generate-image routes only
 * RETURN data (they don't persist), so this action generates copy + a still,
 * then writes ad_creatives rows itself. That's what makes Rebuild output show up
 * in Rebuild's grid and the Publish queue.
 */
export async function generateCreatives(
  adId: string,
  brandSlug: string | null,
  variants = 3
): Promise<ActionResult> {
  // 1. original copy (10 hooks in the same psychological angle)
  const copy = await callRoute("/api/spy/generate", {
    ad_id: adId,
    generation_type: "hooks",
  });
  if (!copy.ok) return copy;
  const hooks = (((copy.data as { result?: { hooks?: Hook[] } })?.result?.hooks) ??
    []) as Hook[];
  if (hooks.length === 0) return { ok: false, error: "No hooks generated" };

  // 2. one on-brand still (attached to the hero variant)
  const img = await callRoute("/api/spy/generate-image", { ad_id: adId });
  const imageUrl = img.ok
    ? ((img.data as { image_url?: string })?.image_url ?? null)
    : null;
  const imagePrompt = img.ok
    ? ((img.data as { prompt?: string })?.prompt ?? null)
    : null;

  // 3. persist the variants
  try {
    const sb = getServiceClient();
    const { data: ad } = await sb
      .from("spy_ads")
      .select("vertical")
      .eq("id", adId)
      .single();
    const vertical = (ad as { vertical?: string } | null)?.vertical ?? null;

    const rows = hooks.slice(0, Math.max(1, variants)).map((h, i) => ({
      brand_slug: brandSlug,
      vertical,
      hook_type: "rebuild",
      hook_text: h.hook ?? "(untitled)",
      bridge_text: h.bridge ?? null,
      cta_text: h.cta ?? null,
      all_hooks: hooks,
      image_prompt: imagePrompt,
      image_url: i === 0 ? imageUrl : null,
      platform: "meta",
      creative_type: "composite",
      inspired_by: adId,
    }));

    const { error } = await sb.from("ad_creatives").insert(rows);
    if (error) return { ok: false, error: error.message };

    revalidatePath("/rebuild");
    revalidatePath("/publish");
    return { ok: true, data: { created: rows.length, image: Boolean(imageUrl) } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Persist failed" };
  }
}

/**
 * Recreate a winning ad on-brand in one shot: decode its landing (if not yet),
 * generate original copy + an on-brand still in the same proven angle, and pin
 * the ad's scraped creative as the visual reference so the video comes out
 * SIMILAR to the original. Persists to ad_creatives → shows in Create.
 * `auto: true` also kicks the video render; otherwise the user renders in Create.
 */
export async function recreate(
  adId: string,
  opts: { brandSlug?: string | null; auto?: boolean; provider?: string } = {}
): Promise<ActionResult> {
  try {
    const sb = getServiceClient();
    const { data } = await sb
      .from("spy_ads")
      .select("crawl_status, creative_media_url, creative_media_type")
      .eq("id", adId)
      .single();
    const ad = data as
      | { crawl_status?: string; creative_media_url?: string | null; creative_media_type?: string | null }
      | null;

    // 1. Decode the landing page first (best-effort) so the copy is sharper.
    if (ad && ad.crawl_status !== "done") {
      await callRoute("/api/spy/crawl", { ad_id: adId });
    }

    // 2. Generate on-brand copy + a still in the same angle (the proven engine).
    const gen = await generateCreatives(adId, opts.brandSlug ?? null, 3);
    if (!gen.ok) return gen;

    // 3. Pin the winning creative as the visual reference on the newest variant,
    //    so a video render comes out similar to the original ad.
    const refUrl = ad?.creative_media_type === "image" ? ad?.creative_media_url ?? null : null;
    let heroId: string | null = null;
    try {
      const { data: hero } = await sb
        .from("ad_creatives")
        .select("id")
        .eq("inspired_by", adId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      heroId = (hero as { id: string } | null)?.id ?? null;
      if (heroId && refUrl) {
        await sb.from("ad_creatives").update({ image_url: refUrl }).eq("id", heroId);
      }
    } catch {}

    // 4. Optionally render the video now (else the user renders it in Create).
    if (opts.auto && heroId) {
      await renderVideo(heroId, opts.provider ?? "seedance");
    }

    revalidatePath("/publish");
    revalidatePath("/rebuild");
    return {
      ok: true,
      data: {
        created: (gen.data as { created?: number })?.created ?? 3,
        reference: refUrl,
        rendered: Boolean(opts.auto),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Recreate failed" };
  }
}

/**
 * Decode ANY url (standalone — no Source pick needed). Best-effort fetch of the
 * page text, then Claude extracts why it works + a rebuild brief. Returns inline.
 */
export async function decodeUrl(url: string): Promise<ActionResult> {
  const u = (url || "").trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: "Enter a valid http(s) URL" };
  try {
    let pageText = "";
    try {
      const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0" }, cache: "no-store" });
      const html = await res.text();
      pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 6000);
    } catch {
      /* JS-only page — Claude infers from the URL */
    }
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system:
        "You are a direct-response ad strategist. Analyze the ad/landing page and return JSON only — no markdown, no prose.",
      messages: [
        {
          role: "user",
          content: `Analyze this ad/landing page (URL: ${u}).\nPage text:\n${
            pageText || "(could not fetch page — infer from the URL and brand)"
          }\n\nReturn JSON:\n{"hook":"the core hook","emotional_trigger":"","visual_mechanic":"","copy_structure":"","cta":"","summary":"1-2 sentences","brief":"a creative brief to rebuild this on-brand, compliant"}`,
        },
      ],
    });
    const raw = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "{}";
    return { ok: true, data: parseJson(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Decode failed" };
  }
}

/**
 * Rebuild from a SCRATCH brief (standalone — no Source ad needed). Claude writes
 * N hooks from the brief, persisted to ad_creatives so they flow to Publish.
 */
export async function generateFromBrief(input: {
  brief: string;
  brandSlug?: string | null;
  variants?: number;
}): Promise<ActionResult> {
  const brief = (input.brief || "").trim();
  if (!brief) return { ok: false, error: "Write a brief first" };
  const variants = Math.max(1, Math.min(6, input.variants ?? 3));
  try {
    const sb = getServiceClient();
    let voice = "";
    if (input.brandSlug) {
      const { data } = await sb.from("brands").select("brand_voice").eq("slug", input.brandSlug).single();
      voice = (data as { brand_voice?: string } | null)?.brand_voice || "";
    }
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system:
        "You are a direct-response copywriter. Return JSON only. No banned CTAs (Get Started/Sign Up/Learn More), no therapeutic or guaranteed-outcome claims.",
      messages: [
        {
          role: "user",
          content: `From this brief, write ${variants} original ad hook variations.${
            voice ? ` Brand voice: ${voice}.` : ""
          }\nBRIEF: ${brief}\nReturn JSON: {"hooks":[{"hook":"5-10 words","bridge":"one connecting sentence","cta":"3-5 words, outcome-framed"}]}`,
        },
      ],
    });
    const raw = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "{}";
    const hooks = ((parseJson(raw).hooks as { hook?: string; bridge?: string; cta?: string }[]) || []).slice(
      0,
      variants
    );
    if (hooks.length === 0) return { ok: false, error: "No hooks generated" };
    const rows = hooks.map((h) => ({
      brand_slug: input.brandSlug ?? null,
      hook_type: "scratch",
      hook_text: h.hook ?? "(untitled)",
      bridge_text: h.bridge ?? null,
      cta_text: h.cta ?? null,
      all_hooks: hooks,
      platform: "meta",
      creative_type: "scratch",
      video_status: "none",
    }));
    const { error } = await sb.from("ad_creatives").insert(rows);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/rebuild");
    revalidatePath("/publish");
    return { ok: true, data: { created: rows.length } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Generation failed" };
  }
}

/** Decode: synthesize the intelligence brief for a search. */
export async function synthesizeBrief(searchId: string): Promise<ActionResult> {
  const r = await callRoute("/api/spy/synthesize", { search_id: searchId });
  if (r.ok) revalidatePath("/decode");
  return r;
}

/**
 * Rebuild/Publish → video render, direct to kie.ai (no separate engine).
 * Submits the chosen model's job, stores the kie taskId + provider, flips
 * video_status to 'rendering'. kie is poll-based, so pollVideoJobs() (driven
 * by the Studio UI) later fills video_url.
 */
export async function renderVideo(
  creativeId: string,
  provider = "seedance"
): Promise<ActionResult> {
  if (!isVideoProvider(provider)) {
    return { ok: false, error: `Unknown model: ${provider}` };
  }
  try {
    const sb = getServiceClient();
    const { data: c } = await sb
      .from("ad_creatives")
      .select("id, brand_slug, hook_text, bridge_text, cta_text, image_url")
      .eq("id", creativeId)
      .single();
    if (!c) return { ok: false, error: "Creative not found" };

    const cr = c as {
      brand_slug: string | null;
      hook_text: string;
      bridge_text: string | null;
      cta_text: string | null;
      image_url: string | null;
    };

    // brand voice → on-brand prompt
    let voice = "";
    if (cr.brand_slug) {
      const { data: b } = await sb
        .from("brands")
        .select("brand_voice")
        .eq("slug", cr.brand_slug)
        .single();
      voice = (b as { brand_voice?: string } | null)?.brand_voice || "";
    }

    const prompt = [
      cr.hook_text,
      cr.bridge_text,
      cr.cta_text ? `CTA: ${cr.cta_text}.` : "",
      voice ? `Brand voice: ${voice}.` : "",
      "UGC testimonial style, vertical 9:16. Compliant — no therapeutic or guaranteed-outcome claims.",
    ]
      .filter(Boolean)
      .join(" ");

    const hasImage = Boolean(cr.image_url);
    const { taskId } = await submitKieVideo({
      provider,
      prompt,
      mode: hasImage ? "image-to-video" : "text-to-video",
      referenceImageUrls: cr.image_url ? [cr.image_url] : null,
      duration: 9,
    });

    await sb
      .from("ad_creatives")
      .update({
        t2v_job_id: taskId,
        video_provider: provider,
        video_status: "rendering",
        video_url: null,
      })
      .eq("id", creativeId);

    revalidatePath("/rebuild");
    revalidatePath("/publish");
    return { ok: true, data: { task_id: taskId, provider } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Render submit failed" };
  }
}

/**
 * Poll every in-progress kie job and persist results. Called on an interval by
 * the Studio while any creative is rendering. Returns how many flipped state.
 */
export async function pollVideoJobs(): Promise<ActionResult> {
  try {
    const sb = getServiceClient();
    const { data } = await sb
      .from("ad_creatives")
      .select("id, t2v_job_id, video_provider, video_status")
      .in("video_status", ["queued", "rendering"])
      .not("t2v_job_id", "is", null);

    const rows = (data || []) as {
      id: string;
      t2v_job_id: string;
      video_provider: string | null;
      video_status: string;
    }[];

    let updated = 0;
    for (const row of rows) {
      if (!row.video_provider || !isVideoProvider(row.video_provider)) continue;
      try {
        const r = await pollKieVideo(row.video_provider, row.t2v_job_id);
        if (r.state === "completed" && r.videoUrl) {
          await sb
            .from("ad_creatives")
            .update({ video_url: r.videoUrl, video_status: "ready" })
            .eq("id", row.id);
          updated++;
        } else if (r.state === "failed") {
          await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", row.id);
          updated++;
        }
      } catch {
        // transient — leave it queued, retry next tick
      }
    }

    // When a storyboard's scenes are all done, hand them to the stitch worker.
    await triggerReadyStoryboards(sb);

    if (updated) {
      revalidatePath("/publish");
      revalidatePath("/rebuild");
    }
    return { ok: true, data: { pending: rows.length, updated } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Poll failed" };
  }
}

type SB = ReturnType<typeof getServiceClient>;

/** Fire the stitch worker for any storyboard whose scene clips are all finished. */
async function triggerReadyStoryboards(sb: SB): Promise<void> {
  const worker = process.env.STITCH_WORKER_URL;
  if (!worker) return; // no worker configured yet — scenes still usable individually
  const { data: stories } = await sb
    .from("storyboards")
    .select("id, clip_count")
    .eq("status", "generating");
  for (const s of (stories || []) as { id: string; clip_count: number }[]) {
    const { data: clips } = await sb
      .from("ad_creatives")
      .select("scene_index, video_url, video_status")
      .eq("storyboard_id", s.id)
      .order("scene_index", { ascending: true });
    const rows = (clips || []) as {
      scene_index: number;
      video_url: string | null;
      video_status: string;
    }[];
    if (rows.length < s.clip_count) continue;
    const allDone = rows.every((r) => r.video_status === "ready" || r.video_status === "failed");
    if (!allDone) continue;
    const urls = rows.filter((r) => r.video_url).map((r) => r.video_url as string);
    if (urls.length < 2) {
      await sb.from("storyboards").update({ status: "failed", final_status: "failed" }).eq("id", s.id);
      continue;
    }
    await sb.from("storyboards").update({ status: "stitching", final_status: "stitching" }).eq("id", s.id);
    try {
      await fetch(`${worker.replace(/\/$/, "")}/stitch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          storyboard_id: s.id,
          clip_urls: urls,
          callback_url: `${await baseUrl()}/api/storyboards/stitch-callback`,
        }),
        cache: "no-store",
      });
    } catch {
      // worker unreachable — revert so we retry next tick
      await sb.from("storyboards").update({ status: "generating", final_status: "none" }).eq("id", s.id);
    }
  }
}

/**
 * Multi-scene storyboard: N reference images + a brief → Sonnet master script
 * → one Kie image-to-video clip per scene. Clips render live in the Studio; when
 * all finish, the poll loop hands them to the stitch worker for one final video.
 */
export async function createStoryboard(input: {
  imageUrls: string[];
  prompt: string;
  provider?: string;
  durationPerClip?: number;
}): Promise<ActionResult> {
  const provider = input.provider ?? "seedance";
  if (!isVideoProvider(provider)) return { ok: false, error: `Unknown model: ${provider}` };
  const imgs = (input.imageUrls || []).filter(Boolean);
  if (imgs.length < 2) return { ok: false, error: "Add at least 2 images (one per scene)" };
  const prompt = (input.prompt || "").trim();
  if (!prompt) return { ok: false, error: "A story brief is required" };
  const durationPerClip = input.durationPerClip ?? 5;
  const clipCount = imgs.length;

  try {
    const sb = getServiceClient();
    const scenes = await buildMasterScript(prompt, provider, clipCount, durationPerClip);

    const { data: story, error: sErr } = await sb
      .from("storyboards")
      .insert({
        prompt,
        provider,
        clip_count: clipCount,
        duration_per_clip: durationPerClip,
        status: "generating",
        master_script_json: { scenes },
        final_status: "none",
      })
      .select("id")
      .single();
    if (sErr || !story) return { ok: false, error: sErr?.message || "Failed to create storyboard" };
    const storyId = (story as { id: string }).id;

    let created = 0;
    for (let i = 0; i < clipCount; i++) {
      const scene = scenes[i];
      const { data: row } = await sb
        .from("ad_creatives")
        .insert({
          storyboard_id: storyId,
          scene_index: i,
          hook_text: scene.scene_summary,
          image_prompt: scene.scene_prompt,
          image_url: imgs[i],
          hook_type: "scene",
          platform: "meta",
          creative_type: "scene",
          video_status: "rendering",
          video_provider: provider,
        })
        .select("id")
        .single();
      const id = (row as { id: string } | null)?.id;
      if (!id) continue;
      try {
        const { taskId } = await submitKieVideo({
          provider,
          prompt: scene.scene_prompt,
          mode: "image-to-video",
          referenceImageUrls: [imgs[i]],
          duration: scene.duration || durationPerClip,
        });
        await sb.from("ad_creatives").update({ t2v_job_id: taskId }).eq("id", id);
        created++;
      } catch {
        await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", id);
      }
    }

    revalidatePath("/publish");
    if (created === 0) {
      await sb.from("storyboards").update({ status: "failed" }).eq("id", storyId);
      return { ok: false, error: "All scenes failed to submit" };
    }
    return { ok: true, data: { storyboard_id: storyId, scenes: created } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Storyboard failed" };
  }
}

/** Upload a reference image to storage; returns its public URL for kie to fetch. */
export async function uploadReference(
  formData: FormData
): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const file = formData.get("file");
    if (!(file instanceof File)) return { ok: false, error: "No file provided" };
    if (file.size > 50 * 1024 * 1024) return { ok: false, error: "File too large (max 50MB)" };
    const type = file.type || "image/png";
    const ext = (type.split("/")[1] || "png").replace("jpeg", "jpg");
    const path = `${crypto.randomUUID()}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    const sb = getServiceClient();
    const { error } = await sb.storage
      .from("ad-references")
      .upload(path, buf, { contentType: type, upsert: false });
    if (error) return { ok: false, error: error.message };
    const { data } = sb.storage.from("ad-references").getPublicUrl(path);
    return { ok: true, url: data.publicUrl };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Upload failed" };
  }
}

/**
 * Replicate-from-reference: a reference image (+ optional guide images) and an
 * instruction prompt → N image-to-video variations via kie. Each variant is an
 * ad_creatives row that renders live in the Studio (reference shown as the still
 * until its video lands).
 */
export async function replicate(input: {
  referenceUrls: string[];
  prompt: string;
  provider?: string;
  count?: number;
}): Promise<ActionResult> {
  const provider = input.provider ?? "seedance";
  if (!isVideoProvider(provider)) return { ok: false, error: `Unknown model: ${provider}` };
  const refs = (input.referenceUrls || []).filter(Boolean);
  if (refs.length === 0) return { ok: false, error: "A reference image is required" };
  const prompt = (input.prompt || "").trim();
  if (!prompt) return { ok: false, error: "An instruction prompt is required" };
  const count = Math.max(1, Math.min(6, input.count ?? 3));

  try {
    const sb = getServiceClient();
    let created = 0;
    for (let i = 0; i < count; i++) {
      const { data: row } = await sb
        .from("ad_creatives")
        .insert({
          hook_text: prompt.slice(0, 200),
          image_prompt: prompt,
          image_url: refs[0],
          hook_type: "replicate",
          platform: "meta",
          creative_type: "replicate",
          video_status: "rendering",
          video_provider: provider,
        })
        .select("id")
        .single();
      const id = (row as { id: string } | null)?.id;
      if (!id) continue;
      try {
        const { taskId } = await submitKieVideo({
          provider,
          prompt,
          mode: "image-to-video",
          referenceImageUrls: refs,
          duration: 9,
        });
        await sb.from("ad_creatives").update({ t2v_job_id: taskId }).eq("id", id);
        created++;
      } catch {
        await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", id);
      }
    }
    revalidatePath("/publish");
    if (created === 0) return { ok: false, error: "All variants failed to submit" };
    return { ok: true, data: { created } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Replicate failed" };
  }
}
