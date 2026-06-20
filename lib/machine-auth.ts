import { timingSafeEqual } from 'node:crypto';

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

export function isMachineAuthed(req: Request): boolean {
  const key = process.env.MACHINE_API_KEY;
  if (!key) return false;
  const header =
    req.headers.get('x-api-key') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!header) return false;
  return safeEqual(header, key);
}
