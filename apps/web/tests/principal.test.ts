import { SESSION_IDLE_MS, SESSION_TOUCH_MS } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/** The sign-in records, in memory: Ada's session, counted and failable per lookup. */
let sessionLookups = 0;
let failNext = false;
let seen = Date.now();
const touches: unknown[] = [];
const { InMemoryAuthStore } = await import('@commerceworker/test-kit/commerce');
const { sha256Hex } = await import('~/lib/credentials');
let store: InstanceType<typeof InMemoryAuthStore>;
const counted = () => ({
  ...Object.fromEntries(
    Object.getOwnPropertyNames(Object.getPrototypeOf(store)).map((k) => [
      k,
      (store as unknown as Record<string, (...a: unknown[]) => unknown>)[k]!.bind(store),
    ]),
  ),
  liveSession: async (...a: Parameters<typeof store.liveSession>) => {
    sessionLookups++;
    if (failNext) {
      failNext = false;
      throw new Error('D1 unavailable');
    }
    return store.liveSession(...a);
  },
  // The marker the test looks for in what was handed to `afterResponse`.
  touchSession: () => 'touch' as unknown as Promise<void>,
});
vi.mock('~/lib/wire.server', () => ({ authStore: () => counted() }));
const afterResponse = vi.fn((work: unknown) => touches.push(work));
vi.mock('~/lib/env.server', () => ({ afterResponse }));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn(), clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/demo.server', () => ({ isDemo: () => false, DEMO_USER: { id: 'usr_demo' } }));
vi.mock('~/lib/settings.server', () => ({
  ssoOnlyInEffect: async () => false,
  twoFactorRequirement: async () => 'none',
}));

const { principal, sessionPerson } = await import('~/lib/auth.server');

const page = (path = '/orders/ord_1') =>
  new Request(`https://acme.commerceworker.com${path}`, {
    headers: { cookie: '__Host-cmw_session=tok_abc' },
  });

describe('principal()', () => {
  beforeEach(async () => {
    seen = Date.now();
    store = new InMemoryAuthStore({
      users: [
        {
          id: 'usr_ada',
          email: 'ada@example.com',
          name: 'Ada',
          role: 'operator',
          totpEnabledAt: 1,
        },
      ],
      sessions: [
        {
          tokenHash: await sha256Hex('tok_abc'),
          userId: 'usr_ada',
          createdAt: Date.now() - 60_000,
          expiresAt: Date.now() + 3_600_000,
          lastSeenAt: seen,
        },
      ],
    });
    sessionLookups = 0;
    failNext = false;
    touches.length = 0;
    afterResponse.mockClear();
  });

  it('looks the session up once per Request, for the shell and the page alike', async () => {
    const request = page();
    const [shell, child] = await Promise.all([principal(request), principal(request)]);
    expect(shell).toMatchObject({ kind: 'user', id: 'usr_ada', role: 'operator' });
    expect(child).toBe(shell);
    expect(await principal(request)).toBe(shell);
    expect(sessionLookups).toBe(1);
  });

  it('looks again for another Request, such as a client navigation’s .data fetch', async () => {
    await principal(page('/orders/ord_1'));
    await principal(page('/orders/ord_1.data'));
    expect(sessionLookups).toBe(2);
  });

  it('does not keep a failed lookup', async () => {
    const request = page();
    failNext = true;
    await expect(principal(request)).rejects.toThrow(/D1 unavailable/);
    expect(await principal(request)).toMatchObject({ id: 'usr_ada' });
    expect(sessionLookups).toBe(2);
  });

  it('records a stale session’s last use after the response, once', async () => {
    seen = Date.now() - SESSION_TOUCH_MS - 1000;
    await store.touchSession(await sha256Hex('tok_abc'), seen, null);
    const request = page();
    await Promise.all([principal(request), principal(request)]);
    expect(afterResponse).toHaveBeenCalledTimes(1);
    expect(touches).toEqual(['touch']);
  });

  it('rechecks a content socket session without extending its activity and stops it after sign-out', async () => {
    const hash = await sha256Hex('tok_abc');
    expect(await sessionPerson(hash, Date.now())).toMatchObject({ caller: { id: 'usr_ada' } });
    expect(afterResponse).not.toHaveBeenCalled();
    await store.endSession(hash);
    expect(await sessionPerson(hash, Date.now())).toBeNull();
  });

  it('refuses idle, disabled and setup-due content socket callers', async () => {
    const hash = await sha256Hex('tok_abc');
    await store.touchSession(hash, Date.now() - SESSION_IDLE_MS - 1000, null);
    expect(await sessionPerson(hash, Date.now())).toBeNull();
    await store.touchSession(hash, Date.now(), null);
    store.users.set('usr_ada', {
      ...store.users.get('usr_ada')!,
      passwordHash: 'temporary',
      passwordChangeDue: true,
    });
    expect(await sessionPerson(hash, Date.now())).toBeNull();
    store.users.set('usr_ada', {
      ...store.users.get('usr_ada')!,
      passwordChangeDue: false,
      disabledAt: 1,
    });
    expect(await sessionPerson(hash, Date.now())).toBeNull();
  });

  it('leaves a recently seen session alone', async () => {
    await principal(page());
    expect(afterResponse).not.toHaveBeenCalled();
  });
});
