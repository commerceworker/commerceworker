/**
 * The passkeys port (`PasskeyStore`, @commerceworker/ports/commerce) on D1: `passkeys` and
 * `passkey_challenges`. Moved here from the web app. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import type { Passkey, PasskeyStore } from '@commerceworker/ports/commerce';
import { and, desc, eq, lt } from 'drizzle-orm';
import { createDb } from './index';
import { passkeyChallenges, passkeys, users } from './schema';

type Row = typeof passkeys.$inferSelect;
const passkeyOf = (r: Row): Passkey => ({ ...r, transports: JSON.parse(r.transports) as string[] });

export function d1PasskeyStore(d1: D1Database): PasskeyStore {
  const d = createDb(d1);
  return {
    async forUser(userId) {
      const rows = await d
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, userId))
        .orderBy(desc(passkeys.createdAt));
      return rows.map(passkeyOf);
    },
    async withUser(id) {
      const row = await d
        .select({
          passkey: passkeys,
          user: {
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            disabledAt: users.disabledAt,
          },
        })
        .from(passkeys)
        .innerJoin(users, eq(users.id, passkeys.userId))
        .where(eq(passkeys.id, id))
        .get();
      return row ? { passkey: passkeyOf(row.passkey), user: row.user } : undefined;
    },
    async add(p) {
      await d
        .insert(passkeys)
        .values({ ...p, transports: JSON.stringify(p.transports) })
        .onConflictDoNothing();
    },
    async used(id, counter, at) {
      await d.update(passkeys).set({ counter, lastUsedAt: at }).where(eq(passkeys.id, id));
    },
    async remove(id, userId) {
      const [gone] = await d
        .delete(passkeys)
        .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
        .returning({ name: passkeys.name });
      return gone?.name;
    },
    async clear(userId) {
      return (
        await d.delete(passkeys).where(eq(passkeys.userId, userId)).returning({ id: passkeys.id })
      ).length;
    },
    async putChallenge(c, now) {
      await d
        .insert(passkeyChallenges)
        .values(c)
        .onConflictDoUpdate({
          target: passkeyChallenges.id,
          set: { challenge: c.challenge, userId: c.userId, expiresAt: c.expiresAt },
        });
      // Challenges are short-lived: a cheap moment to drop the stale ones.
      await d.delete(passkeyChallenges).where(lt(passkeyChallenges.expiresAt, now));
    },
    async takeChallenge(id, now) {
      const [row] = await d
        .delete(passkeyChallenges)
        .where(eq(passkeyChallenges.id, id))
        .returning();
      return row && row.expiresAt > now
        ? { challenge: row.challenge, userId: row.userId }
        : undefined;
    },
  };
}
