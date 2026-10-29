import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Small signed tokens: base64url(JSON payload) + "." + HMAC-SHA256. `purpose` keeps a token of one kind from being
 * used as another. For password reset, the key also includes the user's current password hash, so a link stops
 * working as soon as the password changes: each link works once, with nothing stored.
 */
export function signToken(key: string, purpose: string, payload: Record<string, unknown>, ttlSeconds: number, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, p: purpose, e: Math.floor(now / 1000) + ttlSeconds, n: randomBytes(9).toString('base64url') })).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(`${purpose}:${body}`).digest('base64url')}`;
}

/** The payload, or null if the token is malformed, signed with another key or purpose, or expired. */
export function readToken<T extends Record<string, unknown>>(key: string, purpose: string, token: string, now = Date.now()): (T & { n: string }) | null {
  const [body, sig] = (token ?? '').split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(createHmac('sha256', key).update(`${purpose}:${body}`).digest('base64url'));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { p: string; e: number; n: string };
    return v.p === purpose && v.e * 1000 >= now ? v : null;
  } catch {
    return null;
  }
}

/** Reads the payload without checking the signature (to find which user's key to check it with). */
export function peekToken<T>(token: string): T | null {
  try {
    return JSON.parse(Buffer.from((token ?? '').split('.')[0], 'base64url').toString()) as T;
  } catch {
    return null;
  }
}
