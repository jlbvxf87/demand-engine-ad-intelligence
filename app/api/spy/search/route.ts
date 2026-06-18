import { NextResponse } from 'next/server';
import { isAdminAuthed } from '@/lib/admin-auth';
import { isMachineAuthed } from '@/lib/machine-auth';
import { getServiceClient } from '@/lib/supabase/server';
import { looksLikeUrl } from '@/lib/url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const META_AD_LIBRARY_URL = 'https://graph.facebook.com/v21.0/ads_archive';

// Full field set — potential_reach removed (deprecated in Meta API v13+)
const FIELDS = [
  'id',
  'page_name',
  'page_id',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_captions',
  'ad_creative_link_descriptions',
  'ad_snapshot_url',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'currency',
  'impressions',
  'spend',
  'publisher_platforms',
  'languages',
  'estimated_audience_size',
  'target_ages',
  'target_gender',
  'demographic_distribution',
  'delivery_by_region',
].join(',');

// ─── Scoring ──────────────────────────────────────────────────────────────────

function computeWinnerScore(
  spendLower: number | null,
  spendUpper: number | null,
  impressionsLower: number | null,
  impressionsUpper: number | null,
  daysRunning: number
): number {
  const spendMid = ((spendLower ?? 0) + (spendUpper ?? 0)) / 2;
  const impMid = ((impressionsLower ?? 0) + (impressionsUpper ?? 0)) / 2;
  return spendMid * Math.pow(Math.max(daysRunning, 1) / 30, 0.6) * Math.log10(impMid + 10);
}

function winnerBadge(score: number, daysRunning: number, spendMid: number) {
  if (score > 8000 && daysRunning >= 60 && spendMid >= 10000) return 'dominant';
  if (score > 1500 && daysRunning >= 30 && spendMid >= 2000)  return 'proven';
  if (score > 200  && daysRunning >= 14)                       return 'scaling';
  return 'testing';
}

// ─── Meta ad type ─────────────────────────────────────────────────────────────

type MetaAd = {
  id: string;
  page_name?: string;
  page_id?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_captions?: string[];
  ad_creative_link_descriptions?: string[];
  ad_snapshot_url?: string;
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  currency?: string;
  impressions?: { lower_bound?: string; upper_bound?: string };
  spend?: { lower_bound?: string; upper_bound?: string };
  publisher_platforms?: string[];
  languages?: string[];
  estimated_audience_size?: { lower_bound?: number; upper_bound?: number };
  target_ages?: string[];
  target_gender?: string;
  demographic_distribution?: { age: string; gender: string; percentage: string }[];
  delivery_by_region?: { region: string; percentage: string }[];
  potential_reach?: { lower_bound?: number; upper_bound?: number };
};

type MetaResponse = {
  data: MetaAd[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
};

// ─── Pagination config ────────────────────────────────────────────────────────

// Advertiser (page_id) mode: pull everything — up to 1000 ads
// Keyword mode: pull up to 500 — sorted by winner score client-side
const PAGE_SIZE        = 200;
const MAX_PAGES_PAGE   = 5;   // 1000 ads for full advertiser library
const MAX_PAGES_KEYWORD = 3;  // 600 ads for keyword search
const TIME_BUDGET_MS   = 100_000; // 100s — within maxDuration

// ─── Request body ─────────────────────────────────────────────────────────────

type SearchBody = {
  keyword?: string;
  search_page_ids?: string;
  /**
   * @advertiser alias from the UI (e.g. "Hims"). When present, the route
   * tries to resolve this to a cached page_id from known_advertisers first.
   * Cache miss → keyword-search Meta, pick best page_name match, cache it,
   * and (on future calls) use search_page_ids for true exact-page lookup.
   */
  advertiser_alias?: string;
  country?: string;
  ad_active_status?: 'ACTIVE' | 'ALL' | 'INACTIVE';
  media_type?: 'ALL' | 'VIDEO' | 'IMAGE' | 'NONE';
  publisher_platforms?: string[];
  limit?: number;
  ad_delivery_start_time_min?: number;
};

// ─── Brand → page_id resolver ────────────────────────────────────────────────

function rankPageMatch(pageName: string, brand: string): number {
  const p = pageName.toLowerCase().trim();
  const b = brand.toLowerCase().trim();
  if (!p || !b) return 0;
  if (p === b)                                    return 100;            // exact
  if (p.startsWith(b + ' ') || p.startsWith(b + ',')) return 80;          // "Hims & Hers Health" for "Hims"
  if (p.endsWith(' ' + b))                        return 70;             // "Online Hims"
  if (new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(p)) return 60; // word boundary
  if (p.includes(b))                              return 30;             // substring
  return 0;
}

type ResolvedAdvertiser = {
  alias:        string;
  page_id:      string;
  page_name:    string;
  match_score:  number;
  source:       'cache' | 'auto-resolved';
};

/** Prefer a caption that's a clean URL (no spaces); else the first caption for context. */
function pickDest(captions?: string[]): string | null {
  const list = (captions ?? []).map((c) => (c || '').trim()).filter(Boolean);
  return list.find(looksLikeUrl) ?? list[0] ?? null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  if (!(await isAdminAuthed()) && !isMachineAuthed(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: 'META_ACCESS_TOKEN not configured' },
      { status: 503 }
    );
  }

  const body = (await req.json()) as SearchBody;
  let {
    keyword,
    search_page_ids,
  } = body;
  const {
    advertiser_alias,
    country = 'US',
    ad_active_status = 'ACTIVE',
    media_type = 'ALL',
    publisher_platforms,
    ad_delivery_start_time_min,
  } = body;
  const reachedCountry = (country || 'US').toUpperCase().slice(0, 2);

  if (!keyword?.trim() && !search_page_ids?.trim() && !advertiser_alias?.trim()) {
    return NextResponse.json(
      { error: 'keyword, search_page_ids, or advertiser_alias is required' },
      { status: 400 }
    );
  }

  // ── Brand-alias resolution ────────────────────────────────────────────────
  // When advertiser_alias is provided (e.g. "@Hims" → "Hims"), check the
  // known_advertisers cache first. Cache hit → upgrade to exact-page lookup.
  // Cache miss → fall through to keyword search; we'll auto-cache the best
  // page_name match after results come back.
  let resolution: ResolvedAdvertiser | null = null;
  const supabaseEarly = advertiser_alias ? getServiceClient() : null;

  if (advertiser_alias && supabaseEarly) {
    const alias = advertiser_alias.toLowerCase().trim();
    const { data: cached } = await supabaseEarly
      .from('known_advertisers')
      .select('page_id, page_name, match_score')
      .eq('brand_alias', alias)
      .maybeSingle();

    if (cached) {
      // Cache hit — use TRUE exact-page lookup via search_page_ids
      search_page_ids = cached.page_id;
      keyword = undefined;
      resolution = {
        alias,
        page_id:     cached.page_id,
        page_name:   cached.page_name,
        match_score: cached.match_score,
        source:      'cache',
      };
    } else {
      // Cache miss — use the alias as a keyword for now; we'll resolve
      // and cache after seeing what Meta returns.
      keyword = advertiser_alias;
    }
  }

  const isAdvertiserMode = Boolean(search_page_ids?.trim());
  const maxPages = isAdvertiserMode ? MAX_PAGES_PAGE : MAX_PAGES_KEYWORD;

  // ── Build base params ──────────────────────────────────────────────────────

  const baseParams: Record<string, string> = {
    ad_reached_countries: JSON.stringify([reachedCountry]),
    ad_active_status,
    fields: FIELDS,
    limit: String(PAGE_SIZE),
    access_token: token,
  };

  if (keyword?.trim())         baseParams.search_terms    = keyword.trim();
  if (search_page_ids?.trim()) baseParams.search_page_ids = search_page_ids.trim();
  if (media_type !== 'ALL')    baseParams.media_type      = media_type;

  if (publisher_platforms && publisher_platforms.length > 0) {
    baseParams.publisher_platforms = JSON.stringify(publisher_platforms);
  }

  if (ad_delivery_start_time_min) {
    baseParams.ad_delivery_date_min = new Date(ad_delivery_start_time_min * 1000)
      .toISOString().split('T')[0];
  }

  // ── Pagination loop ────────────────────────────────────────────────────────

  const allAds: MetaAd[] = [];
  let cursor: string | null = null;
  let pagesLoaded = 0;
  let metaError: { status: number; message: string } | null = null;
  let networkError: string | null = null;
  const started = Date.now();

  while (pagesLoaded < maxPages) {
    const params = new URLSearchParams(baseParams);
    if (cursor) params.set('after', cursor);

    let metaRes: Response;
    try {
      metaRes = await fetch(`${META_AD_LIBRARY_URL}?${params.toString()}`);
    } catch (e) {
      networkError = e instanceof Error ? e.message : 'network failure';
      break;
    }

    if (!metaRes.ok) {
      const err = await metaRes.json().catch(() => ({})) as { error?: { message?: string } };
      metaError = { status: metaRes.status, message: err.error?.message ?? 'Meta API error' };
      if (pagesLoaded === 0) {
        // Hard fail on first page — return Meta's error directly so the UI
        // can surface it ("invalid token", "rate limited", etc.)
        return NextResponse.json(
          { error: metaError.message, diagnostic: buildDiagnostic({
            keyword, search_page_ids, ad_active_status, media_type,
            pagesLoaded, elapsedMs: Date.now() - started,
            totalFetched: 0, metaError, networkError,
          }) },
          { status: 502 }
        );
      }
      break;
    }

    const page = await metaRes.json() as MetaResponse;
    const pageAds = page.data ?? [];
    allAds.push(...pageAds);
    pagesLoaded++;

    // Stop conditions
    const nextCursor = page.paging?.cursors?.after ?? null;
    const hasMore = Boolean(page.paging?.next) && nextCursor;
    if (!hasMore || pageAds.length < PAGE_SIZE) break;
    if (Date.now() - started > TIME_BUDGET_MS) break;

    cursor = nextCursor;
  }

  if (allAds.length === 0) {
    const supabase = getServiceClient();
    const searchLabel = keyword?.trim() || `page:${search_page_ids?.trim()}`;
    await supabase.from('spy_searches').insert({ keyword: searchLabel, ad_count: 0 });
    return NextResponse.json({
      ads: [],
      diagnostic: buildDiagnostic({
        keyword, search_page_ids, ad_active_status, media_type,
        pagesLoaded, elapsedMs: Date.now() - started,
        totalFetched: 0, metaError, networkError,
      }),
    });
  }

  // ── Deduplicate by meta_ad_id within this result set ──────────────────────

  const seen = new Set<string>();
  const uniqueAds = allAds.filter(ad => {
    if (seen.has(ad.id)) return false;
    seen.add(ad.id);
    return true;
  });

  // ── Build DB rows ──────────────────────────────────────────────────────────

  const now = Date.now();

  const pageAdCount: Record<string, number> = {};
  for (const ad of uniqueAds) {
    if (ad.page_id) pageAdCount[ad.page_id] = (pageAdCount[ad.page_id] ?? 0) + 1;
  }

  const rows = uniqueAds.map((ad) => {
    const spendLower  = ad.spend?.lower_bound  ? parseInt(ad.spend.lower_bound, 10)  : null;
    const spendUpper  = ad.spend?.upper_bound  ? parseInt(ad.spend.upper_bound, 10)  : null;
    const impLower    = ad.impressions?.lower_bound ? parseInt(ad.impressions.lower_bound, 10) : null;
    const impUpper    = ad.impressions?.upper_bound ? parseInt(ad.impressions.upper_bound, 10) : null;

    const startMs    = ad.ad_delivery_start_time ? new Date(ad.ad_delivery_start_time).getTime() : now;
    const daysRunning = Math.max(0, Math.floor((now - startMs) / 86_400_000));
    const spendMid   = ((spendLower ?? 0) + (spendUpper ?? 0)) / 2;
    const score      = computeWinnerScore(spendLower, spendUpper, impLower, impUpper, daysRunning);
    const badge      = winnerBadge(score, daysRunning, spendMid);

    // Merge publisher_platforms into intelligence_json alongside new fields
    const intelligenceJson: Record<string, unknown> = {};
    if (ad.publisher_platforms?.length) intelligenceJson.publisher_platforms = ad.publisher_platforms;

    return {
      meta_ad_id:               ad.id,
      page_name:                ad.page_name ?? null,
      page_id:                  ad.page_id ?? null,
      ad_body:                  ad.ad_creative_bodies?.[0] ?? null,
      ad_title:                 ad.ad_creative_link_titles?.[0] ?? null,
      ad_snapshot_url:          ad.ad_snapshot_url ?? null,
      destination_url:          pickDest(ad.ad_creative_link_captions),
      impressions_lower:        impLower,
      impressions_upper:        impUpper,
      spend_lower:              spendLower,
      spend_upper:              spendUpper,
      currency:                 ad.currency ?? 'USD',
      delivery_start_time:      ad.ad_delivery_start_time ?? null,
      ad_delivery_stop_time:    ad.ad_delivery_stop_time ?? null,
      crawl_status:             'pending',
      days_running:             daysRunning,
      winner_score:             Math.round(score),
      brand_ad_count:           ad.page_id ? (pageAdCount[ad.page_id] ?? 1) : 1,
      vertical:                 badge,
      // Rich intelligence fields
      demographic_distribution: ad.demographic_distribution ?? null,
      delivery_by_region:       ad.delivery_by_region ?? null,
      potential_reach_lower:    ad.potential_reach?.lower_bound ?? null,
      potential_reach_upper:    ad.potential_reach?.upper_bound ?? null,
      intelligence_json:        Object.keys(intelligenceJson).length ? intelligenceJson : null,
      total_pages_fetched:      pagesLoaded,
    };
  });

  // ── Save to DB ─────────────────────────────────────────────────────────────

  const supabase = getServiceClient();

  // Dedup against what's already stored: only insert ads we don't have yet
  // (matched by meta_ad_id), so re-running a search never piles up duplicates.
  const metaIds = rows.map((r) => r.meta_ad_id).filter(Boolean) as string[];
  const existing = new Set<string>();
  for (let i = 0; i < metaIds.length; i += 200) {
    const { data: ex } = await supabase
      .from('spy_ads')
      .select('meta_ad_id')
      .in('meta_ad_id', metaIds.slice(i, i + 200));
    for (const e of (ex ?? []) as { meta_ad_id: string }[]) existing.add(e.meta_ad_id);
  }
  const newRows = rows.filter((r) => r.meta_ad_id && !existing.has(r.meta_ad_id));
  const alreadyHad = uniqueAds.length - newRows.length;

  const searchLabel = keyword?.trim() || `page:${search_page_ids?.trim()}`;
  const { data: searchRow, error: searchErr } = await supabase
    .from('spy_searches')
    .insert({ keyword: searchLabel, ad_count: uniqueAds.length })
    .select('id')
    .single();

  if (searchErr || !searchRow) {
    return NextResponse.json({ error: 'Failed to save search' }, { status: 500 });
  }

  const rowsWithSearchId = newRows.map(r => ({ ...r, search_id: searchRow.id as string }));

  // Insert in chunks — Supabase has row limits per insert
  const CHUNK = 100;
  const inserted: unknown[] = [];

  for (let i = 0; i < rowsWithSearchId.length; i += CHUNK) {
    const chunk = rowsWithSearchId.slice(i, i + CHUNK);
    const { data, error } = await supabase.from('spy_ads').insert(chunk).select();
    if (error) continue; // skip bad chunks, don't fail the whole search
    if (data) inserted.push(...data);
  }

  // Sort by winner_score descending
  const sorted = [...inserted].sort(
    (a, b) =>
      ((b as { winner_score: number }).winner_score ?? 0) -
      ((a as { winner_score: number }).winner_score ?? 0)
  );

  // ── Auto-resolve: if user typed @BrandName and we don't have a cached
  //    page_id yet, rank the page_names we just got back and cache the
  //    best match. Next call with the same alias will use exact lookup.
  if (advertiser_alias && !resolution && uniqueAds.length > 0) {
    const alias = advertiser_alias.toLowerCase().trim();
    type PageStat = { page_id: string; page_name: string; ad_count: number; score: number };
    const byPage: Record<string, PageStat> = {};
    for (const ad of uniqueAds) {
      if (!ad.page_id || !ad.page_name) continue;
      if (!byPage[ad.page_id]) {
        byPage[ad.page_id] = {
          page_id:   ad.page_id,
          page_name: ad.page_name,
          ad_count:  0,
          score:     rankPageMatch(ad.page_name, alias),
        };
      }
      byPage[ad.page_id].ad_count++;
    }
    // Pick best — primary sort by match score, tiebreak by ad_count
    const candidates = Object.values(byPage)
      .filter(p => p.score >= 30)
      .sort((a, b) => b.score - a.score || b.ad_count - a.ad_count);

    if (candidates.length > 0) {
      const top = candidates[0];
      // Check existing row's override_locked before writing
      const { data: existing } = await supabase
        .from('known_advertisers')
        .select('override_locked')
        .eq('brand_alias', alias)
        .maybeSingle();

      if (!existing?.override_locked) {
        await supabase.from('known_advertisers').upsert({
          brand_alias:     alias,
          page_id:         top.page_id,
          page_name:       top.page_name,
          match_score:     top.score,
          ad_count:        top.ad_count,
          resolved_by:     'auto',
          resolved_at:     new Date().toISOString(),
          override_locked: false,
        }, { onConflict: 'brand_alias' });

        resolution = {
          alias,
          page_id:     top.page_id,
          page_name:   top.page_name,
          match_score: top.score,
          source:      'auto-resolved',
        };
      }
    }
  }

  return NextResponse.json({
    search_id: searchRow.id,
    ads: sorted,
    resolution, // null when not using advertiser_alias, or no match found
    meta: {
      total_fetched: uniqueAds.length,
      added: newRows.length,
      already_had: alreadyHad,
      pages_loaded: pagesLoaded,
      elapsed_ms: Date.now() - started,
    },
    diagnostic: buildDiagnostic({
      keyword, search_page_ids, ad_active_status, media_type,
      pagesLoaded, elapsedMs: Date.now() - started,
      totalFetched: uniqueAds.length, metaError: null, networkError: null,
    }),
  });
}

// ─── Diagnostic ───────────────────────────────────────────────────────────────

/**
 * Builds a structured diagnostic the client can render to explain WHY a
 * search returned the results it did. Surfaces the exact query sent to
 * Meta, the filters applied, what came back, and human-readable suggestions
 * for the most common failure modes.
 */
function buildDiagnostic(opts: {
  keyword?: string;
  search_page_ids?: string;
  ad_active_status: string;
  media_type: string;
  pagesLoaded: number;
  elapsedMs: number;
  totalFetched: number;
  metaError: { status: number; message: string } | null;
  networkError: string | null;
}) {
  const suggestions: string[] = [];

  if (opts.metaError) {
    const m = opts.metaError.message.toLowerCase();
    if (m.includes('access token') || m.includes('oauth')) {
      suggestions.push('META_ACCESS_TOKEN is missing, expired, or invalid — regenerate in the Meta Developer console and update Vercel env.');
    } else if (m.includes('rate') || m.includes('limit')) {
      suggestions.push('You hit Meta\'s rate limit — wait 5 minutes and try again.');
    } else if (m.includes('does not exist') || m.includes('cannot be loaded')) {
      suggestions.push('Meta does not recognize this page or query — check the exact spelling.');
    } else {
      suggestions.push(`Meta returned: "${opts.metaError.message}". This is from Meta\'s API, not from us.`);
    }
  } else if (opts.networkError) {
    suggestions.push(`Network error reaching Meta: ${opts.networkError}. Retry in a moment.`);
  } else if (opts.totalFetched === 0) {
    if (opts.ad_active_status === 'ACTIVE') {
      suggestions.push('Try Status = "All" — this brand may have paused their ads recently.');
    }
    if (opts.media_type !== 'ALL') {
      suggestions.push(`Try Format = "All" — current filter is ${opts.media_type} only.`);
    }
    if (opts.keyword && opts.keyword.length > 20) {
      suggestions.push('Try a shorter keyword (1–3 words). Long queries return fewer matches.');
    }
    if (opts.keyword && opts.keyword.split(' ').length === 1) {
      suggestions.push(`Try the @advertiser form: "@${opts.keyword}" — forces a page-name lookup.`);
    }
    if (opts.search_page_ids) {
      suggestions.push('Meta could not find ads for this page ID. Verify the page exists and is currently advertising.');
    }
  }

  if (opts.totalFetched > 0 && opts.totalFetched < 10) {
    suggestions.push('Very few results — try a broader keyword or relax filters to see more.');
  }

  return {
    query_sent: {
      keyword:         opts.keyword ?? null,
      search_page_ids: opts.search_page_ids ?? null,
    },
    filters_applied: {
      ad_active_status: opts.ad_active_status,
      media_type:       opts.media_type,
    },
    api_call: {
      pages_fetched:  opts.pagesLoaded,
      elapsed_ms:     opts.elapsedMs,
      meta_error:     opts.metaError,
      network_error:  opts.networkError,
    },
    result: {
      total_fetched: opts.totalFetched,
      reason:
        opts.metaError      ? 'meta_error' :
        opts.networkError   ? 'network_error' :
        opts.totalFetched === 0 ? 'no_matches' :
        'ok',
    },
    suggestions,
  };
}
