import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

/**
 * Encrypts small secrets (two-factor secrets) before they are stored: AES-256-GCM with a key derived (HKDF) from
 * DATA_ENCRYPTION_KEY, or from JWT_ACCESS_SECRET when that is not set. Format: "v1.<iv>.<tag>.<ciphertext>" (base64url).
 * A database copy alone is then not enough to generate someone's codes.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(rootKey: string) {
    if (!rootKey || rootKey.length < 32) throw new Error('an encryption key of at least 32 characters is required');
    this.key = Buffer.from(hkdfSync('sha256', rootKey, 'pm-platform', 'two-factor-secret', 32));
  }

  seal(plain: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv, c.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  open(sealed: string) {
    const [v, iv, tag, data] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('unknown secret format');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  }
}
