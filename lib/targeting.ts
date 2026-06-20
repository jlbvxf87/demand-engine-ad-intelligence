/* Targeting filter — the whole point of broad discovery is to find INDEPENDENT
   operators (small brands, clinics, DTC marketers) who are scaling winning ads,
   NOT market leaders (Pfizer, Hims) or advocacy/issue campaigns. On a broad
   search like "GLP-1" those big players dominate by reported spend and drown out
   the operators worth modeling. This module flags who to skip. Isomorphic. */

import { toDomain } from "@/lib/url";

// Household pharma / DTC giants — not who we're modeling on a broad search.
// Each entry is matched on WORD BOUNDARIES (not substring) so "hers" hits
// "Hims & Hers" but never "Mothers", and "roman"/"getro" no longer need the
// old trailing-space hacks. Multi-word/punctuated entries are normalized to a
// single space and bounded as a phrase.
const MARKET_LEADERS = [
  "pfizer", "eli lilly", "lilly direct", "lillydirect", "novo nordisk", "novonordisk",
  "hims", "hers", "ro health", "roman", "getro", "noom", "weightwatchers",
  "weight watchers", "calibrate", "found health", "sequence health", "goodrx",
  "amazon", "costco", "walmart", "cvs", "walgreens", "teladoc", "plushcare",
  "everlywell", "henry meds", "mochi health", "eli lilly and company",
];

// Precompiled \b-anchored matchers, one per leader. Internal whitespace is made
// flexible so "weight watchers" still matches double-spaced page names.
const LEADER_RES = MARKET_LEADERS.map(
  (b) => new RegExp("\\b" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "\\b", "i")
);

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
  // Word-boundary match: "Hims & Hers" hits, "Mothers Wellness" / "Amazonia"
  // do not (substring includes() used to false-match those).
  if (LEADER_RES.some((re) => re.test(name))) return "Market leader";
  const isAdvocacyOrMedia = ADVOCACY_OR_MEDIA.test(row.page_name || "");
  if (isAdvocacyOrMedia) return "Advocacy / media";
  const dom = toDomain(row.destination_url);
  if (/\.(org|gov)$/i.test(dom)) return "Nonprofit / gov";
  // Reported-spend rule, revised: high-spend commercial DTC operators (exactly
  // who we WANT to surface) routinely report spend in the low thousands, so the
  // old `spend >= 1000` flag false-flagged them as "Issue / advocacy". Meta
  // discloses spend for political/social-issue ads, but spend alone isn't proof
  // of that — so we now gate this flag on a corroborating advocacy/media signal
  // (org name OR .org/.gov destination) AND raise the threshold to $25k, well
  // above typical DTC test budgets. A pure-commercial big spender no longer trips it.
  const spend = Math.max(row.spend_lower || 0, row.spend_upper || 0);
  const advocacySignal = isAdvocacyOrMedia || /\.(org|gov)$/i.test(dom);
  if (spend >= 25_000 && advocacySignal) return "Issue / advocacy ad";
  return null;
}

export function isIndependent(row: TargetRow): boolean {
  return offTargetReason(row) === null;
}
