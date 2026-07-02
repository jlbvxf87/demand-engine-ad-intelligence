/**
 * Instant route-transition skeleton. Dynamic pages take ~0.8–1.8s to server-render;
 * this shows the moment a nav item is tapped (Next renders it during the pending
 * navigation, inside the persistent AppShell), so a tap always reacts immediately
 * instead of hanging on the previous screen. Prefetched with the route.
 */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-hidden>
      {/* Header */}
      <div className="mb-6">
        <div className="h-9 w-44 rounded-lg bg-[var(--color-surface-2)]" />
        <div className="mt-2.5 h-4 w-72 max-w-full rounded bg-[var(--color-surface-2)]" />
      </div>
      {/* Primary block */}
      <div className="mb-5 h-28 w-full rounded-2xl bg-[var(--color-surface-2)]" />
      {/* Content grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="aspect-[4/3] rounded-2xl bg-[var(--color-surface-2)]" />
        ))}
      </div>
    </div>
  );
}
