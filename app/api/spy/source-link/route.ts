import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin-auth";
import { isMachineAuthed } from "@/lib/machine-auth";
import { getServiceClient } from "@/lib/supabase/server";
import { toAdRow } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Pull the ad id out of any Meta Ad Library link (or a bare id). */
function extractAdId(link: string): string | null {
  const s = (link || "").trim();
  try {
    const u = new URL(s);
    const id = u.searchParams.get("id");
    if (id && /^\d{5,}$/.test(id)) return id;
  } catch {
    /* not a full URL — fall through to regex */
  }
  const m = s.match(/[?&]id=(\d{5,})/) || s.match(/\/(\d{8,})(?:\/|\?|$)/) || s.match(/^(\d{8,})$/);
  return m ? m[1] : null;
}

/**
 * Source ONE specific ad straight from a Meta Ad Library link. Extracts the ad
 * id, renders it via Meta's render_ad endpoint through the scraper (which returns
 * the creative + the ad's text/advertiser/destination), and stores it as a
 * spy_ad — so you can recreate an ad you found outside your library.
 */
export async function POST(req: Request) {
  if (!(await isAdminAuthed()) && !isMachineAuthed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const scraper = process.env.SCRAPER_URL;
  if (!scraper) return NextResponse.json({ error: "SCRAPER_URL not configured" }, { status: 503 });
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return NextResponse.json({ error: "META_ACCESS_TOKEN not configured" }, { status: 503 });

  const { link } = (await req.json()) as { link?: string };
  const id = extractAdId(link || "");
  if (!id) {
    return NextResponse.json(
      { error: "Couldn't find an ad id in that link. Paste a Meta Ad Library URL (…/ads/library/?id=…)." },
      { status: 400 },
    );
  }

  const sb = getServiceClient();

  // Already in the library? Return it instead of duplicating.
  const { data: existing } = await sb.from("spy_ads").select("*").eq("meta_ad_id", id).maybeSingle();
  if (existing) {
    return NextResponse.json({ ad: toAdRow(existing as Record<string, unknown>), existed: true });
  }

  // Render the single ad and scrape its creative + text.
  const renderUrl = `https://www.facebook.com/ads/archive/render_ad/?id=${id}&access_token=${token}`;
  let scraped: { media_url?: string | null; media_type?: string | null; page_text?: string | null; advertiser?: string | null; link?: string | null; error?: string } = {};
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.SCRAPE_SECRET) headers["x-scrape-key"] = process.env.SCRAPE_SECRET;
    const res = await fetch(`${scraper.replace(/\/$/, "")}/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: renderUrl, ad_id: id }),
      cache: "no-store",
    });
    scraped = (await res.json().catch(() => ({}))) as typeof scraped;
    if (!res.ok || scraped.error) {
      return NextResponse.json({ error: scraped.error || `Scraper HTTP ${res.status}` }, { status: 502 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Scrape failed" }, { status: 500 });
  }

  // Record a search row so the ad has provenance, then insert the ad.
  const { data: searchRow } = await sb
    .from("spy_searches")
    .insert({ keyword: `link:${id}`, ad_count: 1 })
    .select("id")
    .single();

  const row: Record<string, unknown> = {
    meta_ad_id: id,
    page_name: scraped.advertiser || "Unknown advertiser",
    ad_body: scraped.page_text || null,
    ad_snapshot_url: `https://www.facebook.com/ads/archive/render_ad/?id=${id}`,
    destination_url: scraped.link || null,
    creative_media_url: scraped.media_url || null,
    creative_media_type: scraped.media_type || (scraped.media_url ? "image" : null),
    crawl_status: "pending",
    days_running: 0,
    winner_score: 0,
    brand_ad_count: 1,
    currency: "USD",
    vertical: "testing",
    search_id: (searchRow as { id: string } | null)?.id ?? null,
  };

  const { data: inserted, error: insErr } = await sb.from("spy_ads").insert(row).select("*").single();
  if (insErr || !inserted) {
    return NextResponse.json({ error: insErr?.message || "Failed to save ad" }, { status: 500 });
  }

  return NextResponse.json({ ad: toAdRow(inserted as Record<string, unknown>) });
}
