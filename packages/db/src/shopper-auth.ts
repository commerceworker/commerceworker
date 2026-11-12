/**
 * The shopper sign-in port (`ShopperAuth`, @commerceworker/ports/commerce) on D1: the
 * `shopper_sign_ins` and `shopper_sessions` tables. Every state change is one guarded statement,
 * so a code or link is used by exactly one of two racing redemptions, and a new sign-in can't slip
 * past the cooldown. Emails arrive normalized (`shopperEmail`). The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import type { ShopperAuth } from '@commerceworker/ports/commerce';
import { and, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm';
import { createDb } from './index';
import { shopperSessions, shopperSignIns } from './schema';

export function d1ShopperAuth(d1: D1Database): ShopperAuth {
  const d = createDb(d1);
  return {
    async issueSignIn(s, limits) {
      const t = shopperSignIns;
      const row = {
        email: s.email,
        codeHash: s.codeHash,
        linkHash: s.linkHash,
        expiresAt: s.expiresAt,
        attempts: 0,
        lastAttemptAt: null,
        usedAt: null,
        createdAt: s.createdAt,
        dayStartedAt: s.createdAt,
        sentToday: 1,
      };
      const dayOver = sql`${t.dayStartedAt} <= ${s.createdAt - limits.dayMs}`;
      // The guard is on the row being replaced, in the same statement that replaces it.
      const written = await d
        .insert(t)
        .values(row)
        .onConflictDoUpdate({
          target: t.email,
          set: {
            codeHash: row.codeHash,
            linkHash: row.linkHash,
            expiresAt: row.expiresAt,
            // The tries so far go with the address, not the code: a used sign-in, or a last try
            // older than the lockout, starts them again; anything else keeps them.
            attempts: sql`case when ${t.usedAt} is not null or ${t.lastAttemptAt} is null or ${t.lastAttemptAt} <= ${s.createdAt - limits.lockoutMs} then 0 else ${t.attempts} end`,
            usedAt: null,
            createdAt: row.createdAt,
            dayStartedAt: sql`case when ${dayOver} then ${s.createdAt} else ${t.dayStartedAt} end`,
            sentToday: sql`case when ${dayOver} then 1 else ${t.sentToday} + 1 end`,
          },
          setWhere: and(
            lte(t.createdAt, s.createdAt - limits.cooldownMs),
            sql`not (${t.attempts} >= ${limits.maxAttempts} and ${t.lastAttemptAt} > ${s.createdAt - limits.lockoutMs})`,
            sql`not (not ${dayOver} and ${t.sentToday} >= ${limits.dailyMax})`,
          ),
        })
        .returning({ email: t.email });
      return written.length === 1;
    },

    async spendAttempt(email, now, maxAttempts) {
      const rows = await d
        .update(shopperSignIns)
        .set({ attempts: sql`${shopperSignIns.attempts} + 1`, lastAttemptAt: now })
        .where(
          and(
            eq(shopperSignIns.email, email),
            isNull(shopperSignIns.usedAt),
            gt(shopperSignIns.expiresAt, now),
            lt(shopperSignIns.attempts, maxAttempts),
          ),
        )
        .returning({ codeHash: shopperSignIns.codeHash });
      return rows[0]?.codeHash ?? null;
    },

    async consumeCode(email, codeHash, now) {
      const rows = await d
        .update(shopperSignIns)
        .set({ usedAt: now })
        .where(
          and(
            eq(shopperSignIns.email, email),
            eq(shopperSignIns.codeHash, codeHash),
            isNull(shopperSignIns.usedAt),
            gt(shopperSignIns.expiresAt, now),
          ),
        )
        .returning({ email: shopperSignIns.email });
      return rows.length === 1;
    },

    async consumeLink(linkHash, now) {
      const rows = await d
        .update(shopperSignIns)
        .set({ usedAt: now })
        .where(
          and(
            eq(shopperSignIns.linkHash, linkHash),
            isNull(shopperSignIns.usedAt),
            gt(shopperSignIns.expiresAt, now),
          ),
        )
        .returning({ email: shopperSignIns.email });
      return rows[0]?.email ?? null;
    },

    async linkEmail(linkHash, now) {
      const row = await d
        .select({ email: shopperSignIns.email })
        .from(shopperSignIns)
        .where(
          and(
            eq(shopperSignIns.linkHash, linkHash),
            isNull(shopperSignIns.usedAt),
            gt(shopperSignIns.expiresAt, now),
          ),
        )
        .get();
      return row?.email ?? null;
    },

    async createSession(s) {
      await d.insert(shopperSessions).values({ ...s, lastSeenAt: null });
    },

    async session(tokenHash, now) {
      const row = await d
        .select({
          email: shopperSessions.email,
          createdAt: shopperSessions.createdAt,
          expiresAt: shopperSessions.expiresAt,
          lastSeenAt: shopperSessions.lastSeenAt,
        })
        .from(shopperSessions)
        .where(and(eq(shopperSessions.tokenHash, tokenHash), gt(shopperSessions.expiresAt, now)))
        .get();
      return row ?? null;
    },

    async touchSession(tokenHash, now, before) {
      await d
        .update(shopperSessions)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(shopperSessions.tokenHash, tokenHash),
            sql`(${shopperSessions.lastSeenAt} is null or ${shopperSessions.lastSeenAt} < ${before})`,
          ),
        );
    },

    async endSession(tokenHash) {
      const rows = await d
        .delete(shopperSessions)
        .where(eq(shopperSessions.tokenHash, tokenHash))
        .returning({ h: shopperSessions.tokenHash });
      return rows.length === 1;
    },

    async exportFor(email) {
      const [signIns, sessions] = await Promise.all([
        d
          .select({
            email: shopperSignIns.email,
            createdAt: shopperSignIns.createdAt,
            expiresAt: shopperSignIns.expiresAt,
            attempts: shopperSignIns.attempts,
            usedAt: shopperSignIns.usedAt,
          })
          .from(shopperSignIns)
          .where(eq(shopperSignIns.email, email)),
        d
          .select({
            email: shopperSessions.email,
            createdAt: shopperSessions.createdAt,
            expiresAt: shopperSessions.expiresAt,
            lastSeenAt: shopperSessions.lastSeenAt,
          })
          .from(shopperSessions)
          .where(eq(shopperSessions.email, email)),
      ]);
      return { signIns, sessions };
    },

    async eraseFor(email) {
      const [signIns, sessions] = await d.batch([
        d
          .delete(shopperSignIns)
          .where(eq(shopperSignIns.email, email))
          .returning({ e: shopperSignIns.email }),
        d
          .delete(shopperSessions)
          .where(eq(shopperSessions.email, email))
          .returning({ h: shopperSessions.tokenHash }),
      ]);
      return { signIns: signIns.length, sessions: sessions.length };
    },

    async prune(before) {
      const [signIns, sessions] = await d.batch([
        d
          .delete(shopperSignIns)
          .where(lt(shopperSignIns.expiresAt, before.signIns))
          .returning({ e: shopperSignIns.email }),
        d
          .delete(shopperSessions)
          .where(lt(shopperSessions.expiresAt, before.sessions))
          .returning({ h: shopperSessions.tokenHash }),
      ]);
      return { signIns: signIns.length, sessions: sessions.length };
    },
  };
}
