import {
  hashPassword,
  randomToken,
  sha256Hex,
  verifyPassword,
} from '@commerceworker/security/credentials';
import {
  authFailures,
  passwordResets,
  sessions,
  signInChallenges,
  users,
} from '@commerceworker/store/auth';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetReset,
  formatResetCode,
  keepReset,
  maskEmail,
  newResetCode,
  parseResetCode,
  parseResetLink,
  RESET_CODE_INVALID,
  RESET_LINK_INVALID,
  RESET_MS,
  RESET_TRIES,
  resetFrom,
} from '~/lib/password-reset';
import { authTestDb } from './auth-db';

vi.mock('cloudflare:workers', () => ({ env: {}, waitUntil: () => {} }));

let store = authTestDb();
let ssoOnly = false;
/** Work `afterResponse` was handed: what runs once the response has gone. */
let later: Promise<unknown>[] = [];
type Mail = { to: string[]; subject: string; text: string };
let mail: Mail[] = [];
let mailWorks = true;
const audits: { action: string; target?: string | null; detail?: Record<string, unknown> }[] = [];

let pepper: string | undefined;
vi.mock('~/lib/env.server', () => ({
  db: () => store.db,
  passwordPepper: () => pepper,
  afterResponse: (p: Promise<unknown>) => later.push(p),
  sendsEmail: () => true,
  emailSender: () => ({
    send: async (m: Mail) => {
      if (!mailWorks) return { delivered: false, error: 'E_SENDER_NOT_VERIFIED' };
      mail.push(m);
      return { delivered: true, id: 'msg' };
    },
  }),
}));
vi.mock('~/lib/data-key.server', () => ({ openSecret: async (v: string) => v }));
vi.mock('~/lib/audit.server', () => ({
  audit: async (_r: Request, action: string, e: (typeof audits)[number] = { action }) =>
    void audits.push({ ...e, action }),
  clientIp: (r: Request) => r.headers.get('cf-connecting-ip') ?? 'local',
}));
vi.mock('~/lib/settings.server', () => ({
  ssoOnlyInEffect: async () => ssoOnly,
  twoFactorRequirement: async () => 'off',
}));

const { signIn, Throttled } = await import('~/lib/auth.server');
const { openResetLink, requestReset, resetPassword, ResetError } = await import(
  '~/lib/password-reset.server'
);

const OLD = 'old horse battery';
const NEW = 'new horse battery staple';

const from = (ip = '203.0.113.7') =>
  new Request('https://cms.example.com/login/forgot', {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip },
  });

async function addUser(id: string, email: string, more: Partial<typeof users.$inferInsert> = {}) {
  await store.db.insert(users).values({
    id,
    email,
    name: id,
    role: 'member',
    passwordHash: await hashPassword(OLD),
    createdAt: 1,
    ...more,
  });
}

async function addSession(token: string, userId: string, ip?: string) {
  await store.db.insert(sessions).values({
    tokenHash: token,
    userId,
    ip: ip ?? null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
  });
}

/** The nonce each address's code was asked for with: the asking browser's cookie. */
const browsers = new Map<string, string>();

/** Asks for a code and lets the after-response work finish; the code and link it emailed. */
async function ask(email: string, ip?: string) {
  const sent = mail.length;
  const asked = await requestReset(from(ip), email);
  browsers.set(asked.email, asked.nonce);
  await Promise.all(later.splice(0));
  const m = mail[sent];
  if (!m) return null;
  const code = /Your code: (\S+)/.exec(m.text)?.[1] ?? '';
  const link = /\/login\/reset\/(\S+)/.exec(m.text)?.[1] ?? '';
  return { code, link, mail: m };
}

/** Types a code in the browser that asked for it (another, if none did). */
const reset = (email: string, code: string, password = NEW, ip?: string) =>
  resetPassword(from(ip), { email, nonce: browsers.get(email) ?? randomToken(16) }, code, password);

const viaLink = (link: string, password = NEW, ip?: string) =>
  resetPassword(from(ip), { link, masked: 'a***@example.com' }, '', password);

const failureWith = (fn: () => Promise<unknown>) =>
  fn().then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: unknown) => err as Error,
  );

beforeEach(async () => {
  store = authTestDb();
  pepper = undefined;
  ssoOnly = false;
  later = [];
  mail = [];
  mailWorks = true;
  audits.length = 0;
  browsers.clear();
  await addUser('usr_ann', 'ann@example.com');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reset codes', () => {
  it('are 8 letters from an alphabet without look-alikes, typed loosely', () => {
    for (let i = 0; i < 50; i++) expect(newResetCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(formatResetCode('ABCD2345')).toBe('ABCD-2345');
    expect(parseResetCode(' abcd-2345 ')).toBe('ABCD2345');
    // O, I and L read as the digits people mistake them for.
    expect(parseResetCode('OIL0-1111')).toBe('01101111');
    expect(parseResetCode('ABCD-234')).toBeNull();
    expect(parseResetCode('ABCD-234U')).toBeNull();
  });

  it('travel in a cookie scoped to the reset page, never shaped by the client', () => {
    const link = 'pwr_lz3k9q0abc123.ABCD2345';
    expect(parseResetLink(link)).toEqual({ id: 'pwr_lz3k9q0abc123', code: 'ABCD2345' });
    expect(parseResetLink('pwr_x.ABCD2345')).toBeNull();
    expect(parseResetLink('pwr_lz3k9q0abc123.abcd2345')).toBeNull();
    const cookie = (set: string) =>
      new Request('https://cms.example.com/login/reset', {
        headers: { cookie: set.split(';')[0]! },
      });
    const masked = 'a***@example.com';
    const nonce = randomToken(16);
    expect(keepReset({ link, masked })).toMatch(
      /Path=\/login\/reset; HttpOnly; Secure; SameSite=Lax/,
    );
    expect(resetFrom(cookie(keepReset({ link, masked })))).toEqual({ link, masked });
    expect(resetFrom(cookie(keepReset({ email: 'ann@example.com', nonce })))).toEqual({
      email: 'ann@example.com',
      nonce,
    });
    expect(resetFrom(cookie('cw_reset=l.not-a-link'))).toBeNull();
    // An address without the asking browser's nonce is no carry at all.
    expect(resetFrom(cookie('cw_reset=e.YW5uQGV4YW1wbGUuY29t'))).toBeNull();
    expect(maskEmail('blake@example.com')).toBe('b***@example.com');
    expect(forgetReset()).toMatch(/Max-Age=0/);
  });
});

describe('asking for a code', () => {
  it('emails a code and a link, and stores only a hash of it', async () => {
    const got = await ask('Ann@Example.com ');
    expect(got?.mail.to).toEqual(['ann@example.com']);
    expect(got?.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(got?.link).toMatch(/^pwr_[0-9a-z]+\.[0-9A-Z]{8}$/);
    expect(got?.mail.text).toContain('https://cms.example.com/login/reset/');
    const rows = await store.db.select().from(passwordResets);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(parseResetCode(got!.code));
    expect(rows[0]!.expiresAt - rows[0]!.createdAt).toBe(RESET_MS);
    expect(audits.at(-1)).toMatchObject({
      action: 'auth.password_reset_requested',
      detail: { outcome: 'sent' },
    });
  });

  it('answers the same, after the same work, whether or not the account can have one', async () => {
    await addUser('usr_off', 'off@example.com', { disabledAt: 5 });
    await addUser('usr_sso', 'sso@example.com', { passwordHash: null, externalSub: 'sub-1' });
    /** The statements run before the response, with the address taken out. */
    const workFor = async (email: string, ip: string) => {
      const before = store.log.length;
      const answer = await requestReset(from(ip), email);
      const work = store.log.slice(before);
      await Promise.all(later.splice(0));
      return { answer: answer.email.replace(email, '<email>'), work };
    };
    const ann = await workFor('ann@example.com', '198.51.100.1');
    for (const [email, ip] of [
      ['nobody@example.com', '198.51.100.2'],
      ['off@example.com', '198.51.100.3'],
      ['sso@example.com', '198.51.100.4'],
    ] as const) {
      const other = await workFor(email, ip);
      expect(other).toEqual(ann);
    }
    ssoOnly = true;
    expect(await workFor('ann@example.com', '198.51.100.5')).toEqual(ann);
    // Only the account that may reset got an email; the audit log says why the others didn't.
    expect(mail.map((m) => m.to[0])).toEqual(['ann@example.com']);
    expect(audits.map((a) => a.detail?.outcome)).toEqual([
      'sent',
      'no account',
      'disabled',
      'no password',
      'SSO only',
    ]);
    expect(await store.db.select().from(passwordResets)).toHaveLength(1);
  });

  it('sends an address a few codes per window, then goes quiet without saying so', async () => {
    for (let i = 0; i < 3; i++)
      expect(await ask('ann@example.com', `198.51.100.${i}`)).not.toBeNull();
    // The fourth, even from elsewhere, gets the same answer and no email.
    await expect(requestReset(from('198.51.100.9'), 'ann@example.com')).resolves.toMatchObject({
      email: 'ann@example.com',
    });
    await Promise.all(later.splice(0));
    expect(mail).toHaveLength(3);
    expect(audits.at(-1)?.detail?.outcome).toBe('too many codes for this address');
  });

  it('is a hard cap: once a stranger has used up the window, the owner gets no email either', async () => {
    await addSession('s-home', 'usr_ann', '192.0.2.77');
    for (let i = 0; i < 3; i++) await ask('ann@example.com', `198.51.100.${i}`);
    expect(await ask('ann@example.com', '192.0.2.77')).toBeNull();
    expect(mail).toHaveLength(3);
  });

  it('counts a burst of parallel requests atomically: no more than the cap is sent', async () => {
    const burst = Array.from({ length: 20 }, (_, i) =>
      requestReset(from(`198.51.100.${i}`), 'ann@example.com'),
    );
    await Promise.all(burst);
    await Promise.all(later.splice(0));
    const inserts = store.log.filter((q) => /^insert into "password_resets"/i.test(q));
    expect(inserts.length).toBeLessThanOrEqual(3);
    expect(mail.length).toBeLessThanOrEqual(3);
    expect(mail.length).toBeGreaterThan(0);
  });

  it('counts a burst of parallel requests from one place atomically too', async () => {
    const burst = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => requestReset(from(), `person${i}@example.com`)),
    );
    expect(burst.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  });

  it('peppers the stored hash when the deployment has a pepper', async () => {
    pepper = 'a-deployment-pepper';
    const { link } = (await ask('ann@example.com'))!;
    const [id, code] = link.split('.') as [string, string];
    const row = await store.db.select().from(passwordResets).get();
    expect(row!.codeHash).not.toBe(await sha256Hex(`${id}:${code}`));
    await expect(reset('ann@example.com', code)).resolves.toBeUndefined();
  });

  it('refuses a place that asks too often, across addresses', async () => {
    for (let i = 0; i < 10; i++) await requestReset(from(), `person${i}@example.com`);
    const err = await failureWith(() => requestReset(from(), 'ann@example.com'));
    expect(err).toBeInstanceOf(Throttled);
    // Another place is unaffected.
    await expect(requestReset(from('192.0.2.1'), 'ann@example.com')).resolves.toBeTruthy();
  });

  it('refuses something that is not an address, before counting it', async () => {
    const err = await failureWith(() => requestReset(from(), 'not an address'));
    expect(err).toBeInstanceOf(ResetError);
    expect(await store.db.select().from(authFailures)).toHaveLength(0);
  });

  it('records a send that failed, and still answers the same', async () => {
    mailWorks = false;
    await expect(requestReset(from(), 'ann@example.com')).resolves.toMatchObject({
      email: 'ann@example.com',
    });
    await Promise.all(later.splice(0));
    expect(audits.at(-1)?.detail?.outcome).toBe('email not sent: E_SENDER_NOT_VERIFIED');
  });
});

describe('setting a new password with a code', () => {
  it('sets it, ends every session and pending two-factor step, and keeps two-factor sign-in', async () => {
    await store.db
      .update(users)
      .set({
        totpEnabledAt: 10,
        totpSecret: 'secret',
        passwordChangeDue: true,
        passwordExpiresAt: 1,
      })
      .where(eq(users.id, 'usr_ann'));
    await addUser('usr_bob', 'bob@example.com');
    await addSession('s1', 'usr_ann');
    await addSession('s2', 'usr_ann');
    await addSession('s3', 'usr_bob');
    await store.db
      .insert(signInChallenges)
      .values({ tokenHash: 'c1', userId: 'usr_ann', createdAt: 1, expiresAt: Date.now() + 60_000 });

    const { code } = (await ask('ann@example.com'))!;
    await reset('ann@example.com', code.toLowerCase());

    const ann = (await store.db.select().from(users).where(eq(users.id, 'usr_ann')).get())!;
    expect(await verifyPassword(NEW, ann.passwordHash!)).toBe(true);
    expect(ann.passwordChangeDue).toBe(false);
    expect(ann.passwordExpiresAt).toBeNull();
    expect(ann.totpEnabledAt).toBe(10);
    const left = await store.db.select({ id: sessions.tokenHash }).from(sessions);
    expect(left.map((s) => s.id)).toEqual(['s3']);
    expect(await store.db.select().from(signInChallenges)).toHaveLength(0);
    expect(await store.db.select().from(passwordResets)).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({
      action: 'auth.password_reset',
      target: 'ann@example.com',
      detail: { sessions: 2 },
    });
    // The owner hears about it.
    await Promise.all(later.splice(0));
    expect(mail.at(-1)?.subject).toMatch(/password was changed/);

    // The new password signs in only as far as the two-factor step: the reset bypassed nothing.
    const signedIn = await signIn(from('192.0.2.50'), 'ann@example.com', NEW);
    expect(signedIn?.twoFactor).toBe(true);
    expect(signedIn?.cookie).toMatch(/^__Host-cw_2fa=/);
    expect(await signIn(from('192.0.2.50'), 'ann@example.com', OLD)).toBeNull();
  });

  it('works once', async () => {
    const { code } = (await ask('ann@example.com'))!;
    await reset('ann@example.com', code);
    const err = await failureWith(() => reset('ann@example.com', code, 'another horse battery'));
    expect(err).toBeInstanceOf(ResetError);
    expect(err.message).toBe(RESET_CODE_INVALID);
  });

  it('stops working after 15 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { code } = (await ask('ann@example.com'))!;
    vi.setSystemTime(Date.now() + RESET_MS + 1);
    const err = await failureWith(() => reset('ann@example.com', code));
    expect(err.message).toBe(RESET_CODE_INVALID);
    expect(audits.at(-1)?.detail?.reason).toBe('no live code');
  });

  it('is replaced by a newer code', async () => {
    const first = (await ask('ann@example.com'))!;
    const second = (await ask('ann@example.com'))!;
    expect((await failureWith(() => reset('ann@example.com', first.code))).message).toBe(
      RESET_CODE_INVALID,
    );
    await expect(reset('ann@example.com', second.code)).resolves.toBeUndefined();
  });

  it('dies after a few wrong tries, even for the right code', async () => {
    const { code } = (await ask('ann@example.com'))!;
    const wrong = code.startsWith('2') ? '3333-3333' : '2222-2222';
    for (let i = 0; i < RESET_TRIES; i++)
      expect((await failureWith(() => reset('ann@example.com', wrong))).message).toBe(
        RESET_CODE_INVALID,
      );
    expect((await failureWith(() => reset('ann@example.com', code))).message).toBe(
      RESET_CODE_INVALID,
    );
    const ann = await store.db.select().from(users).where(eq(users.id, 'usr_ann')).get();
    expect(await verifyPassword(OLD, ann!.passwordHash!)).toBe(true);
  });

  it('throttles a place trying codes across addresses', async () => {
    for (let i = 0; i < 10; i++)
      await failureWith(() => reset(`person${i}@example.com`, '2222-2222'));
    expect(await failureWith(() => reset('ann@example.com', '2222-2222'))).toBeInstanceOf(
      Throttled,
    );
  });

  it('says the same for an unknown address as for a wrong code', async () => {
    await ask('ann@example.com');
    const unknown = await failureWith(() => reset('nobody@example.com', '2222-2222'));
    const wrong = await failureWith(() => reset('ann@example.com', '2222-2222'));
    expect(unknown.message).toBe(wrong.message);
  });

  it('does the same work for a wrong code whether or not the address has a live one', async () => {
    await addUser('usr_off', 'off@example.com', { disabledAt: 5 });
    await addUser('usr_sso', 'sso@example.com', { passwordHash: null, externalSub: 'sub-1' });
    await ask('ann@example.com');
    const wrongFor = async (email: string, ip: string) => {
      const before = store.log.length;
      const err = await failureWith(() => reset(email, '2222-2222', NEW, ip));
      return { message: err.message, work: store.log.slice(before) };
    };
    const ann = await wrongFor('ann@example.com', '198.51.100.1');
    for (const [email, ip] of [
      ['nobody@example.com', '198.51.100.2'],
      ['off@example.com', '198.51.100.3'],
      ['sso@example.com', '198.51.100.4'],
    ] as const)
      expect(await wrongFor(email, ip)).toEqual(ann);
    expect(audits.slice(-4).map((a) => a.detail?.reason)).toEqual([
      'wrong code',
      'no live code',
      'no live code',
      'no live code',
    ]);
  });

  it('does equal write work for a live code and for none: two counter upserts, no row changed', async () => {
    await ask('ann@example.com');
    const workFor = async (email: string, ip: string) => {
      const before = store.log.length;
      await failureWith(() => reset(email, '2222-2222', NEW, ip));
      return store.log.slice(before);
    };
    const live = await workFor('ann@example.com', '198.51.100.1');
    expect(await workFor('nobody@example.com', '198.51.100.2')).toEqual(live);
    expect(live.filter((q) => /^insert into "auth_failures"/i.test(q))).toHaveLength(2);
    expect(live.filter((q) => /^update "password_resets"/i.test(q))).toHaveLength(0);
  });

  it('takes typed tries only from the browser that asked: a stranger can’t kill the owner’s code', async () => {
    const { code } = (await ask('ann@example.com'))!;
    const stranger = { email: 'ann@example.com', nonce: randomToken(16) };
    for (let i = 0; i < RESET_TRIES; i++) {
      const err = await failureWith(() =>
        resetPassword(from(`192.0.2.${i}`), stranger, '2222-2222', NEW),
      );
      expect(err.message).toBe(RESET_CODE_INVALID);
    }
    // Even the right code is refused from a browser that didn't ask, fresh tries or not: rotating
    // browsers gets a guesser nothing.
    const fresh = { email: 'ann@example.com', nonce: randomToken(16) };
    expect(
      (await failureWith(() => resetPassword(from('192.0.2.99'), fresh, code, NEW))).message,
    ).toBe(RESET_CODE_INVALID);
    expect(audits.at(-1)?.detail?.reason).toBe('no live code');
    await expect(reset('ann@example.com', code)).resolves.toBeUndefined();
  });

  it('counts a burst of parallel tries from one place atomically', async () => {
    const { code } = (await ask('ann@example.com'))!;
    const wrong = code.startsWith('2') ? '3333-3333' : '2222-2222';
    const burst = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => reset(`person${i}@example.com`, wrong)),
    );
    const throttled = burst.filter((r) => r.status === 'rejected' && r.reason instanceof Throttled);
    expect(throttled).toHaveLength(10);
    expect(audits.filter((a) => a.action === 'auth.password_reset_failed')).toHaveLength(10);
  });

  it('keeps the password policy, without spending a try', async () => {
    const { code } = (await ask('ann@example.com'))!;
    for (let i = 0; i < RESET_TRIES + 1; i++)
      expect((await failureWith(() => reset('ann@example.com', code, 'short'))).message).toMatch(
        /at least 10/,
      );
    expect(
      (await failureWith(() => reset('ann@example.com', code, 'ann@example.com-1234'))).message,
    ).toMatch(/email/);
    await expect(reset('ann@example.com', code)).resolves.toBeUndefined();
  });

  it('refuses an account disabled, or a workspace gone SSO-only, since the code was sent', async () => {
    const { code } = (await ask('ann@example.com'))!;
    ssoOnly = true;
    expect((await failureWith(() => reset('ann@example.com', code))).message).toBe(
      RESET_CODE_INVALID,
    );
    ssoOnly = false;
    await store.db.update(users).set({ disabledAt: 5 }).where(eq(users.id, 'usr_ann'));
    expect((await failureWith(() => reset('ann@example.com', code))).message).toBe(
      RESET_CODE_INVALID,
    );
  });

  it('lets only one of two racing requests with the right code win', async () => {
    const { code } = (await ask('ann@example.com'))!;
    const results = await Promise.allSettled([
      reset('ann@example.com', code, 'first horse battery'),
      reset('ann@example.com', code, 'second horse battery'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(audits.filter((a) => a.action === 'auth.password_reset')).toHaveLength(1);
  });
});

describe('setting a new password from the emailed link', () => {
  it('needs no typed code', async () => {
    const { link } = (await ask('ann@example.com'))!;
    await viaLink(link);
    const ann = await store.db.select().from(users).where(eq(users.id, 'usr_ann')).get();
    expect(await verifyPassword(NEW, ann!.passwordHash!)).toBe(true);
    expect(audits.at(-1)?.detail).toMatchObject({ via: 'link' });
  });

  it('dies after a few wrong tries through the link too', async () => {
    const { link } = (await ask('ann@example.com'))!;
    const [id, code] = link.split('.') as [string, string];
    const other = `${id}.${code.startsWith('2') ? '33333333' : '22222222'}`;
    for (let i = 0; i < RESET_TRIES; i++) await failureWith(() => viaLink(other));
    expect((await failureWith(() => viaLink(link))).message).toBe(RESET_LINK_INVALID);
  });

  it('shows the masked address only for a link that works, counting a wrong one as a try', async () => {
    await addUser('usr_blake', 'blake@example.com');
    const { link } = (await ask('blake@example.com'))!;
    expect(await openResetLink(from(), link)).toBe('b***@example.com');
    const [id, code] = link.split('.') as [string, string];
    const other = `${id}.${code.startsWith('2') ? '33333333' : '22222222'}`;
    expect(await openResetLink(from(), other)).toBeNull();
    expect(audits.at(-1)).toMatchObject({
      action: 'auth.password_reset_failed',
      detail: { reason: 'wrong code', via: 'link' },
    });
    // Opening it spent tries but not the code: the link still sets the password.
    await expect(viaLink(link)).resolves.toBeUndefined();
  });

  it('refuses a link with another code, or one already used', async () => {
    const { link } = (await ask('ann@example.com'))!;
    const [id, code] = link.split('.') as [string, string];
    const other = `${id}.${code.startsWith('2') ? '33333333' : '22222222'}`;
    const err = await failureWith(() => viaLink(other));
    expect(err.message).toBe(RESET_LINK_INVALID);
    await viaLink(link);
    expect((await failureWith(() => viaLink(link))).message).toBe(RESET_LINK_INVALID);
  });
});
