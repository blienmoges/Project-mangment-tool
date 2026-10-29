import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryChannel, DeliveryStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { jobId, QueueService } from '../jobs/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { EVENTS } from './events';
import { EmailProvider, emailProviderFrom, SmsProvider, smsProviderFrom } from './providers/providers';
import { PushService } from './push.service';
import { appLink, renderEmail, renderSms } from './render';

/** Retries after the first try: 30 s, 60 s, 120 s (API Design: "retrying failures 3 times with increasing waits"). */
export const DELIVERY_ATTEMPTS = 4;
const BACKOFF_MS = 30_000;

/** Sends one email or SMS delivery and records the result (SRS SI-1, SI-2). */
@Injectable()
export class DeliveryService implements OnModuleInit {
  private readonly logger = new Logger('Delivery');
  private readonly email: EmailProvider;
  private readonly sms: SmsProvider;
  private readonly origin: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    config: ConfigService,
    private readonly push: PushService,
  ) {
    const env = { NODE_ENV: config.get('NODE_ENV'), SMTP_URL: config.get('SMTP_URL'), EMAIL_FROM: config.get('EMAIL_FROM'),
      TWILIO_ACCOUNT_SID: config.get('TWILIO_ACCOUNT_SID'), TWILIO_AUTH_TOKEN: config.get('TWILIO_AUTH_TOKEN'), TWILIO_FROM: config.get('TWILIO_FROM') };
    this.email = emailProviderFrom(env);
    this.sms = smsProviderFrom(env);
    this.origin = (config.get<string>('WEB_ORIGIN') ?? 'http://localhost:5173').split(',')[0].trim();
  }

  onModuleInit() {
    this.queues.process('notifications', (job: Job<{ deliveryId: string }>) =>
      this.send(job.data.deliveryId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
    );
    this.logger.log(`Email: ${this.email.name}, SMS: ${this.sms.name}`);
  }

  /** Emails someone who has no account yet (invitations). Returns false instead of throwing when sending fails. */
  async sendEmailNow(to: string, subject: string, text: string, html: string) {
    try {
      await this.email.send({ to, subject, text, html });
      return true;
    } catch (e) {
      this.logger.warn(`Email to ${to} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Queues the delivery; without a queue, sends it now with in-process retries. */
  async dispatch(deliveryId: string) {
    const queued = await this.queues.add('notifications', 'deliver', { deliveryId }, {
      jobId: jobId('del', deliveryId), attempts: DELIVERY_ATTEMPTS, backoff: { type: 'exponential', delay: BACKOFF_MS },
    });
    if (!queued && !this.queues.enabled) this.sendWithRetries(deliveryId);
    // If the queue is on but Redis is down, the row stays "queued" and the safety sweep sends it later.
  }

  private sendWithRetries(deliveryId: string, attempt = 1) {
    this.send(deliveryId, attempt >= DELIVERY_ATTEMPTS).catch(() => {
      if (attempt < DELIVERY_ATTEMPTS) setTimeout(() => this.sendWithRetries(deliveryId, attempt + 1), BACKOFF_MS * 2 ** (attempt - 1)).unref();
    });
  }

  /** Sends one delivery. Throws on failure so the queue retries; on the last attempt the row is marked failed. */
  async send(deliveryId: string, lastAttempt: boolean) {
    const d = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: { notification: { include: { user: { select: { fullName: true, email: true, phone: true } }, workspace: { select: { name: true } } } } },
    });
    if (!d) {
      // The notification's transaction may not be committed yet; a retry will find it.
      if (lastAttempt) return;
      throw new Error(`delivery ${deliveryId} not found yet`);
    }
    if (d.status !== DeliveryStatus.queued) return;
    const n = d.notification;
    const link = appLink(this.origin, n.linkType, n.linkId);
    try {
      let result;
      if (d.channel === DeliveryChannel.email) {
        result = await this.email.send({ to: n.user.email, ...renderEmail(n, link, n.user.fullName, n.workspace.name) });
      } else if (d.channel === DeliveryChannel.sms) {
        if (!n.user.phone) throw new Error('no phone number on the profile');
        result = await this.sms.send({ to: n.user.phone.replace(/\s+/g, ''), text: renderSms(n, link) });
      } else {
        result = await this.push.sendToUser(n.userId, { title: EVENTS[n.eventType].label, body: n.body, url: link, tag: n.id });
      }
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: DeliveryStatus.sent, sentAt: new Date(), providerMessageId: result.providerMessageId || null, error: null },
      });
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: { error: message, ...(lastAttempt ? { status: DeliveryStatus.failed } : {}) },
      });
      throw e;
    }
  }
}
