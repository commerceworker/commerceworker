/**
 * The pricing port (`PricingStore`, @commerceworker/ports/commerce) on D1. Moved here from the
 * engine's connectors so the engine reaches commerce storage through a port; the same contract
 * (@commerceworker/test-kit/commerce) holds this and the in-memory store.
 */
import {
  BASE_CURRENCY,
  type FxSource,
  matchCustomerByName,
  PROMOTION_KINDS,
  PROMOTION_STACKING,
  type PriceRule,
  type PriceSource,
  type PriceSourceKind,
  type Promotion,
  parseBxgyRule,
  quoteLineRule,
} from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type { PricingStore, Redemption } from '@commerceworker/ports/commerce';
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { createDb } from './index';
import { endsWith } from './match';
import {
  contractPrices,
  customers,
  fxRates,
  priceBookAssignments,
  priceBooks,
  priceRules,
  priceSources,
  products,
  promotionRedemptions,
  promotions,
  quoteLines,
  quotes,
} from './schema';

type PromotionRow = typeof promotions.$inferSelect;

/** D1 binds at most 100 parameters per statement: SKU lists are read in runs under that. */
const SKUS_PER_QUERY = 90;

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** A stored rule, or null when there is none or it isn't one (such a promotion never applies). */
function bxgyOf(text: string | null): Promotion['bxgy'] {
  if (!text) return null;
  try {
    const r = parseBxgyRule(JSON.parse(text));
    return 'rule' in r ? r.rule : null;
  } catch {
    return null;
  }
}

/** A stored promotion as the discount node reads it. */
export function promotionFromRow(r: PromotionRow): Promotion {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: (PROMOTION_KINDS as readonly string[]).includes(r.kind)
      ? (r.kind as Promotion['kind'])
      : 'pct',
    value: r.value,
    currency: r.currency,
    minSubtotal: r.minSubtotal,
    skus: r.skus ? (JSON.parse(r.skus) as string[]) : null,
    customerId: r.customerId,
    validFrom: r.validFrom,
    validTo: r.validTo,
    maxRedemptions: r.maxRedemptions,
    perCustomerLimit: r.perCustomerLimit,
    status: r.status === 'paused' ? 'paused' : 'active',
    priority: r.priority,
    stacking: (PROMOTION_STACKING as readonly string[]).includes(r.stacking)
      ? (r.stacking as Promotion['stacking'])
      : 'exclusive',
    maxDiscount: r.maxDiscount,
    condition: r.condition ? (JSON.parse(r.condition) as object) : null,
    conditionMessage: r.conditionMessage,
    bxgy: bxgyOf(r.bxgy),
  };
}

type ProductRow = typeof products.$inferSelect;
type FxRow = typeof fxRates.$inferSelect;
type SourceRow = typeof priceSources.$inferSelect;
type RuleRow = typeof priceRules.$inferSelect;
/** A rule with the book it belongs to, null for one in none. */
type RuleRead = {
  rule: RuleRow;
  book: { id: string | null; name: string | null; priority: number | null } | null;
};
/**
 * A contract price, or a line of an accepted quote (`quoteId` set, with the quote's name, the line's
 * position, the most it covers and when the quote expires): both are the customer's agreed prices
 * per SKU, read by one statement.
 */
type ContractRow = {
  customerId: string;
  sku: string;
  price: number;
  quoteId: string | null;
  quoteName: string | null;
  position: number | null;
  maxQty: number | null;
  expiresAt: number | null;
};

/** The price chain from its rows: contract prices become the contract source's entries. */
function chainOf(
  sources: SourceRow[],
  rules: RuleRead[],
  contracts: ContractRow[],
  customer: { tier: string } | undefined,
) {
  return {
    sources: sources.map(
      (s): PriceSource => ({
        id: s.id as PriceSourceKind,
        label: s.label,
        priority: s.priority,
        stopProcessing: s.stopProcessing,
      }),
    ),
    rules: [
      ...rules.map(
        ({ rule: r, book }): PriceRule => ({
          ...r,
          source: r.sourceId as PriceSourceKind,
          // A book's entries are named by the book, so a line's price says which book priced it.
          ...(book?.id
            ? { name: book.name ?? r.name, bookId: book.id, bookPriority: book.priority }
            : {}),
        }),
      ),
      ...contracts.map(
        (c): PriceRule =>
          c.quoteId
            ? quoteLineRule(
                {
                  id: c.quoteId,
                  name: c.quoteName ?? '',
                  companyId: c.customerId,
                  expiresAt: c.expiresAt,
                },
                c.position ?? 0,
                { sku: c.sku, qty: c.maxQty ?? 0, unitPrice: c.price },
              )
            : {
                id: `contract_${c.customerId}_${c.sku}`,
                source: 'contract',
                name: 'Contract price',
                sku: c.sku,
                customerId: c.customerId,
                price: c.price,
              },
      ),
    ],
    tier: customer?.tier ?? null,
  };
}

export function d1PricingStore(d1: D1Database, clock: Clock): PricingStore {
  const db = createDb(d1);

  /**
   * The rules the chain reads: every entry in no book, and the entries of the books assigned to
   * the customer (by id or by their tier) that are active and inside their dates at `at`, with
   * each entry's book. With no customer, no book is assigned (a customer id is never empty). When
   * `skus` is given the book entries are only those SKUs', in runs under D1's parameter limit
   * (the first run also carries the entries in no book); one statement for any usual order.
   */
  const ruleReads = (customerId: string | undefined, at: number, skus?: readonly string[]) => {
    const assigned = db
      .select({ id: priceBooks.id })
      .from(priceBooks)
      .innerJoin(priceBookAssignments, eq(priceBookAssignments.bookId, priceBooks.id))
      .where(
        and(
          eq(priceBooks.status, 'active'),
          or(isNull(priceBooks.startsAt), lte(priceBooks.startsAt, at)),
          or(isNull(priceBooks.endsAt), gt(priceBooks.endsAt, at)),
          or(
            eq(priceBookAssignments.customerId, customerId ?? ''),
            eq(
              priceBookAssignments.tier,
              sql`(SELECT ${customers.tier} FROM ${customers} WHERE ${customers.id} = ${customerId ?? ''})`,
            ),
          ),
        ),
      );
    const read = (loose: boolean, only?: readonly string[]) =>
      db
        .select({
          rule: priceRules,
          // Aliased: Drizzle's D1 batch reads rows by column name, so a joined `id` and `name`
          // would overwrite the rule's own.
          book: {
            id: sql<string | null>`${priceBooks.id}`.as('pb_id'),
            name: sql<string | null>`${priceBooks.name}`.as('pb_name'),
            priority: sql<number | null>`${priceBooks.priority}`.as('pb_priority'),
          },
        })
        .from(priceRules)
        .leftJoin(priceBooks, eq(priceBooks.id, priceRules.bookId))
        .where(
          or(
            loose ? isNull(priceRules.bookId) : undefined,
            and(
              inArray(priceRules.bookId, assigned),
              only ? inArray(priceRules.sku, [...only]) : undefined,
            ),
          ),
        );
    if (!skus) return [read(true)];
    const runs = chunk([...new Set(skus)], SKUS_PER_QUERY);
    return runs.length ? runs.map((run, i) => read(i === 0, run)) : [read(true)];
  };

  /**
   * The customer's agreed prices, in one statement: their contract prices, and the lines of the
   * company's accepted quotes that haven't expired at `at` (a quote's SKUs are the order's when
   * `skus` fits one statement; a longer order reads all of them). The quote source's entries are
   * these rows, so the statement count of a pricing read is what it was before quotes.
   */
  const agreedReads = (customerId: string | undefined, at: number, skus?: readonly string[]) => {
    const none = <T>() => sql<T | null>`null`;
    const contracts = db
      .select({
        customerId: contractPrices.customerId,
        sku: contractPrices.sku,
        price: contractPrices.price,
        quoteId: none<string>().as('quote_id'),
        quoteName: none<string>().as('quote_name'),
        position: none<number>().as('position'),
        maxQty: none<number>().as('max_qty'),
        expiresAt: none<number>().as('expires_at'),
      })
      .from(contractPrices)
      .where(eq(contractPrices.customerId, customerId ?? ''));
    const wanted = skus && skus.length <= SKUS_PER_QUERY ? [...new Set(skus)] : undefined;
    const quoted = db
      .select({
        customerId: quotes.companyId,
        sku: quoteLines.sku,
        price: quoteLines.unitPrice,
        quoteId: sql<string | null>`${quotes.id}`,
        quoteName: sql<string | null>`${quotes.name}`,
        position: sql<number | null>`${quoteLines.position}`,
        maxQty: sql<number | null>`${quoteLines.qty}`,
        expiresAt: sql<number | null>`${quotes.expiresAt}`,
      })
      .from(quoteLines)
      .innerJoin(quotes, eq(quotes.id, quoteLines.quoteId))
      .where(
        and(
          eq(quotes.companyId, customerId ?? ''),
          eq(quotes.status, 'accepted'),
          gt(quotes.expiresAt, at),
          wanted?.length ? inArray(quoteLines.sku, wanted) : undefined,
        ),
      );
    return contracts.unionAll(quoted);
  };

  /**
   * The price chain's reads, as one batch's statements: sources, rules (`ruleReads`), the
   * customer's agreed prices (`agreedReads`) and their tier. With no customer, the agreed and tier
   * reads match nothing (a customer id is never empty), so the batch keeps its shape.
   */
  const chainReads = (customerId: string | undefined, at: number, skus?: readonly string[]) =>
    [
      db.select().from(priceSources).where(eq(priceSources.active, true)),
      ...ruleReads(customerId, at, skus),
      agreedReads(customerId, at, skus),
      db
        .select({ tier: customers.tier })
        .from(customers)
        .where(eq(customers.id, customerId ?? ''))
        .limit(1),
    ] as const;

  /** The chain from a batch of `chainReads`: sources, one or more rule reads, contracts, tier. */
  const chainFrom = (results: unknown[][]) =>
    chainOf(
      results[0] as SourceRow[],
      results.slice(1, -2).flat() as RuleRead[],
      results.at(-2) as ContractRow[],
      (results.at(-1) as { tier: string }[])[0],
    );

  return {
    async customer(id) {
      if (!id) return undefined;
      return db.query.customers.findFirst({ where: eq(customers.id, id) });
    },

    customersByEmail: (email, domain) =>
      db
        .select({ id: customers.id, email: customers.email })
        .from(customers)
        .where(
          or(
            sql`lower(${customers.email}) = ${email.toLowerCase()}`,
            endsWith(sql`lower(${customers.email})`, `@${domain.toLowerCase()}`),
          ),
        ),

    async customers(ids) {
      const runs = chunk([...new Set(ids)], SKUS_PER_QUERY);
      const found = await Promise.all(
        runs.map((run) => db.select().from(customers).where(inArray(customers.id, run))),
      );
      return found.flat();
    },

    async customerByName(name) {
      const all = await db.select({ id: customers.id, name: customers.name }).from(customers);
      return matchCustomerByName(all, name);
    },

    async products(skus) {
      if (!skus) return db.select().from(products);
      // Each SKU once, in runs a statement can bind: a large order must not hit D1's limit.
      const runs = chunk([...new Set(skus)], SKUS_PER_QUERY);
      const found = await Promise.all(
        runs.map((run) => db.select().from(products).where(inArray(products.sku, run))),
      );
      return found.flat();
    },

    async promotionsByCode(codes) {
      if (!codes.length) return [];
      const rows = await db
        .select()
        .from(promotions)
        .where(inArray(promotions.code, [...codes]));
      return rows.map(promotionFromRow);
    },

    async automaticPromotions(at) {
      const rows = await db
        .select()
        .from(promotions)
        .where(
          and(
            sql`${promotions.code} IS NULL`,
            eq(promotions.status, 'active'),
            sql`(${promotions.validFrom} IS NULL OR ${promotions.validFrom} <= ${at})`,
            sql`(${promotions.validTo} IS NULL OR ${promotions.validTo} > ${at})`,
          ),
        );
      return rows.map(promotionFromRow);
    },

    async redemptionsOf(promotionId, orderId, customerId) {
      const row = await db
        .select({
          total: sql<number>`count(*)`,
          byCustomer: sql<number>`coalesce(sum(case when ${promotionRedemptions.customerId} = ${customerId ?? null} then 1 else 0 end), 0)`,
        })
        .from(promotionRedemptions)
        .where(
          and(
            eq(promotionRedemptions.promotionId, promotionId),
            sql`${promotionRedemptions.orderId} <> ${orderId}`,
          ),
        )
        .get();
      return { total: row?.total ?? 0, byCustomer: row?.byCustomer ?? 0 };
    },

    async redeem(r: Redemption) {
      const max = r.promotion.maxRedemptions ?? Number.MAX_SAFE_INTEGER;
      // The count and the insert are one statement: two orders racing for the last redemption
      // can't both have it.
      await d1
        .prepare(
          `INSERT INTO promotion_redemptions (promotion_id, order_id, customer_id, amount, step_key, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE (SELECT count(*) FROM promotion_redemptions WHERE promotion_id = ?1 AND order_id <> ?2) < ?7
           ON CONFLICT (promotion_id, order_id) DO NOTHING`,
        )
        .bind(
          r.promotion.id,
          r.orderId,
          r.customerId ?? null,
          r.amount,
          r.stepKey,
          clock.now().getTime(),
          max,
        )
        .run();
      const held = await db
        .select({ id: promotionRedemptions.promotionId })
        .from(promotionRedemptions)
        .where(
          and(
            eq(promotionRedemptions.promotionId, r.promotion.id),
            eq(promotionRedemptions.orderId, r.orderId),
          ),
        )
        .get();
      return !!held;
    },

    async releaseRedemptions(orderId) {
      const r = await d1
        .prepare('DELETE FROM promotion_redemptions WHERE order_id = ?')
        .bind(orderId)
        .run();
      return r.meta.changes ?? 0;
    },

    async listPromotions() {
      const [rows, counts] = await db.batch([
        db.select().from(promotions).orderBy(desc(promotions.createdAt), desc(promotions.id)),
        db
          .select({ id: promotionRedemptions.promotionId, n: sql<number>`count(*)` })
          .from(promotionRedemptions)
          .groupBy(promotionRedemptions.promotionId),
      ]);
      const used = new Map(counts.map((c) => [c.id, c.n]));
      return rows.map((r) => ({ ...promotionFromRow(r), redeemed: used.get(r.id) ?? 0 }));
    },

    async promotion(id) {
      const row = await db.select().from(promotions).where(eq(promotions.id, id)).get();
      return row ? promotionFromRow(row) : undefined;
    },

    async createPromotion(p, createdBy) {
      const at = clock.now().getTime();
      const res = await db
        .insert(promotions)
        .values({
          id: p.id,
          code: p.code,
          name: p.name,
          kind: p.kind,
          value: p.value,
          minSubtotal: p.minSubtotal,
          skus: p.skus?.length ? JSON.stringify(p.skus) : null,
          customerId: p.customerId,
          validTo: p.validTo,
          maxRedemptions: p.maxRedemptions,
          perCustomerLimit: p.perCustomerLimit,
          priority: p.priority,
          stacking: p.stacking,
          maxDiscount: p.maxDiscount,
          condition: p.condition ? JSON.stringify(p.condition) : null,
          conditionMessage: p.conditionMessage,
          bxgy: p.bxgy ? JSON.stringify(p.bxgy) : null,
          createdBy,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: promotions.id });
      return res.length > 0;
    },

    async setPromotionStatus(id, status) {
      await db
        .update(promotions)
        .set({ status, updatedAt: clock.now().getTime() })
        .where(eq(promotions.id, id));
    },

    async fxRate(currency) {
      if (currency === BASE_CURRENCY) return 1;
      const row = await db.select().from(fxRates).where(eq(fxRates.currency, currency)).get();
      return row?.rate ?? null;
    },

    async fxRateRows() {
      const rows = await db.select().from(fxRates).orderBy(fxRates.currency).all();
      return rows
        .filter((r) => r.currency !== BASE_CURRENCY)
        .map((r) => ({
          currency: r.currency,
          rate: r.rate,
          updatedAt: r.updatedAt,
          source: r.source as FxSource,
          updatedBy: r.updatedBy,
        }));
    },

    async setFxRates(rates, at, source, by) {
      const rows = rates.filter(
        (r) => r.currency !== BASE_CURRENCY && Number.isFinite(r.rate) && r.rate > 0,
      );
      if (!rows.length) return 0;
      // Five bound parameters a row, so at most 20 rows a statement (D1 allows 100); the
      // statements go in one batch, so the rates change together or not at all.
      const writes = [];
      for (let i = 0; i < rows.length; i += 20)
        writes.push(
          db
            .insert(fxRates)
            .values(
              rows.slice(i, i + 20).map((r) => ({
                currency: r.currency,
                rate: r.rate,
                updatedAt: at,
                source,
                updatedBy: by ?? null,
              })),
            )
            .onConflictDoUpdate({
              target: fxRates.currency,
              set: {
                rate: sql`excluded.rate`,
                updatedAt: sql`excluded.updated_at`,
                source: sql`excluded.source`,
                updatedBy: sql`excluded.updated_by`,
              },
            }),
        );
      await db.batch(writes as unknown as Parameters<typeof db.batch>[0]);
      return rows.length;
    },

    async pricingFor(customerId, at, skus) {
      const [head, ...rest] = chainReads(customerId, at, skus);
      return chainFrom((await db.batch([head, ...rest])) as unknown[][]);
    },

    async priceInputs(skus, currency, customerId, chain, at) {
      const runs = chunk([...new Set(skus)], SKUS_PER_QUERY);
      const productReads = runs.map((run) =>
        db.select().from(products).where(inArray(products.sku, run)),
      );
      const rate =
        currency === BASE_CURRENCY
          ? []
          : [db.select().from(fxRates).where(eq(fxRates.currency, currency))];
      const reads = chain ? chainReads(customerId, at, skus) : [];
      const all = [...productReads, ...rate, ...reads];
      if (!all.length) return { products: [], fxRate: 1, chain: null };
      const [head, ...rest] = all;
      // One batch: one round trip for everything pricing reads.
      const results = (await db.batch([head!, ...rest])) as unknown[][];
      const found = results.slice(0, productReads.length).flat() as ProductRow[];
      const rateRow = (rate.length ? results[productReads.length] : []) as FxRow[];
      const c = results.slice(productReads.length + rate.length);
      return {
        products: found,
        fxRate: currency === BASE_CURRENCY ? 1 : (rateRow[0]?.rate ?? null),
        chain: chain ? chainFrom(c) : null,
      };
    },
  };
}
