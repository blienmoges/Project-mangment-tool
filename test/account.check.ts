/* Step-9 checks (two-factor login, passwords, skill verification, photos) without a database. Run: npx ts-node test/account.check.ts */
import { strict as assert } from 'node:assert';
import * as bcrypt from 'bcryptjs';
import { AuthService } from '../src/auth/auth.service';
import { SecretBox } from '../src/auth/secret-box';
import { readToken, signToken } from '../src/auth/signed-token';
import { base32Encode, codeAt, stepAt, verifyCode } from '../src/auth/totp';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { AppException } from '../src/common/app-exception';
import { RateLimiter } from '../src/common/rate-limit';
import { SkillsService } from '../src/skills/skills.service';
import { imageType } from '../src/users/avatar';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const KEY = 'x'.repeat(40);
const code = (e: unknown) => (e as AppException).body?.code;

(async () => {
  await test('TOTP matches RFC 6238 and accepts one step of clock drift', () => {
    const rfc = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(codeAt(rfc, Math.floor(59 / 30), 8), '94287082');
    assert.equal(codeAt(rfc, Math.floor(1111111109 / 30), 8), '07081804');
    const now = Date.parse('2027-02-10T09:00:15Z');
    const s = stepAt(now);
    assert.equal(verifyCode(rfc, codeAt(rfc, s), now), s);
    assert.equal(verifyCode(rfc, codeAt(rfc, s - 1), now), s - 1, '30 s late is fine');
    assert.equal(verifyCode(rfc, codeAt(rfc, s - 2), now), null, '60 s late is not');
    assert.equal(verifyCode(rfc, '12345', now), null);
  });
  await test('stored secrets are encrypted; tampering or another key is detected', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('JBSWY3DPEHPK3PXP');
    assert.ok(!sealed.includes('JBSWY3DP'));
    assert.notEqual(box.seal('JBSWY3DPEHPK3PXP'), sealed, 'a new IV every time');
    assert.equal(box.open(sealed), 'JBSWY3DPEHPK3PXP');
    const [v, iv, tag, data] = sealed.split('.');
    assert.throws(() => box.open([v, iv, tag, data.slice(0, -2) + (data.endsWith('A') ? 'BA' : 'AA')].join('.')));
    assert.throws(() => new SecretBox('y'.repeat(40)).open(sealed));
    assert.throws(() => new SecretBox('short'));
  });
  await test('signed tokens: right purpose only, expire, and reset links die when the password changes', () => {
    const now = Date.parse('2027-02-10T09:00:00Z');
    const t = signToken(KEY + 'hash-1', 'password-reset', { u: 'meron' }, 3600, now);
    assert.equal(readToken(KEY + 'hash-1', 'password-reset', t, now)?.u, 'meron');
    assert.equal(readToken(KEY + 'hash-1', '2fa-login', t, now), null, 'other purpose');
    assert.equal(readToken(KEY + 'hash-1', 'password-reset', t, now + 3601_000), null, 'expired');
    assert.equal(readToken(KEY + 'hash-2', 'password-reset', t, now), null, 'password changed since');
  });
  await test('rate limiter: the 11th try in the window is refused with 429', () => {
    const rl = new RateLimiter(10, 60_000);
    for (let i = 0; i < 10; i++) rl.hit('k', 1000 + i);
    assert.throws(() => rl.hit('k', 2000), (e) => code(e) === 'RATE_LIMITED');
    rl.hit('k', 70_000);
  });
  await test('photos are recognised by their bytes; SVG and others are refused', () => {
    assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
    assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
    assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
    assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(imageType(Buffer.from('GIF89a')), null);
  });

  // ── login, two-factor and password reset over an in-memory database ──
  const box = new SecretBox(KEY);
  const totpSecret = base32Encode(Buffer.from('meron-secret-bytes!!'));
  const users: Record<string, any> = {
    meron: { id: 'meron', email: 'meron@company.com', fullName: 'Meron Alemu', passwordHash: await bcrypt.hash('Password123!', 4), twoFactorEnabled: true, twoFactorSecret: box.seal(totpSecret) },
    dawit: { id: 'dawit', email: 'dawit@company.com', fullName: 'Dawit', passwordHash: await bcrypt.hash('Password123!', 4), twoFactorEnabled: false, twoFactorSecret: null },
  };
  const revoked: string[] = [];
  const emails: { to: string; text: string }[] = [];
  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) => (where.id ? users[where.id] : Object.values(users).find((u: any) => u.email === where.email)) ?? null,
      findUniqueOrThrow: async ({ where }: any) => users[where.id],
      update: async ({ where, data }: any) => Object.assign(users[where.id], data),
    },
    session: { create: async () => ({}), updateMany: async ({ where }: any) => { revoked.push(where.userId); return { count: 1 }; } },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  const config: any = { get: (k: string) => ({ JWT_ACCESS_SECRET: KEY, NODE_ENV: 'development', WEB_ORIGIN: 'https://app.example.com' } as any)[k] };
  const jwt: any = { signAsync: async () => 'access-token' };
  const twoFactor = new TwoFactorService(prisma, config);
  const mail: any = { sendEmailNow: async (to: string, _s: string, text: string) => { emails.push({ to, text }); return true; } };
  const auth = new AuthService(prisma, jwt, {} as any, twoFactor, mail, config);

  await test('two-factor login: password gives a challenge, not tokens; the right code finishes', async () => {
    const step1: any = await auth.login({ email: 'Meron@Company.com', password: 'Password123!' }, 'test', '10.0.0.1');
    assert.equal(step1.twoFactorRequired, true);
    assert.ok(!('tokens' in step1));
    const done: any = await auth.loginTwoFactor(step1.challengeId, codeAt(totpSecret, stepAt(Date.now())), 'test', '10.0.0.1');
    assert.equal(done.tokens.accessToken, 'access-token');
    assert.ok(!('passwordHash' in done.user) && !('twoFactorSecret' in done.user), 'secrets never leave the server');
    await assert.rejects(auth.loginTwoFactor(step1.challengeId, codeAt(totpSecret, stepAt(Date.now())), 'test', '10.0.0.1'), (e) => code(e) === 'INVALID_2FA_CODE', 'a challenge works once');
  });
  await test('two-factor: the same code cannot be used twice; 5 wrong codes spend the challenge', async () => {
    const c1: any = await auth.login({ email: 'meron@company.com', password: 'Password123!' }, 't', '10.0.0.2');
    await assert.rejects(auth.loginTwoFactor(c1.challengeId, codeAt(totpSecret, stepAt(Date.now())), 't', '10.0.0.2'), (e) => code(e) === 'INVALID_2FA_CODE', 'code already used in the previous test');
    for (let i = 0; i < 4; i++) await assert.rejects(auth.loginTwoFactor(c1.challengeId, '000000', 't', '10.0.0.2'));
    await assert.rejects(auth.loginTwoFactor(c1.challengeId, codeAt(totpSecret, stepAt(Date.now()) + 1), 't', '10.0.0.2'), (e) => code(e) === 'INVALID_2FA_CODE', 'spent: even a correct code is refused');
  });
  await test('accounts without two-factor get tokens straight away', async () => {
    const r: any = await auth.login({ email: 'dawit@company.com', password: 'Password123!' }, 't', '10.0.0.3');
    assert.equal(r.tokens.accessToken, 'access-token');
  });
  await test('login: 10 wrong passwords for one email, then 429 even with the right one', async () => {
    for (let i = 0; i < 10; i++) await assert.rejects(auth.login({ email: 'dawit@company.com', password: 'wrong' }, 't', `10.1.0.${i}`), (e) => code(e) === 'INVALID_CREDENTIALS');
    await assert.rejects(auth.login({ email: 'dawit@company.com', password: 'Password123!' }, 't', '10.1.1.1'), (e) => code(e) === 'RATE_LIMITED');
  });
  await test('forgot password: the same answer for unknown emails, and no email is sent', async () => {
    const known: any = await auth.forgotPassword('meron@company.com', '10.2.0.1');
    const unknown: any = await auth.forgotPassword('nobody@company.com', '10.2.0.1');
    assert.equal(known.message, unknown.message);
    assert.equal(unknown.resetLink, undefined);
    assert.deepEqual(emails.map((e) => e.to), ['meron@company.com']);
    assert.match(emails[0].text, /https:\/\/app\.example\.com\/reset-password\?token=/);
  });
  await test('reset link: changes the password once, signs out everywhere, then is dead', async () => {
    const link: string = ((await auth.forgotPassword('meron@company.com', '10.2.0.2')) as any).resetLink;
    const token = decodeURIComponent(link.split('token=')[1]);
    await auth.resetPassword(token, 'NewPassword456!');
    assert.ok(await bcrypt.compare('NewPassword456!', users.meron.passwordHash));
    assert.ok(revoked.includes('meron'));
    await assert.rejects(auth.resetPassword(token, 'Another789!'), (e) => code(e) === 'RESET_LINK_INVALID');
    await assert.rejects(auth.resetPassword('garbage', 'Another789!'), (e) => code(e) === 'RESET_LINK_INVALID');
  });
  await test('changing the password needs the current one', async () => {
    await assert.rejects(auth.changePassword('dawit', 'wrong', 'Something123!'), (e) => code(e) === 'VALIDATION_FAILED');
    await auth.changePassword('dawit', 'Password123!', 'Something123!');
    assert.ok(await bcrypt.compare('Something123!', users.dawit.passwordHash));
  });

  // ── skill verification ──
  const skillWorld = (role: 'admin' | 'member', sharesProject: boolean) => {
    const prismaS: any = {
      skill: { findUnique: async () => ({ id: 'node', name: 'Node.js', workspaceId: 'w1' }) },
      project: { findFirst: async () => (sharesProject ? { id: 'p1' } : null) },
      userSkill: {
        findUnique: async () => ({ level: 'expert' }),
        update: async ({ data }: any) => ({ level: 'expert', verifiedAt: data.verifiedAt, verifiedBy: data.verifiedById ? { id: data.verifiedById, fullName: 'Blien' } : null }),
      },
    };
    const access: any = { requireNonGuest: async () => ({ role }) };
    return new SkillsService(prismaS, access, { log: async () => undefined } as any);
  };
  await test('skills are verified by the Admin or a PM of a shared project, never by the person', async () => {
    assert.equal((await skillWorld('admin', false).verify('dawit', 'node', 'abel', true)).verified, true);
    assert.equal((await skillWorld('member', true).verify('dawit', 'node', 'blien', true)).verifiedBy?.fullName, 'Blien');
    await assert.rejects(skillWorld('member', false).verify('dawit', 'node', 'yonas', true), (e) => code(e) === 'FORBIDDEN');
    await assert.rejects(skillWorld('admin', true).verify('abel', 'node', 'abel', true), (e) => code(e) === 'FORBIDDEN');
    assert.equal((await skillWorld('admin', false).verify('dawit', 'node', 'abel', false)).verified, false, 'can be withdrawn');
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
