import { Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';

export interface EmailMessage { to: string; subject: string; text: string; html: string }
export interface SmsMessage { to: string; text: string }
export interface SendResult { providerMessageId: string }

export interface EmailProvider { readonly name: string; send(m: EmailMessage): Promise<SendResult> }
export interface SmsProvider { readonly name: string; send(m: SmsMessage): Promise<SendResult> }

/** Email through any SMTP service (SRS SI-1). SMTP_URL example: smtps://user:password@smtp.example.com:465 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transport: Transporter;
  constructor(url: string, private readonly from: string) {
    this.transport = createTransport(url);
  }
  async send(m: EmailMessage) {
    const info = await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    return { providerMessageId: String(info.messageId ?? '').slice(0, 100) };
  }
}

/** SMS through Twilio's REST API (SRS SI-2). Other gateways can implement SmsProvider the same way. */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  constructor(private readonly accountSid: string, private readonly authToken: string, private readonly from: string) {}
  async send(m: SmsMessage) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: m.to, From: this.from, Body: m.text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${body.message ?? res.statusText}`);
    return { providerMessageId: body.sid ?? '' };
  }
}

/** Development stand-in: writes the message to the server log instead of sending it. */
export class LogProvider implements EmailProvider, SmsProvider {
  private readonly logger = new Logger('Outbox');
  constructor(readonly name: 'log-email' | 'log-sms') {}
  async send(m: EmailMessage | SmsMessage) {
    const text = 'subject' in m ? `${m.subject}\n${m.text}` : m.text;
    this.logger.log(`${this.name === 'log-email' ? 'EMAIL' : 'SMS'} to ${m.to}: ${text.replace(/\n/g, ' | ')}`);
    return { providerMessageId: `${this.name}-${Date.now()}` };
  }
}

/** Refuses to send, so a production server without settings records a clear failure instead of pretending. */
export class MissingProvider implements EmailProvider, SmsProvider {
  readonly name = 'missing';
  constructor(private readonly what: string) {}
  async send(): Promise<SendResult> {
    throw new Error(`${this.what} is not configured on the server`);
  }
}

type Env = Record<string, string | undefined>;

export function emailProviderFrom(env: Env): EmailProvider {
  if (env.SMTP_URL) return new SmtpEmailProvider(env.SMTP_URL, env.EMAIL_FROM ?? 'PM Platform <no-reply@example.com>');
  return env.NODE_ENV === 'production' ? new MissingProvider('Email (SMTP_URL)') : new LogProvider('log-email');
}

export function smsProviderFrom(env: Env): SmsProvider {
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) {
    return new TwilioSmsProvider(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM);
  }
  return env.NODE_ENV === 'production' ? new MissingProvider('SMS (TWILIO_* settings)') : new LogProvider('log-sms');
}
