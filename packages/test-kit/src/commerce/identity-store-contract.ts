/**
 * The behaviour every `IdentityStore` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). The fixture is the only team in the store.
 */
import type { IdentityStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { IdentityFixture } from './identity-store';

const MIN = 60_000;
export const IDENTITY_NOW = 1_000 * MIN;
const now = IDENTITY_NOW;

export const IDENTITY_FIXTURE: IdentityFixture = {
  users: [
    { id: 'id_ada', email: 'ada@example.com', name: 'Ada', role: 'admin' },
    { id: 'id_gone', email: 'gone@example.com', name: 'Gone', role: 'viewer', disabledAt: 5 },
  ],
  tokens: [
    { id: 'id_tok', role: 'operator' },
    { id: 'id_tok_revoked', role: 'operator', revokedAt: 5 },
  ],
  sessions: [
    {
      tokenHash: 'id_s_live',
      userId: 'id_ada',
      createdAt: now - 60 * MIN,
      expiresAt: now + MIN,
      lastSeenAt: now - MIN,
      reauthAt: now - 2 * MIN,
    },
    { tokenHash: 'id_s_idle', userId: 'id_ada', createdAt: now - 60 * MIN, expiresAt: now + MIN },
    { tokenHash: 'id_s_expired', userId: 'id_ada', createdAt: now - MIN, expiresAt: now - 1 },
    { tokenHash: 'id_s_disabled', userId: 'id_gone', createdAt: now - MIN, expiresAt: now + MIN },
  ],
};

export function describeIdentityStoreContract(
  name: string,
  make: (fixture: IdentityFixture) => Promise<IdentityStore>,
) {
  describe(`${name}: the identity store contract`, () => {
    const fresh = () => make(IDENTITY_FIXTURE);

    it('says whether anyone has an account', async () => {
      expect(await (await fresh()).anyone()).toBe(true);
      expect(await (await make({})).anyone()).toBe(false);
    });

    it("reads a token's standing and a person's", async () => {
      const s = await fresh();
      expect(await s.token('id_tok')).toEqual({
        role: 'operator',
        revokedAt: null,
        expiresAt: null,
      });
      expect((await s.token('id_tok_revoked'))?.revokedAt).toBe(5);
      expect(await s.token('id_none')).toBeUndefined();
      expect(await s.disabledAt('id_gone')).toBe(5);
      expect(await s.disabledAt('id_ada')).toBeNull();
      expect(await s.disabledAt('id_none')).toBeUndefined();
    });

    it('reads a live session with its person, and not an idle, expired or disabled one', async () => {
      const s = await fresh();
      const idle = 30 * MIN;
      expect(await s.session('id_s_live', now, idle)).toEqual({
        id: 'id_ada',
        email: 'ada@example.com',
        name: 'Ada',
        role: 'admin',
        seen: now - MIN,
        reauthAt: now - 2 * MIN,
      });
      expect(await s.session('id_s_idle', now, idle)).toBeUndefined();
      expect(await s.session('id_s_expired', now, idle)).toBeUndefined();
      expect(await s.session('id_s_disabled', now, idle)).toBeUndefined();
      // Used now, the idle one is live again.
      await s.touchSession('id_s_idle', now);
      expect((await s.session('id_s_idle', now, idle))?.seen).toBe(now);
    });
  });
}
