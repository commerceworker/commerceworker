import { hashPassword, verifyPassword } from '@commerceworker/security/credentials';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '~/lib/roles';
import { fromBase32, newTotpSecret, totpCode, totpStep } from '../app/lib/totp';

vi.mock('cloudflare:workers', () => ({ env: {} }));

type User = {
  id: string;
  totpEnabledAt: number | null;
  totpSecret: string | null;
  totpLastStep: number | null;
  passwordHash: string | null;
  externalSub?: string | null;
};
let user: User;
let session: { createdAt: number; reauthAt: number | null } | undefined;
let ssoOnly = false;
const failures = new Map<string, { key: string; count: number; windowStart: number }>();

/** The port is instrumented here for the sign-in and step-up rules. */
let pepper: string | undefined;
const rehashed: string[] = [];
vi.mock('~/lib/env.server', () => ({ passwordPepper: () => pepper, afterResponse: () => {} }));
vi.mock('~/lib/wire.server', () => ({
  adminAuth: () => ({
    user: async () => user,
    userByEmail: async () => user,
    session: async () => session,
    failures: async (keys: string[]) => [...failures.values()].filter((r) => keys.includes(r.key)),
    recordFailures: async (keys: string[], now: number, windowMs: number) => {
      for (const key of keys) {
        const old = failures.get(key);
        failures.set(
          key,
          !old || now - old.windowStart >= windowMs
            ? { key, count: 1, windowStart: now }
            : { ...old, count: old.count + 1 },
        );
      }
    },
    pruneFailures: async () => {},
    clearFailures: async (key: string) => {
      failures.delete(key);
    },
    knownPlace: async () => !!session,
    setReauth: async (_hash: string, _id: string, at: number) => {
      if (session) session.reauthAt = at;
    },
    useTotpStep: async (_id: string, step: number) => {
      if (user.totpLastStep !== null && step <= user.totpLastStep) return false;
      user.totpLastStep = step;
      return true;
    },
    rehashPassword: async (_id: string, _was: string, hash: string) => {
      rehashed.push(hash);
    },
    startSession: async () => {},
    startChallenge: async () => {},
  }),
}));
vi.mock('~/lib/data-key.server', () => ({ openSecret: async (v: string) => v }));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn(), clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/settings.server', () => ({
  ssoOnlyInEffect: async () => ssoOnly,
  twoFactorRequirement: async () => 'off',
}));

const { recordReauth, signIn, signInToLink, stepUp, stepUpMethod, Throttled } = await import(
  '~/lib/auth.server'
);

const admin: Principal = { kind: 'user', id: 'usr_1', name: 'Ann', role: 'admin' };
const request = new Request('https://app.test/plugins', {
  method: 'POST',
  headers: { cookie: '__Host-cw_session=tok_abc' },
});

beforeEach(() => {
  failures.clear();
  ssoOnly = false;
  session = { createdAt: Date.now() - 60 * 60_000, reauthAt: null };
  user = {
    id: 'usr_1',
    totpEnabledAt: null,
    totpSecret: null,
    totpLastStep: null,
    passwordHash: null,
  };
});

describe('stepUp', () => {
  it('takes a current two-factor code once, from someone who has two-factor sign-in', async () => {
    const secret = newTotpSecret();
    user = {
      ...user,
      totpEnabledAt: 1,
      totpSecret: secret,
      passwordHash: await hashPassword('pw'),
    };
    expect(await stepUpMethod(admin)).toBe('code');
    const code = await totpCode(fromBase32(secret)!, totpStep(Date.now()));
    // Their password isn't enough once they have two-factor sign-in.
    expect(await stepUp(request, admin, { password: 'pw' })).toMatch(/authenticator/);
    expect(await stepUp(request, admin, { code })).toBeNull();
    // The same code again (a replay, or one already used to sign in) is refused.
    expect(await stepUp(request, admin, { code })).toMatch(/authenticator/);
  });

  it('takes the password of someone without two-factor sign-in, unless passwords are off', async () => {
    user = { ...user, passwordHash: await hashPassword('right horse') };
    expect(await stepUpMethod(admin)).toBe('password');
    expect(await stepUp(request, admin, { password: 'wrong' })).toMatch(/password is not right/);
    expect(await stepUp(request, admin, { password: 'right horse' })).toBeNull();
    ssoOnly = true;
    expect(await stepUpMethod(admin)).toBe('sso');
    expect(await stepUp(request, admin, { password: 'right horse' })).toMatch(/single sign-on/);
  });

  it('takes signing in again at the provider in the last ten minutes, from someone with neither', async () => {
    expect(await stepUpMethod(admin)).toBe('sso');
    expect(await stepUp(request, admin, {})).toMatch(/Confirm with single sign-on/);
    // A new session alone isn't enough: the provider may have answered from its own session.
    session = { createdAt: Date.now() - 60_000, reauthAt: null };
    expect(await stepUp(request, admin, {})).toMatch(/Confirm with single sign-on/);
    session = { createdAt: Date.now() - 60 * 60_000, reauthAt: Date.now() - 11 * 60_000 };
    expect(await stepUp(request, admin, {})).toMatch(/Confirm with single sign-on/);
    session = { createdAt: Date.now() - 60 * 60_000, reauthAt: Date.now() - 5 * 60_000 };
    expect(await stepUp(request, admin, {})).toBeNull();
  });

  it('records signing in again only for the identity linked to the person', async () => {
    user = { ...user, externalSub: 'sub-1' };
    expect(await recordReauth(request, admin, 'sub-2', Date.now())).toBe(false);
    expect(await stepUp(request, admin, {})).toMatch(/Confirm with single sign-on/);
    expect(await recordReauth(request, admin, 'sub-1', Date.now())).toBe(true);
    expect(await stepUp(request, admin, {})).toBeNull();
  });

  it('stops answering after five wrong tries', async () => {
    user = { ...user, passwordHash: await hashPassword('pw') };
    for (let i = 0; i < 5; i++) await stepUp(request, admin, { password: 'nope' });
    expect(await stepUp(request, admin, { password: 'pw' })).toMatch(/Too many tries/);
  });

  it('refuses open local development, which has no one to ask', async () => {
    const open: Principal = { kind: 'open', id: 'local', name: 'local', role: 'admin' };
    expect(await stepUpMethod(open)).toBeNull();
    expect(await stepUp(request, open, { password: 'x' })).toMatch(/person signed in/);
  });
});

describe('signInToLink', () => {
  const ann = async (
    totpEnabledAt: number | null = null,
    passwordExpiresAt: number | null = null,
  ) => ({
    id: 'usr_1',
    email: 'ann@acme.com',
    passwordHash: await hashPassword('right horse'),
    totpEnabledAt,
    passwordChangeDue: passwordExpiresAt !== null,
    passwordExpiresAt,
  });

  it('links nothing with a temporary password that has run out', async () => {
    expect(await signInToLink(request, await ann(null, Date.now() - 1), 'right horse')).toBeNull();
  });

  it('takes the password even while the workspace is SSO-only, then the code when they have one', async () => {
    ssoOnly = true;
    expect(await signInToLink(request, await ann(), 'wrong')).toBeNull();
    const signedIn = await signInToLink(request, await ann(), 'right horse');
    if (!signedIn || signedIn.twoFactor) throw new Error('expected a sign-in without a code');
    // The session waits until the caller has linked the identity.
    expect(await signedIn.signIn()).toMatch(/^__Host-cw_session=/);
    expect(await signInToLink(request, await ann(1), 'right horse')).toMatchObject({
      twoFactor: true,
      cookie: expect.not.stringMatching(/^__Host-cw_session=/),
    });
  });

  it('counts wrong passwords against the same limits as signing in', async () => {
    for (let i = 0; i < 5; i++) expect(await signInToLink(request, await ann(), 'nope')).toBeNull();
    await expect(signInToLink(request, await ann(), 'right horse')).rejects.toBeInstanceOf(
      Throttled,
    );
  });
});

describe('password sign-in', () => {
  const sign = (password: string) => signIn(request, 'ann@acme.com', password);
  const ann = async (over: Record<string, unknown> = {}) => {
    user = {
      ...user,
      passwordHash: await hashPassword('right horse'),
      ...over,
    } as typeof user;
    Object.assign(user, { email: 'ann@acme.com', name: 'Ann', role: 'member', disabledAt: null });
  };

  it('refuses a temporary password once it has expired', async () => {
    await ann({ passwordChangeDue: true, passwordExpiresAt: Date.now() - 1 });
    expect(await sign('right horse')).toBeNull();
    // A password they chose never runs out, whatever an older Worker left in the column.
    await ann({ passwordChangeDue: false, passwordExpiresAt: Date.now() - 1 });
    expect(await sign('right horse')).toMatchObject({ twoFactor: false });
    await ann({ passwordChangeDue: true, passwordExpiresAt: Date.now() + 60_000 });
    expect(await sign('right horse')).toMatchObject({ twoFactor: false });
  });

  it('keeps the account’s owner signing in from a known place while others fail at it', async () => {
    await ann({ passwordExpiresAt: null });
    // Many places got the account's password wrong: its own count is full.
    failures.set('email:ann@acme.com', {
      key: 'email:ann@acme.com',
      count: 50,
      windowStart: Date.now(),
    });
    session = undefined;
    await expect(sign('right horse')).rejects.toBeInstanceOf(Throttled);
    // From a place one of their sessions was seen at, they still get in.
    session = { createdAt: Date.now(), reauthAt: null };
    expect(await sign('right horse')).toMatchObject({ twoFactor: false });
  });

  it('stores a password hashed before the pepper again with it, once it is known', async () => {
    rehashed.length = 0;
    pepper = 'p'.repeat(64);
    try {
      await ann({ passwordChangeDue: false, passwordExpiresAt: null });
      expect(await sign('right horse')).toMatchObject({ twoFactor: false });
      expect(rehashed).toHaveLength(1);
      expect(rehashed[0]).toMatch(/^pbkdf2p:/);
      expect(await verifyPassword('right horse', rehashed[0]!, pepper)).toBe(true);
    } finally {
      pepper = undefined;
    }
  });

  it('tells the operator, not the person, when the pepper a hash was made with is gone', async () => {
    const { audit } = await import('~/lib/audit.server');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    pepper = 'q'.repeat(64);
    try {
      await ann({
        passwordHash: await hashPassword('right horse', 'p'.repeat(64)),
        passwordChangeDue: false,
        passwordExpiresAt: null,
      });
      vi.mocked(audit).mockClear();
      expect(await sign('right horse')).toBeNull();
      expect(vi.mocked(audit)).toHaveBeenCalledWith(request, 'auth.sign_in_failed', {
        target: 'ann@acme.com',
        detail: { reason: 'password pepper mismatch' },
      });
      expect(logged.mock.calls.flat().join()).toMatch(/password_pepper_mismatch/);
    } finally {
      pepper = undefined;
      logged.mockRestore();
    }
  });
});
