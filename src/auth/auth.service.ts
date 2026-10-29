import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AppException, Errors } from '../common/app-exception';
import { RateLimiter } from '../common/rate-limit';
import { DeliveryService } from '../notifications/delivery.service';
import { normalizeEmail, publicUser, randomToken, sha256 } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationsService } from '../workspaces/invitations.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { peekToken, readToken, signToken } from './signed-token';
import { TwoFactorService } from './two-factor.service';

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_DAYS = 30;
const BCRYPT_ROUNDS = 12;
export const CHALLENGE_SECONDS = 5 * 60;
const RESET_SECONDS = 60 * 60;
const MAX_CODE_TRIES = 5;
/** A real hash, so checking a password for an unknown email takes as long as for a real one. */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  /** 10 tries per email and 50 per address in 15 minutes (login); 5 reset emails per email an hour. */
  private readonly loginLimit = new RateLimiter(10, 15 * 60_000);
  private readonly ipLimit = new RateLimiter(50, 15 * 60_000);
  private readonly resetLimit = new RateLimiter(5, 60 * 60_000);
  /** Wrong codes per login challenge; a challenge is spent after a success or 5 wrong codes. */
  private readonly challengeTries = new Map<string, number>();
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly invitations: InvitationsService,
    private readonly twoFactor: TwoFactorService,
    private readonly delivery: DeliveryService,
    private readonly config: ConfigService,
  ) {
    this.secret = config.get<string>('JWT_ACCESS_SECRET') ?? '';
  }

  async register(dto: RegisterDto, userAgent?: string) {
    const email = normalizeEmail(dto.email);
    const invitation = dto.invitationToken ? await this.invitations.findUsable(dto.invitationToken) : null;
    if (invitation && invitation.email !== email) {
      throw Errors.validation({ email: 'must be the email address the invitation was sent to' });
    }
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw Errors.conflict('ALREADY_EXISTS', 'An account with this email already exists. Please log in instead.');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { email, passwordHash, fullName: dto.fullName.trim(), lastLoginAt: new Date() } });
      if (invitation) await this.invitations.acceptWithTx(tx, invitation, created.id);
      return created;
    });
    const tokens = await this.issueTokens(user.id, userAgent);
    return { tokens, user: publicUser(user) };
  }

  /** Step 1. With two-factor on, returns a challenge instead of tokens: { twoFactorRequired, challengeId }. */
  async login(dto: LoginDto, userAgent?: string, ip = 'unknown') {
    const email = normalizeEmail(dto.email);
    this.ipLimit.hit(`ip:${ip}`);
    this.loginLimit.hit(`login:${email}`);
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Compare even when the user does not exist, so response time does not reveal which emails are registered.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw Errors.invalidCredentials();
    this.loginLimit.reset(`login:${email}`);
    if (user.twoFactorEnabled) {
      const challengeId = signToken(this.secret, '2fa-login', { u: user.id }, CHALLENGE_SECONDS);
      return { twoFactorRequired: true as const, challengeId, expiresIn: CHALLENGE_SECONDS };
    }
    return this.finishLogin(user.id, userAgent);
  }

  /** Step 2 (POST /auth/login/2fa): the 6-digit code from the authenticator app. */
  async loginTwoFactor(challengeId: string, code: string, userAgent?: string, ip = 'unknown') {
    this.ipLimit.hit(`ip:${ip}`);
    const c = readToken<{ u: string }>(this.secret, '2fa-login', challengeId);
    const spent = c ? (this.challengeTries.get(c.n) ?? 0) >= MAX_CODE_TRIES : true;
    if (!c || spent) throw new AppException(401, { code: 'INVALID_2FA_CODE', message: 'This sign-in has expired. Enter your email and password again.' });
    const user = await this.prisma.user.findUnique({ where: { id: c.u } });
    if (!user?.twoFactorEnabled) throw Errors.unauthenticated();
    let backupCodesLeft: number | null = null;
    try {
      // A backup code looks like "k7m2-qx4pa"; an app code is 6 digits.
      backupCodesLeft = /[a-z]/i.test(code) ? await this.twoFactor.useBackupCode(user.id, code) : null;
      if (backupCodesLeft === null) this.twoFactor.verifyForLogin(user.id, user.twoFactorSecret, code);
    } catch (e) {
      this.challengeTries.set(c.n, (this.challengeTries.get(c.n) ?? 0) + 1);
      throw e;
    }
    this.challengeTries.set(c.n, MAX_CODE_TRIES); // single use
    setTimeout(() => this.challengeTries.delete(c.n), CHALLENGE_SECONDS * 1000).unref();
    const result = await this.finishLogin(user.id, userAgent);
    return backupCodesLeft === null ? result : { ...result, backupCodesLeft };
  }

  /** POST /auth/password/forgot — always the same answer, so it cannot be used to find out who has an account. */
  async forgotPassword(emailRaw: string, ip = 'unknown') {
    const email = normalizeEmail(emailRaw);
    this.ipLimit.hit(`ip:${ip}`);
    this.resetLimit.hit(`reset:${email}`);
    const user = await this.prisma.user.findUnique({ where: { email } });
    let resetLink: string | undefined;
    if (user) {
      const token = signToken(this.secret + user.passwordHash, 'password-reset', { u: user.id }, RESET_SECONDS);
      resetLink = `${this.webOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
      await this.delivery.sendEmailNow(
        user.email, 'Reset your password',
        `Hello ${user.fullName},\n\nSomeone asked to reset the password of your account. If it was you, choose a new password here (the link works for one hour, once):\n${resetLink}\n\nIf it was not you, ignore this email; your password stays the same.`,
        `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:560px"><p>Hello ${escapeHtml(user.fullName)},</p><p>Someone asked to reset the password of your account. If it was you, choose a new password (the link works for one hour, once):</p><p><a href="${escapeHtml(resetLink)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Choose a new password</a></p><p style="color:#6b7280;font-size:13px">If it was not you, ignore this email; your password stays the same.</p></div>`,
      );
    }
    // In development the link is also returned, for testing without an inbox (never in production).
    return { message: 'If an account exists for this email, we sent a link to reset the password.', ...(this.config.get('NODE_ENV') !== 'production' && resetLink ? { resetLink } : {}) };
  }

  /** POST /auth/password/reset — the link works once: the new password changes the key it was signed with. */
  async resetPassword(token: string, password: string) {
    const invalid = () => Errors.gone('RESET_LINK_INVALID', 'This link has expired or was already used. Ask for a new one.');
    const peek = peekToken<{ u?: string }>(token);
    const user = peek?.u ? await this.prisma.user.findUnique({ where: { id: String(peek.u) } }) : null;
    if (!user || !readToken(this.secret + user.passwordHash, 'password-reset', token)) throw invalid();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      // Whoever knew the old password is signed out everywhere.
      this.prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    this.loginLimit.reset(`login:${user.email}`);
    return { message: 'Your password was changed. You can sign in now.' };
  }

  /** PATCH /me/password — needs the current password; other sessions are signed out, this one stays. */
  async changePassword(userId: string, currentPassword: string, newPassword: string, currentRefreshToken?: string) {
    this.loginLimit.hit(`change:${userId}`);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw Errors.validation({ currentPassword: 'is not correct' });
    if (currentPassword === newPassword) throw Errors.validation({ newPassword: 'must be different from the current password' });
    const keep = currentRefreshToken ? sha256(currentRefreshToken) : '';
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) } }),
      this.prisma.session.updateMany({ where: { userId, revokedAt: null, tokenHash: { not: keep } }, data: { revokedAt: new Date() } }),
    ]);
    this.loginLimit.reset(`change:${userId}`);
  }

  /** Checks the password before a sensitive change (switching two-factor off). */
  async checkPassword(userId: string, password: string) {
    this.loginLimit.hit(`change:${userId}`);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(password, user.passwordHash))) throw Errors.validation({ password: 'is not correct' });
  }

  private async finishLogin(userId: string, userAgent?: string) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    const tokens = await this.issueTokens(user.id, userAgent);
    return { tokens, user: publicUser(user) };
  }

  private webOrigin() {
    return (this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:5173').split(',')[0].trim();
  }

  /** Swaps a refresh token for new tokens. Each refresh token works once (rotation). */
  async refresh(refreshToken: string | undefined, userAgent?: string): Promise<IssuedTokens> {
    if (!refreshToken) throw Errors.unauthenticated();
    const session = await this.prisma.session.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!session) throw Errors.unauthenticated();
    if (session.revokedAt) {
      // An old token was reused: it may have been stolen, so end every session of this user.
      await this.prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw Errors.unauthenticated();
    }
    if (session.expiresAt < new Date()) throw Errors.unauthenticated();
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(session.userId, userAgent);
  }

  async logout(refreshToken: string | undefined) {
    if (!refreshToken) return;
    await this.prisma.session.updateMany({ where: { tokenHash: sha256(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async issueTokens(userId: string, userAgent?: string): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync({ sub: userId }, { expiresIn: ACCESS_TOKEN_SECONDS });
    const refreshToken = randomToken(48);
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        userAgent: userAgent?.slice(0, 300),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_SECONDS };
  }
}


const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
