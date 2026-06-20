/* Shared URL helpers — one source of truth for "is this a real site link" and
   "reduce it to a clean domain" (used by Source, the scaled grouping, and the
   search route's destination picker). */

/* A bare hostname (optionally with a path): one or more dot-separated DNS labels
   followed by a letter-based TLD (>= 2 letters), anchored at both ends of the
   host portion. Anchoring the END + requiring a real TLD rejects version-ish
   junk like "v1.2.3" / "9.99"; the [^@] note below rejects userinfo. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?:[/?#].*)?$/i;

/** Final-pass check that a constructed URL has a real dotted, letter-TLD host. */
function validHost(u: string): boolean {
  try {
    const { hostname } = new URL(u);
    if (!hostname.includes(".")) return false;
    const tld = hostname.split(".").pop() || "";
    return /^[a-z]{2,}$/i.test(tld);
  } catch {
    return false;
  }
}

/** A clickable site URL only if the value really looks like one (no whitespace). */
export function toSiteUrl(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (/\s/.test(t)) return null; // captions / disclaimers contain spaces
  if (/^https?:\/\//i.test(t)) return validHost(t) ? t : null;
  // Reject userinfo: an "@" before the first "/" means the leading token is
  // credentials, not the host ("a.b@evil.com/x" must not yield evil.com).
  const beforePath = t.split("/", 1)[0];
  if (beforePath.includes("@")) return null;
  if (HOSTNAME.test(t)) {
    const url = "https://" + t;
    return validHost(url) ? url : null;
  }
  return null;
}

export function looksLikeUrl(s: string | null | undefined): boolean {
  return toSiteUrl(s) !== null;
}

/** Reduce a URL/caption to its bare host (no protocol, no www, no path). */
export function toDomain(s: string | null | undefined): string {
  const u = toSiteUrl(s);
  if (!u) return "";
  return u
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "");
}
