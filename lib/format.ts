export function compact(n: number | null | undefined): string {
  // Guard null/undefined/NaN/Infinity — never surface "NaN" to the UI; the "—"
  // sentinel matches the existing "no value" convention callers rely on.
  if (n == null || !Number.isFinite(n)) return "—";
  // Compact the magnitude and re-apply the sign so negatives compact too
  // (e.g. -1_500 → "-1.5K") rather than rendering uncompacted.
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return sign + String(Math.round(abs));
}

export function money(lower: number | null, upper: number | null): string {
  if (lower == null && upper == null) return "—";
  const mid = ((lower ?? 0) + (upper ?? 0)) / 2;
  // A non-finite mid would compact to "—"; emit the bare sentinel rather than "$—".
  if (!Number.isFinite(mid)) return "—";
  return "$" + compact(mid);
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.replace(/[^a-zA-Z0-9 ]/g, "").trim().split(/\s+/);
  return (parts[0]?.[0] || "?").toUpperCase() + (parts[1]?.[0] || "").toUpperCase();
}

const VERTICAL_LABEL: Record<string, string> = {
  glp1: "GLP-1",
  trt: "TRT",
  peptides: "Peptides",
  joint_pain: "Joint Pain",
};
export function verticalLabel(v: string | null | undefined): string {
  if (!v) return "—";
  return VERTICAL_LABEL[v] || v;
}
