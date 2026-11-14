import type { Passkey, PasskeyStore } from '@commerceworker/ports/commerce';
import { and, desc, eq, lt } from 'drizzle-orm';
import { type AuthDb, authDbOf } from './auth';
import { passkeyChallenges, passkeys, users } from './auth-schema';

type Row = typeof passkeys.$inferSelect;
const passkeyOf = (r: Row): Passkey => ({ ...r, transports: JSON.parse(r.transports) as string[] });

/** Studio's content-database implementation of the shared passkey port. */
export function createAdminPasskeys(d1: D1Database): PasskeyStore {
  return adminPasskeyQueries(authDbOf(d1));
}

export function adminPasskeyQueries(d: AuthDb): PasskeyStore {
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
