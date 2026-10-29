import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Short-lived download links (API Design: "Short-lived download link"): <attachmentId>.<expiresAt>.<signature>,
 * signed with HMAC-SHA256, so files can be fetched by <img> tags and browsers without sending the access token.
 */
export const DOWNLOAD_LINK_SECONDS = 5 * 60;

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(`download:${payload}`).digest('base64url');

export function makeDownloadToken(secret: string, attachmentId: string, now = Date.now()) {
  const expires = Math.floor(now / 1000) + DOWNLOAD_LINK_SECONDS;
  const payload = `${attachmentId}.${expires}`;
  return { token: `${payload}.${sign(secret, payload)}`, expiresAt: new Date(expires * 1000) };
}

/** Returns the attachment id, or null when the token is malformed, tampered with or expired. */
export function readDownloadToken(secret: string, token: string, now = Date.now()): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expected = Buffer.from(sign(secret, `${id}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  return id;
}
