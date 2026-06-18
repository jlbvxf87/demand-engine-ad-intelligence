import Link from "next/link";
import { Search, ArrowRight, Sparkles, ExternalLink } from "lucide-react";
import { Card, WinnerBadge } from "@/components/ui";
import { getHomeStats, getWinningCreatives, getGeneratedCreatives } from "@/lib/data";
import { compact, money, initials } from "@/lib/format";
import { toDomain } from "@/lib/url";
import { adHook, metaAdUrl } from "@/lib/ad";
import { isIndependent } from "@/lib/targeting";
import LatestVideos from "./LatestVideos";

export const dynamic = "force-dynamic";

const STAT_ACCENT = [
  "var(--color-source)",
  "var(--color-rebuild)",
  "var(--color-publish)",
  "var(--color-decode)",
];

export default async function HomePage() {
  const [stats, winnersRaw, creatives] = await Promise.all([
    getHomeStats(),
    getWinningCreatives({ limit: 120 }),
    getGeneratedCreatives(12),
  ]);
  // Independent operators only (skip market leaders + advocacy/media), ranked by
  // ad VOLUME — how many creatives the brand is running — not reported spend.
  // One top ad per brand so the grid shows variety.
  const seenBrand = new Set<string>();
  const winners = winnersRaw
    .filter(isIndependent)
    .sort((a, b) => b.brand_ad_count - a.brand_ad_count || b.winner_score - a.winner_score)
    .filter((w) => {
      const b = (w.page_name || w.id).toLowerCase();
      if (seenBrand.has(b)) return false;
      seenBrand.add(b);
      return true;
    })
    .slice(0, 6);
  const videos = creatives.filter((c) => c.video_url).slice(0, 6);

  const tiles = [
    { label: "Winners", value: stats.winners, href: "/source" },
    { label: "Creatives", value: stats.creatives, href: "/publish" },
    { label: "Videos", value: stats.videos, href: "/publish" },
    { label: "Stories", value: stats.stories, href: "/publish" },
  ];

  return (
    <div>
      <h1 className="text-[26px] font-extrabold leading-tight tracking-tight md:text-[30px]">
        Creative Factory
      </h1>
      <p className="mb-5 mt-1 text-[14px] text-[var(--color-ink-muted)]">
        Find winners → decode why → create → publish to test.
      </p>

      {/* Live stats */}
      <div className="mb-5 grid grid-cols-4 divide-x divide-[var(--color-line)] overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[0_1px_2px_rgba(16,27,22,0.04)]">
        {tiles.map((t, i) => (
          <Link
            key={t.label}
            href={t.href}
            className="px-2 py-3.5 text-center transition-colors hover:bg-[var(--color-surface-2)]"
          >
            <p className="text-[23px] font-extrabold leading-none tabular-nums" style={{ color: STAT_ACCENT[i] }}>
              {compact(t.value)}
            </p>
            <p className="mt-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-ink-muted)]">
              {t.label}
            </p>
          </Link>
        ))}
      </div>

      {/* Primary action */}
      <Link
        href="/source"
        className="mb-6 flex items-center gap-2 rounded-2xl px-4 py-3.5 text-[15px] font-bold text-white active:scale-[0.99]"
        style={{ background: "var(--color-source)" }}
      >
        <Search size={18} strokeWidth={2.4} />
        Search winning ads
        <ArrowRight size={18} strokeWidth={2.4} className="ml-auto" />
      </Link>

      {/* Top winning ads */}
      <SectionHeader title="Top winning ads" href="/source" cta="Source" />
      {winners.length === 0 ? (
        <Empty
          icon={<Search size={22} className="text-[var(--color-ink-muted)]" />}
          title="No winners yet"
          hint="Run a search in Source to surface high-performing ads."
        />
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {winners.map((w) => {
            const hook = adHook(w.ad_body, w.ad_title, w.page_headline);
            const meta = metaAdUrl(w.meta_ad_id);
            const dom = toDomain(w.destination_url);
            return (
              <Card key={w.id} className="overflow-hidden p-0 transition-shadow hover:shadow-[0_4px_16px_rgba(16,27,22,0.08)]">
                {/* Tap the ad → open the real, live ad on Meta (like Source) */}
                <a href={meta ?? "#"} target="_blank" rel="noreferrer" className="block">
                  <div className="aspect-[4/3] w-full overflow-hidden">
                    {w.creative_media_url ? (
                      w.creative_media_type === "video" ? (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video src={`${w.creative_media_url}#t=0.1`} muted playsInline preload="metadata" className="h-full w-full bg-black object-cover" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={w.creative_media_url} alt={w.page_name || "ad"} className="h-full w-full bg-black object-cover" />
                      )
                    ) : w.page_screenshot_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={w.page_screenshot_url} alt={w.page_name || "ad"} className="h-full w-full object-cover object-top" />
                    ) : hook ? (
                      // No image from Meta — show the real hook so the card still has value
                      <div className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-[var(--color-accent-soft)] to-[var(--color-surface-2)] p-2.5">
                        <span className="line-clamp-4 text-[11px] font-semibold leading-snug">{hook}</span>
                        <span className="flex items-center gap-1 text-[9.5px] font-bold text-[var(--color-source)]">
                          <ExternalLink size={11} /> View on Meta
                        </span>
                      </div>
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-[var(--color-accent-soft)] to-[var(--color-surface-2)]">
                        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white text-[16px] font-extrabold text-[var(--color-accent)] shadow-sm">
                          {initials(w.page_name)}
                        </span>
                        <span className="flex items-center gap-1 text-[9.5px] font-bold text-[var(--color-source)]">
                          <ExternalLink size={11} /> View on Meta
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="px-2.5 pb-1.5 pt-2.5">
                    <p className="truncate text-[12.5px] font-bold">{w.page_name || "Unknown"}</p>
                    {dom && <p className="truncate text-[10px] text-[var(--color-ink-muted)]">{dom}</p>}
                    <div className="mt-1 flex items-center justify-between gap-1">
                      <WinnerBadge badge={w.badge} />
                      <span className="text-[11px] font-bold tabular-nums" style={{ color: "var(--color-source)" }}>
                        {Math.round(w.winner_score)}
                      </span>
                    </div>
                    <p className="mt-1 text-[10.5px] text-[var(--color-ink-muted)]">
                      {w.days_running}d running
                      {(w.spend_lower ?? 0) > 0 || (w.spend_upper ?? 0) > 0 ? ` · ${money(w.spend_lower, w.spend_upper)}` : ""}
                    </p>
                  </div>
                </a>
                {/* Secondary: decode why it works */}
                <Link
                  href={`/decode?ad=${w.id}`}
                  className="flex items-center justify-center gap-1 border-t border-[var(--color-line)] py-1.5 text-[11px] font-bold text-[var(--color-decode)]"
                >
                  Decode <ArrowRight size={12} />
                </Link>
              </Card>
            );
          })}
        </div>
      )}

      {/* Latest videos — open a player in place */}
      <SectionHeader title="Latest videos" href="/publish" cta="Create" />
      {videos.length === 0 ? (
        <Empty
          icon={<Sparkles size={22} className="text-[var(--color-ink-muted)]" />}
          title="No videos yet"
          hint="Generate creatives in Create (Replicate or Multi-scene)."
        />
      ) : (
        <LatestVideos
          videos={videos.map((v) => ({
            id: v.id,
            video_url: v.video_url,
            video_provider: v.video_provider,
            hook_text: v.hook_text,
          }))}
        />
      )}
    </div>
  );
}

function SectionHeader({ title, href, cta }: { title: string; href: string; cta: string }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h2 className="text-[16px] font-bold tracking-tight">{title}</h2>
      <Link href={href} className="text-[12.5px] font-semibold text-[var(--color-ink-muted)]">
        {cta} →
      </Link>
    </div>
  );
}

function Empty({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="mb-6 flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-[var(--color-line)] bg-[var(--color-surface)] px-6 py-10 text-center">
      {icon}
      <p className="text-[14px] font-semibold">{title}</p>
      <p className="max-w-xs text-[12.5px] text-[var(--color-ink-muted)]">{hint}</p>
    </div>
  );
}
