import type { AdminAuth } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import type { AuthFixture } from './commerce/auth-store';

const person = {
  id: 'aac_ada',
  email: 'ada@example.com',
  name: 'Ada',
  role: 'member',
  passwordHash: 'old',
};
const session = {
  tokenHash: 'aac_session',
  userId: person.id,
  createdAt: 100,
  expiresAt: 1000,
  ip: '1.2.3.4',
};

export function describeAdminAuthContract(
  name: string,
  make: (f: AuthFixture) => Promise<AdminAuth>,
) {
  describe(`${name}: Studio sign-in storage`, () => {
    it('links an immutable commerce identity only once without replacing OIDC or another link', async () => {
      const other = {
        ...person,
        id: 'aac_other',
        email: 'other@example.com',
        externalSub: 'oidc:other',
      };
      const s = await make({ users: [person, other] });
      expect(await s.userByCommerceSubject('commerce:new')).toBeUndefined();
      expect(await s.linkCommerceSubject(other.id, 'commerce:new')).toBe(true);
      expect((await s.userByCommerceSubject('commerce:new'))?.id).toBe(other.id);
      expect(await s.commerceSubjectForUser(other.id)).toBe('commerce:new');
      expect(await s.commerceSubjectForUser(person.id)).toBeUndefined();
      expect((await s.userBySub('oidc:other'))?.id).toBe(other.id);
      expect(await s.linkCommerceSubject(person.id, 'commerce:new')).toBe(false);
      expect(await s.linkCommerceSubject(other.id, 'commerce:replacement')).toBe(false);
      expect(await s.linkCommerceSubject('missing', 'commerce:missing')).toBe(false);
    });
    it('finds people and conditionally rehashes only the known password', async () => {
      const s = await make({ users: [person] });
      expect(await s.userCount()).toBe(1);
      expect((await s.userByEmail(person.email))?.id).toBe(person.id);
      expect(await s.userByEmail('unknown@example.com')).toBeUndefined();
      await s.rehashPassword(person.id, 'wrong', 'bad');
      expect((await s.user(person.id))?.passwordHash).toBe('old');
      await s.rehashPassword(person.id, 'old', 'new');
      await s.rehashPassword(person.id, 'old', 'stale');
      expect((await s.user(person.id))?.passwordHash).toBe('new');
    });
    it('adds an SSO identity without a password and refuses duplicate addresses or subjects', async () => {
      const s = await make({});
      const user = {
        id: person.id,
        email: person.email,
        name: person.name,
        role: 'member',
        externalSub: 'subject',
        createdAt: 1,
      };
      await s.addSsoUser(user);
      expect(await s.userBySub('subject')).toMatchObject({
        id: person.id,
        externalSub: 'subject',
        passwordHash: null,
      });
      expect(await s.userBySub('missing')).toBeUndefined();
      await expect(
        s.addSsoUser({ ...user, id: 'other', email: 'other@example.com' }),
      ).rejects.toThrow();
      await expect(s.addSsoUser({ ...user, id: 'other', externalSub: 'other' })).rejects.toThrow();
      expect(await s.userCount()).toBe(1);
    });
    it('links only an unlinked account and never reassigns an existing identity', async () => {
      const s = await make({
        users: [person, { ...person, id: 'other', email: 'other@example.com' }],
      });
      expect(await s.linkSub(person.id, 'subject')).toBe(true);
      expect(await s.linkSub(person.id, 'replacement')).toBe(false);
      expect(await s.linkSub('other', 'subject')).toBe(false);
      expect(await s.linkSub('missing', 'fresh')).toBe(false);
      expect((await s.userBySub('subject'))?.id).toBe(person.id);
      expect((await s.user('other'))?.externalSub).toBeNull();
    });
    it('admits one account when two accounts concurrently claim the same subject', async () => {
      const s = await make({
        users: [person, { ...person, id: 'other', email: 'other@example.com' }],
      });
      const results = await Promise.all([
        s.linkSub(person.id, 'subject'),
        s.linkSub('other', 'subject'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await s.userBySub('subject')).toBeDefined();
    });
    it('admits one subject when two subjects concurrently claim the same account', async () => {
      const s = await make({ users: [person] });
      const results = await Promise.all([
        s.linkSub(person.id, 'first'),
        s.linkSub(person.id, 'second'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const links = await Promise.all([s.userBySub('first'), s.userBySub('second')]);
      expect(links.filter(Boolean)).toHaveLength(1);
    });
    it('rejects expired and idle sessions, and touches only the requested session', async () => {
      const s = await make({ users: [person], sessions: [session] });
      expect((await s.liveSession(session.tokenHash, 150, 100))?.id).toBe(person.id);
      expect(await s.liveSession(session.tokenHash, 200, 100)).toBeUndefined();
      expect(await s.liveSession(session.tokenHash, 1000, 2000)).toBeUndefined();
      expect(await s.liveSession('missing', 150, 100)).toBeUndefined();
      await s.touchSession(session.tokenHash, 250, '5.6.7.8');
      expect((await s.liveSession(session.tokenHash, 300, 100))?.seen).toBe(250);
      expect(await s.knownPlace(person.email, '1.2.3.4', 300)).toBe(false);
      expect(await s.knownPlace(person.email, '5.6.7.8', 300)).toBe(true);
      expect(await s.knownPlace('unknown@example.com', '5.6.7.8', 300)).toBe(false);
      expect(await s.knownPlace(person.email, '5.6.7.8', 1000)).toBe(false);
    });
    it('refuses a disabled person’s session and two-factor challenge', async () => {
      const s = await make({
        users: [{ ...person, disabledAt: 1, totpEnabledAt: 1 }],
        sessions: [session],
      });
      await s.startChallenge({
        tokenHash: 'challenge',
        userId: person.id,
        createdAt: 100,
        expiresAt: 1000,
      });
      expect(await s.liveSession(session.tokenHash, 150, 100)).toBeUndefined();
      expect(await s.challenge('challenge', 150)).toBeUndefined();
    });
    it('starts, reauthenticates and ends a session without admitting another owner', async () => {
      const s = await make({ users: [person] });
      await s.startSession({ ...session, userAgent: 'Safari' });
      expect((await s.liveSession(session.tokenHash, 150, 100))?.seen).toBe(100);
      await s.setReauth(session.tokenHash, 'someone-else', 160);
      expect((await s.session(session.tokenHash))?.reauthAt).toBeNull();
      await s.setReauth(session.tokenHash, person.id, 170);
      expect(await s.session(session.tokenHash)).toEqual({ userId: person.id, reauthAt: 170 });
      await s.endSession(session.tokenHash);
      expect(await s.session(session.tokenHash)).toBeUndefined();
    });
    it('spends each TOTP step and owned recovery code once under concurrent calls', async () => {
      const s = await make({
        users: [{ ...person, totpLastStep: 10 }],
        recoveryCodes: [{ userId: person.id, codeHash: 'code' }],
      });
      expect(await s.useTotpStep(person.id, 10)).toBe(false);
      const steps = await Promise.all([s.useTotpStep(person.id, 11), s.useTotpStep(person.id, 11)]);
      expect(steps.filter(Boolean)).toHaveLength(1);
      expect(await s.useRecoveryCode('someone-else', 'code')).toBe(false);
      const codes = await Promise.all([
        s.useRecoveryCode(person.id, 'code'),
        s.useRecoveryCode(person.id, 'code'),
      ]);
      expect(codes.filter(Boolean)).toHaveLength(1);
      expect(await s.recoveryCodesLeft(person.id)).toBe(0);
    });
    it('enables TOTP with the confirmed step and replaces only the owner’s recovery codes', async () => {
      const other = { ...person, id: 'aac_other', email: 'other@example.com' };
      const s = await make({
        users: [person, other],
        recoveryCodes: [
          { userId: person.id, codeHash: 'old' },
          { userId: other.id, codeHash: 'other' },
        ],
      });
      await s.enableTotp(person.id, 'sealed-secret', 100, 42);
      expect(await s.user(person.id)).toMatchObject({
        totpSecret: 'sealed-secret',
        totpEnabledAt: 100,
        totpLastStep: 42,
      });
      expect(await s.useTotpStep(person.id, 42)).toBe(false);
      await s.replaceRecoveryCodes(person.id, ['new-one', 'new-two'], 101);
      expect(await s.useRecoveryCode(person.id, 'old')).toBe(false);
      expect(await s.recoveryCodesLeft(person.id)).toBe(2);
      expect(await s.useRecoveryCode(other.id, 'other')).toBe(true);
      await s.replaceRecoveryCodes(person.id, [], 102);
      expect(await s.recoveryCodesLeft(person.id)).toBe(0);
    });
    it('disables TOTP and drops its recovery codes without changing another person', async () => {
      const other = {
        ...person,
        id: 'aac_other',
        email: 'other@example.com',
        totpSecret: 'other-secret',
        totpEnabledAt: 1,
        totpLastStep: 4,
      };
      const s = await make({
        users: [{ ...person, totpSecret: 'secret', totpEnabledAt: 1, totpLastStep: 5 }, other],
        recoveryCodes: [
          { userId: person.id, codeHash: 'old' },
          { userId: other.id, codeHash: 'other' },
        ],
      });
      await s.disableTotp(person.id);
      await s.disableTotp(person.id);
      expect(await s.user(person.id)).toMatchObject({
        totpSecret: null,
        totpEnabledAt: null,
        totpLastStep: null,
      });
      expect(await s.recoveryCodesLeft(person.id)).toBe(0);
      expect(await s.user(other.id)).toMatchObject({
        totpSecret: 'other-secret',
        totpEnabledAt: 1,
        totpLastStep: 4,
      });
      expect(await s.recoveryCodesLeft(other.id)).toBe(1);
    });
    it('adds a password user and replaces temporary passwords without changing identity', async () => {
      const s = await make({});
      const u = { ...person, createdAt: 100, passwordChangeDue: true, passwordExpiresAt: 200 };
      await s.addUser(u);
      expect(await s.user(person.id)).toMatchObject({
        id: person.id,
        passwordHash: 'old',
        passwordChangeDue: true,
        passwordExpiresAt: 200,
      });
      await expect(s.addUser({ ...u, id: 'duplicate' })).rejects.toThrow();
      await s.setPassword(person.id, 'chosen', { changeDue: false, expiresAt: null });
      expect(await s.user(person.id)).toMatchObject({
        email: person.email,
        passwordHash: 'chosen',
        passwordChangeDue: false,
        passwordExpiresAt: null,
      });
    });
    it('lists and finds only owned sessions and returns the actual revocation count', async () => {
      const s = await make({
        users: [person, { ...person, id: 'other', email: 'other@example.com' }],
        sessions: [
          { ...session, tokenHash: 'abcdef01-current' },
          { ...session, tokenHash: 'abcdef02-other-browser' },
          { ...session, tokenHash: 'expired', expiresAt: 50 },
          { ...session, userId: 'other', tokenHash: 'foreign' },
        ],
      });
      expect((await s.sessionsOf(person.id, 100)).map((r) => r.tokenHash).sort()).toEqual([
        'abcdef01-current',
        'abcdef02-other-browser',
      ]);
      expect((await s.sessionByRef(person.id, 'abcdef02'))?.tokenHash).toBe(
        'abcdef02-other-browser',
      );
      expect(await s.sessionByRef(person.id, 'foreign')).toBeUndefined();
      expect(await s.endSessions(person.id, 'abcdef01-current')).toBe(2);
      expect(await s.endSessions(person.id, 'abcdef01-current')).toBe(0);
      expect(await s.session('foreign')).toBeDefined();
      expect(await s.session('abcdef01-current')).toBeDefined();
      expect(await s.endSessions(person.id)).toBe(1);
    });
    it('admits only live challenges with two-factor enabled, and removes ended ones', async () => {
      const s = await make({ users: [{ ...person, totpEnabledAt: 1 }] });
      await s.startChallenge({
        tokenHash: 'challenge',
        userId: person.id,
        createdAt: 100,
        expiresAt: 200,
      });
      expect((await s.challenge('challenge', 150))?.id).toBe(person.id);
      expect(await s.challenge('challenge', 200)).toBeUndefined();
      await s.endChallenge('challenge');
      expect(await s.challenge('challenge', 150)).toBeUndefined();
      const without = await make({ users: [person] });
      await without.startChallenge({
        tokenHash: 'challenge',
        userId: person.id,
        createdAt: 100,
        expiresAt: 200,
      });
      expect(await without.challenge('challenge', 150)).toBeUndefined();
    });
    it('counts failures, resets elapsed windows, clears and prunes independently', async () => {
      const s = await make({});
      expect(await s.failures([])).toEqual([]);
      await s.recordFailures(['a', 'b'], 100, 50);
      await s.recordFailures(['a'], 120, 50);
      expect(await s.failures(['a'])).toEqual([{ key: 'a', count: 2, windowStart: 100 }]);
      await s.recordFailures(['a'], 150, 50);
      expect(await s.failures(['a'])).toEqual([{ key: 'a', count: 1, windowStart: 150 }]);
      await s.pruneFailures(120);
      expect(await s.failures(['b'])).toEqual([]);
      await s.clearFailures('a');
      expect(await s.failures(['a'])).toEqual([]);
    });
    it('returns each simultaneous attempt’s own written count', async () => {
      const s = await make({});
      const results = await Promise.all([
        s.countAttempts(['a'], 100, 50),
        s.countAttempts(['a'], 100, 50),
      ]);
      expect(
        results
          .flat()
          .map((r) => r.count)
          .sort(),
      ).toEqual([1, 2]);
      expect(await s.countAttempts(['a'], 150, 50)).toEqual([
        { key: 'a', count: 1, windowStart: 150 },
      ]);
      expect(await s.countAttempts([], 150, 50)).toEqual([]);
    });
  });
}
