/**
 * The price book port (`PriceBookStore`, @commerceworker/ports/commerce) on D1: books, their
 * entries (`price_rules` rows in the `price_book` source, tied by `book_id`), their assignees and
 * customers' contract prices. A book's status moves by one compare-and-set; bulk writes go in
 * batches of statements under D1's 100 bound parameters, one batch a call so a call changes
 * everything or nothing. The same contract (@commerceworker/test-kit/commerce) holds this and the
 * in-memory store.
 */
import {
  bookEntryId,
  type PriceBook,
  type PriceBookAssignment,
  type PriceBookEntry,
  type PriceBookStatus,
} from '@commerceworker/core';
import type { PriceBookStore } from '@commerceworker/ports/commerce';
import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { createDb } from './index';
import { contractPrices, priceBookAssignments, priceBooks, priceRules } from './schema';

type BookRow = typeof priceBooks.$inferSelect;

/**
 * Rows a statement may write: entries bind 9 parameters each and contract prices 3, so 10 and 30
 * rows stay under D1's 100. Deletes bind a key list and one more value.
 */
const ENTRIES_PER_STATEMENT = 10;
const CONTRACTS_PER_STATEMENT = 30;
const KEYS_PER_DELETE = 80;

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

const bookOf = (r: BookRow): PriceBook => ({
  ...r,
  status: r.status as PriceBookStatus,
});

const entryOf = (r: typeof priceRules.$inferSelect): PriceBookEntry => ({
  sku: r.sku ?? '',
  minQty: r.minQty ?? 1,
  price: r.price,
  discountPct: r.discountPct,
});

export function d1PriceBookStore(d1: D1Database): PriceBookStore {
  const db = createDb(d1);
  /** A batch of writes; typed loosely as the other stores' bulk writes are. */
  const run = (writes: unknown[]) =>
    writes.length
      ? db.batch(writes as unknown as Parameters<typeof db.batch>[0])
      : Promise.resolve();

  return {
    async list({ status, after, limit }) {
      const [rows, count] = await db.batch([
        db
          .select()
          .from(priceBooks)
          .where(
            and(
              status ? eq(priceBooks.status, status) : undefined,
              after ? gt(priceBooks.code, after) : undefined,
            ),
          )
          .orderBy(asc(priceBooks.code))
          .limit(limit + 1),
        db
          .select({ n: sql<number>`count(*)` })
          .from(priceBooks)
          .where(status ? eq(priceBooks.status, status) : undefined),
      ]);
      const shown = rows.slice(0, limit);
      return {
        rows: shown.map(bookOf),
        total: count[0]?.n ?? 0,
        next: rows.length > limit ? (shown.at(-1)?.code ?? null) : null,
      };
    },

    async find(idOrCode) {
      const row = await db
        .select()
        .from(priceBooks)
        .where(or(eq(priceBooks.id, idOrCode), eq(priceBooks.code, idOrCode)))
        .get();
      return row ? bookOf(row) : undefined;
    },

    async create(book) {
      const res = await db
        .insert(priceBooks)
        .values(book)
        .onConflictDoNothing()
        .returning({ id: priceBooks.id });
      return res.length > 0;
    },

    async transition(id, from, to, at) {
      const res = await db
        .update(priceBooks)
        .set({ status: to, updatedAt: at })
        .where(and(eq(priceBooks.id, id), eq(priceBooks.status, from)))
        .returning({ id: priceBooks.id });
      return res.length > 0;
    },

    async entries(bookId, { after, limit }) {
      const mine = eq(priceRules.bookId, bookId);
      const [rows, count] = await db.batch([
        db
          .select()
          .from(priceRules)
          .where(
            and(
              mine,
              after
                ? or(
                    gt(priceRules.sku, after.sku),
                    and(eq(priceRules.sku, after.sku), gt(priceRules.minQty, after.minQty)),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(priceRules.sku), asc(priceRules.minQty))
          .limit(limit + 1),
        db.select({ n: sql<number>`count(*)` }).from(priceRules).where(mine),
      ]);
      const shown = rows.slice(0, limit).map(entryOf);
      const last = shown.at(-1);
      return {
        rows: shown,
        total: count[0]?.n ?? 0,
        next: rows.length > limit && last ? { sku: last.sku, minQty: last.minQty } : null,
      };
    },

    async putEntries(bookId, entries, at) {
      await run(
        chunk(entries, ENTRIES_PER_STATEMENT).map((rows) =>
          db
            .insert(priceRules)
            .values(
              rows.map((e) => ({
                id: bookEntryId(bookId, e.sku, e.minQty),
                sourceId: 'price_book',
                // The chain names a book's entries by the book; this is only the column's value.
                name: 'Price book entry',
                sku: e.sku,
                minQty: e.minQty,
                price: e.price,
                discountPct: e.discountPct,
                createdAt: at,
                bookId,
              })),
            )
            .onConflictDoUpdate({
              target: priceRules.id,
              set: { price: sql`excluded.price`, discountPct: sql`excluded.discount_pct` },
            }),
        ),
      );
    },

    async removeEntries(bookId, keys) {
      const ids = keys.map((k) => bookEntryId(bookId, k.sku, k.minQty));
      await run(
        chunk(ids, KEYS_PER_DELETE).map((part) =>
          db
            .delete(priceRules)
            .where(and(eq(priceRules.bookId, bookId), inArray(priceRules.id, part))),
        ),
      );
    },

    async assign(bookId, to, at) {
      const res = await db
        .insert(priceBookAssignments)
        .values({
          bookId,
          customerId: 'customerId' in to ? to.customerId : null,
          tier: 'tier' in to ? to.tier : null,
          createdAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: priceBookAssignments.bookId });
      return res.length > 0;
    },

    async unassign(bookId, from) {
      const res = await db
        .delete(priceBookAssignments)
        .where(
          and(
            eq(priceBookAssignments.bookId, bookId),
            'customerId' in from
              ? eq(priceBookAssignments.customerId, from.customerId)
              : eq(priceBookAssignments.tier, from.tier),
          ),
        )
        .returning({ id: priceBookAssignments.bookId });
      return res.length > 0;
    },

    async assignments(bookId): Promise<PriceBookAssignment[]> {
      return db
        .select()
        .from(priceBookAssignments)
        .where(eq(priceBookAssignments.bookId, bookId))
        .orderBy(
          sql`${priceBookAssignments.customerId} IS NULL`,
          asc(priceBookAssignments.customerId),
          asc(priceBookAssignments.tier),
        );
    },

    async forCustomer(scope, customerId, tier) {
      if (!('all' in scope) && scope.companyId !== customerId) return [];
      const rows = await db
        .selectDistinct({ book: priceBooks })
        .from(priceBooks)
        .innerJoin(priceBookAssignments, eq(priceBookAssignments.bookId, priceBooks.id))
        .where(
          or(
            eq(priceBookAssignments.customerId, customerId),
            tier ? eq(priceBookAssignments.tier, tier) : undefined,
          ),
        )
        .orderBy(desc(priceBooks.priority), asc(priceBooks.code));
      return rows.map((r) => bookOf(r.book));
    },

    async contractPrices(scope, customerId) {
      if (!('all' in scope) && scope.companyId !== customerId) return [];
      return db
        .select({ sku: contractPrices.sku, price: contractPrices.price })
        .from(contractPrices)
        .where(eq(contractPrices.customerId, customerId))
        .orderBy(asc(contractPrices.sku));
    },

    async putContractPrices(scope, customerId, prices) {
      if (!('all' in scope) && scope.companyId !== customerId) return false;
      await run(
        chunk(prices, CONTRACTS_PER_STATEMENT).map((rows) =>
          db
            .insert(contractPrices)
            .values(rows.map((p) => ({ customerId, sku: p.sku, price: p.price })))
            .onConflictDoUpdate({
              target: [contractPrices.customerId, contractPrices.sku],
              set: { price: sql`excluded.price` },
            }),
        ),
      );
      return true;
    },

    async removeContractPrices(scope, customerId, skus) {
      if (!('all' in scope) && scope.companyId !== customerId) return false;
      await run(
        chunk(skus, KEYS_PER_DELETE).map((part) =>
          db
            .delete(contractPrices)
            .where(
              and(eq(contractPrices.customerId, customerId), inArray(contractPrices.sku, part)),
            ),
        ),
      );
      return true;
    },
  };
}
