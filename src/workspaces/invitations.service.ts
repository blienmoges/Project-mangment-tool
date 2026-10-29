import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Invitation, Prisma } from '@prisma/client';
import { Errors } from '../common/app-exception';
import { normalizeEmail, randomToken, sha256 } from '../common/utils';
import { ActivityService } from '../activity/activity.service';
import { DeliveryService } from '../notifications/delivery.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvitationsDto } from './dto/workspace.dto';
import { defaultPreferenceRows } from './notification-defaults';
import { WorkspaceAccessService } from './workspace-access.service';

const INVITE_DAYS = 7;

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly activity: ActivityService,
    private readonly config: ConfigService,
    private readonly delivery: DeliveryService,
  ) {}

  private inviteLink(token: string) {
    const origin = (this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:5173').split(',')[0];
    return `${origin}/invite/${token}`;
  }

  /** FR-8.2: invite people by email. In development the link is also returned, for testing without an inbox. */
  async create(workspaceId: string, actorId: string, dto: CreateInvitationsDto) {
    await this.access.requireAdmin(workspaceId, actorId);
    const showLinks = this.config.get('NODE_ENV') !== 'production';
    const results = [];
    for (const raw of new Set(dto.emails.map(normalizeEmail))) {
      const existing = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, user: { email: raw } } });
      if (existing) {
        results.push({ email: raw, status: 'already_member' });
        continue;
      }
      const token = randomToken(32);
      const invitation = await this.prisma.invitation.create({
        data: {
          workspaceId,
          email: raw,
          role: dto.role,
          tokenHash: sha256(token),
          invitedById: actorId,
          expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
        },
      });
      await this.activity.log({ workspaceId, actorId, entityType: 'invitation', entityId: invitation.id, action: 'created', newValue: { email: raw, role: dto.role } });
      const emailed = await this.sendInvitation(raw, token, workspaceId, actorId);
      results.push({ email: raw, status: 'invited', invitationId: invitation.id, expiresAt: invitation.expiresAt, emailed, ...(showLinks ? { inviteLink: this.inviteLink(token) } : {}) });
    }
    return { data: results };
  }

  private async sendInvitation(email: string, token: string, workspaceId: string, actorId: string) {
    const [workspace, inviter] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: actorId }, select: { fullName: true } }),
    ]);
    const link = this.inviteLink(token);
    const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const subject = `${inviter.fullName} invited you to ${workspace.name}`;
    const text = `${inviter.fullName} invited you to join ${workspace.name} on the Project Management Platform.\n\nAccept the invitation: ${link}\n\nThe link works for ${INVITE_DAYS} days.`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:560px"><p>${esc(inviter.fullName)} invited you to join <b>${esc(workspace.name)}</b> on the Project Management Platform.</p><p><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Accept the invitation</a></p><p style="color:#6b7280;font-size:13px">The link works for ${INVITE_DAYS} days.</p></div>`;
    return this.delivery.sendEmailNow(email, subject, text, html);
  }

  async listPending(workspaceId: string, actorId: string) {
    await this.access.requireAdmin(workspaceId, actorId);
    const data = await this.prisma.invitation.findMany({
      where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return { data };
  }

  async cancel(invitationId: string, actorId: string) {
    const invitation = await this.prisma.invitation.findUnique({ where: { id: invitationId } });
    if (!invitation) throw Errors.notFound('Invitation');
    await this.access.requireAdmin(invitation.workspaceId, actorId);
    await this.prisma.invitation.delete({ where: { id: invitationId } });
  }

  /** Finds an invitation that can still be used, or explains why not. */
  async findUsable(token: string) {
    const invitation = await this.prisma.invitation.findUnique({ where: { tokenHash: sha256(token) }, include: { workspace: true } });
    if (!invitation) throw Errors.notFound('Invitation');
    if (invitation.acceptedAt) throw Errors.conflict('INVITATION_ALREADY_USED', 'This invitation has already been accepted.');
    if (invitation.expiresAt < new Date()) throw Errors.gone('INVITATION_EXPIRED', 'This invitation has expired. Ask the Workspace Admin to send a new one.');
    return invitation;
  }

  async preview(token: string) {
    const inv = await this.findUsable(token);
    return { workspaceName: inv.workspace.name, email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
  }

  /** Signed-in user accepts an invitation sent to their email address. */
  async accept(token: string, userId: string) {
    const invitation = await this.findUsable(token);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.email !== invitation.email) throw Errors.forbidden('This invitation was sent to a different email address.');
    await this.prisma.$transaction((tx) => this.acceptWithTx(tx, invitation, userId));
    return { workspaceId: invitation.workspaceId, role: invitation.role };
  }

  /** Shared by accept() and registration with an invitation token. */
  async acceptWithTx(tx: Prisma.TransactionClient, invitation: Invitation, userId: string) {
    const already = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } } });
    if (!already) {
      await tx.workspaceMember.create({
        data: { workspaceId: invitation.workspaceId, userId, role: invitation.role, invitedById: invitation.invitedById },
      });
      await tx.notificationPreference.createMany({ data: defaultPreferenceRows(invitation.workspaceId, userId), skipDuplicates: true });
    }
    await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
    await this.activity.log(
      { workspaceId: invitation.workspaceId, actorId: userId, entityType: 'workspace_member', entityId: userId, action: 'joined', newValue: { role: invitation.role } },
      tx,
    );
  }
}

