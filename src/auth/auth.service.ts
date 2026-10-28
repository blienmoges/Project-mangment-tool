import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { Errors } from '../common/app-exception';
import { normalizeEmail, publicUser, randomToken, sha256 } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationsService } from '../workspaces/invitations.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_DAYS = 30;
const BCRYPT_ROUNDS = 12;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly invitations: InvitationsService,
  ) {}

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

  async login(dto: LoginDto, userAgent?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(dto.email) } });
    // Compare even when the user does not exist, so response time does not reveal which emails are registered.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok) throw Errors.invalidCredentials();
    // TODO (next step): if user.twoFactorEnabled, return { twoFactorRequired, challengeId } instead of tokens.
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const tokens = await this.issueTokens(user.id, userAgent);
    return { tokens, user: publicUser(user) };
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

