import "server-only";
import { getServiceClient } from "@/lib/supabase/server";

/* Shared "pull the real ad creative" engine, used by both the single-ad route
   (Source "Load real creative") and the batch backfill cron. Re-tokens an ad's
   render_ad URL, hands it to the scraper (headless Chromium → fbcdn media),
   stores the result on spy_ads.creative_media_url, and returns it. */

type ScrapeResult =
  | { ok: true; media_url: string | null; media_type: string | null; cached?: boolean }
  | { ok: false; error: string };

export async function scrapeAndStoreCreative(adId: string): Promise<ScrapeResult> {
  const scraper = process.env.SCRAPER_URL;
  if (!scraper) return { ok: false, error: "SCRAPER_URL not configured" };
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "META_ACCESS_TOKEN not configured" };

  const sb = getServiceClient();
  const { data } = await sb
    .from("spy_ads")
    .select("id, ad_snapshot_url, creative_media_url, creative_media_type")
    .eq("id", adId)
    .single();
  const ad = data as {
    ad_snapshot_url: string | null;
    creative_media_url: string | null;
    creative_media_type: string | null;
  } | null;
  if (!ad) return { ok: false, error: "Ad not found" };

  if (ad.creative_media_url) {
    return { ok: true, media_url: ad.creative_media_url, media_type: ad.creative_media_type, cached: true };
  }
  if (!ad.ad_snapshot_url) return { ok: false, error: "No snapshot URL for this ad" };

  let renderUrl: string;
  try {
    const u = new URL(ad.ad_snapshot_url);
    // Guard against poisoned/forged ad_snapshot_url values in the DB: only attach
    // the live Meta access token (and only navigate the scraper) when the host is
    // a Facebook host. Otherwise the token would leak to an attacker-controlled host.
    const host = u.hostname.toLowerCase();
    const isFacebookHost =
      host === "facebook.com" || host === "www.facebook.com" || host.endsWith(".facebook.com");
    if (!isFacebookHost) {
      return { ok: false, error: "Snapshot URL is not a Facebook ad URL" };
    }
    u.searchParams.set("access_token", token);
    renderUrl = u.toString();
  } catch {
    return { ok: false, error: "Snapshot URL is not a Facebook ad URL" };
  }

  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.SCRAPE_SECRET) headers["x-scrape-key"] = process.env.SCRAPE_SECRET;
    const res = await fetch(`${scraper.replace(/\/$/, "")}/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: renderUrl, ad_id: adId }),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as {
      media_url?: string;
      media_type?: string;
      error?: string;
    };
    if (!res.ok || json.error) {
      return { ok: false, error: json.error || `Scraper HTTP ${res.status}` };
    }
    if (json.media_url) {
      await sb
        .from("spy_ads")
        .update({ creative_media_url: json.media_url, creative_media_type: json.media_type ?? null })
        .eq("id", adId);
    } else {
      // Scrape ran but the page exposed no real creative (text/link ad, or a video
      // that won't stream in headless). Mark it so the batch job stops retrying.
      await sb.from("spy_ads").update({ creative_media_type: "none" }).eq("id", adId);
    }
    return { ok: true, media_url: json.media_url ?? null, media_type: json.media_type ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Scrape failed" };
  }
}
