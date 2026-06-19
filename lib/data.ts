import "server-only";
import { getServiceClient } from "@/lib/supabase/server";
import { toDomain } from "@/lib/url";
import { adHook, isBoilerplate } from "@/lib/ad";

/* ──────────────────────────────────────────────────────────────────────────
   Server-only read layer for the factory screens. Every function is defensive:
   on any error it returns an empty result so a screen renders an empty state
   rather than crashing. Runs with the service-role client (server only).
   ────────────────────────────────────────────────────────────────────────── */

export type WinnerBadge = "dominant" | "proven" | "scaling" | "testing";

export function computeBadge(
  score: number,
  daysRunning: number,
  spendMid: number
): WinnerBadge {
  if (score > 8000 && daysRunning >= 60 && spendMid >= 10000) return "dominant";
  if (score > 1500 && daysRunning >= 30 && spendMid >= 2000) return "proven";
  if (score > 200 && daysRunning >= 14) return "scaling";
  return "testing";
}

export type AdRow = {
  id: string;
  meta_ad_id: string | null;
  page_name: string | null;
  page_id: string | null;
  ad_title: string | null;
  ad_body: string | null;
  ad_snapshot_url: string | null;
  page_screenshot_url: string | null;
  destination_url: string | null;
  winner_score: number;
  days_running: number;
  brand_ad_count: number;
  spend_lower: number | null;
  spend_upper: number | null;
  impressions_lower: number | null;
  impressions_upper: number | null;
  vertical: string | null;
  badge: WinnerBadge;
  // crawl / decode fields
  page_headline: string | null;
  page_offer: string | null;
  page_cta: string | null;
  page_product: string | null;
  page_pricing: string | null;
  page_ai_summary: string | null;
  crawl_status: string | null;
  creative_media_url: string | null;
  creative_media_type: string | null;
};

const AD_COLS =
  "id, meta_ad_id, page_name, page_id, ad_title, ad_body, ad_snapshot_url, page_screenshot_url, destination_url, winner_score, days_running, brand_ad_count, spend_lower, spend_upper, impressions_lower, impressions_upper, vertical, page_headline, page_offer, page_cta, page_product, page_pricing, page_ai_summary, crawl_status, creative_media_url, creative_media_type";

function spendMid(a: { spend_lower: number | null; spend_upper: number | null }) {
  return ((a.spend_lower ?? 0) + (a.spend_upper ?? 0)) / 2;
}

export function toAdRow(a: Record<string, unknown>): AdRow {
  const score = Number(a.winner_score ?? 0);
  const days = Number(a.days_running ?? 0);
  const sl = a.spend_lower == null ? null : Number(a.spend_lower);
  const su = a.spend_upper == null ? null : Number(a.spend_upper);
  return {
    id: String(a.id),
    meta_ad_id: (a.meta_ad_id as string) ?? null,
    page_name: (a.page_name as string) ?? null,
    page_id: (a.page_id as string) ?? null,
    ad_title: (a.ad_title as string) ?? null,
    ad_body: (a.ad_body as string) ?? null,
    ad_snapshot_url: (a.ad_snapshot_url as string) ?? null,
    page_screenshot_url: (a.page_screenshot_url as string) ?? null,
    destination_url: (a.destination_url as string) ?? null,
    winner_score: score,
    days_running: days,
    brand_ad_count: Number(a.brand_ad_count ?? 1),
    spend_lower: sl,
    spend_upper: su,
    impressions_lower: a.impressions_lower == null ? null : Number(a.impressions_lower),
    impressions_upper: a.impressions_upper == null ? null : Number(a.impressions_upper),
    vertical: (a.vertical as string) ?? null,
    badge: computeBadge(score, days, spendMid({ spend_lower: sl, spend_upper: su })),
    page_headline: (a.page_headline as string) ?? null,
    page_offer: (a.page_offer as string) ?? null,
    page_cta: (a.page_cta as string) ?? null,
    page_product: (a.page_product as string) ?? null,
    page_pricing: (a.page_pricing as string) ?? null,
    page_ai_summary: (a.page_ai_summary as string) ?? null,
    crawl_status: (a.crawl_status as string) ?? null,
    creative_media_url: (a.creative_media_url as string) ?? null,
    creative_media_type: (a.creative_media_type as string) ?? null,
  };
}

export type AdFilters = {
  vertical?: string;
  limit?: number;
  offset?: number; // for "Load more" paging through every result
};

/** Individual winning creatives, highest winner_score first (Source > Creatives tab). */
export async function getWinningCreatives(f: AdFilters = {}): Promise<AdRow[]> {
  try {
    const sb = getServiceClient();
    const limit = f.limit ?? 60;
    const offset = f.offset ?? 0;
    let q = sb
      .from("spy_ads")
      .select(AD_COLS)
      .order("winner_score", { ascending: false })
      .range(offset, offset + limit - 1);
    if (f.vertical && f.vertical !== "all") q = q.eq("vertical", f.vertical);
    const { data, error } = await q;
    if (error || !data) return [];
    return dedupeByMetaId(data.map(toAdRow));
  } catch {
    return [];
  }
}

/** Total ad count (for the "Showing N of M" pager in Source > Creatives). */
export async function getCreativesCount(): Promise<number> {
  try {
    const sb = getServiceClient();
    const { count } = await sb.from("spy_ads").select("id", { count: "exact", head: true });
    return count ?? 0;
  } catch {
    return 0;
  }
}

export type ScaledWinner = {
  key: string;
  ad: AdRow; // representative ad (for the detail viewer + scrape)
  adCount: number; // how many ads run this same creative
  landingPages: number; // distinct destinations/links it runs across
  advertisers: number; // distinct pages running it
  maxDays: number;
};

/** Drop re-ingested duplicate ads (same meta_ad_id from re-running searches). */
function dedupeByMetaId(rows: AdRow[]): AdRow[] {
  const seen = new Set<string>();
  const out: AdRow[] = [];
  for (const r of rows) {
    const k = r.meta_ad_id || r.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * "Scaled winners" — creatives DUPLICATED across many ads / landing pages.
 * Since Meta gives no spend for commercial ads, the strongest signal that a
 * creative works is that an operator is running it over and over. Groups
 * spy_ads by ad copy and ranks by (ad count + landing-page spread + longevity).
 */
// Only the fields the grouping/ranking needs — keeps the wide 1500-row scan
// off the heavy text columns (ad_body excerpt is enough; page_ai_summary,
// offer/pricing copy, and screenshots are only hydrated for the few reps shown).
const SCALED_GROUP_COLS =
  "id, meta_ad_id, ad_body, destination_url, page_name, winner_score, days_running, creative_media_url";

type ScaledGroupRow = {
  id: string;
  meta_ad_id: string | null;
  ad_body: string | null;
  destination_url: string | null;
  page_name: string | null;
  winner_score: number | null;
  days_running: number | null;
  creative_media_url: string | null;
};

export async function getScaledWinners(limit = 24): Promise<ScaledWinner[]> {
  try {
    const sb = getServiceClient();
    const { data, error } = await sb
      .from("spy_ads")
      .select(SCALED_GROUP_COLS)
      .order("created_at", { ascending: false })
      .limit(1500);
    if (error || !data) return [];

    // Dedupe re-ingested ads (same meta_ad_id) before grouping.
    const seen = new Set<string>();
    const rows = (data as ScaledGroupRow[]).filter((r) => {
      const k = r.meta_ad_id || r.id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const groups = new Map<
      string,
      { repId: string; repHasCreative: boolean; repScore: number; repDays: number; count: number; pages: Set<string>; advs: Set<string>; maxDays: number }
    >();
    for (const r of rows) {
      if (isBoilerplate(r.ad_body)) continue; // Meta disclaimer, not a real creative
      const body = (r.ad_body || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (body.length < 20) continue;
      const key = body.slice(0, 140);
      const score = r.winner_score ?? 0;
      const days = r.days_running ?? 0;
      const hasCreative = !!r.creative_media_url;
      let g = groups.get(key);
      if (!g) {
        g = { repId: r.id, repHasCreative: hasCreative, repScore: score, repDays: days, count: 0, pages: new Set(), advs: new Set(), maxDays: 0 };
        groups.set(key, g);
      }
      g.count += 1;
      // Prefer a representative that already has a real scraped creative, then
      // higher score, then longevity — so the card shows a picture when any ad
      // in the group has one (not a blank/unscraped rep).
      const better =
        (hasCreative && !g.repHasCreative) ||
        (hasCreative === g.repHasCreative && (score > g.repScore || (score === g.repScore && days > g.repDays)));
      if (better) {
        g.repId = r.id;
        g.repHasCreative = hasCreative;
        g.repScore = score;
        g.repDays = days;
      }
      if (days > g.maxDays) g.maxDays = days;
      const dom = toDomain(r.destination_url);
      if (dom) g.pages.add(dom);
      if (r.page_name) g.advs.add(r.page_name);
    }

    // Rank groups, keep only duplicated creatives, take the top `limit`.
    const ranked = [...groups.entries()]
      .filter(([, g]) => g.count >= 2) // only creatives an operator is duplicating
      .map(([key, g]) => ({
        key,
        repId: g.repId,
        adCount: g.count,
        landingPages: g.pages.size,
        advertisers: g.advs.size,
        maxDays: g.maxDays,
      }))
      .sort(
        (a, b) =>
          b.adCount + b.landingPages * 2 + b.maxDays * 0.1 - (a.adCount + a.landingPages * 2 + a.maxDays * 0.1)
      )
      .slice(0, limit);
    if (ranked.length === 0) return [];

    // Hydrate full ad rows only for the handful of representatives we'll render.
    const { data: repData } = await sb
      .from("spy_ads")
      .select(AD_COLS)
      .in("id", ranked.map((r) => r.repId));
    const byId = new Map<string, AdRow>((repData ?? []).map((a) => [String((a as { id: string }).id), toAdRow(a)]));

    return ranked
      .map((r) => {
        const ad = byId.get(r.repId);
        if (!ad) return null;
        return { key: r.key, ad, adCount: r.adCount, landingPages: r.landingPages, advertisers: r.advertisers, maxDays: r.maxDays };
      })
      .filter((x): x is ScaledWinner => x !== null);
  } catch {
    return [];
  }
}

export type Advertiser = {
  page_name: string;
  page_id: string | null;
  activeAds: number;
  maxScore: number;
  badge: WinnerBadge;
  vertical: string | null;
  topCreative: string | null;
  topDomain: string | null; // where their top ad sends — the clearest "what's the product" signal
  topCreativeId: string | null;
  isPersona: boolean;
};

const PERSONA_RE = /^(dr\.?\s|doctor\s|prof\.?\s)/i;

/** Advertisers grouped & sorted by active ad count (Source > Advertisers tab). */
export async function getTopAdvertisers(f: AdFilters = {}): Promise<Advertiser[]> {
  const ads = await getWinningCreatives({ vertical: f.vertical, limit: 500 });
  const map = new Map<string, Advertiser>();
  for (const a of ads) {
    const name = a.page_name || "Unknown";
    const cur = map.get(name);
    if (!cur) {
      map.set(name, {
        page_name: name,
        page_id: a.page_id,
        activeAds: Math.max(a.brand_ad_count, 1),
        maxScore: a.winner_score,
        badge: a.badge,
        vertical: a.vertical,
        topCreative: adHook(a.ad_body, a.ad_title, a.page_headline),
        topDomain: toDomain(a.destination_url) || null,
        topCreativeId: a.id,
        isPersona: PERSONA_RE.test(name),
      });
    } else {
      cur.activeAds = Math.max(cur.activeAds, a.brand_ad_count);
      if (a.winner_score > cur.maxScore) {
        cur.maxScore = a.winner_score;
        cur.badge = a.badge;
        cur.topCreative = adHook(a.ad_body, a.ad_title, a.page_headline);
        cur.topDomain = toDomain(a.destination_url) || null;
        cur.topCreativeId = a.id;
      }
    }
  }
  return [...map.values()].sort((x, y) => y.activeAds - x.activeAds).slice(0, f.limit ?? 40);
}

export type IdentityRollup = {
  persona: string;
  page_id: string | null;
  activeAds: number;
  badge: WinnerBadge;
  resolvedBrand: string | null; // null = unresolved
  resolvedSlug: string | null;
};

/**
 * Identity tab: persona-style advertisers ("Dr. ABC") resolved up to a real
 * brand via known_advertisers (manual/auto mapping) where available.
 */
export async function getIdentityRollups(f: AdFilters = {}): Promise<IdentityRollup[]> {
  const advertisers = await getTopAdvertisers({ vertical: f.vertical, limit: 200 });
  let known: Record<string, { brand: string; slug: string | null }> = {};
  try {
    const sb = getServiceClient();
    const { data } = await sb
      .from("known_advertisers")
      .select("page_id, page_name, brand_alias");
    if (data) {
      for (const k of data as Record<string, unknown>[]) {
        const pid = (k.page_id as string) ?? "";
        if (pid)
          known[pid] = {
            brand: (k.brand_alias as string) || (k.page_name as string) || "",
            slug: (k.brand_alias as string) ?? null,
          };
      }
    }
  } catch {
    known = {};
  }
  return advertisers
    .filter((a) => a.isPersona)
    .map((a) => {
      const res = a.page_id ? known[a.page_id] : undefined;
      return {
        persona: a.page_name,
        page_id: a.page_id,
        activeAds: a.activeAds,
        badge: a.badge,
        resolvedBrand: res?.brand || null,
        resolvedSlug: res?.slug || null,
      };
    });
}

/** Full ad detail + extracted hook patterns for Decode. */
export async function getAdDetail(id: string): Promise<{
  ad: AdRow | null;
  patterns: HookPattern[];
}> {
  try {
    const sb = getServiceClient();
    const { data: adData } = await sb.from("spy_ads").select(AD_COLS).eq("id", id).single();
    const ad = adData ? toAdRow(adData) : null;
    const { data: pat } = await sb
      .from("ad_hook_patterns")
      .select(
        "id, hook_type, emotional_trigger, bridge_mechanism, visual_technique, hook_sentence, bridge_text, cta_text, why_it_works, copy_structure, winner_score"
      )
      .eq("spy_ad_id", id)
      .order("winner_score", { ascending: false });
    return { ad, patterns: (pat as HookPattern[]) || [] };
  } catch {
    return { ad: null, patterns: [] };
  }
}

export type HookPattern = {
  id: string;
  hook_type: string;
  emotional_trigger: string | null;
  bridge_mechanism: string | null;
  visual_technique: string | null;
  hook_sentence: string | null;
  bridge_text: string | null;
  cta_text: string | null;
  why_it_works: string | null;
  copy_structure: unknown;
  winner_score: number | null;
};

export type Creative = {
  id: string;
  brand_slug: string | null;
  vertical: string | null;
  hook_type: string | null;
  hook_text: string;
  bridge_text: string | null;
  cta_text: string | null;
  image_url: string | null;
  image_prompt: string | null;
  video_url: string | null;
  video_status: string | null;
  video_provider: string | null;
  t2v_job_id: string | null;
  platform: string;
  creative_type: string;
  inspired_by: string | null;
  created_at: string;
};

/** Generated creatives (Rebuild output / Publish queue). */
export async function getGeneratedCreatives(limit = 24): Promise<Creative[]> {
  try {
    const sb = getServiceClient();
    const { data, error } = await sb
      .from("ad_creatives")
      .select(
        "id, brand_slug, vertical, hook_type, hook_text, bridge_text, cta_text, image_url, image_prompt, video_url, video_status, video_provider, t2v_job_id, platform, creative_type, inspired_by, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as Creative[];
  } catch {
    return [];
  }
}

export type HomeStats = { winners: number; creatives: number; videos: number; stories: number };

/** Live counts for the Home dashboard. Defensive — zeros on error. */
export async function getHomeStats(): Promise<HomeStats> {
  try {
    const sb = getServiceClient();
    const head = async (table: string, applyFilter?: boolean) => {
      let q = sb.from(table).select("id", { count: "exact", head: true });
      if (applyFilter) q = q.not("video_url", "is", null);
      const { count } = await q;
      return count ?? 0;
    };
    const [winners, creatives, videos, stories] = await Promise.all([
      head("spy_ads"),
      head("ad_creatives"),
      head("ad_creatives", true),
      head("storyboards"),
    ]);
    return { winners, creatives, videos, stories };
  } catch {
    return { winners: 0, creatives: 0, videos: 0, stories: 0 };
  }
}

export type Storyboard = {
  id: string;
  prompt: string;
  provider: string | null;
  clip_count: number;
  status: string;
  final_video_url: string | null;
  final_status: string | null;
  created_at: string;
};

/** Multi-scene storyboards (their scene clips are ad_creatives with this storyboard_id). */
export async function getStoryboards(limit = 8): Promise<Storyboard[]> {
  try {
    const sb = getServiceClient();
    const { data, error } = await sb
      .from("storyboards")
      .select("id, prompt, provider, clip_count, status, final_video_url, final_status, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as Storyboard[];
  } catch {
    return [];
  }
}

export type Brand = {
  id: string;
  name: string;
  slug: string;
  vertical: string | null;
  brand_voice: string | null;
  content_themes: string[] | null;
  gender_target: string | null;
  age_range: string | null;
  active: boolean;
};

export async function getBrands(): Promise<Brand[]> {
  try {
    const sb = getServiceClient();
    const { data, error } = await sb
      .from("brands")
      .select(
        "id, name, slug, vertical, brand_voice, content_themes, gender_target, age_range, active"
      )
      .order("name");
    if (error || !data) return [];
    return data as Brand[];
  } catch {
    return [];
  }
}

// The `vertical` column is overloaded: pre-crawl it holds the winner badge
// (dominant/proven/scaling/testing); post-crawl it holds the real health
// vertical. Only treat known health verticals as real filter options.
const KNOWN_VERTICALS = new Set(["glp1", "trt", "peptides", "joint_pain"]);

/** Distinct (real) verticals present in the ad data, for filter options. */
export async function getVerticals(): Promise<string[]> {
  try {
    const sb = getServiceClient();
    const { data } = await sb
      .from("spy_ads")
      .select("vertical")
      .not("vertical", "is", null)
      .limit(1000);
    const set = new Set<string>();
    (data || []).forEach((r: Record<string, unknown>) => {
      const v = r.vertical ? String(r.vertical) : "";
      if (KNOWN_VERTICALS.has(v)) set.add(v);
    });
    return [...set].sort();
  } catch {
    return [];
  }
}
