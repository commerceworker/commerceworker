import type { AdminAuth } from '@commerceworker/ports';
import type { AuthUser, FailureWindow } from '@commerceworker/ports/commerce';
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { type AuthDb, authDbOf, startsWith } from './auth';
import { authFailures, recoveryCodes, sessions, signInChallenges, users } from './auth-schema';
import { isUniqueViolation } from './exec';

const session = {
  tokenHash: sessions.tokenHash,
  userAgent: sessions.userAgent,
  ip: sessions.ip,
  createdAt: sessions.createdAt,
  lastSeenAt: sessions.lastSeenAt,
};

const person = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  passwordHash: users.passwordHash,
  externalSub: users.externalSub,
  disabledAt: users.disabledAt,
  totpSecret: users.totpSecret,
  totpEnabledAt: users.totpEnabledAt,
  totpLastStep: users.totpLastStep,
  passwordChangeDue: users.passwordChangeDue,
  passwordExpiresAt: users.passwordExpiresAt,
};

const changes = (r: unknown) => ((r as D1Result).meta?.changes ?? 0) > 0;

export function createAdminAuth(d1: D1Database): AdminAuth {
  return adminAuthQueries(authDbOf(d1));
}

/** Adapter over an auth database; also exercised by Studio's SQLite integration tests. */
export function adminAuthQueries(d: AuthDb): AdminAuth {
  const seen = sql<number>`coalesce(${sessions.lastSeenAt}, ${sessions.createdAt})`;
  return {
    async userCount() {
      return (await d.select({ n: count() }).from(users).get())?.n ?? 0;
    },
    userByEmail: (email) => d.select(person).from(users).where(eq(users.email, email)).get(),
    user: (id) => d.select(person).from(users).where(eq(users.id, id)).get(),
    userBySub: (sub) => d.select(person).from(users).where(eq(users.externalSub, sub)).get(),
    async addSsoUser(u) {
      await d.insert(users).values(u);
    },
    async linkSub(userId, sub) {
      try {
        return changes(
          await d
            .update(users)
            .set({ externalSub: sub })
            .where(and(eq(users.id, userId), isNull(users.externalSub)))
            .run(),
        );
      } catch (err) {
        // Someone else holds the subject (its unique index).
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },
    async addUser(u) {
      await d.insert(users).values(u);
    },
    async setPassword(id, passwordHash, temporary) {
      await d
        .update(users)
        .set({
          passwordHash,
          passwordChangeDue: temporary.changeDue,
          passwordExpiresAt: temporary.expiresAt,
        })
        .where(eq(users.id, id));
    },
    async rehashPassword(id, was, next) {
      await d
        .update(users)
        .set({ passwordHash: next })
        .where(and(eq(users.id, id), eq(users.passwordHash, was)));
    },
    async useTotpStep(id, step) {
      // Conditional, so two requests racing with the same code can't both win.
      return changes(
        await d
          .update(users)
          .set({ totpLastStep: step })
          .where(
            and(eq(users.id, id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
          )
          .run(),
      );
    },
    async useRecoveryCode(userId, codeHash) {
      return changes(
        await d
          .delete(recoveryCodes)
          .where(and(eq(recoveryCodes.codeHash, codeHash), eq(recoveryCodes.userId, userId)))
          .run(),
      );
    },
    async replaceRecoveryCodes(userId, codeHashes, now) {
      // One batch: the old codes never go without the new ones arriving.
      const drop = d.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      if (!codeHashes.length) return void (await drop);
      await d.batch([
        drop,
        d
          .insert(recoveryCodes)
          .values(codeHashes.map((codeHash) => ({ codeHash, userId, createdAt: now }))),
      ]);
    },
    async enableTotp(userId, sealedSecret, at, step) {
      await d
        .update(users)
        .set({ totpSecret: sealedSecret, totpEnabledAt: at, totpLastStep: step })
        .where(eq(users.id, userId));
    },
    async disableTotp(userId) {
      // One batch: two-factor sign-in is never half off.
      await d.batch([
        d
          .update(users)
          .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
          .where(eq(users.id, userId)),
        d.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)),
      ]);
    },
    async recoveryCodesLeft(userId) {
      return (
        (
          await d
            .select({ n: count() })
            .from(recoveryCodes)
            .where(eq(recoveryCodes.userId, userId))
            .get()
        )?.n ?? 0
      );
    },

    liveSession: (tokenHash, now, idleMs) =>
      d
        .select({ ...person, seen })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            gt(sessions.expiresAt, now),
            // Idle too long: the session has ended even though its cookie hasn't.
            gt(seen, now - idleMs),
            isNull(users.disabledAt),
          ),
        )
        .get(),
    session: (tokenHash) =>
      d
        .select({ userId: sessions.userId, reauthAt: sessions.reauthAt })
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .get(),
    sessionsOf: (userId, now) =>
      d
        .select(session)
        .from(sessions)
        .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now))),
    sessionByRef: (userId, ref) =>
      d
        .select(session)
        .from(sessions)
        .where(and(eq(sessions.userId, userId), startsWith(sessions.tokenHash, ref)))
        .get(),
    async startSession(s) {
      await d.insert(sessions).values({ ...s, lastSeenAt: s.createdAt });
      await d.update(users).set({ lastLoginAt: s.createdAt }).where(eq(users.id, s.userId));
    },
    async touchSession(tokenHash, now, ip) {
      await d
        .update(sessions)
        .set({ lastSeenAt: now, ip })
        .where(eq(sessions.tokenHash, tokenHash));
    },
    async setReauth(tokenHash, userId, at) {
      await d
        .update(sessions)
        .set({ reauthAt: at })
        .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, userId)));
    },
    async endSession(tokenHash) {
      await d.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },
    async endSessions(userId, except) {
      const rows = await d
        .delete(sessions)
        .where(
          and(eq(sessions.userId, userId), except ? ne(sessions.tokenHash, except) : undefined),
        )
        .returning({ id: sessions.tokenHash });
      return rows.length;
    },
    async knownPlace(email, ip, now) {
      const row = await d
        .select({ id: sessions.tokenHash })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(users.email, email), eq(sessions.ip, ip), gt(sessions.expiresAt, now)))
        .get();
      return !!row;
    },

    async failures(keys) {
      if (!keys.length) return [];
      return d
        .select()
        .from(authFailures)
        .where(inArray(authFailures.key, [...keys]));
    },
    async recordFailures(keys, now, windowMs) {
      const expired = sql`${now} - ${authFailures.windowStart} >= ${windowMs}`;
      for (const key of keys)
        await d
          .insert(authFailures)
          .values({ key, count: 1, windowStart: now })
          .onConflictDoUpdate({
            target: authFailures.key,
            set: {
              count: sql`case when ${expired} then 1 else ${authFailures.count} + 1 end`,
              windowStart: sql`case when ${expired} then ${now} else ${authFailures.windowStart} end`,
            },
          });
    },
    async countAttempts(keys, now, windowMs) {
      const expired = sql`${now} - ${authFailures.windowStart} >= ${windowMs}`;
      const rows: FailureWindow[] = [];
      for (const key of keys) {
        const [row] = await d
          .insert(authFailures)
          .values({ key, count: 1, windowStart: now })
          .onConflictDoUpdate({
            target: authFailures.key,
            set: {
              count: sql`case when ${expired} then 1 else ${authFailures.count} + 1 end`,
              windowStart: sql`case when ${expired} then ${now} else ${authFailures.windowStart} end`,
            },
          })
          .returning();
        if (row) rows.push(row);
      }
      return rows;
    },
    async clearFailures(key) {
      await d.delete(authFailures).where(eq(authFailures.key, key));
    },
    async pruneFailures(before) {
      await d.delete(authFailures).where(lt(authFailures.windowStart, before));
    },

    async startChallenge(c) {
      await d.delete(signInChallenges).where(lte(signInChallenges.expiresAt, c.createdAt));
      await d.insert(signInChallenges).values(c);
    },
    challenge: (tokenHash, now) =>
      d
        .select(person)
        .from(signInChallenges)
        .innerJoin(users, eq(users.id, signInChallenges.userId))
        .where(
          and(
            eq(signInChallenges.tokenHash, tokenHash),
            gt(signInChallenges.expiresAt, now),
            isNull(users.disabledAt),
            isNotNull(users.totpEnabledAt),
          ),
        )
        .get() as Promise<AuthUser | undefined>,
    async endChallenge(tokenHash) {
      await d.delete(signInChallenges).where(eq(signInChallenges.tokenHash, tokenHash));
    },
  };
}
