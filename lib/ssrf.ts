import "server-only";

import { isIP } from "node:net";

/**
 * Returns a human-readable reason if `urlStr` is an unsafe server-side fetch
 * target (SSRF risk), or `null` if it appears safe to fetch.
 *
 * Rejects:
 *  - non-http(s) protocols
 *  - localhost / *.local / *.internal hostnames
 *  - literal private / loopback / link-local IPs:
 *      127.0.0.0/8, 10/8, 172.16-31/12, 192.168/16, 169.254/16
 *      (incl. 169.254.169.254 cloud metadata), 0.0.0.0,
 *      ::1, fc00::/7, fe80::/10
 */
export function unsafeFetchReason(urlStr: string): string | null {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return "invalid URL";
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return `unsupported protocol "${url.protocol}"`;
  }

  // Normalize hostname: lowercase and strip surrounding [] from IPv6 literals.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (hostname === "") {
    return "missing hostname";
  }

  // Hostname-based (non-IP) blocks.
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return `disallowed hostname "${hostname}"`;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isPrivateIPv4(hostname)) {
    return `private/loopback/link-local IPv4 "${hostname}"`;
  }
  if (ipVersion === 6 && isPrivateIPv6(hostname)) {
    return `private/loopback/link-local IPv6 "${hostname}"`;
  }

  return null;
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }

  const [a, b] = octets;

  // 0.0.0.0/8 (incl. 0.0.0.0)
  if (a === 0) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12 (172.16 - 172.31)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 169 && b === 254) return true;

  return false;
}

function isPrivateIPv6(host: string): boolean {
  // Expand and normalize for prefix checks. isIP has already validated it.
  const lower = host.toLowerCase();

  // Loopback ::1 and unspecified ::
  if (lower === "::1" || lower === "::") return true;

  // IPv4-mapped / IPv4-compatible IPv6 (e.g. ::ffff:127.0.0.1) — inspect the
  // trailing IPv4 portion if present.
  const mapped = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && isPrivateIPv4(mapped[1])) {
    return true;
  }

  const firstHextet = expandFirstHextet(lower);
  if (firstHextet === null) return false;

  // fc00::/7  -> first 7 bits are 1111110 => high byte 0xfc or 0xfd
  const highByte = firstHextet >> 8;
  if (highByte === 0xfc || highByte === 0xfd) return true;

  // fe80::/10 -> first 10 bits 1111111010 => 0xfe80..0xfebf
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;

  return false;
}

/** Returns the numeric value (0..0xffff) of the first 16-bit hextet, or null. */
function expandFirstHextet(host: string): number | null {
  // Strip any zone id.
  const noZone = host.split("%")[0];
  const head = noZone.startsWith("::") ? "0" : noZone.split(":")[0];
  if (head === "") return 0;
  const value = parseInt(head, 16);
  return Number.isNaN(value) ? null : value & 0xffff;
}
