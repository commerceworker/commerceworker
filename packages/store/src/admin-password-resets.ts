import type { AdminPasswordResets } from '@commerceworker/ports';
import { and, desc, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { type AuthDb, authDbOf } from './auth';
import { passwordResets, sessions, signInChallenges, users } from './auth-schema';

export const createAdminPasswordResets = (d1: D1Database): AdminPasswordResets =>
  adminPasswordResetQueries(authDbOf(d1));

export function adminPasswordResetQueries(db: AuthDb): AdminPasswordResets {
  return {
    async issue(reset) {
      await db.batch([
        db
          .delete(passwordResets)
          .where(
            or(
              eq(passwordResets.userId, reset.userId),
              lte(passwordResets.expiresAt, reset.createdAt),
            ),
          ),
        db.insert(passwordResets).values(reset),
      ]);
    },
    live: (query, now) =>
      db
        .select({
          id: passwordResets.id,
          userId: passwordResets.userId,
          codeHash: passwordResets.codeHash,
        })
        .from(passwordResets)
        .innerJoin(users, eq(users.id, passwordResets.userId))
        .where(
          and(
            'id' in query
              ? eq(passwordResets.id, query.id)
              : and(
                  eq(users.email, query.email),
                  eq(passwordResets.browserHash, query.browserHash),
                ),
            isNull(passwordResets.usedAt),
            gt(passwordResets.expiresAt, now),
            isNull(users.disabledAt),
            isNotNull(users.passwordHash),
          ),
        )
        .orderBy(desc(passwordResets.createdAt))
        .get(),
    async claim(id, now) {
      const used = await db
        .update(passwordResets)
        .set({ usedAt: now })
        .where(and(eq(passwordResets.id, id), isNull(passwordResets.usedAt)))
        .returning({ id: passwordResets.id });
      return used.length > 0;
    },
    async complete(userId, passwordHash) {
      const [, , , ended] = await db.batch([
        db
          .update(users)
          .set({ passwordHash, passwordChangeDue: false, passwordExpiresAt: null })
          .where(eq(users.id, userId)),
        db.delete(passwordResets).where(eq(passwordResets.userId, userId)),
        db.delete(signInChallenges).where(eq(signInChallenges.userId, userId)),
        db
          .delete(sessions)
          .where(eq(sessions.userId, userId))
          .returning({ id: sessions.tokenHash }),
      ]);
      return ended.length;
    },
  };
}
