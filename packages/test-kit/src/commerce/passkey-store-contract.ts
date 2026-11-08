/**
 * The behaviour every `PasskeyStore` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Ids start `pk_`.
 */
import type { Passkey, PasskeyStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { PasskeyFixture } from './passkey-store';

export const PASSKEY_FIXTURE: PasskeyFixture = {
  users: [
    { id: 'pk_ada', email: 'ada@example.com', name: 'Ada', role: 'admin' },
    { id: 'pk_gone', email: 'gone@example.com', name: 'Gone', role: 'viewer', disabledAt: 5 },
  ],
};

const key = (id: string, over: Partial<Passkey> = {}): Passkey => ({
  id,
  userId: 'pk_ada',
  publicKey: 'cHVibGlj',
  counter: 0,
  transports: ['internal'],
  name: `Key ${id}`,
  backedUp: false,
  createdAt: 1,
  lastUsedAt: null,
  ...over,
});

export function describePasskeyStoreContract(
  name: string,
  make: (fixture: PasskeyFixture) => Promise<PasskeyStore>,
) {
  describe(`${name}: the passkey store contract`, () => {
    it("lists a person's passkeys newest first, and reads one with its person", async () => {
      const s = await make(PASSKEY_FIXTURE);
      await s.add(key('pk_1', { createdAt: 1 }));
      await s.add(key('pk_2', { createdAt: 2, transports: ['usb', 'nfc'] }));
      await s.add(key('pk_3', { userId: 'pk_gone' }));
      expect((await s.forUser('pk_ada')).map((k) => k.id)).toEqual(['pk_2', 'pk_1']);
      expect((await s.forUser('pk_ada'))[0]?.transports).toEqual(['usb', 'nfc']);
      expect(await s.withUser('pk_3')).toMatchObject({
        passkey: { id: 'pk_3' },
        user: { id: 'pk_gone', disabledAt: 5 },
      });
      expect(await s.withUser('pk_none')).toBeUndefined();
      await s.used('pk_1', 7, 99);
      expect((await s.withUser('pk_1'))?.passkey).toMatchObject({ counter: 7, lastUsedAt: 99 });
    });

    it('keeps the first passkey stored under an id', async () => {
      const s = await make(PASSKEY_FIXTURE);
      await s.add(key('pk_twice', { name: 'First' }));
      await s.add(key('pk_twice', { name: 'Second', userId: 'pk_gone' }));
      expect((await s.withUser('pk_twice'))?.passkey).toMatchObject({
        name: 'First',
        userId: 'pk_ada',
      });
    });

    it("removes only the person's own passkey, once, and clears them all", async () => {
      const s = await make(PASSKEY_FIXTURE);
      await s.add(key('pk_a'));
      await s.add(key('pk_b'));
      expect(await s.remove('pk_a', 'pk_gone')).toBeUndefined();
      expect(await s.remove('pk_a', 'pk_ada')).toBe('Key pk_a');
      expect(await s.remove('pk_a', 'pk_ada')).toBeUndefined();
      expect(await s.clear('pk_ada')).toBe(1);
      expect(await s.forUser('pk_ada')).toEqual([]);
    });

    it('answers a challenge once, and not after it expires', async () => {
      const s = await make(PASSKEY_FIXTURE);
      await s.putChallenge({ id: 'pk_c1', challenge: 'ch1', userId: 'pk_ada', expiresAt: 100 }, 0);
      await s.putChallenge({ id: 'pk_c2', challenge: 'ch2', userId: null, expiresAt: 100 }, 0);
      expect(await s.takeChallenge('pk_c1', 50)).toEqual({ challenge: 'ch1', userId: 'pk_ada' });
      expect(await s.takeChallenge('pk_c1', 50)).toBeUndefined();
      expect(await s.takeChallenge('pk_c2', 100)).toBeUndefined();
    });
  });
}
