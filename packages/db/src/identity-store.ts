/**
 * The identity port (`IdentityStore`, @commerceworker/ports/commerce) on D1: `users`, `api_tokens`
 * and `sessions`. Moved here from the engine's principals. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import type { IdentityStore } from '@commerceworker/ports/commerce';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createDb } from './index';
import { apiTokens, sessions, users } from './schema';

export function d1IdentityStore(d1: D1Database): IdentityStore {
  const d = createDb(d1);
  return {
    async anyone() {
      return !!(await d.select({ id: users.id }).from(users).limit(1).get());
    },

    token: (id) =>
      d
        .select({
          role: apiTokens.role,
          revokedAt: apiTokens.revokedAt,
          expiresAt: apiTokens.expiresAt,
        })
        .from(apiTokens)
        .where(eq(apiTokens.id, id))
        .get(),

    session(tokenHash, now, idleMs) {
      const seen = sql<number>`coalesce(${sessions.lastSeenAt}, ${sessions.createdAt})`;
      return d
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          seen,
          reauthAt: sessions.reauthAt,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            gt(sessions.expiresAt, now),
            gt(seen, now - idleMs),
            isNull(users.disabledAt),
          ),
        )
        .get();
    },

    async touchSession(tokenHash, now) {
      await d.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.tokenHash, tokenHash));
    },

    async disabledAt(userId) {
      const row = await d
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, userId))
        .get();
      return row ? row.disabledAt : undefined;
    },
  };
}
