import { createHmac, createSign, timingSafeEqual } from 'crypto';

/**
 * Task IDs in commit messages, branch names and pull requests (SRS FR-16.1): MBA-42, mba-42 or MBA_42 in a branch
 * such as "feature/MBA-42-login". Returns distinct keys like "MBA-42", upper-cased.
 */
export function findTaskKeys(...texts: (string | null | undefined)[]): string[] {
  const keys: string[] = [];
  for (const text of texts) {
    for (const m of (text ?? '').matchAll(/(?<![A-Za-z0-9@.])([A-Za-z][A-Za-z0-9]{1,4})[-_](\d{1,9})(?![0-9])/g)) {
      const key = `${m[1].toUpperCase()}-${Number(m[2])}`;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/** GitHub signs each webhook: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body) in hex. */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined) {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The "state" sent through GitHub's install page: who started the installation, for which workspace, valid 30 minutes.
 * Signed, so the callback cannot be pointed at another workspace.
 */
export const STATE_MINUTES = 30;

export function makeInstallState(secret: string, workspaceId: string, userId: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ w: workspaceId, u: userId, e: Math.floor(now / 1000) + STATE_MINUTES * 60 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(`github-state:${payload}`).digest('base64url')}`;
}

export function readInstallState(secret: string, state: string | undefined, now = Date.now()): { workspaceId: string; userId: string } | null {
  const [payload, sig] = (state ?? '').split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`github-state:${payload}`).digest('base64url'));
  if (expected.length !== Buffer.from(sig).length || !timingSafeEqual(expected, Buffer.from(sig))) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { w: string; u: string; e: number };
    return v.e * 1000 >= now ? { workspaceId: v.w, userId: v.u } : null;
  } catch {
    return null;
  }
}

/** The JWT a GitHub App signs with its private key to call the API as the app (valid 9 minutes). */
export function appJwt(appId: string, privateKeyPem: string, now = Date.now()) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000) - 60; // allows for clock drift, as GitHub recommends
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 600, iss: appId })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKeyPem, 'base64url')}`;
}
