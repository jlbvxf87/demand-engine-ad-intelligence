import { cookies } from 'next/headers';
import { timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'demand_engine_admin';

/**
 * Constant-time string comparison. Returns false when either input is empty
 * or the lengths differ (timingSafeEqual requires equal-length buffers).
 */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Returns true if the request is authenticated via cookie or query key. */
export async function isAdminAuthed(searchParamsKey?: string): Promise<boolean> {
  const internal = process.env.INTERNAL_API_SECRET;
  const adminPw = process.env.ADMIN_PASSWORD;
  const validTokens = [internal, adminPw]
    .filter((v): v is string => Boolean(v))
    .map((t) => t.replace(/\s+/g, ''));
  if (validTokens.length === 0) return false;

  // Check cookie first.
  const c = await cookies();
  const cookieValue = c.get(COOKIE_NAME)?.value?.replace(/\s+/g, '');
  if (cookieValue && validTokens.some((t) => safeEqual(t, cookieValue))) {
    return true;
  }

  // Fallback: query/form key (back-compat with older URLs and POST forms).
  const submitted = (searchParamsKey ?? '').replace(/\s+/g, '');
  if (submitted && validTokens.some((t) => safeEqual(t, submitted))) {
    return true;
  }

  return false;
}

export const ADMIN_COOKIE_NAME = COOKIE_NAME;
