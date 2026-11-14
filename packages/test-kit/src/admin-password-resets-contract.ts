import type { AdminAuth, AdminPasswordReset, AdminPasswordResets } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import type { AuthFixture } from './commerce/auth-store';

export const RESET_FIXTURE: AuthFixture = {
  users: [
    {
      id: 'pr_ada',
      email: 'ada@example.com',
      name: 'Ada',
      role: 'member',
      passwordHash: 'old',
      passwordChangeDue: true,
      passwordExpiresAt: 50,
      totpEnabledAt: 1,
      totpSecret: 'sealed',
      totpLastStep: 3,
    },
    {
      id: 'pr_other',
      email: 'other@example.com',
      name: 'Other',
      role: 'member',
      passwordHash: 'other',
      totpEnabledAt: 1,
    },
    {
      id: 'pr_disabled',
      email: 'disabled@example.com',
      name: 'Disabled',
      role: 'member',
      passwordHash: 'hash',
      disabledAt: 1,
    },
    { id: 'pr_sso', email: 'sso@example.com', name: 'SSO', role: 'member' },
  ],
  sessions: [
    { tokenHash: 'one', userId: 'pr_ada', createdAt: 1, expiresAt: 1000 },
    { tokenHash: 'two', userId: 'pr_ada', createdAt: 1, expiresAt: 1000 },
    { tokenHash: 'other', userId: 'pr_other', createdAt: 1, expiresAt: 1000 },
  ],
  recoveryCodes: [{ userId: 'pr_ada', codeHash: 'recovery' }],
};
export const resetRow = (id: string, userId = 'pr_ada', createdAt = 100): AdminPasswordReset => ({
  id,
  userId,
  codeHash: `hash:${id}`,
  browserHash: 'browser',
  createdAt,
  expiresAt: createdAt + 100,
});
export function describeAdminPasswordResetsContract(
  name: string,
  make: () => Promise<{
    resets: AdminPasswordResets;
    auth: AdminAuth;
  }>,
) {
  describe(`${name}: Studio password-reset storage`, () => {
    it('finds only live codes, bound to their id or asking browser and address', async () => {
      const { resets } = await make();
      await resets.issue(resetRow('first'));
      const expected = { id: 'first', userId: 'pr_ada', codeHash: 'hash:first' };
      expect(await resets.live({ id: 'first' }, 150)).toEqual(expected);
      expect(await resets.live({ email: 'ada@example.com', browserHash: 'browser' }, 150)).toEqual(
        expected,
      );
      expect(
        await resets.live({ email: 'ada@example.com', browserHash: 'wrong' }, 150),
      ).toBeUndefined();
      expect(
        await resets.live({ email: 'other@example.com', browserHash: 'browser' }, 150),
      ).toBeUndefined();
      expect(await resets.live({ id: 'first' }, 200)).toBeUndefined();
      expect(await resets.live({ id: 'missing' }, 150)).toBeUndefined();
    });
    it('excludes disabled and passwordless accounts', async () => {
      const { resets } = await make();
      for (const id of ['pr_disabled', 'pr_sso']) {
        await resets.issue(resetRow(id, id));
        expect(await resets.live({ id }, 150)).toBeUndefined();
      }
    });
    it('replaces one person’s codes and prunes expired codes without dropping other live ones', async () => {
      const { resets } = await make();
      await resets.issue(resetRow('expired', 'pr_other', 0));
      await resets.issue(resetRow('old', 'pr_ada', 10));
      await resets.issue(resetRow('new', 'pr_ada', 100));
      expect(await resets.live({ id: 'old' }, 50)).toBeUndefined();
      expect(await resets.live({ id: 'expired' }, 50)).toBeUndefined();
      await resets.issue(resetRow('other', 'pr_other', 110));
      expect(await resets.live({ id: 'new' }, 150)).toBeDefined();
      expect(await resets.live({ id: 'other' }, 150)).toBeDefined();
    });
    it('keeps previous codes when a replacement id belongs to another live reset', async () => {
      const { resets } = await make();
      await resets.issue(resetRow('own'));
      await resets.issue(resetRow('taken', 'pr_other'));
      await expect(resets.issue(resetRow('taken', 'pr_ada', 110))).rejects.toThrow();
      expect(await resets.live({ id: 'own' }, 150)).toBeDefined();
      expect(await resets.live({ id: 'taken' }, 150)).toMatchObject({ userId: 'pr_other' });
    });
    it('spends a reset once under concurrent claims', async () => {
      const { resets } = await make();
      await resets.issue(resetRow('claim'));
      const results = await Promise.all([resets.claim('claim', 150), resets.claim('claim', 150)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await resets.claim('claim', 150)).toBe(false);
      expect(await resets.claim('missing', 150)).toBe(false);
      expect(await resets.live({ id: 'claim' }, 150)).toBeUndefined();
    });
    it('changes the password and ends only its owner’s resets, sessions and pending second-factor challenges', async () => {
      const { resets, auth } = await make();
      await resets.issue(resetRow('own'));
      await resets.issue(resetRow('other', 'pr_other'));
      for (const userId of ['pr_ada', 'pr_other'])
        await auth.startChallenge({ tokenHash: userId, userId, createdAt: 100, expiresAt: 1000 });
      expect(await resets.claim('own', 150)).toBe(true);
      expect(await resets.complete('pr_ada', 'new')).toBe(2);
      expect(await auth.user('pr_ada')).toMatchObject({
        passwordHash: 'new',
        passwordChangeDue: false,
        passwordExpiresAt: null,
        totpEnabledAt: 1,
        totpSecret: 'sealed',
        totpLastStep: 3,
      });
      expect(await auth.recoveryCodesLeft('pr_ada')).toBe(1);
      expect(await auth.session('one')).toBeUndefined();
      expect(await auth.session('two')).toBeUndefined();
      expect(await auth.challenge('pr_ada', 150)).toBeUndefined();
      expect(await resets.live({ id: 'own' }, 150)).toBeUndefined();
      expect(await auth.user('pr_other')).toMatchObject({ passwordHash: 'other' });
      expect(await auth.session('other')).toBeDefined();
      expect(await auth.challenge('pr_other', 150)).toBeDefined();
      expect(await resets.live({ id: 'other' }, 150)).toBeDefined();
      expect(await resets.complete('pr_ada', 'new')).toBe(0);
    });
  });
}
