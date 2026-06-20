"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getServiceClient } from "@/lib/supabase/server";
import { getWinningCreatives, searchLibrary as searchLibraryData, type AdRow } from "@/lib/data";
import Anthropic from "@anthropic-ai/sdk";
import { submitKieVideo, pollKieVideo, isVideoProvider } from "@/lib/kie";
import { buildMasterScript } from "@/lib/storyboard";
import { reconcileStoryboards } from "@/lib/storyboard-reconcile";
import { persistVideoToStorage } from "@/lib/persist";
import { BROWSER_UA } from "@/lib/http";
import { unsafeResolvedFetchReason } from "@/lib/ssrf";

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

/** Source: find an ad ALREADY in your library by brand / copy / domain (not Meta). */
export async function findSavedAds(query: string): Promise<{ ok: boolean; rows?: AdRow[] }> {
  try {
    const rows = await searchLibraryData(query, 100);
    return { ok: true, rows };
  } catch {
    return { ok: false };
  }
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

    const { data: inserted, error } = await sb
      .from("ad_creatives")
      .insert(rows)
      .select("id");
    if (error) return { ok: false, error: error.message };

    // Inserted ids in row order — ids[0] is the hero (the i===0 row that
    // carries image_url), so callers can pin the reference image deterministically.
    const ids = ((inserted as { id: string }[] | null) ?? []).map((r) => r.id);

    revalidatePath("/rebuild");
    revalidatePath("/publish");
    return { ok: true, data: { created: rows.length, ids, image: Boolean(imageUrl) } };
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
    //    Skip if already done, or already errored (uncrawlable destination) — no
    //    point re-firing a guaranteed-failing crawl on every recreate.
    if (ad && ad.crawl_status !== "done" && ad.crawl_status !== "error") {
      await callRoute("/api/spy/crawl", { ad_id: adId });
    }

    // 2. Generate on-brand copy + a still in the same angle (the proven engine).
    const gen = await generateCreatives(adId, opts.brandSlug ?? null, 3);
    if (!gen.ok) return gen;

    // 3. Pin the winning creative as the visual reference on the HERO variant,
    //    so a video render comes out similar to the original ad. generateCreatives
    //    returns the inserted ids in order, and ids[0] is the hero (the i===0 row
    //    that carries the still). Pinning by that id is deterministic — no more
    //    arbitrary created_at re-query that could hit the wrong variant.
    // Only pin the original creative if it's a PERMANENT (Supabase storage) URL.
    // Raw fbcdn links expire and 404 later, so pinning one would both break the
    // hero AND throw away the generated still. When it's not persisted media,
    // leave the generated still in place (refUrl = null).
    const persistedMedia =
      ad?.creative_media_type === "image" &&
      typeof ad?.creative_media_url === "string" &&
      ad.creative_media_url.includes("supabase.co/storage");
    const refUrl = persistedMedia ? ad!.creative_media_url ?? null : null;
    const heroId = (gen.data as { ids?: string[] })?.ids?.[0] ?? null;
    if (heroId && refUrl) {
      try {
        await sb.from("ad_creatives").update({ image_url: refUrl }).eq("id", heroId);
      } catch {}
    }

    // 4. Optionally render the video now (else the user renders it in Create).
    let rendered = false;
    if (opts.auto && heroId) {
      await renderVideo(heroId, opts.provider ?? "seedance");
      rendered = true;
    }

    revalidatePath("/publish");
    revalidatePath("/rebuild");
    return {
      ok: true,
      data: {
        created: (gen.data as { created?: number })?.created ?? 3,
        reference: refUrl,
        rendered,
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
  const bad = await unsafeResolvedFetchReason(u);
  if (bad) return { ok: false, error: `Can't fetch that URL — ${bad}` };
  try {
    let pageText = "";
    try {
      const res = await fetch(u, { headers: { "user-agent": BROWSER_UA }, cache: "no-store" });
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

/** Parse a Supabase public storage URL into { bucket, path }, or null. */
function parseStoragePublicUrl(
  url: string | null | undefined,
): { bucket: string; path: string } | null {
  if (!url) return null;
  const m = url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], path: decodeURIComponent(m[2].split("?")[0]) };
}

/**
 * Delete a generated creative and its stored artifacts. Powers the "Delete"
 * control on Home → Latest videos (and the Create studio). Removes the
 * ad_creatives row, then best-effort drops the persisted video/still from our
 * storage buckets so nothing is orphaned.
 */
export async function deleteCreative(id: string): Promise<ActionResult> {
  if (!id) return { ok: false, error: "Missing id" };
  try {
    const sb = getServiceClient();
    const { data } = await sb
      .from("ad_creatives")
      .select("video_url, image_url")
      .eq("id", id)
      .single();
    const row = data as { video_url?: string | null; image_url?: string | null } | null;

    const { error } = await sb.from("ad_creatives").delete().eq("id", id);
    if (error) return { ok: false, error: error.message };

    // Best-effort cleanup of our own buckets only; ignore failures.
    for (const u of [row?.video_url, row?.image_url]) {
      const loc = parseStoragePublicUrl(u);
      if (loc && (loc.bucket === "ad-creatives" || loc.bucket === "ad-references")) {
        try {
          await sb.storage.from(loc.bucket).remove([loc.path]);
        } catch {}
      }
    }

    revalidatePath("/");
    revalidatePath("/publish");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
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
          // Kie's videoUrl is a temporary CDN link that expires — download and
          // re-upload to permanent Supabase Storage. Fall back to the temp URL
          // if persistence fails, so the video is never lost.
          const permanent = await persistVideoToStorage(r.videoUrl, row.id);
          const { data: flipped } = await sb
            .from("ad_creatives")
            .update({ video_url: permanent ?? r.videoUrl, video_status: "ready" })
            .eq("id", row.id)
            .in("video_status", ["queued", "rendering"])
            .select("id");
          if (flipped && flipped.length > 0) updated++;
        } else if (r.state === "failed") {
          const { data: flipped } = await sb
            .from("ad_creatives")
            .update({ video_status: "failed" })
            .eq("id", row.id)
            .in("video_status", ["queued", "rendering"])
            .select("id");
          if (flipped && flipped.length > 0) updated++;
        }
      } catch {
        // transient — leave it queued, retry next tick
      }
    }

    // Re-render any failed scenes (self-heal) and stitch storyboards once ready.
    await reconcileStoryboards(sb, await baseUrl());

    if (updated) {
      revalidatePath("/publish");
      revalidatePath("/rebuild");
    }
    return { ok: true, data: { pending: rows.length, updated } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Poll failed" };
  }
}

/**
 * Multi-scene storyboard: N reference images + a brief → Sonnet master script
 * → one Kie image-to-video clip per scene. Clips render live in the Studio; when
 * all finish, the poll loop hands them to the stitch worker for one final video.
 */
export async function createStoryboard(input: {
  imageUrls?: string[];
  prompt: string;
  provider?: string;
  durationPerClip?: number;
  sceneCount?: number; // used when no reference frames are uploaded (text-to-video scenes)
}): Promise<ActionResult> {
  const provider = input.provider ?? "seedance";
  if (!isVideoProvider(provider)) return { ok: false, error: `Unknown model: ${provider}` };
  const imgs = (input.imageUrls || []).filter(Boolean);
  // Reference frames drive the scene count; otherwise use the chosen scene count
  // and render each scene from text (no upload required).
  const clipCount = imgs.length >= 2 ? imgs.length : Math.max(0, Math.floor(input.sceneCount ?? 0));
  if (clipCount < 2) {
    return { ok: false, error: "Add 2+ reference frames, or pick a scene count of 2 or more." };
  }
  const prompt = (input.prompt || "").trim();
  if (!prompt) return { ok: false, error: "A story brief is required" };
  const durationPerClip = input.durationPerClip ?? 5;

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
    let sceneErr: string | null = null;
    for (let i = 0; i < clipCount; i++) {
      const scene = scenes[i];
      const img = imgs[i] ?? null; // null for text-to-video scenes
      const { data: row } = await sb
        .from("ad_creatives")
        .insert({
          storyboard_id: storyId,
          scene_index: i,
          hook_text: scene.scene_summary,
          image_prompt: scene.scene_prompt,
          image_url: img,
          hook_type: "scene",
          platform: "meta",
          creative_type: "scene",
          video_status: "rendering",
          video_provider: provider,
          video_attempts: 1, // this initial submit; reconciler retries up to the cap
        })
        .select("id")
        .single();
      const id = (row as { id: string } | null)?.id;
      if (!id) continue;
      try {
        const { taskId } = await submitKieVideo({
          provider,
          prompt: scene.scene_prompt,
          mode: img ? "image-to-video" : "text-to-video",
          referenceImageUrls: img ? [img] : null,
          duration: scene.duration || durationPerClip,
        });
        await sb.from("ad_creatives").update({ t2v_job_id: taskId }).eq("id", id);
        created++;
      } catch (e) {
        sceneErr = e instanceof Error ? e.message : "submit failed";
        await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", id);
      }
    }

    revalidatePath("/publish");
    if (created === 0) {
      await sb.from("storyboards").update({ status: "failed" }).eq("id", storyId);
      return { ok: false, error: sceneErr ? `Video render failed — ${sceneErr}` : "All scenes failed to submit" };
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
    let lastErr: string | null = null;
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
      } catch (e) {
        lastErr = e instanceof Error ? e.message : "submit failed";
        await sb.from("ad_creatives").update({ video_status: "failed" }).eq("id", id);
      }
    }
    revalidatePath("/publish");
    // Surface the real reason (e.g. "Credits insufficient…") instead of a generic message.
    if (created === 0) return { ok: false, error: lastErr ? `Video render failed — ${lastErr}` : "All variants failed to submit" };
    return { ok: true, data: { created } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Replicate failed" };
  }
}
