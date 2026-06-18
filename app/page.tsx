import Link from "next/link";
import { Search, ArrowRight, Sparkles, ExternalLink } from "lucide-react";
import { Card } from "@/components/ui";
import { getHomeStats, getScaledWinners, getGeneratedCreatives } from "@/lib/data";
import { compact, initials } from "@/lib/format";
import { toDomain, landingShot } from "@/lib/url";
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
  const [stats, scaledRaw, creatives] = await Promise.all([
    getHomeStats(),
    getScaledWinners(40),
    getGeneratedCreatives(12),
  ]);
  // ONLY proven winners: creatives an independent operator is running at SCALE
  // (the same ad duplicated across many ads / landing pages). Ranked by volume,
  // not reported spend — one per brand so the grid shows variety.
  const seenBrand = new Set<string>();
  const winners = scaledRaw
    .filter((w) => isIndependent(w.ad))
    .sort((a, b) => b.adCount - a.adCount)
    .filter((w) => {
      const b = (w.ad.page_name || w.ad.id).toLowerCase();
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
      <p className="-mt-1.5 mb-2.5 text-[12px] text-[var(--color-ink-muted)]">
        Independent operators running the same creative at scale — proven by volume, not spend.
      </p>
      {winners.length === 0 ? (
        <Empty
          icon={<Search size={22} className="text-[var(--color-ink-muted)]" />}
          title="No scaled winners yet"
          hint="Run a search in Source — creatives an operator is running over and over surface here."
        />
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {winners.map((w) => {
            const ad = w.ad;
            const hook = adHook(ad.ad_body, ad.ad_title, ad.page_headline);
            const meta = metaAdUrl(ad.meta_ad_id);
            const dom = toDomain(ad.destination_url);
            return (
              <Card key={w.key} className="overflow-hidden p-0 transition-shadow hover:shadow-[0_4px_16px_rgba(16,27,22,0.08)]">
                {/* Tap the ad → open the real, live ad on Meta (like Source) */}
                <a href={meta ?? "#"} target="_blank" rel="noreferrer" className="block">
                  <div className="relative aspect-[4/3] w-full overflow-hidden">
                    {ad.creative_media_url ? (
                      ad.creative_media_type === "video" ? (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video src={`${ad.creative_media_url}#t=0.1`} muted playsInline preload="metadata" className="h-full w-full bg-black object-cover" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={ad.creative_media_url} alt={ad.page_name || "ad"} className="h-full w-full bg-black object-cover" />
                      )
                    ) : ad.page_screenshot_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={ad.page_screenshot_url} alt={ad.page_name || "ad"} className="h-full w-full object-cover object-top" />
                    ) : landingShot(ad.destination_url) ? (
                      <div className="relative h-full w-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={landingShot(ad.destination_url) as string} alt="landing page" className="h-full w-full object-cover object-top" />
                        <span className="absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[8.5px] font-bold text-white">
                          Landing page
                        </span>
                      </div>
                    ) : hook ? (
                      <div className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-[var(--color-accent-soft)] to-[var(--color-surface-2)] p-2.5">
                        <span className="line-clamp-4 text-[11px] font-semibold leading-snug">{hook}</span>
                        <span className="flex items-center gap-1 text-[9.5px] font-bold text-[var(--color-source)]">
                          <ExternalLink size={11} /> View on Meta
                        </span>
                      </div>
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-[var(--color-accent-soft)] to-[var(--color-surface-2)]">
                        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white text-[16px] font-extrabold text-[var(--color-accent)] shadow-sm">
                          {initials(ad.page_name)}
                        </span>
                        <span className="flex items-center gap-1 text-[9.5px] font-bold text-[var(--color-source)]">
                          <ExternalLink size={11} /> View on Meta
                        </span>
                      </div>
                    )}
                    {/* Winner signal: how many ads run this creative */}
                    <span className="absolute right-1.5 top-1.5 rounded-md bg-[var(--color-source)] px-1.5 py-0.5 text-[10px] font-extrabold text-white shadow-sm">
                      {w.adCount}× ads
                    </span>
                  </div>
                  <div className="px-2.5 pb-1.5 pt-2.5">
                    <p className="truncate text-[12.5px] font-bold">{ad.page_name || "Unknown"}</p>
                    {dom && <p className="truncate text-[10px] text-[var(--color-ink-muted)]">{dom}</p>}
                    <p className="mt-1 text-[10.5px] font-semibold text-[var(--color-ink-muted)]">
                      {w.adCount}× ads
                      {w.landingPages > 1 ? ` · ${w.landingPages} landing pages` : ""} · {w.maxDays}d live
                    </p>
                  </div>
                </a>
                {/* Secondary: decode why it works */}
                <Link
                  href={`/decode?ad=${ad.id}`}
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
