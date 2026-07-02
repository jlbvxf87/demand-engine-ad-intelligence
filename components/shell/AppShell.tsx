"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { NAV } from "./nav";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  // Optimistic active state: highlight the tapped item IMMEDIATELY (before the
  // server-rendered page arrives), then reconcile once the route actually changes.
  // Dynamic pages take up to ~2s to render, so without this the nav feels dead.
  const [tapped, setTapped] = useState<string | null>(null);
  useEffect(() => setTapped(null), [pathname]);
  const navHref = tapped ?? pathname;

  return (
    <div className="min-h-dvh w-full md:flex">
      {/* ── Desktop side rail ───────────────────────────────────────────── */}
      <aside className="hidden md:flex md:w-[240px] md:flex-col md:fixed md:inset-y-0 md:border-r md:border-[var(--color-line)] md:bg-[var(--color-surface)] md:px-4 md:py-5">
        <div className="flex items-center px-2 pb-6">
          <Image
            src="/de-logo.png"
            alt="Demand Engine"
            width={1175}
            height={350}
            priority
            className="h-11 w-auto"
          />
        </div>

        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = isActive(navHref, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.stage}
                href={item.href}
                prefetch
                onClick={() => setTapped(item.href)}
                className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors"
                style={{
                  background: active ? item.accentSoft : "transparent",
                  color: active ? item.accent : "var(--color-ink-muted)",
                }}
              >
                <Icon size={19} strokeWidth={active ? 2.4 : 2} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex items-center justify-between rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-ink-muted)]">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-win)] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-win)]" />
            </span>
            Live
          </div>
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[12px] font-extrabold text-[var(--color-accent)]">
            JB
          </span>
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────────────────── */}
      <div className="flex min-h-dvh w-full flex-col md:pl-[240px]">
        {/* Mobile header */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-canvas)]/70 px-4 py-3 backdrop-blur-xl md:hidden">
          <div className="flex items-center">
            <Image
              src="/de-logo.png"
              alt="Demand Engine"
              width={1175}
              height={350}
              priority
              className="h-8 w-auto"
            />
          </div>
          <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[12px] font-extrabold text-[var(--color-accent)] shadow-[inset_0_0_0_1px_rgba(23,46,215,0.12)]">
            JB
          </span>
        </header>

        <main
          key={pathname}
          className="de-in mx-auto w-full max-w-2xl flex-1 px-4 pb-[calc(7rem_+_env(safe-area-inset-bottom))] pt-5 md:max-w-3xl md:px-8 md:pb-12 md:pt-8"
        >
          {children}
        </main>
      </div>

      {/* ── Mobile bottom nav ───────────────────────────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-[var(--color-line)] bg-[var(--color-surface)]/95 pb-[max(0.4rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur md:hidden">
        {NAV.map((item) => {
          const active = isActive(navHref, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.stage}
              href={item.href}
              prefetch
              onClick={() => setTapped(item.href)}
              className="flex flex-1 flex-col items-center gap-1 py-1 active:opacity-70"
            >
              <span
                className="grid h-8 w-[52px] place-items-center rounded-full transition-[background,color] duration-150"
                style={{
                  background: active ? "var(--color-accent-soft)" : "transparent",
                  color: active ? item.accent : "var(--color-ink-muted)",
                }}
              >
                <Icon size={20} strokeWidth={active ? 2.5 : 2} />
              </span>
              <span
                className="text-[10px] font-semibold"
                style={{ color: active ? item.accent : "var(--color-ink-muted)" }}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
