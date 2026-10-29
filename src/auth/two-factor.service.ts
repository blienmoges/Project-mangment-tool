import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import { AppException, Errors } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { SecretBox } from './secret-box';
import { base32Encode as base32, newSecret, otpauthUrl, verifyCode } from './totp';

/** Two-factor login with an authenticator app (SRS NFR-4). The secret is stored encrypted. */
@Injectable()
export class TwoFactorService {
  private readonly box: SecretBox;
  /** Last accepted time step per user: the same code can never be used twice (in this API process). */
  private readonly lastStep = new Map<string, number>();
  private readonly issuer: string;
  private readonly pepper: string;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.box = new SecretBox(config.get<string>('DATA_ENCRYPTION_KEY') ?? config.get<string>('JWT_ACCESS_SECRET') ?? '');
    this.issuer = config.get<string>('APP_NAME') ?? 'PM Platform';
    this.pepper = config.get<string>('DATA_ENCRYPTION_KEY') ?? config.get<string>('JWT_ACCESS_SECRET') ?? '';
  }

  /** POST /me/2fa/enable — a new secret, as a QR code and as text for typing in. Not active until confirmed. */
  async start(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, twoFactorEnabled: true } });
    if (user.twoFactorEnabled) throw Errors.conflict('TWO_FACTOR_ALREADY_ON', 'Two-factor login is already on. Switch it off first to set up a new device.');
    const secret = newSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: this.box.seal(secret) } });
    const url = otpauthUrl(secret, user.email, this.issuer);
    return { qrCode: await QRCode.toDataURL(url, { margin: 1, width: 240 }), otpauthUrl: url, secret: secret.match(/.{1,4}/g)!.join(' ') };
  }

  /** POST /me/2fa/confirm — the first code from the app switches it on. */
  async confirm(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabled: true, twoFactorSecret: true } });
    if (user.twoFactorEnabled) throw Errors.conflict('TWO_FACTOR_ALREADY_ON', 'Two-factor login is already on.');
    if (!user.twoFactorSecret) throw Errors.conflict('TWO_FACTOR_NOT_STARTED', 'Start the setup first (POST /me/2fa/enable).');
    this.check(userId, user.twoFactorSecret, code);
    const { codes, hashes } = this.newBackupCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true, twoFactorBackupCodes: hashes } });
    // Shown once: the app asks the person to save them.
    return { twoFactorEnabled: true, backupCodes: codes };
  }

  /** DELETE /me/2fa — the caller has already given their password. */
  async disable(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] } });
    this.lastStep.delete(userId);
  }

  /** GET /me/2fa — whether it is on and how many backup codes are left. */
  async status(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabled: true, twoFactorBackupCodes: true } });
    return { enabled: u.twoFactorEnabled, backupCodesLeft: u.twoFactorEnabled ? u.twoFactorBackupCodes.length : 0 };
  }

  /** POST /me/2fa/backup-codes — 10 new codes; the old ones stop working (the password is checked first). */
  async regenerateBackupCodes(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabled: true } });
    if (!u.twoFactorEnabled) throw Errors.conflict('TWO_FACTOR_NOT_STARTED', 'Switch two-factor login on first.');
    const { codes, hashes } = this.newBackupCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorBackupCodes: hashes } });
    return { backupCodes: codes };
  }

  /** A backup code (xxxx-xxxx) instead of the app's code: works once. Returns how many are left, or null if wrong. */
  async useBackupCode(userId: string, code: string) {
    const clean = (code ?? '').toLowerCase().replace(/[\s-]/g, '');
    if (!/^[a-z2-7]{10}$/.test(clean)) return null;
    const hash = this.hashCode(clean);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorBackupCodes: true } });
    if (!u.twoFactorBackupCodes.includes(hash)) return null;
    // Only succeeds if the code is still there, so two sign-ins at once cannot both use it.
    const left = u.twoFactorBackupCodes.filter((h) => h !== hash);
    const r = await this.prisma.user.updateMany({ where: { id: userId, twoFactorBackupCodes: { has: hash } }, data: { twoFactorBackupCodes: left } });
    return r.count ? left.length : null;
  }

  /** Ten codes like "k7m2-qx4pa"; stored only as HMAC hashes with a server-side key. */
  private newBackupCodes() {
    const codes = Array.from({ length: 10 }, () => {
      const raw = base32(randomBytes(7)).slice(0, 10).toLowerCase();
      return `${raw.slice(0, 4)}-${raw.slice(4)}`;
    });
    return { codes, hashes: codes.map((c) => this.hashCode(c.replace('-', ''))) };
  }

  private hashCode(clean: string) {
    return createHmac('sha256', this.pepper).update(`backup-code:${clean}`).digest('hex');
  }

  /** Checks a code for a user with two-factor on; throws 401 INVALID_2FA_CODE. */
  verifyForLogin(userId: string, sealedSecret: string | null, code: string) {
    if (!sealedSecret) throw Errors.unauthenticated();
    this.check(userId, sealedSecret, code);
  }

  private check(userId: string, sealed: string, code: string) {
    const step = verifyCode(this.box.open(sealed), (code ?? '').replace(/\s/g, ''));
    if (step === null || step <= (this.lastStep.get(userId) ?? -1)) {
      throw new AppException(401, { code: 'INVALID_2FA_CODE', message: 'The code is wrong or has expired. Use the newest code from your app.' });
    }
    this.lastStep.set(userId, step);
  }
}
