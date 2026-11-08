/**
 * The behaviour every `AuthStore` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). The fixture is the only team in the store; ids start `au_`.
 */
import type { AuthStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { AuthFixture } from './auth-store';

const MIN = 60_000;
export const AUTH_NOW = 10_000 * MIN;
const now = AUTH_NOW;

export const AUTH_FIXTURE: AuthFixture = {
  users: [
    {
      id: 'au_ada',
      email: 'ada@example.com',
      name: 'Ada',
      role: 'admin',
      passwordHash: 'h1',
      totpEnabledAt: 1,
      totpSecret: 'sealed',
    },
    { id: 'au_lin', email: 'lin@example.com', name: 'Lin', role: 'viewer', externalSub: 'sub-lin' },
    { id: 'au_gone', email: 'gone@example.com', name: 'Gone', role: 'viewer', disabledAt: 5 },
  ],
  sessions: [
    {
      tokenHash: 'au_s_ada',
      userId: 'au_ada',
      createdAt: now - 10 * MIN,
      expiresAt: now + MIN,
      lastSeenAt: now - MIN,
      ip: '203.0.113.7',
    },
    { tokenHash: 'au_s_gone', userId: 'au_gone', createdAt: now - MIN, expiresAt: now + MIN },
  ],
  tokens: [
    {
      id: 'au_t1',
      name: 'ci',
      prefix: 'cmw_live_ab',
      tokenHash: 'th1',
      role: 'operator',
      expiresAt: now + MIN,
    },
    {
      id: 'au_t2',
      name: 'old',
      prefix: 'cmw_live_cd',
      tokenHash: 'th2',
      role: 'operator',
      revokedAt: 5,
    },
  ],
  recoveryCodes: [
    { userId: 'au_ada', codeHash: 'rc1' },
    { userId: 'au_ada', codeHash: 'rc2' },
  ],
};

export function describeAuthStoreContract(
  name: string,
  make: (fixture: AuthFixture) => Promise<AuthStore>,
) {
  describe(`${name}: the auth store contract`, () => {
    const fresh = () => make(AUTH_FIXTURE);

    it('reads people by email and id, and adds one only once', async () => {
      const s = await fresh();
      expect(await s.userCount()).toBe(3);
      expect(await s.userByEmail('ada@example.com')).toMatchObject({
        id: 'au_ada',
        totpEnabledAt: 1,
        passwordChangeDue: false,
      });
      expect((await s.user('au_lin'))?.externalSub).toBe('sub-lin');
      expect(await s.userByEmail('nobody@example.com')).toBeUndefined();
      await s.addUserIfAbsent({
        id: 'au_lin',
        email: 'x@example.com',
        name: 'X',
        role: 'admin',
        createdAt: 0,
      });
      expect((await s.user('au_lin'))?.email).toBe('lin@example.com');
      await s.rehashPassword('au_ada', 'not-it', 'h2');
      await s.rehashPassword('au_ada', 'h1', 'h3');
      expect((await s.user('au_ada'))?.passwordHash).toBe('h3');
    });

    it('finds a person by subject, adds one single sign-on brought, and links a subject once', async () => {
      const s = await make(AUTH_FIXTURE);
      expect((await s.userBySub('sub-lin'))?.id).toBe('au_lin');
      expect(await s.userBySub('sub-nobody')).toBeUndefined();
      await s.addSsoUser({
        id: 'au_new',
        email: 'new@example.com',
        name: 'New',
        role: 'viewer',
        externalSub: 'sub-new',
        createdAt: 1,
      });
      expect(await s.userBySub('sub-new')).toMatchObject({ id: 'au_new', passwordHash: null });
      await expect(
        s.addSsoUser({
          id: 'au_new2',
          email: 'other@example.com',
          name: 'Other',
          role: 'viewer',
          externalSub: 'sub-new',
          createdAt: 1,
        }),
      ).rejects.toThrow();
      // Someone else's subject, or a person already linked: no link.
      expect(await s.linkSub('au_ada', 'sub-lin')).toBe(false);
      expect(await s.linkSub('au_lin', 'sub-other')).toBe(false);
      expect(await s.linkSub('au_ada', 'sub-ada')).toBe(true);
      expect(await s.linkSub('au_ada', 'sub-ada')).toBe(false);
      expect((await s.userBySub('sub-ada'))?.id).toBe('au_ada');
    });

    it('adds a person with a password once per email, and sets a temporary one', async () => {
      const s = await make(AUTH_FIXTURE);
      const amy = {
        id: 'au_amy',
        email: 'amy@example.com',
        name: 'Amy',
        role: 'operator',
        passwordHash: 'h-amy',
        passwordChangeDue: true,
        passwordExpiresAt: 77,
        createdAt: 1,
      };
      await s.addUser(amy);
      expect(await s.userByEmail('amy@example.com')).toMatchObject({
        id: 'au_amy',
        passwordHash: 'h-amy',
        passwordChangeDue: true,
        passwordExpiresAt: 77,
      });
      await expect(s.addUser({ ...amy, id: 'au_amy2' })).rejects.toThrow();
      await s.setPassword('au_amy', 'h-new', { changeDue: false, expiresAt: null });
      expect(await s.user('au_amy')).toMatchObject({
        passwordHash: 'h-new',
        passwordChangeDue: false,
        passwordExpiresAt: null,
      });
    });

    it("lists a person's unexpired sessions, and finds one by the start of its hash", async () => {
      const s = await make(AUTH_FIXTURE);
      const mine = await s.sessionsOf('au_ada', now);
      expect(mine.map((x) => x.tokenHash)).toEqual(['au_s_ada']);
      expect(mine[0]).toEqual({
        tokenHash: 'au_s_ada',
        userAgent: null,
        ip: '203.0.113.7',
        createdAt: now - 10 * MIN,
        lastSeenAt: now - MIN,
      });
      expect(await s.sessionsOf('au_ada', now + 2 * MIN)).toEqual([]);
      expect((await s.sessionByRef('au_ada', 'au_s_a'))?.tokenHash).toBe('au_s_ada');
      // Someone else's session, or a pattern, is not theirs.
      expect(await s.sessionByRef('au_ada', 'au_s_g')).toBeUndefined();
      expect(await s.sessionByRef('au_ada', 'au%')).toBeUndefined();
    });

    it('uses a code step once, later steps only, and spends a recovery code once', async () => {
      const s = await fresh();
      expect(await s.useTotpStep('au_ada', 100)).toBe(true);
      expect(await s.useTotpStep('au_ada', 100)).toBe(false);
      expect(await s.useTotpStep('au_ada', 99)).toBe(false);
      expect(await s.useTotpStep('au_ada', 101)).toBe(true);
      expect(await s.useRecoveryCode('au_ada', 'rc1')).toBe(true);
      expect(await s.useRecoveryCode('au_ada', 'rc1')).toBe(false);
      expect(await s.useRecoveryCode('au_lin', 'rc2')).toBe(false);
      expect(await s.recoveryCodesLeft('au_ada')).toBe(1);
      await s.replaceRecoveryCodes('au_ada', ['rc8', 'rc9'], now);
      expect(await s.useRecoveryCode('au_ada', 'rc2')).toBe(false);
      expect(await s.recoveryCodesLeft('au_ada')).toBe(2);
      await s.enableTotp('au_lin', 'sealed-lin', 9, 500);
      expect(await s.user('au_lin')).toMatchObject({
        totpSecret: 'sealed-lin',
        totpEnabledAt: 9,
        totpLastStep: 500,
      });
      expect(await s.useTotpStep('au_lin', 500)).toBe(false);
      await s.disableTotp('au_ada');
      expect(await s.user('au_ada')).toMatchObject({
        totpSecret: null,
        totpEnabledAt: null,
        totpLastStep: null,
      });
      expect(await s.recoveryCodesLeft('au_ada')).toBe(0);
    });

    it('reads a live session with its person, not a disabled one, and keeps its times', async () => {
      const s = await fresh();
      expect(await s.liveSession('au_s_ada', now, 30 * MIN)).toMatchObject({
        id: 'au_ada',
        seen: now - MIN,
      });
      expect(await s.liveSession('au_s_ada', now, MIN / 2)).toBeUndefined();
      expect(await s.liveSession('au_s_gone', now, 30 * MIN)).toBeUndefined();
      await s.touchSession('au_s_ada', now, '198.51.100.1');
      expect((await s.liveSession('au_s_ada', now, MIN / 2))?.seen).toBe(now);
      await s.setReauth('au_s_ada', 'au_lin', 7);
      expect((await s.session('au_s_ada'))?.reauthAt).toBeNull();
      await s.setReauth('au_s_ada', 'au_ada', 7);
      expect(await s.session('au_s_ada')).toEqual({ userId: 'au_ada', reauthAt: 7 });
      expect(await s.knownPlace('ada@example.com', '198.51.100.1', now)).toBe(true);
      expect(await s.knownPlace('ada@example.com', '192.0.2.1', now)).toBe(false);
      await s.startSession({
        tokenHash: 'au_s_new',
        userId: 'au_lin',
        createdAt: now,
        expiresAt: now + MIN,
        ip: null,
        userAgent: 'ua',
      });
      expect((await s.liveSession('au_s_new', now, MIN))?.id).toBe('au_lin');
      await s.endSession('au_s_new');
      expect(await s.session('au_s_new')).toBeUndefined();
      await s.startSession({
        tokenHash: 'au_s_2',
        userId: 'au_ada',
        createdAt: now,
        expiresAt: now + MIN,
        ip: null,
        userAgent: null,
      });
      expect(await s.endSessions('au_ada', 'au_s_ada')).toBe(1);
      expect(await s.session('au_s_ada')).toBeDefined();
      expect(await s.endSessions('au_ada')).toBe(1);
      expect(await s.session('au_s_ada')).toBeUndefined();
    });

    it('reads a token that was not revoked, and counts failures per window', async () => {
      const s = await fresh();
      expect(await s.liveToken('th1')).toMatchObject({
        id: 'au_t1',
        role: 'operator',
        lastUsedAt: null,
      });
      expect(await s.liveToken('th2')).toBeUndefined();
      await s.touchToken('au_t1', 9);
      expect((await s.liveToken('th1'))?.lastUsedAt).toBe(9);
      await s.recordFailures(['au_k1', 'au_k2'], 1_000, 500);
      await s.recordFailures(['au_k1'], 1_200, 500);
      expect(
        (await s.failures(['au_k1', 'au_k2', 'au_k3'])).sort((a, b) => a.key.localeCompare(b.key)),
      ).toEqual([
        { key: 'au_k1', count: 2, windowStart: 1_000 },
        { key: 'au_k2', count: 1, windowStart: 1_000 },
      ]);
      await s.recordFailures(['au_k1'], 1_600, 500);
      expect(await s.failures(['au_k1'])).toEqual([{ key: 'au_k1', count: 1, windowStart: 1_600 }]);
      await s.clearFailures('au_k1');
      await s.pruneFailures(1_100);
      expect(await s.failures(['au_k1', 'au_k2'])).toEqual([]);
    });

    it("holds a two-factor challenge until it's over or ended", async () => {
      const s = await fresh();
      await s.startChallenge({
        tokenHash: 'au_c1',
        userId: 'au_ada',
        createdAt: now,
        expiresAt: now + MIN,
      });
      expect((await s.challenge('au_c1', now))?.id).toBe('au_ada');
      expect(await s.challenge('au_c1', now + MIN)).toBeUndefined();
      await s.startChallenge({
        tokenHash: 'au_c2',
        userId: 'au_lin',
        createdAt: now,
        expiresAt: now + MIN,
      });
      expect(await s.challenge('au_c2', now)).toBeUndefined();
      await s.endChallenge('au_c1');
      expect(await s.challenge('au_c1', now)).toBeUndefined();
    });
  });
}
