/* Targeting filter — the whole point of broad discovery is to find INDEPENDENT
   operators (small brands, clinics, DTC marketers) who are scaling winning ads,
   NOT market leaders (Pfizer, Hims) or advocacy/issue campaigns. On a broad
   search like "GLP-1" those big players dominate by reported spend and drown out
   the operators worth modeling. This module flags who to skip. Isomorphic. */

import { toDomain } from "@/lib/url";

// Household pharma / DTC giants — not who we're modeling on a broad search.
const MARKET_LEADERS = [
  "pfizer", "eli lilly", "lilly direct", "lillydirect", "novo nordisk", "novonordisk",
  "hims", "hers", "ro health", "roman ", "getro", "noom", "weightwatchers",
  "weight watchers", "calibrate", "found health", "sequence health", "goodrx",
  "amazon", "costco", "walmart", "cvs ", "walgreens", "teladoc", "plushcare",
  "everlywell", "henry meds", "mochi health", "eli lilly and company",
];

// Non-commercial advertisers: advocacy orgs, PACs, nonprofits, news/media.
const ADVOCACY_OR_MEDIA =
  /\b(coalition|foundation|alliance|association|institute|society|council|partnership|committee|caucus|\bpac\b|coalition|press|news|times|\bpost\b|journal|magazine|tribune|gazette|herald|network)\b/i;

type TargetRow = {
  page_name?: string | null;
  destination_url?: string | null;
  spend_lower?: number | null;
  spend_upper?: number | null;
};

/** Why an advertiser is NOT an independent operator (null = it IS one). */
export function offTargetReason(row: TargetRow): string | null {
  const name = (row.page_name || "").toLowerCase().trim();
  if (!name) return null;
  if (MARKET_LEADERS.some((b) => name.includes(b))) return "Market leader";
  if (ADVOCACY_OR_MEDIA.test(row.page_name || "")) return "Advocacy / media";
  const dom = toDomain(row.destination_url);
  if (/\.(org|gov)$/i.test(dom)) return "Nonprofit / gov";
  // Meta reports spend ONLY for political / social-issue ads — a meaningful
  // reported spend means it's an issue/advocacy campaign, not a DTC operator.
  const spend = Math.max(row.spend_lower || 0, row.spend_upper || 0);
  if (spend >= 1000) return "Issue / advocacy ad";
  return null;
}

export function isIndependent(row: TargetRow): boolean {
  return offTargetReason(row) === null;
}
