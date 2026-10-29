import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { Errors } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';

export interface PushPayload { title: string; body: string; url: string; tag?: string }

/**
 * Browser push notifications (SRS FR-4.6) with the Web Push standard. Settings: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and
 * VAPID_SUBJECT (mailto: address); make the keys once with: npx web-push generate-vapid-keys
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger('Push');
  readonly publicKey?: string;
  private readonly configured: boolean;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.publicKey = config.get<string>('VAPID_PUBLIC_KEY');
    const priv = config.get<string>('VAPID_PRIVATE_KEY');
    this.configured = !!(this.publicKey && priv);
    if (this.configured) webpush.setVapidDetails(config.get<string>('VAPID_SUBJECT') ?? 'mailto:admin@example.com', this.publicKey!, priv!);
  }

  /** POST /me/push-subscriptions — the object the browser gives (PushSubscription.toJSON()). */
  async subscribe(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
    if (!this.configured) throw Errors.conflict('PUSH_NOT_CONFIGURED', 'Push notifications are not set up on this server (VAPID keys).');
    if (!/^https:\/\//.test(sub.endpoint)) throw Errors.validation({ endpoint: 'must be an https address from the browser' });
    // An endpoint belongs to one browser; if someone else signs in there, it moves to them.
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 300) },
      update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 300) },
    });
    return { subscribed: true, devices: await this.prisma.pushSubscription.count({ where: { userId } }) };
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  /** Sends to every browser of the person. Throws if none received it (so the delivery is retried / marked failed). */
  async sendToUser(userId: string, payload: PushPayload) {
    if (!this.configured) throw new Error('push is not configured on the server');
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (!subs.length) throw new Error('no browser has allowed push notifications');
    let sent = 0;
    const errors: string[] = [];
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 24 * 3600, timeout: 15_000 });
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await this.prisma.pushSubscription.deleteMany({ where: { id: s.id } }); // the browser withdrew it
        } else {
          errors.push(`${status ?? ''} ${(e as Error).message}`.trim());
        }
      }
    }
    if (!sent) throw new Error(errors[0] ?? 'every subscription has expired');
    return { providerMessageId: `push:${sent}/${subs.length}` };
  }
}
