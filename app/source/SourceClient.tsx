"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight, ExternalLink, Loader2, CornerDownRight, Download, SlidersHorizontal } from "lucide-react";
import {
  ScreenHeader,
  Card,
  Badge,
  WinnerBadge,
  EmptyState,
  Modal,
  Stat,
} from "@/components/ui";
import AdThumb from "@/components/AdThumb";
import { compact, money, verticalLabel, initials } from "@/lib/format";
import { toSiteUrl, toDomain } from "@/lib/url";
import { adHook, metaAdUrl } from "@/lib/ad";
import { isIndependent } from "@/lib/targeting";
import { searchAds, fetchCreative, searchByPage, loadCreatives, recreate, sourceFromLink, findSavedAds, loadSearchAds } from "@/app/actions";
import type { Advertiser, AdRow, IdentityRollup, ScaledWinner, SearchBatch } from "@/lib/data";

const ACCENT = "var(--color-source)";

const COUNTRIES = [
  { value: "US", label: "United States" },
  { value: "GB", label: "United Kingdom" },
  { value: "CA", label: "Canada" },
  { value: "AU", label: "Australia" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "BR", label: "Brazil" },
  { value: "IN", label: "India" },
  { value: "MX", label: "Mexico" },
];

/** Pill-styled native dropdown for the advanced filter bar. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] font-semibold">
      <span className="text-[var(--color-ink-muted)]">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent font-bold text-[var(--color-ink)] outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Reconstructed Facebook-style ad card (ported from v1). Meta blocks embedding
 * the real creative (X-Frame-Options: DENY) and the API returns no media URL —
 * so we rebuild the ad from its text fields + a live landing-page screenshot
 * (crawled page_screenshot_url, else a thum.io shot of the destination).
 */
function FacebookAdPreview({ ad }: { ad: AdRow }) {
  const abs = toSiteUrl(ad.destination_url);
  const hook = adHook(ad.ad_body, ad.ad_title, ad.page_headline);
  const previewImg = ad.page_screenshot_url;
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-white">
      <div className="flex items-center gap-2.5 px-3 pt-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[12px] font-extrabold text-[var(--color-accent)]">
          {initials(ad.page_name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-bold">{ad.page_name || "Advertiser"}</p>
          <p className="text-[11px] text-[var(--color-ink-muted)]">Sponsored · {ad.days_running}d running</p>
        </div>
      </div>
      {hook ? (
        <p className="whitespace-pre-wrap px-3 pb-2 pt-2 text-[13px] leading-relaxed line-clamp-6">{hook}</p>
      ) : (
        <p className="px-3 pb-2 pt-2 text-[12.5px] italic leading-relaxed text-[var(--color-ink-muted)]">
          Meta doesn’t expose this ad’s copy (it’s disabled or undisclosed). Open the real ad on Meta, or
          “Load real creative” below to pull the actual image/video.
        </p>
      )}
      {ad.creative_media_url ? (
        ad.creative_media_type === "video" ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={ad.creative_media_url}
            controls
            playsInline
            className="max-h-[440px] w-full bg-black object-contain"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ad.creative_media_url} alt="ad creative" className="max-h-[440px] w-full bg-black object-contain" />
        )
      ) : previewImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewImg} alt="landing preview" className="max-h-[360px] w-full object-cover" />
      ) : (
        <div className="grid aspect-[1.91/1] place-items-center bg-[var(--color-surface-2)] text-[12px] text-[var(--color-ink-muted)]">
          No image — tap “View ad on Meta”
        </div>
      )}
      <div className="flex items-center justify-between gap-2 bg-[var(--color-surface-2)] px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-bold">
            {ad.page_headline || ad.ad_title || ad.page_name}
          </p>
          {abs && (
            <p className="truncate text-[11px] uppercase tracking-wide text-[var(--color-ink-muted)]">
              {toDomain(ad.destination_url)}
            </p>
          )}
        </div>
        <span className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-[11px] font-bold shadow-sm">
          {ad.page_cta || "Learn More"}
        </span>
      </div>
    </div>
  );
}

/** One ad row — used by the All-ads list and the Searches batch view. `selectable`
 *  adds the bulk-recreate checkbox (All-ads only). */
function AdRowCard({
  c,
  active,
  selectable = false,
  selected = false,
  onToggle,
  onOpen,
}: {
  c: AdRow;
  active: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  onOpen: () => void;
}) {
  const hook = adHook(c.ad_body, c.ad_title, c.page_headline);
  const dom = toDomain(c.destination_url);
  const meta = metaAdUrl(c.meta_ad_id);
  return (
    <Card className="flex items-center gap-3 p-3" accent={selected || active ? ACCENT : undefined}>
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-source)]"
          title="Select to recreate"
        />
      )}
      <AdThumb
        src={(c.creative_media_type === "image" ? c.creative_media_url : null) || c.page_screenshot_url}
        name={c.page_name}
        size={56}
      />
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className="truncate text-[14px] font-bold">{c.page_name || "Advertiser"}</p>
        <p className="truncate text-[12px] text-[var(--color-ink-muted)]">
          {dom || "destination not public"} · {c.days_running}d
        </p>
        {hook ? (
          <p className="mt-0.5 line-clamp-1 text-[12px]">{hook}</p>
        ) : (
          <p className="mt-0.5 truncate text-[12px] italic text-[var(--color-ink-muted)]">
            copy not public — open on Meta
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-2">
          <WinnerBadge badge={c.badge} />
          <span className="text-[11.5px] font-semibold text-[var(--color-ink-muted)]">
            Score {Math.round(c.winner_score)}
          </span>
        </div>
      </button>
      {meta && (
        <a
          href={meta}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 flex-col items-center gap-0.5"
          title="Open the real ad on Meta"
          style={{ color: ACCENT }}
        >
          <ExternalLink size={18} />
          <span className="text-[9px] font-bold">Meta</span>
        </a>
      )}
    </Card>
  );
}

/** "Jun 21, 2026 · 6:09 AM"-style stamp for a search batch. */
function fmtSearchDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

const SEARCH_BUCKETS = ["Today", "Yesterday", "Earlier this week", "Earlier"] as const;
type SearchBucket = (typeof SEARCH_BUCKETS)[number];

/** Which day-group a search falls into, relative to now (local time). */
function dateBucket(iso: string): SearchBucket {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day0 - d0) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff <= 6) return "Earlier this week";
  return "Earlier";
}

/** One past-search row in the Searches view. */
function SearchRow({ s, onOpen }: { s: SearchBatch; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-3 text-left shadow-[0_1px_2px_rgba(16,21,27,0.03)] transition-all duration-150 hover:-translate-y-0.5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Search size={17} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[14px] font-bold">{s.keyword}</p>
          <p className="text-[11.5px] text-[var(--color-ink-muted)]">{fmtSearchDate(s.created_at)}</p>
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        <span
          className="rounded-lg bg-[var(--color-accent-soft)] px-2.5 py-1 text-[12px] font-bold tabular-nums"
          style={{ color: ACCENT }}
        >
          {compact(s.ad_count)} ads
        </span>
        <ArrowRight size={16} className="text-[var(--color-ink-muted)]" />
      </span>
    </button>
  );
}

export default function SourceClient({
  advertisers,
  creatives,
  identity,
  scaled,
  verticals,
  creativesTotal,
  searches,
}: {
  advertisers: Advertiser[];
  creatives: AdRow[];
  identity: IdentityRollup[];
  scaled: ScaledWinner[];
  verticals: string[];
  creativesTotal: number;
  searches: SearchBatch[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState("searches"); // default = your searches, today first
  const [sort, setSort] = useState<"recent" | "top">("recent");
  const [optionsOpen, setOptionsOpen] = useState(false); // Meta-search options (country/status/…)
  const [linkOpen, setLinkOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState(""); // find a past search (Searches view)
  const [vertical, setVertical] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("US");
  const [status, setStatus] = useState<"ACTIVE" | "ALL" | "INACTIVE">("ACTIVE");
  const [media, setMedia] = useState<"ALL" | "VIDEO" | "IMAGE">("ALL");
  const [windowDays, setWindowDays] = useState(0); // 0 = any time
  const [platform, setPlatform] = useState(""); // "" = all platforms
  const [detail, setDetail] = useState<AdRow | null>(null);
  const [advDetail, setAdvDetail] = useState<Advertiser | null>(null);
  const [loadingCreative, setLoadingCreative] = useState(false);
  const [pullingAds, setPullingAds] = useState(false);
  const [extraCreatives, setExtraCreatives] = useState<AdRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [independentOnly, setIndependentOnly] = useState(true);
  const [recreating, setRecreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [linkInput, setLinkInput] = useState("");
  const [sourcing, setSourcing] = useState(false);
  const [libQuery, setLibQuery] = useState("");
  const [libResults, setLibResults] = useState<AdRow[] | null>(null); // null = browsing, [] = no matches
  const [libSearching, setLibSearching] = useState(false);
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  // Searches tab — view ONE search batch (by search_id) on its own.
  const [activeSearch, setActiveSearch] = useState<SearchBatch | null>(null);
  const [batchAds, setBatchAds] = useState<AdRow[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);

  // Search ads ALREADY in the library (server-side, across ALL of them — not just
  // the loaded page). Drives the primary top search box; jumps to the All-ads
  // tab to show the matches.
  async function findInLibrary(q?: string) {
    const term = (q ?? libQuery).trim();
    if (!term) {
      setLibResults(null);
      return;
    }
    setQuery(term);
    setLibQuery(term);
    setTab("creatives");
    setNote(null);
    setLibSearching(true);
    const r = await findSavedAds(term);
    setLibSearching(false);
    setLibResults(r.ok && r.rows ? r.rows : []);
  }
  function clearLibSearch() {
    setLibQuery("");
    setLibResults(null);
  }

  // Paste a Meta Ad Library link → source that exact ad → open it (Recreate/Decode).
  async function sourceLink() {
    if (!linkInput.trim()) return;
    setSourcing(true);
    setNote(null);
    const r = await sourceFromLink(linkInput.trim());
    setSourcing(false);
    if (!r.ok) {
      setNote(r.error || "Couldn't source that link");
      return;
    }
    const payload = r.data as { ad?: AdRow; existed?: boolean };
    if (payload?.ad) {
      setLinkInput("");
      setNote(
        payload.existed
          ? `“${payload.ad.page_name}” is already in your library — opening it.`
          : `Sourced “${payload.ad.page_name}”. Recreate or decode it below.`,
      );
      setDetail(payload.ad);
      router.refresh();
    }
  }

  // Recreate a winner on-brand: draft copy + stage the creative as the visual
  // reference, then drop into Create to refine / render.
  async function runRecreate(ad: AdRow) {
    if (recreating) return; // guard against double-fire (paid generation)
    setRecreating(true);
    setNote(null);
    const r = await recreate(ad.id);
    setRecreating(false);
    if (!r.ok) {
      setNote(r.error || "Recreate failed");
      return;
    }
    const ref = ad.creative_media_type === "image" ? ad.creative_media_url : null;
    const hook = adHook(ad.ad_body, ad.ad_title, ad.page_headline);
    const qs = new URLSearchParams();
    if (ref) qs.set("ref", ref);
    if (hook) qs.set("prompt", `Recreate this winning angle for our brand: ${hook.slice(0, 180)}`);
    router.push(`/publish${qs.toString() ? `?${qs}` : ""}`);
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Bulk: draft on-brand copy for each selected winner, then open Create.
  // recreate() is expensive (landing crawl + Claude generation + DB writes per
  // ad), so run with bounded concurrency and cap runaway bulk selections.
  async function recreateSelected() {
    if (recreating) return; // guard against double-fire (paid generation)
    let ids = [...selected];
    if (!ids.length) return;

    // Guard against runaway bulk — recreate is AI + crawl per ad.
    const MAX_BULK = 12;
    const capped = ids.length > MAX_BULK;
    if (capped) ids = ids.slice(0, MAX_BULK);

    setRecreating(true);
    setNote(
      capped
        ? "Recreating the first 12; select fewer for the rest."
        : null,
    );

    // Bounded concurrency: process ids in chunks of 3 via Promise.all.
    const CONCURRENCY = 3;
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const chunk = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (id) => {
          try {
            const r = await recreate(id);
            return r.ok;
          } catch {
            return false;
          }
        }),
      );
      for (const success of results) success ? ok++ : failed++;
    }

    setRecreating(false);
    setSelected(new Set());
    setNote(`Drafted on-brand versions for ${ok} of ${ids.length} selected ads.`);
    router.push("/publish");
  }

  const vFilter = (v: string | null) => vertical === "all" || v === vertical;
  // Skip market leaders + advocacy/media unless the user turns the toggle off.
  const indOk = (r: { page_name: string | null; destination_url?: string | null; spend_lower?: number | null; spend_upper?: number | null }) =>
    !independentOnly || isIndependent(r);

  // creatives prop (top 60) + any pages loaded via "Load more"
  const allCreatives = useMemo(() => [...creatives, ...extraCreatives], [creatives, extraCreatives]);
  const adv = useMemo(
    () => advertisers.filter((a) => vFilter(a.vertical) && indOk({ page_name: a.page_name, destination_url: a.topDomain })),
    [advertisers, vertical, independentOnly],
  );
  const crv = useMemo(
    () => (libResults !== null ? libResults : allCreatives).filter((a) => vFilter(a.vertical) && indOk(a)),
    [libResults, allCreatives, vertical, independentOnly],
  );
  // Recent-first by default (lowest days_running = most recently launched);
  // "Top winners" keeps the winner-score order.
  const crvSorted = useMemo(() => {
    const arr = [...crv];
    arr.sort((a, b) => (sort === "recent" ? a.days_running - b.days_running : b.winner_score - a.winner_score));
    return arr;
  }, [crv, sort]);
  // Meta-search options that differ from the defaults (shown as a count on the
  // "Search options" button). These configure the live Meta pull, not the ads list.
  const optionCount = [
    country !== "US",
    status !== "ACTIVE",
    media !== "ALL",
    windowDays !== 0,
    platform !== "",
  ].filter(Boolean).length;

  // Searches view: filter by keyword, then bucket newest-first by day.
  const searchGroups = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    const filtered = q ? searches.filter((s) => s.keyword.toLowerCase().includes(q)) : searches;
    const byBucket = new Map<SearchBucket, SearchBatch[]>(SEARCH_BUCKETS.map((b) => [b, []]));
    for (const s of filtered) byBucket.get(dateBucket(s.created_at))!.push(s);
    const groups = SEARCH_BUCKETS.map((b) => ({ label: b, items: byBucket.get(b)! })).filter((g) => g.items.length > 0);
    return { count: filtered.length, groups };
  }, [searches, searchFilter]);
  const scaledF = useMemo(
    () => scaled.filter((w) => indOk(w.ad)),
    [scaled, independentOnly],
  );
  // Batch ads run through the same Vertical / Independent filters as the rest.
  const batchF = useMemo(
    () => batchAds.filter((a) => vFilter(a.vertical) && indOk(a)),
    [batchAds, vertical, independentOnly],
  );
  // A search's ads, sorted by the toolbar choice (most recent by default).
  const batchSorted = useMemo(() => {
    const arr = [...batchF];
    arr.sort((a, b) => (sort === "recent" ? a.days_running - b.days_running : b.winner_score - a.winner_score));
    return arr;
  }, [batchF, sort]);

  // Open one search batch: load only the ads tagged with its search_id.
  async function openSearch(s: SearchBatch) {
    setActiveSearch(s);
    setBatchAds([]);
    setBatchLoading(true);
    const r = await loadSearchAds(s.id);
    setBatchLoading(false);
    setBatchAds(r.ok && r.rows ? r.rows : []);
  }

  // Prune the bulk-select Set to only ads still visible in the rendered list
  // (crv). The list changes on Load more, the "Independent only" toggle, and
  // library-search swaps — without this, recreateSelected() could fire expensive
  // paid recreate() calls on ads the user can no longer see. Only setState when
  // something actually changed to avoid a render loop.
  useEffect(() => {
    const visible = new Set(crv.map((c) => c.id));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [crv]);
  const byId = useMemo(() => new Map(allCreatives.map((c) => [c.id, c])), [allCreatives]);
  const moreAvailable = libResults === null && allCreatives.length < creativesTotal && !exhausted;

  async function loadMoreCreatives() {
    setLoadingMore(true);
    const r = await loadCreatives(allCreatives.length, 100);
    setLoadingMore(false);
    if (r.ok && r.rows) {
      if (r.rows.length === 0) setExhausted(true);
      else setExtraCreatives((prev) => [...prev, ...r.rows!]);
    }
  }

  function runSearch() {
    if (!query.trim()) {
      setNote("Type a keyword (brand, product, or offer) to search Meta — the filters below refine it.");
      return;
    }
    setNote(null);
    startTransition(async () => {
      const r = await searchAds(query.trim(), { country, status, media, windowDays, platform });
      if (!r.ok) {
        setNote(r.error || "Search failed");
        return;
      }
      const m = (r.data as { meta?: { total_fetched?: number; added?: number } })?.meta;
      if (m) {
        setNote(
          m.added
            ? `Found ${m.total_fetched} ads — ${m.added} new added (the rest were already saved).`
            : `Found ${m.total_fetched} ads — all already in your app, no duplicates added.`,
        );
      }
      // Land directly in the ads this pull brought back (its new search batch).
      const sid = (r.data as { search_id?: string })?.search_id;
      if (sid) {
        openSearch({
          id: sid,
          keyword: query.trim(),
          ad_count: m?.total_fetched ?? 0,
          created_at: new Date().toISOString(),
        });
      }
      router.refresh();
    });
  }

  async function loadCreative() {
    if (!detail) return;
    setLoadingCreative(true);
    setNote(null);
    const r = await fetchCreative(detail.id);
    setLoadingCreative(false);
    if (!r.ok) {
      setNote(r.error || "Couldn't load creative");
      return;
    }
    const d = (r.data || {}) as { media_url?: string; media_type?: string };
    if (d.media_url) {
      setDetail({ ...detail, creative_media_url: d.media_url, creative_media_type: d.media_type ?? null });
    } else {
      setNote("No creative found on Meta's page for this ad.");
    }
  }

  function toDecode(id: string) {
    router.push(`/decode?ad=${id}`);
  }

  async function pullAllAds(pageId: string) {
    setPullingAds(true);
    setNote(null);
    const r = await searchByPage(pageId);
    setPullingAds(false);
    if (!r.ok) {
      setNote(r.error || "Couldn't pull their ads");
      return;
    }
    const m = (r.data as { meta?: { total_fetched?: number; added?: number } } | undefined)?.meta;
    const total = m?.total_fetched ?? 0;
    const added = m?.added ?? 0;
    setAdvDetail(null);
    setNote(
      total === 0
        ? "No ads found for this brand on Meta right now — they may have paused them."
        : added > 0
          ? `Pulled ${added} new ad${added === 1 ? "" : "s"} (${total} matched; the rest were already saved).`
          : `All ${total} of their ads were already in your app — nothing new to add.`,
    );
    router.refresh();
  }

  return (
    <div>
      <ScreenHeader
        title="Source"
        subtitle="Find winning ads from the Meta Ad Library."
        badge="live"
        badgeTone="source"
      />

      {/* Search NEW ads from the live Meta Ad Library */}
      <div className="mb-2 flex items-center gap-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-3">
        <Search size={18} className="text-[var(--color-ink-muted)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder="Search new ads from Meta — topic, brand, or offer…"
          className="w-full bg-transparent text-[15px] outline-none placeholder:text-[var(--color-ink-muted)]"
        />
        <button
          onClick={runSearch}
          disabled={pending || !query.trim()}
          title={query.trim() ? `Pull "${query.trim()}" fresh from the Meta Ad Library` : "Type a topic, brand, or offer"}
          className="flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[13px] font-bold text-white disabled:opacity-40"
          style={{ background: ACCENT }}
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Search Meta
        </button>
      </div>

      {/* Meta-search options + source-from-a-link */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setOptionsOpen((v) => !v)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-pill)] border px-3 py-1.5 text-[12.5px] font-bold"
          style={
            optionsOpen || optionCount > 0
              ? { borderColor: ACCENT, color: ACCENT }
              : { borderColor: "var(--color-line)", color: "var(--color-ink-muted)" }
          }
        >
          <SlidersHorizontal size={13} /> Search options{optionCount > 0 ? ` · ${optionCount}` : ""}
        </button>
        <button
          onClick={() => setLinkOpen((v) => !v)}
          title="Source one ad straight from a Meta ad-library link"
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--color-line)] px-3 py-1.5 text-[12.5px] font-bold text-[var(--color-ink-muted)]"
        >
          <ExternalLink size={13} /> From a link
        </button>
      </div>

      {/* Search options (collapsible) — these configure the Meta pull */}
      {optionsOpen && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
          <FilterSelect label="Country" value={country} onChange={setCountry} options={COUNTRIES} />
          <FilterSelect
            label="Status"
            value={status}
            onChange={(v) => setStatus(v as "ACTIVE" | "ALL" | "INACTIVE")}
            options={[
              { value: "ACTIVE", label: "Active" },
              { value: "ALL", label: "All" },
              { value: "INACTIVE", label: "Inactive" },
            ]}
          />
          <FilterSelect
            label="Media"
            value={media}
            onChange={(v) => setMedia(v as "ALL" | "VIDEO" | "IMAGE")}
            options={[
              { value: "ALL", label: "All" },
              { value: "VIDEO", label: "Video" },
              { value: "IMAGE", label: "Image" },
            ]}
          />
          <FilterSelect
            label="Window"
            value={String(windowDays)}
            onChange={(v) => setWindowDays(Number(v))}
            options={[
              { value: "0", label: "Any time" },
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
            ]}
          />
          <FilterSelect
            label="Platform"
            value={platform}
            onChange={setPlatform}
            options={[
              { value: "", label: "All" },
              { value: "facebook", label: "Facebook" },
              { value: "instagram", label: "Instagram" },
            ]}
          />
          <span className="w-full px-1 text-[11px] text-[var(--color-ink-muted)]">
            These refine your <b className="text-[var(--color-ink)]">Meta search</b> (the live pull). Filtering your existing ads is on the Ads view.
          </span>
        </div>
      )}

      {/* Source one ad from a Meta link (collapsible) */}
      {linkOpen && (
        <div className="mb-3 flex items-center gap-2 rounded-2xl border border-dashed border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-2.5">
          <ExternalLink size={16} className="shrink-0 text-[var(--color-ink-muted)]" />
          <input
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sourceLink()}
            placeholder="Paste a Meta ad-library link (…/ads/library/?id=…)"
            className="w-full bg-transparent text-[13.5px] outline-none placeholder:text-[var(--color-ink-muted)]"
          />
          <button
            onClick={sourceLink}
            disabled={sourcing || !linkInput.trim()}
            className="flex shrink-0 items-center gap-1 rounded-xl border border-[var(--color-line)] px-3 py-1.5 text-[12.5px] font-bold disabled:opacity-40"
          >
            {sourcing ? <Loader2 size={13} className="animate-spin" /> : "Source ad"}
          </button>
        </div>
      )}

      {note && (
        <p className="mb-3 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
          {note}
        </p>
      )}

      {/* No tabs: Source is your searches (tap one → its ads). */}

      {/* ── Scaled winners (duplication = proven) ───────────────────────── */}
      {tab === "scaled" &&
        (scaledF.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No scaled winners yet"
            hint="Search, or “Pull all their ads” on a brand — creatives an operator runs over and over (across many ads / landing pages) surface here."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {scaledF.map((w) => {
              const hook = adHook(w.ad.ad_body, w.ad.ad_title, w.ad.page_headline);
              const dom = toDomain(w.ad.destination_url);
              const meta = metaAdUrl(w.ad.meta_ad_id);
              return (
                <div
                  key={w.key}
                  className="flex flex-col rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[0_1px_2px_rgba(16,21,27,0.03),0_10px_28px_-16px_rgba(16,21,27,0.12)] transition-all duration-200 hover:-translate-y-0.5"
                >
                  <button onClick={() => setDetail(w.ad)} className="flex flex-col gap-2 p-3.5 text-left">
                    {/* Brand + product */}
                    <div className="flex items-center gap-2.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--color-accent-soft)] text-[12px] font-extrabold text-[var(--color-accent)]">
                        {initials(w.ad.page_name)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-bold">{w.ad.page_name || "Advertiser"}</p>
                        <p className="truncate text-[11.5px] text-[var(--color-ink-muted)]">
                          {dom ? `sells via ${dom}` : "destination not public"}
                        </p>
                      </div>
                    </div>
                    {/* Real creative hook */}
                    {hook ? (
                      <p className="line-clamp-3 text-[13px] leading-snug">{hook}</p>
                    ) : (
                      <p className="text-[12.5px] italic text-[var(--color-ink-muted)]">
                        Copy not public — open the real ad to see the creative.
                      </p>
                    )}
                    {/* Proof of scale */}
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone="source">{w.adCount}× ads</Badge>
                      {w.landingPages > 1 && <Badge tone="neutral">{w.landingPages} landing pages</Badge>}
                      {w.advertisers > 1 && <Badge tone="neutral">{w.advertisers} advertisers</Badge>}
                      <Badge tone="neutral">{w.maxDays}d live</Badge>
                    </div>
                  </button>
                  {/* Footer actions (anchor kept outside the button) */}
                  <div className="flex items-center justify-between gap-2 border-t border-[var(--color-line)] px-3.5 py-2">
                    {meta ? (
                      <a
                        href={meta}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-[12.5px] font-bold"
                        style={{ color: ACCENT }}
                      >
                        <ExternalLink size={14} /> Open real ad on Meta
                      </a>
                    ) : (
                      <span className="text-[12px] text-[var(--color-ink-muted)]">No Meta link</span>
                    )}
                    <button
                      onClick={() => setDetail(w.ad)}
                      className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-[var(--color-ink-muted)]"
                    >
                      Inspect <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}

      {/* ── Advertisers ─────────────────────────────────────────────────── */}
      {tab === "advertisers" &&
        (adv.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No advertisers yet"
            hint="Run a search above to pull winners from the Meta Ad Library."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {adv.map((a, i) => (
              <button
                key={a.page_id || a.page_name || i}
                onClick={() => setAdvDetail(a)}
                className="flex flex-col gap-2.5 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5 text-left shadow-[0_1px_2px_rgba(16,21,27,0.03),0_10px_28px_-16px_rgba(16,21,27,0.12)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(16,21,27,0.04),0_18px_40px_-20px_rgba(16,21,27,0.20)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--color-accent-soft)] text-[14px] font-extrabold text-[var(--color-accent)]">
                      {initials(a.page_name)}
                    </span>
                    <div className="min-w-0">
                      <span className="flex items-center gap-1.5 truncate text-[13.5px] font-bold">
                        {a.page_name}
                        {a.isPersona && (
                          <span className="shrink-0 rounded bg-[var(--color-decode-soft)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--color-decode)]">
                            PERSONA
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-[var(--color-ink-muted)]">
                        {a.topDomain || "destination not public"}
                      </span>
                    </div>
                  </div>
                  <WinnerBadge badge={a.badge} />
                </div>
                {a.topCreative && (
                  <p className="line-clamp-2 text-[12px] leading-snug text-[var(--color-ink-muted)]">
                    {a.topCreative}
                  </p>
                )}
                <div className="mt-auto flex items-center justify-between border-t border-[var(--color-line)] pt-2 text-[11.5px]">
                  <span className="font-semibold text-[var(--color-ink-muted)]">
                    {compact(a.activeAds)} ads
                  </span>
                  <span className="font-bold tabular-nums" style={{ color: ACCENT }}>
                    Score {Math.round(a.maxScore)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        ))}

      {/* ── Creatives (your saved library) ──────────────────────────────── */}
      {tab === "creatives" && (
        <div className="flex flex-col gap-3">
          {/* Filter / sort the ads you've ALREADY pulled (not the Meta search) */}
          {crv.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <FilterSelect
                label="Sort"
                value={sort}
                onChange={(v) => setSort(v as "recent" | "top")}
                options={[
                  { value: "recent", label: "Most recent" },
                  { value: "top", label: "Top winners" },
                ]}
              />
              <FilterSelect
                label="Vertical"
                value={vertical}
                onChange={setVertical}
                options={[
                  { value: "all", label: "All" },
                  ...verticals.map((v) => ({ value: v, label: verticalLabel(v) })),
                ]}
              />
              <button
                onClick={() => setIndependentOnly((v) => !v)}
                title="Hide market leaders and advocacy/issue ads — show only independent operators"
                className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] border px-3 py-1.5 text-[12.5px] font-bold"
                style={
                  independentOnly
                    ? { background: ACCENT, color: "white", borderColor: ACCENT }
                    : { borderColor: "var(--color-line)", color: "var(--color-ink-muted)" }
                }
              >
                {independentOnly ? "✓ Independent only" : "Independent only"}
              </button>
            </div>
          )}
          {crv.length === 0 ? (
            libResults !== null ? (
              // Seamless: no saved match → one tap pulls this term live from Meta.
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--color-line)] bg-[var(--color-surface)] px-6 py-12 text-center">
                <Search size={24} className="text-[var(--color-ink-muted)]" />
                <p className="text-[15px] font-bold">No saved ads match “{libQuery}”.</p>
                <p className="max-w-sm text-[12.5px] text-[var(--color-ink-muted)]">
                  Pull fresh ads for this term straight from the Meta Ad Library.
                </p>
                <button
                  onClick={runSearch}
                  disabled={pending}
                  className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[14px] font-bold text-white disabled:opacity-60"
                  style={{ background: ACCENT }}
                >
                  {pending ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  Pull “{libQuery}” from Meta
                </button>
                <button onClick={clearLibSearch} className="text-[12px] font-semibold text-[var(--color-ink-muted)]">
                  or clear and browse all
                </button>
              </div>
            ) : (
              <EmptyState
                icon={Search}
                title="No ads yet"
                hint="Search above, or Pull from Meta to populate your library."
              />
            )
          ) : (
            <>
              <p className="px-1 text-[11.5px] text-[var(--color-ink-muted)]">
                {libResults !== null
                  ? `${crv.length.toLocaleString()} match${crv.length === 1 ? "" : "es"} for “${libQuery}” in your library.`
                  : `Showing ${crv.length.toLocaleString()} of ${allCreatives.length.toLocaleString()} loaded (${creativesTotal.toLocaleString()} total).${
                      independentOnly && allCreatives.length - crv.length > 0
                        ? ` ${(allCreatives.length - crv.length).toLocaleString()} hidden by “Independent only”.`
                        : ""
                    } Tick a box to select, then recreate.`}
              </p>
              {crvSorted.map((c) => (
                <AdRowCard
                  key={c.id}
                  c={c}
                  active={detail?.id === c.id}
                  selectable
                  selected={selected.has(c.id)}
                  onToggle={() => toggleSelect(c.id)}
                  onOpen={() => setDetail(c)}
                />
              ))}
            {moreAvailable ? (
              <button
                onClick={loadMoreCreatives}
                disabled={loadingMore}
                className="mt-1 flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--color-line)] px-5 py-3 text-[13.5px] font-bold disabled:opacity-60"
              >
                {loadingMore ? (
                  <>
                    <Loader2 size={15} className="animate-spin" /> Loading more…
                  </>
                ) : (
                  `Load more (${(creativesTotal - allCreatives.length).toLocaleString()} more)`
                )}
              </button>
            ) : libResults === null ? (
              <p className="py-1 text-center text-[11.5px] text-[var(--color-ink-muted)]">
                That’s all {creativesTotal.toLocaleString()} ads.
              </p>
            ) : null}
            {/* Selection → recreate bar */}
            {selected.size > 0 && (
              <div className="sticky bottom-2 z-10 mt-1 flex items-center justify-between gap-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 shadow-[0_8px_30px_-8px_rgba(16,21,27,0.30)]">
                <span className="text-[13px] font-bold">{selected.size} selected</span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setSelected(new Set())}
                    className="text-[12.5px] font-semibold text-[var(--color-ink-muted)]"
                  >
                    Clear
                  </button>
                  <button
                    onClick={recreateSelected}
                    disabled={recreating}
                    className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-bold text-white disabled:opacity-60"
                    style={{ background: ACCENT }}
                  >
                    {recreating ? (
                      <>
                        <Loader2 size={14} className="animate-spin" /> Drafting…
                      </>
                    ) : (
                      `Recreate ${selected.size} on-brand`
                    )}
                  </button>
                </div>
              </div>
            )}
            </>
          )}
        </div>
      )}

      {/* ── Searches (one batch at a time, by search_id) ─────────────────── */}
      {tab === "searches" &&
        (activeSearch ? (
          <div className="flex flex-col gap-3">
            {/* Batch header */}
            <div className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-bold">{activeSearch.keyword}</p>
                <p className="text-[11.5px] text-[var(--color-ink-muted)]">
                  {fmtSearchDate(activeSearch.created_at)} · pulled {compact(activeSearch.ad_count)} ads
                </p>
              </div>
              <button
                onClick={() => {
                  setActiveSearch(null);
                  setBatchAds([]);
                }}
                className="shrink-0 rounded-xl border border-[var(--color-line)] px-3 py-1.5 text-[12.5px] font-bold"
              >
                ← All searches
              </button>
            </div>

            {batchLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--color-ink-muted)]">
                <Loader2 size={16} className="animate-spin" /> Loading this batch…
              </div>
            ) : batchF.length === 0 ? (
              <EmptyState
                icon={Search}
                title="Nothing to show from this search"
                hint={
                  independentOnly
                    ? "Its ads may be hidden by “Independent only,” or none are still saved. Toggle it off above."
                    : "This search’s ads are no longer in your library."
                }
              />
            ) : (
              <>
                {/* Sort / filter the ads inside this search */}
                <div className="flex flex-wrap items-center gap-2">
                  <FilterSelect
                    label="Sort"
                    value={sort}
                    onChange={(v) => setSort(v as "recent" | "top")}
                    options={[
                      { value: "recent", label: "Most recent" },
                      { value: "top", label: "Top winners" },
                    ]}
                  />
                  <FilterSelect
                    label="Vertical"
                    value={vertical}
                    onChange={setVertical}
                    options={[
                      { value: "all", label: "All" },
                      ...verticals.map((v) => ({ value: v, label: verticalLabel(v) })),
                    ]}
                  />
                  <button
                    onClick={() => setIndependentOnly((v) => !v)}
                    title="Hide market leaders and advocacy/issue ads — show only independent operators"
                    className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] border px-3 py-1.5 text-[12.5px] font-bold"
                    style={
                      independentOnly
                        ? { background: ACCENT, color: "white", borderColor: ACCENT }
                        : { borderColor: "var(--color-line)", color: "var(--color-ink-muted)" }
                    }
                  >
                    {independentOnly ? "✓ Independent only" : "Independent only"}
                  </button>
                </div>
                <p className="px-1 text-[11.5px] text-[var(--color-ink-muted)]">
                  {batchF.length.toLocaleString()} ad{batchF.length === 1 ? "" : "s"} from “{activeSearch.keyword}” · {sort === "recent" ? "newest first" : "top winners first"}.
                  {independentOnly && batchAds.length - batchF.length > 0
                    ? ` ${(batchAds.length - batchF.length).toLocaleString()} hidden by “Independent only”.`
                    : ""}
                </p>
                {batchSorted.map((c) => (
                  <AdRowCard key={c.id} c={c} active={detail?.id === c.id} onOpen={() => setDetail(c)} />
                ))}
              </>
            )}
          </div>
        ) : searches.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No searches yet"
            hint="Use “Pull new from Meta” above — every search you run is saved here as its own batch."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {/* Filter past searches by keyword */}
            <div className="flex items-center gap-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-2.5">
              <Search size={15} className="text-[var(--color-ink-muted)]" />
              <input
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filter your searches by keyword…"
                className="w-full bg-transparent text-[13.5px] outline-none placeholder:text-[var(--color-ink-muted)]"
              />
              {searchFilter && (
                <button onClick={() => setSearchFilter("")} className="shrink-0 text-[12px] font-semibold text-[var(--color-ink-muted)]">
                  Clear
                </button>
              )}
            </div>

            {searchGroups.count === 0 ? (
              <p className="px-1 py-6 text-center text-[12.5px] text-[var(--color-ink-muted)]">
                No searches match “{searchFilter}”.
              </p>
            ) : (
              searchGroups.groups.map((g) => (
                <div key={g.label}>
                  <p className="mb-1.5 px-1 text-[11.5px] font-bold uppercase tracking-wide text-[var(--color-ink-muted)]">
                    {g.label} · {g.items.length}
                  </p>
                  <div className="flex flex-col gap-2.5">
                    {g.items.map((s) => (
                      <SearchRow key={s.id} s={s} onOpen={() => openSearch(s)} />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        ))}

      {/* ── Identity ────────────────────────────────────────────────────── */}
      {tab === "identity" &&
        (identity.length === 0 ? (
          <EmptyState
            icon={CornerDownRight}
            title="No personas detected"
            hint="When advertisers run under a 'Dr. ABC' name, they're resolved up to the real brand here."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {identity.map((p, i) => (
              <Card key={p.page_id || p.persona || i} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[14.5px] font-bold">{p.persona}</p>
                  <WinnerBadge badge={p.badge} />
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[13px]">
                  <CornerDownRight size={15} className="text-[var(--color-ink-muted)]" />
                  {p.resolvedBrand ? (
                    <span className="font-semibold text-[var(--color-source)]">
                      rolls up to {p.resolvedBrand}
                    </span>
                  ) : (
                    <span className="text-[var(--color-ink-muted)]">
                      unresolved — needs brand mapping
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[12px] text-[var(--color-ink-muted)]">
                  {compact(p.activeAds)} active ads
                </p>
              </Card>
            ))}
          </div>
        ))}

      {/* ── Advertiser detail ───────────────────────────────────────────── */}
      <Modal
        open={!!advDetail}
        onClose={() => setAdvDetail(null)}
        accent={ACCENT}
        title={
          <span className="flex items-center gap-2">
            <span className="truncate">{advDetail?.page_name || "Advertiser"}</span>
            {advDetail?.isPersona && (
              <span className="rounded bg-[var(--color-decode-soft)] px-1.5 py-0.5 text-[9.5px] font-bold text-[var(--color-decode)]">
                PERSONA
              </span>
            )}
          </span>
        }
      >
        {advDetail && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Ads found" value={advDetail.activeAds} accent={ACCENT} />
              <Stat label="Winner score" value={Math.round(advDetail.maxScore)} />
            </div>
            {advDetail.topDomain && (
              <div className="rounded-xl border border-[var(--color-line)] px-3.5 py-2.5 text-[13px]">
                <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-muted)]">
                  Product
                </span>
                <p className="font-semibold">sells via {advDetail.topDomain}</p>
              </div>
            )}
            <p className="text-[12.5px] text-[var(--color-ink-muted)]">
              We sampled {advDetail.activeAds} of this advertiser&apos;s ads in your search. Open their
              full Meta Ad Library to see every ad and the live creatives.
            </p>
            <div className="flex flex-col gap-2">
              {advDetail.page_id && (
                <button
                  onClick={() => pullAllAds(advDetail.page_id!)}
                  disabled={pullingAds}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-[15px] font-bold text-white disabled:opacity-60"
                  style={{ background: ACCENT }}
                >
                  {pullingAds ? (
                    <>
                      <Loader2 size={17} className="animate-spin" /> Pulling all their ads…
                    </>
                  ) : (
                    "Pull all their ads into the app"
                  )}
                </button>
              )}
              {advDetail.page_id && (
                <a
                  href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&view_all_page_id=${advDetail.page_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--color-line)] px-5 py-3 text-[14px] font-bold"
                >
                  <ExternalLink size={16} /> View all their ads on Meta ↗
                </a>
              )}
              {advDetail.topCreativeId && byId.get(advDetail.topCreativeId) && (
                <button
                  onClick={() => {
                    const c = byId.get(advDetail.topCreativeId!);
                    if (c) setDetail(c);
                    setAdvDetail(null);
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--color-line)] px-5 py-3 text-[14px] font-bold"
                >
                  Inspect top creative
                </button>
              )}
              {advDetail.topCreativeId && (
                <button
                  onClick={() => toDecode(advDetail.topCreativeId!)}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--color-line)] px-5 py-3 text-[14px] font-bold"
                >
                  Decode their angle <ArrowRight size={16} />
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* ── Ad viewer ───────────────────────────────────────────────────── */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        accent={ACCENT}
        title={
          <span className="flex items-center gap-2">
            <span className="truncate">{detail?.page_name || "Ad detail"}</span>
            <WinnerBadge badge={detail?.badge} />
          </span>
        }
      >
        {detail && (
          <div className="flex flex-col gap-4">
            {/* Reconstructed Facebook ad (v1 parity) */}
            <FacebookAdPreview ad={detail} />

            {/* Open the real, live ad on Meta — the primary "see what actually ran" action */}
            {metaAdUrl(detail.meta_ad_id) && (
              <a
                href={metaAdUrl(detail.meta_ad_id) as string}
                target="_blank"
                rel="noreferrer"
                className="flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-[15px] font-bold text-white active:scale-[0.99]"
                style={{ background: ACCENT }}
              >
                <ExternalLink size={17} /> Open the real ad on Meta
              </a>
            )}

            {!detail.creative_media_url && (
              <button
                onClick={loadCreative}
                disabled={loadingCreative}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--color-line)] px-5 py-3 text-[13.5px] font-bold disabled:opacity-60"
              >
                {loadingCreative ? (
                  <>
                    <Loader2 size={15} className="animate-spin" /> Pulling the real creative…
                  </>
                ) : (
                  "Load real creative (image / video)"
                )}
              </button>
            )}

            {/* Metrics */}
            <div className="grid grid-cols-4 gap-2">
              <Stat label="Winner" value={Math.round(detail.winner_score)} accent={ACCENT} />
              <Stat label="Days" value={detail.days_running} />
              <Stat label="Spend" value={money(detail.spend_lower, detail.spend_upper)} />
              <Stat
                label="Impr."
                value={compact(
                  ((detail.impressions_lower ?? 0) + (detail.impressions_upper ?? 0)) / 2 || null
                )}
              />
            </div>

            {/* Landing intel (post-crawl) */}
            {(detail.page_offer || detail.page_cta || detail.page_pricing) && (
              <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-line)] px-3.5 py-3 text-[13px]">
                <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-muted)]">
                  Landing intel
                </p>
                {detail.page_offer && (
                  <p>
                    <span className="font-semibold">Offer:</span> {detail.page_offer}
                  </p>
                )}
                {detail.page_cta && (
                  <p>
                    <span className="font-semibold">CTA:</span> {detail.page_cta}
                  </p>
                )}
                {detail.page_pricing && (
                  <p>
                    <span className="font-semibold">Pricing:</span> {detail.page_pricing}
                  </p>
                )}
              </div>
            )}

            {/* Visit the landing page (the Meta link is the primary action above) */}
            {toSiteUrl(detail.destination_url) && (
              <a
                href={toSiteUrl(detail.destination_url) as string}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1.5 rounded-xl border border-[var(--color-line)] px-3 py-2 text-[12.5px] font-semibold"
              >
                <ExternalLink size={14} /> Visit landing page ({toDomain(detail.destination_url)})
              </a>
            )}
            {detail.destination_url && !toSiteUrl(detail.destination_url) && (
              <p className="-mt-1 text-[11.5px] text-[var(--color-ink-muted)]">
                Ad caption: “{detail.destination_url}” — open it on Meta to see the real destination.
              </p>
            )}

            {/* Primary CTA — recreate this winner on-brand */}
            <button
              onClick={() => runRecreate(detail)}
              disabled={recreating}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-[15px] font-bold text-white active:scale-[0.99] disabled:opacity-60"
              style={{ background: ACCENT }}
            >
              {recreating ? (
                <>
                  <Loader2 size={17} className="animate-spin" /> Drafting your on-brand version…
                </>
              ) : (
                <>
                  Recreate on-brand <ArrowRight size={18} strokeWidth={2.4} />
                </>
              )}
            </button>
            {/* Secondary — just analyze the angle */}
            <button
              onClick={() => toDecode(detail.id)}
              className="-mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--color-line)] px-5 py-3 text-[13.5px] font-bold"
            >
              Just decode the angle <ArrowRight size={16} />
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
