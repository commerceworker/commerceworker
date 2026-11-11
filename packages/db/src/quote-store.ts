/**
 * The quotes port (`QuoteStore`, @commerceworker/ports/commerce) on D1: `quotes` and `quote_lines`.
 * Every read is bound by its scope in the statement itself, so a company-scoped caller can't read
 * another's rows; a status move is one `UPDATE … WHERE id = ? AND status = ?`, so of two moves
 * racing from the same state one wins. A draft's edit is one batch whose every statement names the
 * draft status, so it can't land on a quote sent a moment before, and its lines are replaced with
 * its header or not at all. A revision is one batch too: the next version is inserted only while
 * the quote is still in the status the caller read, the old one is superseded only if that insert
 * happened, and the unique `(root_id, version)` index refuses a second revision of the same
 * version, so two racing revisions make one. Line writes are chunked under D1's 100 bound
 * parameters per statement. Lists are keyset paged newest first, a page and its total in one round
 * trip. The contract in @commerceworker/test-kit/commerce holds this and the in-memory store to
 * the same behaviour.
 */
import type { Quote, QuoteCursor, QuoteLine, QuoteRow } from '@commerceworker/core';
import type { QuotePage, QuoteScope, QuoteStore } from '@commerceworker/ports/commerce';
import { and, count, desc, eq, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { createDb } from './index';
import { contains } from './match';
import { quoteLines, quotes } from './schema';

/** A line row binds this many parameters, and the guard in front of the chunk binds two more. */
const LINE_PARAMS = 7;
const LINE_CHUNK = 13;

/** `column = scope's company`, or nothing for every company. */
const bound = (column: SQLWrapper, scope: QuoteScope): SQL | undefined =>
  'all' in scope ? undefined : eq(column, scope.companyId);

type Row = typeof quotes.$inferSelect;

const quoteOf = (r: Row): Quote => ({
  ...r,
  status: r.status as Quote['status'],
  convertedTo: r.convertedTo as Quote['convertedTo'],
});

const lineCount = sql<number>`(select count(*) from ${quoteLines} where ${quoteLines.quoteId} = ${quotes.id})`;
const total = sql<number>`(select coalesce(sum(${quoteLines.qty} * ${quoteLines.unitPrice}), 0) from ${quoteLines} where ${quoteLines.quoteId} = ${quotes.id})`;

/** A unique index refused the write; Drizzle wraps the driver's error as its `cause`. */
const isUnique = (err: unknown): boolean =>
  err instanceof Error && (/UNIQUE constraint failed/i.test(err.message) || isUnique(err.cause));

const QUOTE_COLUMNS = `id, root_id, version, company_id, buyer_id, name, status, expires_at, notes,
  converted_to, converted_id, converted_at, sent_at, decided_at, created_by, created_at, updated_at`;

const quoteBinds = (q: Quote) => [
  q.id,
  q.rootId,
  q.version,
  q.companyId,
  q.buyerId,
  q.name,
  q.status,
  q.expiresAt,
  q.notes,
  q.convertedTo,
  q.convertedId,
  q.convertedAt,
  q.sentAt,
  q.decidedAt,
  q.createdBy,
  q.createdAt,
  q.updatedAt,
];

export function d1QuoteStore(d1: D1Database): QuoteStore {
  const d = createDb(d1);

  /** The line inserts for `lines`, each chunk written only while `guard` (a quote in the right state) holds. */
  const lineStatements = (
    quoteId: string,
    lines: readonly QuoteLine[],
    guard: { sql: string; binds: unknown[] } | null,
  ) => {
    const out: D1PreparedStatement[] = [];
    for (let i = 0; i < lines.length; i += LINE_CHUNK) {
      const chunk = lines.slice(i, i + LINE_CHUNK);
      const values = chunk.map(() => `(${Array(LINE_PARAMS).fill('?').join(', ')})`).join(', ');
      const binds = chunk.flatMap((l, j) => [
        quoteId,
        i + j,
        l.sku,
        l.name,
        l.qty,
        l.listPrice,
        l.unitPrice,
      ]);
      out.push(
        d1
          .prepare(
            guard
              ? `INSERT INTO quote_lines (quote_id, position, sku, name, qty, list_price, unit_price)
                 SELECT column1, column2, column3, column4, column5, column6, column7 FROM (VALUES ${values})
                 WHERE ${guard.sql}`
              : `INSERT INTO quote_lines (quote_id, position, sku, name, qty, list_price, unit_price)
                 VALUES ${values}`,
          )
          .bind(...binds, ...(guard?.binds ?? [])),
      );
    }
    return out;
  };

  return {
    async list(scope, f, paging) {
      // Naming another company doesn't widen a scope: there is nothing to read.
      if (!('all' in scope) && f.companyId && f.companyId !== scope.companyId)
        return { rows: [], total: 0, next: null };
      const needle = f.search?.trim();
      const where = and(
        bound(quotes.companyId, scope),
        f.companyId ? eq(quotes.companyId, f.companyId) : undefined,
        f.status ? eq(quotes.status, f.status) : undefined,
        f.rootId ? eq(quotes.rootId, f.rootId) : undefined,
        // Where each negotiation stands: the old versions are asked for by name.
        !f.status && !f.rootId ? sql`${quotes.status} <> 'superseded'` : undefined,
        needle ? contains(quotes.name, needle) : undefined,
      );
      const after: QuoteCursor | undefined = paging.after;
      const [counted, rows] = await d.batch([
        d.select({ n: count() }).from(quotes).where(where),
        d
          .select({ quote: quotes, lineCount, total })
          .from(quotes)
          .where(
            and(
              where,
              after
                ? sql`(${quotes.createdAt}, ${quotes.id}) < (${after.at}, ${after.id})`
                : undefined,
            ),
          )
          .orderBy(desc(quotes.createdAt), desc(quotes.id))
          .limit(paging.limit + 1),
      ]);
      const shown = rows.slice(0, paging.limit).map(
        (r): QuoteRow => ({
          ...quoteOf(r.quote),
          lineCount: r.lineCount,
          total: Math.round(r.total * 100) / 100,
        }),
      );
      const last = shown.at(-1);
      const page: QuotePage = {
        rows: shown,
        total: counted[0]?.n ?? 0,
        next: rows.length > paging.limit && last ? { at: last.createdAt, id: last.id } : null,
      };
      return page;
    },

    async get(scope, id) {
      const [head, lines] = await d.batch([
        d
          .select()
          .from(quotes)
          .where(and(eq(quotes.id, id), bound(quotes.companyId, scope)))
          .limit(1),
        d
          .select()
          .from(quoteLines)
          .where(
            and(
              eq(quoteLines.quoteId, id),
              // The header read names the scope; a line of a quote the scope can't see is never asked for.
              'all' in scope
                ? undefined
                : sql`${quoteLines.quoteId} in (select id from ${quotes} where ${quotes.companyId} = ${scope.companyId})`,
            ),
          )
          .orderBy(quoteLines.position),
      ]);
      const q = head[0];
      if (!q) return undefined;
      return {
        ...quoteOf(q),
        lines: lines.map((l) => ({
          sku: l.sku,
          name: l.name,
          qty: l.qty,
          listPrice: l.listPrice,
          unitPrice: l.unitPrice,
        })),
      };
    },

    async versions(scope, rootId) {
      return d
        .select({ id: quotes.id, version: quotes.version, status: quotes.status })
        .from(quotes)
        .where(and(eq(quotes.rootId, rootId), bound(quotes.companyId, scope)))
        .orderBy(quotes.version)
        .then((rows) => rows.map((r) => ({ ...r, status: r.status as Quote['status'] })));
    },

    async create(q, lines) {
      try {
        await d1.batch([
          d1
            .prepare(
              `INSERT INTO quotes (${QUOTE_COLUMNS}) VALUES (${Array(17).fill('?').join(', ')})`,
            )
            .bind(...quoteBinds(q)),
          ...lineStatements(q.id, lines, null),
        ]);
        return { ok: true };
      } catch (err) {
        if (!isUnique(err)) throw err;
        // The batch rolled back whole. Which index refused it: this id, or this version.
        const taken = await d
          .select({ id: quotes.id })
          .from(quotes)
          .where(eq(quotes.id, q.id))
          .get();
        return { ok: false, conflict: taken ? 'id' : 'version' };
      }
    },

    async updateDraft(scope, id, patch, at) {
      const sets: string[] = [];
      const binds: unknown[] = [];
      const set = (column: string, value: unknown) => {
        sets.push(`${column} = ?`);
        binds.push(value);
      };
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.buyerId !== undefined) set('buyer_id', patch.buyerId);
      if (patch.expiresAt !== undefined) set('expires_at', patch.expiresAt);
      if (patch.notes !== undefined) set('notes', patch.notes);
      set('updated_at', at);
      // Every statement is held to the same draft in the same scope, so a quote that was sent
      // (or isn't this company's) takes none of them.
      const scoped = 'all' in scope ? '' : ' AND company_id = ?';
      const scopeBind = 'all' in scope ? [] : [scope.companyId];
      const guard = {
        sql: `EXISTS (SELECT 1 FROM quotes WHERE id = ? AND status = 'draft'${scoped})`,
        binds: [id, ...scopeBind],
      };
      const [head] = await d1.batch([
        d1
          .prepare(
            `UPDATE quotes SET ${sets.join(', ')} WHERE id = ? AND status = 'draft'${scoped}`,
          )
          .bind(...binds, id, ...scopeBind),
        ...(patch.lines
          ? [
              d1
                .prepare(`DELETE FROM quote_lines WHERE quote_id = ? AND ${guard.sql}`)
                .bind(id, ...guard.binds),
              ...lineStatements(id, patch.lines, guard),
            ]
          : []),
      ]);
      return head && head.meta.changes > 0 ? { ok: true } : { ok: false, conflict: 'missing' };
    },

    async transition(scope, id, from, to, at) {
      const res = await d
        .update(quotes)
        .set({
          status: to,
          updatedAt: at,
          ...(to === 'sent' ? { sentAt: at } : {}),
          ...(to === 'accepted' || to === 'declined' ? { decidedAt: at } : {}),
        })
        .where(and(eq(quotes.id, id), eq(quotes.status, from), bound(quotes.companyId, scope)))
        .returning({ id: quotes.id });
      return res.length > 0;
    },

    async revise(scope, id, from, next, lines, at) {
      const scoped = 'all' in scope ? '' : ' AND company_id = ?';
      const scopeBind = 'all' in scope ? [] : [scope.companyId];
      // The next version exists only if the quote is still in `from` in this scope; the old one
      // is superseded only if the next one exists; its lines follow the same guard.
      const written = { sql: 'EXISTS (SELECT 1 FROM quotes WHERE id = ?)', binds: [next.id] };
      try {
        const res = await d1.batch([
          d1
            .prepare(
              `INSERT INTO quotes (${QUOTE_COLUMNS})
               SELECT ${Array(17).fill('?').join(', ')}
               WHERE EXISTS (SELECT 1 FROM quotes WHERE id = ? AND status = ?${scoped})`,
            )
            .bind(...quoteBinds(next), id, from, ...scopeBind),
          ...lineStatements(next.id, lines, written),
          d1
            .prepare(
              `UPDATE quotes SET status = 'superseded', updated_at = ?
               WHERE id = ? AND status = ?${scoped} AND ${written.sql}`,
            )
            .bind(at, id, from, ...scopeBind, ...written.binds),
        ]);
        return res.at(-1)?.meta.changes ? { ok: true } : { ok: false, conflict: 'status' };
      } catch (err) {
        if (!isUnique(err)) throw err;
        const taken = await d
          .select({ id: quotes.id })
          .from(quotes)
          .where(eq(quotes.id, next.id))
          .get();
        return { ok: false, conflict: taken ? 'id' : 'version' };
      }
    },

    async markConverted(scope, id, to, convertedId, at) {
      const scoped = 'all' in scope ? '' : ' AND company_id = ?';
      const scopeBind = 'all' in scope ? [] : [scope.companyId];
      const res = await d1
        .prepare(
          `UPDATE quotes
           SET converted_to = ?, converted_id = ?, converted_at = ?, updated_at = ?
           WHERE id = ? AND status = 'accepted' AND converted_id IS NULL${scoped}`,
        )
        .bind(to, convertedId, at, at, id, ...scopeBind)
        .run();
      if (res.meta.changes > 0) return 'new';
      // Already named: the same result is a repeat, whoever made it.
      const same = await d1
        .prepare(
          `SELECT 1 AS n FROM quotes
           WHERE id = ? AND status = 'accepted' AND converted_to = ? AND converted_id = ?${scoped}`,
        )
        .bind(id, to, convertedId, ...scopeBind)
        .first();
      return same ? 'same' : false;
    },

    async settleConversion(scope, id, from, to, at) {
      const scoped = 'all' in scope ? '' : ' AND company_id = ?';
      const res = await d1
        .prepare(
          `UPDATE quotes SET converted_id = ?, updated_at = ?
           WHERE id = ? AND converted_id IN (?, ?)${scoped}`,
        )
        .bind(to, at, id, from, to, ...('all' in scope ? [] : [scope.companyId]))
        .run();
      return res.meta.changes > 0;
    },
  };
}
