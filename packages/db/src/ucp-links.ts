/**
 * The identity-linking port (`UcpLinks`, @commerceworker/ports/commerce) on D1: `ucp_link_codes`,
 * `ucp_link_grants` and `ucp_link_tokens`. A code and a refresh token are each spent by one guarded
 * statement, and a link starts (or a token rotates) in one batch, which D1 runs as a transaction:
 * of two redemptions of a code, or two uses of a refresh token, exactly one writes. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import type { LinkGrant, LinkToken, UcpLinks } from '@commerceworker/ports/commerce';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { createDb } from './index';
import { ucpLinkCodes, ucpLinkGrants, ucpLinkTokens, ucpPlatforms } from './schema';

const grantRow = (g: typeof ucpLinkGrants.$inferSelect): LinkGrant => ({
  id: g.id,
  platformId: g.platformId,
  email: g.email,
  scope: g.scope,
  createdAt: g.createdAt,
  expiresAt: g.expiresAt,
  revokedAt: g.revokedAt,
});

export function d1UcpLinks(d1: D1Database): UcpLinks {
  const d = createDb(d1);
  const tokenArgs = (t: LinkToken) => [
    t.tokenHash,
    t.grantId,
    t.kind,
    t.scope,
    t.createdAt,
    t.expiresAt,
  ];
  return {
    async issueCode(c) {
      await d.insert(ucpLinkCodes).values({ ...c, usedAt: null });
    },

    async spendCode(codeHash, now) {
      const spent = await d
        .update(ucpLinkCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(ucpLinkCodes.codeHash, codeHash),
            isNull(ucpLinkCodes.usedAt),
            gt(ucpLinkCodes.expiresAt, now),
          ),
        )
        .returning();
      const row = spent[0];
      if (row) {
        const { usedAt: _used, replayedAt: _replayed, ...code } = row;
        return { kind: 'spent', code };
      }
      const prior = await d
        .select({ grantId: ucpLinkCodes.grantId, usedAt: ucpLinkCodes.usedAt })
        .from(ucpLinkCodes)
        .where(eq(ucpLinkCodes.codeHash, codeHash))
        .get();
      if (prior?.usedAt == null) return null;
      // Marked on the row, so a replay that lands before the link exists still stops it being made.
      await d
        .update(ucpLinkCodes)
        .set({ replayedAt: now })
        .where(and(eq(ucpLinkCodes.codeHash, codeHash), isNull(ucpLinkCodes.replayedAt)));
      return { kind: 'replayed', grantId: prior.grantId };
    },

    async createGrant(g, tokens, now, codeHash) {
      // Every write waits on the code not having been replayed, so a replay between the code's
      // spending and this batch leaves nothing: the one statement that decides is repeated, and
      // D1 runs the batch as a transaction.
      const open = codeHash
        ? 'NOT EXISTS (SELECT 1 FROM ucp_link_codes WHERE code_hash = ? AND replayed_at IS NOT NULL)'
        : '1 = 1';
      const guard = codeHash ? [codeHash] : [];
      const results = await d1.batch([
        d1
          .prepare(
            `UPDATE ucp_link_grants SET revoked_at = ? WHERE platform_id = ? AND email = ? AND revoked_at IS NULL AND ${open}`,
          )
          .bind(now, g.platformId, g.email, ...guard),
        d1
          .prepare(
            `INSERT INTO ucp_link_grants (id, platform_id, email, scope, created_at, expires_at)
             SELECT ?, ?, ?, ?, ?, ? WHERE ${open}`,
          )
          .bind(g.id, g.platformId, g.email, g.scope, g.createdAt, g.expiresAt, ...guard),
        ...tokens.map((t) =>
          d1
            .prepare(
              `INSERT INTO ucp_link_tokens (token_hash, grant_id, kind, scope, created_at, expires_at)
               SELECT ?, ?, ?, ?, ?, ? WHERE ${open}`,
            )
            .bind(...tokenArgs(t), ...guard),
        ),
      ]);
      return results[1]?.meta.changes === 1;
    },

    async access(tokenHash, now) {
      const row = await d
        .select({ grant: ucpLinkGrants, scope: ucpLinkTokens.scope })
        .from(ucpLinkTokens)
        .innerJoin(ucpLinkGrants, eq(ucpLinkGrants.id, ucpLinkTokens.grantId))
        .where(
          and(
            eq(ucpLinkTokens.tokenHash, tokenHash),
            eq(ucpLinkTokens.kind, 'access'),
            gt(ucpLinkTokens.expiresAt, now),
            isNull(ucpLinkGrants.revokedAt),
            gt(ucpLinkGrants.expiresAt, now),
          ),
        )
        .get();
      return row ? { grant: grantRow(row.grant), scope: row.scope } : null;
    },

    async refresh(tokenHash) {
      const row = await d
        .select({
          grant: ucpLinkGrants,
          scope: ucpLinkTokens.scope,
          usedAt: ucpLinkTokens.usedAt,
          expiresAt: ucpLinkTokens.expiresAt,
        })
        .from(ucpLinkTokens)
        .innerJoin(ucpLinkGrants, eq(ucpLinkGrants.id, ucpLinkTokens.grantId))
        .where(and(eq(ucpLinkTokens.tokenHash, tokenHash), eq(ucpLinkTokens.kind, 'refresh')))
        .get();
      return row
        ? {
            grant: grantRow(row.grant),
            scope: row.scope,
            spent: row.usedAt !== null,
            expiresAt: row.expiresAt,
          }
        : null;
    },

    async rotate(tokenHash, next, now) {
      const successor = next.find((t) => t.kind === 'refresh')?.tokenHash;
      if (!successor) throw new Error('A rotation issues a refresh token');
      // The first statement spends the token only while it and its link are live; each insert
      // below writes only where that spending named this caller's successor, so a second caller
      // spends nothing and stores nothing.
      const results = await d1.batch([
        d1
          .prepare(
            `UPDATE ucp_link_tokens SET used_at = ?, successor = ?
             WHERE token_hash = ? AND kind = 'refresh' AND used_at IS NULL AND expires_at > ?
               AND grant_id IN (SELECT id FROM ucp_link_grants WHERE revoked_at IS NULL AND expires_at > ?)`,
          )
          .bind(now, successor, tokenHash, now, now),
        ...next.map((t) =>
          d1
            .prepare(
              `INSERT INTO ucp_link_tokens (token_hash, grant_id, kind, scope, created_at, expires_at)
               SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ucp_link_tokens WHERE token_hash = ? AND successor = ?)`,
            )
            .bind(...tokenArgs(t), tokenHash, successor),
        ),
      ]);
      if (results[0]?.meta.changes === 1) return 'rotated';
      const row = await d
        .select({ usedAt: ucpLinkTokens.usedAt })
        .from(ucpLinkTokens)
        .where(and(eq(ucpLinkTokens.tokenHash, tokenHash), eq(ucpLinkTokens.kind, 'refresh')))
        .get();
      return row?.usedAt != null ? 'reused' : 'unknown';
    },

    async grantOfToken(tokenHash) {
      const row = await d
        .select({ grant: ucpLinkGrants })
        .from(ucpLinkTokens)
        .innerJoin(ucpLinkGrants, eq(ucpLinkGrants.id, ucpLinkTokens.grantId))
        .where(eq(ucpLinkTokens.tokenHash, tokenHash))
        .get();
      return row ? grantRow(row.grant) : null;
    },

    async grant(id) {
      const row = await d.select().from(ucpLinkGrants).where(eq(ucpLinkGrants.id, id)).get();
      return row ? grantRow(row) : null;
    },

    async revokeGrant(id, now) {
      const rows = await d
        .update(ucpLinkGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(ucpLinkGrants.id, id),
            isNull(ucpLinkGrants.revokedAt),
            gt(ucpLinkGrants.expiresAt, now),
          ),
        )
        .returning({ id: ucpLinkGrants.id });
      return rows.length === 1;
    },

    async forShopper(email, now) {
      const rows = await d
        .select({
          id: ucpLinkGrants.id,
          platformId: ucpLinkGrants.platformId,
          platformName: ucpPlatforms.name,
          scope: ucpLinkGrants.scope,
          createdAt: ucpLinkGrants.createdAt,
          expiresAt: ucpLinkGrants.expiresAt,
        })
        .from(ucpLinkGrants)
        .leftJoin(ucpPlatforms, eq(ucpPlatforms.id, ucpLinkGrants.platformId))
        .where(
          and(
            eq(ucpLinkGrants.email, email),
            isNull(ucpLinkGrants.revokedAt),
            gt(ucpLinkGrants.expiresAt, now),
          ),
        )
        .orderBy(desc(ucpLinkGrants.createdAt));
      return rows.map((r) => ({ ...r, platformName: r.platformName ?? r.platformId }));
    },

    async revokeForShopper(email, grantId, now) {
      const rows = await d
        .update(ucpLinkGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(ucpLinkGrants.id, grantId),
            eq(ucpLinkGrants.email, email),
            isNull(ucpLinkGrants.revokedAt),
            gt(ucpLinkGrants.expiresAt, now),
          ),
        )
        .returning({ id: ucpLinkGrants.id });
      return rows.length === 1;
    },

    exportFor: (email) =>
      d
        .select({
          id: ucpLinkGrants.id,
          platformId: ucpLinkGrants.platformId,
          email: ucpLinkGrants.email,
          scope: ucpLinkGrants.scope,
          createdAt: ucpLinkGrants.createdAt,
          expiresAt: ucpLinkGrants.expiresAt,
          revokedAt: ucpLinkGrants.revokedAt,
        })
        .from(ucpLinkGrants)
        .where(eq(ucpLinkGrants.email, email)),

    async eraseFor(email) {
      const [, , grants] = await d.batch([
        d
          .delete(ucpLinkTokens)
          .where(
            sql`${ucpLinkTokens.grantId} in (select ${ucpLinkGrants.id} from ${ucpLinkGrants} where ${ucpLinkGrants.email} = ${email})`,
          ),
        d.delete(ucpLinkCodes).where(eq(ucpLinkCodes.email, email)),
        d
          .delete(ucpLinkGrants)
          .where(eq(ucpLinkGrants.email, email))
          .returning({ id: ucpLinkGrants.id }),
      ]);
      return grants.length;
    },

    async prune(before) {
      const over = sql`((${ucpLinkGrants.revokedAt} is not null and ${ucpLinkGrants.revokedAt} < ${before.grants}) or ${ucpLinkGrants.expiresAt} < ${before.grants})`;
      const t = ucpLinkTokens;
      const [ofEnded, expired, spent, codes, grants] = await d.batch([
        d
          .delete(t)
          .where(
            sql`${t.grantId} in (select ${ucpLinkGrants.id} from ${ucpLinkGrants} where ${over})`,
          )
          .returning({ h: t.tokenHash }),
        d
          .delete(t)
          .where(and(eq(t.kind, 'access'), sql`${t.expiresAt} < ${before.tokens}`))
          .returning({ h: t.tokenHash }),
        // A spent refresh token older than the cut goes unless it is its link's latest spent one.
        d
          .delete(t)
          .where(
            and(
              eq(t.kind, 'refresh'),
              sql`${t.usedAt} is not null`,
              sql`${t.usedAt} < ${before.spent}`,
              sql`${t.usedAt} < (select max(t2.used_at) from ucp_link_tokens t2 where t2.grant_id = ${t.grantId} and t2.kind = 'refresh' and t2.used_at is not null)`,
            ),
          )
          .returning({ h: t.tokenHash }),
        d
          .delete(ucpLinkCodes)
          .where(sql`${ucpLinkCodes.expiresAt} < ${before.codes}`)
          .returning({ h: ucpLinkCodes.codeHash }),
        d.delete(ucpLinkGrants).where(over).returning({ id: ucpLinkGrants.id }),
      ]);
      return {
        codes: codes.length,
        grants: grants.length,
        tokens: ofEnded.length + expired.length + spent.length,
      };
    },
  };
}
