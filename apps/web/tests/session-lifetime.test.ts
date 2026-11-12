import { SESSION_MAX_MS, SESSION_SSO_MAX_MS } from '@commerceworker/core';
import { InMemoryAuthStore } from '@commerceworker/test-kit/commerce';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

let store: InMemoryAuthStore;
vi.mock('~/lib/wire.server', () => ({ authStore: () => store }));
vi.mock('~/lib/env.server', () => ({
  passwordPepper: () => undefined,
  afterResponse: (work: PromiseLike<unknown>) => work,
}));
vi.mock('~/lib/data-key.server', () => ({ openSecret: async (v: string) => v }));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn(), clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/demo.server', () => ({ isDemo: () => false, DEMO_USER: { id: 'usr_demo' } }));
vi.mock('~/lib/settings.server', () => ({
  ssoOnlyInEffect: async () => false,
  twoFactorRequirement: async () => 'off',
}));

const { principal, recordReauth, startSession, stepUp } = await import('~/lib/auth.server');

const H = 3_600_000;
const ann = { id: 'usr_1', email: 'ann@acme.com', name: 'Ann', role: 'admin' as const };
const signedIn = { kind: 'user' as const, ...ann };

/** The browser's next request, carrying the cookie `startSession` returned. */
const withCookie = (setCookie: string) =>
  new Request('https://app.test/orders', {
    headers: { cookie: setCookie.split(';')[0]! },
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T08:00:00Z'));
  store = new InMemoryAuthStore({ users: [{ ...ann, externalSub: 'sub-1' }] });
});
afterEach(() => vi.useRealTimers());

const sessionAt = async (sso: boolean) =>
  withCookie(await startSession(new Request('https://app.test/'), ann.id, { sso }));

describe('single sign-on sessions', () => {
  it('end at the cap, so a person disabled at the provider is signed out', async () => {
    const request = await sessionAt(true);
    expect(await principal(request)).not.toBeNull();
    vi.setSystemTime(Date.now() + SESSION_SSO_MAX_MS - 1_000);
    expect(await principal(withCookie(request.headers.get('cookie')!))).not.toBeNull();
    vi.setSystemTime(Date.now() + 2_000);
    expect(await principal(withCookie(request.headers.get('cookie')!))).toBeNull();
  });

  it('set a cookie that lasts as long as the cap, and a password session as long as ever', async () => {
    const sso = await startSession(new Request('https://app.test/'), ann.id, { sso: true });
    const password = await startSession(new Request('https://app.test/'), ann.id);
    expect(sso).toContain(`Max-Age=${SESSION_SSO_MAX_MS / 1000}`);
    expect(password).toContain(`Max-Age=${SESSION_MAX_MS / 1000}`);
  });

  it('are the only ones capped: a password session is still live past it', async () => {
    const request = await sessionAt(false);
    vi.setSystemTime(Date.now() + SESSION_SSO_MAX_MS + 1_000);
    // Within an admin's idle limit, so only the cap could have ended it.
    store.sessions.forEach((s) => {
      s.lastSeenAt = Date.now() - H;
    });
    expect(await principal(request)).toMatchObject({ id: ann.id });
  });

  it('can still be stepped up before they end, by signing in again at the provider', async () => {
    const request = await sessionAt(true);
    vi.setSystemTime(Date.now() + 6 * H);
    expect(await stepUp(request, signedIn, {})).toMatch(/Confirm with single sign-on/);
    expect(await recordReauth(request, signedIn, 'sub-1', Date.now())).toBe(true);
    expect(await stepUp(request, signedIn, {})).toBeNull();
  });
});
