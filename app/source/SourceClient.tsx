"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight, ExternalLink, Loader2, CornerDownRight } from "lucide-react";
import {
  ScreenHeader,
  Card,
  Badge,
  WinnerBadge,
  Tabs,
  EmptyState,
  Modal,
  Stat,
} from "@/components/ui";
import AdThumb from "@/components/AdThumb";
import { compact, money, verticalLabel, initials } from "@/lib/format";
import { toSiteUrl, toDomain } from "@/lib/url";
import { adHook, metaAdUrl } from "@/lib/ad";
import { isIndependent } from "@/lib/targeting";
import { searchAds, fetchCreative, searchByPage, loadCreatives } from "@/app/actions";
import type { Advertiser, AdRow, IdentityRollup, ScaledWinner } from "@/lib/data";

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

export default function SourceClient({
  advertisers,
  creatives,
  identity,
  scaled,
  verticals,
  creativesTotal,
}: {
  advertisers: Advertiser[];
  creatives: AdRow[];
  identity: IdentityRollup[];
  scaled: ScaledWinner[];
  verticals: string[];
  creativesTotal: number;
}) {
  const router = useRouter();
  const [tab, setTab] = useState("scaled");
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
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

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
    () => allCreatives.filter((a) => vFilter(a.vertical) && indOk(a)),
    [allCreatives, vertical, independentOnly],
  );
  const scaledF = useMemo(
    () => scaled.filter((w) => indOk(w.ad)),
    [scaled, independentOnly],
  );
  const byId = useMemo(() => new Map(allCreatives.map((c) => [c.id, c])), [allCreatives]);
  const moreAvailable = allCreatives.length < creativesTotal && !exhausted;

  async function loadMoreCreatives() {
    setLoadingMore(true);
    const r = await loadCreatives(allCreatives.length, 60);
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

      {/* Search */}
      <div className="mb-4 flex items-center gap-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-3">
        <Search size={18} className="text-[var(--color-ink-muted)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder="Search brand, page, doctor, hook…"
          className="w-full bg-transparent text-[15px] outline-none placeholder:text-[var(--color-ink-muted)]"
        />
        <button
          onClick={runSearch}
          disabled={pending || !query.trim()}
          className="flex items-center gap-1 rounded-xl px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-40"
          style={{ background: ACCENT }}
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : "Search"}
        </button>
      </div>
      {note && (
        <p className="mb-3 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
          {note}
        </p>
      )}

      {/* Advanced filters — drive the Meta search */}
      <div className="no-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => setIndependentOnly((v) => !v)}
          title="Hide market leaders (Pfizer, Hims…) and advocacy/issue ads — show only independent operators"
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] border px-3 py-1.5 text-[12.5px] font-bold"
          style={
            independentOnly
              ? { background: ACCENT, color: "white", borderColor: ACCENT }
              : { borderColor: "var(--color-line)", color: "var(--color-ink-muted)" }
          }
        >
          {independentOnly ? "✓ Independent only" : "Independent only"}
        </button>
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
        <FilterSelect
          label="Vertical"
          value={vertical}
          onChange={setVertical}
          options={[
            { value: "all", label: "All" },
            ...verticals.map((v) => ({ value: v, label: verticalLabel(v) })),
          ]}
        />
      </div>
      <p className="mb-4 px-1 text-[11px] text-[var(--color-ink-muted)]">
        Set filters, then Search. Vertical filters the results shown.
      </p>

      {/* Tabs */}
      <div className="mb-4">
        <Tabs
          accent={ACCENT}
          active={tab}
          onChange={setTab}
          tabs={[
            { id: "scaled", label: `Proven${scaledF.length ? ` · ${scaledF.length}` : ""}` },
            { id: "advertisers", label: `Brands${adv.length ? ` · ${adv.length}` : ""}` },
            { id: "creatives", label: `All ads${crv.length ? ` · ${crv.length}` : ""}` },
            { id: "identity", label: `Personas${identity.length ? ` · ${identity.length}` : ""}` },
          ]}
        />
      </div>
      {/* Always-visible explainer for the active tab */}
      <p className="mb-3 px-1 text-[12px] text-[var(--color-ink-muted)]">
        {tab === "scaled" && (
          <><b className="text-[var(--color-ink)]">Proven</b> — the same creative an advertiser runs over and over (across many ads, links, or pages). Repetition = it’s working.</>
        )}
        {tab === "advertisers" && (
          <><b className="text-[var(--color-ink)]">Brands</b> — each advertiser, ranked by how many ads they’re running. Tap to pull their full ad library.</>
        )}
        {tab === "creatives" && (
          <><b className="text-[var(--color-ink)]">All ads</b> — every individual ad you’ve pulled, highest winner score first.</>
        )}
        {tab === "identity" && (
          <><b className="text-[var(--color-ink)]">Personas</b> — “Dr. ABC”-style advertisers resolved up to the real brand behind them.</>
        )}
      </p>

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
            {adv.map((a) => (
              <button
                key={a.page_name}
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

      {/* ── Creatives ───────────────────────────────────────────────────── */}
      {tab === "creatives" &&
        (crv.length === 0 ? (
          <EmptyState icon={Search} title="No creatives yet" hint="Run a search to populate winners." />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="px-1 text-[11.5px] text-[var(--color-ink-muted)]">
              Showing {crv.length.toLocaleString()} of {creativesTotal.toLocaleString()} ads
              {vertical !== "all" ? " (filtered)" : ""}.
            </p>
            {crv.map((c) => {
              const on = detail?.id === c.id;
              const hook = adHook(c.ad_body, c.ad_title, c.page_headline);
              const dom = toDomain(c.destination_url);
              const meta = metaAdUrl(c.meta_ad_id);
              return (
                <Card
                  key={c.id}
                  className="flex items-center gap-3 p-3"
                  accent={on ? ACCENT : undefined}
                >
                  <AdThumb
                    src={(c.creative_media_type === "image" ? c.creative_media_url : null) || c.page_screenshot_url}
                    name={c.page_name}
                    size={56}
                  />
                  <button onClick={() => setDetail(c)} className="min-w-0 flex-1 text-left">
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
            })}
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
            ) : (
              <p className="py-1 text-center text-[11.5px] text-[var(--color-ink-muted)]">
                That’s all {creativesTotal.toLocaleString()} ads.
              </p>
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
            {identity.map((p) => (
              <Card key={p.persona} className="p-4">
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

            {/* Primary CTA */}
            <button
              onClick={() => toDecode(detail.id)}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-[15px] font-bold text-white active:scale-[0.99]"
              style={{ background: ACCENT }}
            >
              Send Winner to Decode
              <ArrowRight size={18} strokeWidth={2.4} />
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
