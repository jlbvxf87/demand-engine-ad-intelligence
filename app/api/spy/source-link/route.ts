import { NextResponse } from "next/server";
import { isAdminAuthed } from "@/lib/admin-auth";
import { isMachineAuthed } from "@/lib/machine-auth";
import { getServiceClient } from "@/lib/supabase/server";
import { toAdRow } from "@/lib/data";
import { toSiteUrl } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Pull the ad id out of any Meta Ad Library link (or a bare id). */
function extractAdId(link: string): string | null {
  const s = (link || "").trim();
  try {
    const u = new URL(s);
    // 1. The `id` query param of a real URL is the only trustworthy source of
    //    the ad id. Prefer it.
    const id = u.searchParams.get("id");
    if (id && /^\d{5,}$/.test(id)) return id;
    // Only fall back to a path number when the URL actually points at the ad
    // library / render endpoint — otherwise a long number in a path (a profile
    // id, business id, etc.) would silently source the WRONG ad.
    const looksLikeAdUrl = /ads\/library|render_ad/i.test(u.pathname + u.search);
    if (looksLikeAdUrl) {
      const pm = s.match(/\/(\d{8,})(?:\/|\?|$)/);
      if (pm) return pm[1];
    }
  } catch {
    /* not a full URL — fall through to bare-id handling below */
  }
  // 2. A bare numeric id the user typed (not embedded in a URL path). We do NOT
  //    accept a loose 8+ digit number from inside an arbitrary path/string,
  //    because that matches Facebook profile/business ids and mis-sources ads.
  const bare = s.match(/^(\d{5,})$/) || s.match(/[?&]id=(\d{5,})/);
  return bare ? bare[1] : null;
}

/**
 * Try to find a delivery start date in the scraped render text and convert it to
 * a whole-day "days running" count. Meta's render page sometimes contains a
 * "Started running on Jan 5, 2025" style line; if we can parse it we report an
 * honest days_running, otherwise we return null and let the UI omit the figure
 * rather than lie with "0d".
 */
function daysRunningFromText(text: string | null | undefined): number | null {
  const t = (text || "").trim();
  if (!t) return null;
  // "Started running on <date>" or just "<Month DD, YYYY>" near a "running" cue.
  const m =
    t.match(/Started running on\s+([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i) ||
    t.match(/running on\s+([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i);
  if (!m) return null;
  const ms = Date.parse(m[1]);
  if (Number.isNaN(ms)) return null;
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  // Guard against garbage (future dates / unparseable years that slipped through).
  if (days < 0 || days > 36_500) return null;
  return days;
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

  // The render page's innerText is "<Advertiser> Sponsored Library ID: <id> Menu
  // <the actual ad copy>". Pull a clean advertiser + body out of it.
  let advertiser = (scraped.advertiser || "").trim();
  let body = (scraped.page_text || "").trim();
  if (body) {
    const sp = body.search(/\bSponsored\b/i);
    if (!advertiser && sp > 0 && sp < 80) advertiser = body.slice(0, sp).trim();
    const lib = body.match(/Library ID:\s*\d+\s*(?:Menu)?/i);
    if (lib) body = body.slice(body.indexOf(lib[0]) + lib[0].length).trim();
    else if (sp >= 0) body = body.slice(sp + "Sponsored".length).trim();
    body = body.slice(0, 3000);
  }

  // Record a search row so the ad has provenance, then insert the ad.
  const { data: searchRow } = await sb
    .from("spy_searches")
    .insert({ keyword: `link:${id}`, ad_count: 1 })
    .select("id")
    .single();

  // We don't get a reliable ad_delivery_start_time from a render-page scrape, so
  // we can't compute the spend/impression-based winner_score the search route
  // does. Only report days_running when we can actually parse it from the page
  // text; otherwise leave it null so the UI shows nothing instead of "0d".
  // (toAdRow coerces null → 0 for the AdRow type, so cards still render cleanly.)
  const parsedDays = daysRunningFromText(scraped.page_text);

  const row: Record<string, unknown> = {
    meta_ad_id: id,
    page_name: advertiser || "Unknown advertiser",
    ad_body: body || scraped.page_text || null,
    ad_snapshot_url: `https://www.facebook.com/ads/archive/render_ad/?id=${id}`,
    // Normalize a real link to a fetchable https URL at ingestion; keep a
    // non-URL value RAW (not null) so the UI's caption fallback still works.
    destination_url: scraped.link ? (toSiteUrl(scraped.link) ?? scraped.link) : null,
    creative_media_url: scraped.media_url || null,
    creative_media_type: scraped.media_type || (scraped.media_url ? "image" : null),
    crawl_status: "pending",
    // null (not 0) when unknown — honest "no data" rather than a fake "0d running".
    days_running: parsedDays,
    // No spend/impression data from a render scrape → can't score it. Leave 0.
    winner_score: 0,
    brand_ad_count: 1,
    currency: "USD",
    // NOTE: `vertical` is overloaded to store the win-stage badge (see search
    // route's winnerBadge). This is a link-sourced placeholder — we have no
    // metrics to grade the ad, so "testing" is a neutral default, NOT a real
    // computed badge.
    vertical: "testing",
    search_id: (searchRow as { id: string } | null)?.id ?? null,
  };

  const { data: inserted, error: insErr } = await sb.from("spy_ads").insert(row).select("*").single();
  if (insErr || !inserted) {
    // With the meta_ad_id unique index, a concurrent paste of the same link can
    // lose the insert race (Postgres 23505). That's not a failure — the ad is in
    // the library now, so return the existing row instead of erroring.
    if (insErr?.code === "23505") {
      const { data: dup } = await sb.from("spy_ads").select("*").eq("meta_ad_id", id).maybeSingle();
      if (dup) return NextResponse.json({ ad: toAdRow(dup as Record<string, unknown>), existed: true });
    }
    return NextResponse.json({ error: insErr?.message || "Failed to save ad" }, { status: 500 });
  }

  return NextResponse.json({ ad: toAdRow(inserted as Record<string, unknown>) });
}
