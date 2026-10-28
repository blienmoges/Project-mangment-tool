import { createHash, randomBytes } from 'crypto';
import { User } from '@prisma/client';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'workspace';

/** Removes secrets before a user is sent to the app. */
export function publicUser(u: User) {
  const { passwordHash, twoFactorSecret, ...rest } = u;
  return rest;
}


export const unique = <T>(items: T[]) => [...new Set(items)];

/** Today's date as YYYY-MM-DD in an IANA time zone (overdue checks use the workspace's time zone). */
export function todayInTimeZone(timeZone: string, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** A YYYY-MM-DD string as the Date Prisma uses for `@db.Date` columns. */
export const dateOnly = (isoDate: string) => new Date(`${isoDate}T00:00:00.000Z`);

/** A `@db.Date` value as "YYYY-MM-DD" (the API sends dates without a time). */
export const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Short task ID such as MBA-42 (SRS FR-16.1). */
export const shortId = (keyPrefix: string, number: number) => `${keyPrefix}-${number}`;
