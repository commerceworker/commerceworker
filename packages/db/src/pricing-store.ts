/**
 * The pricing port (`PricingStore`, @commerceworker/ports/commerce) on D1. Moved here from the
 * engine's connectors so the engine reaches commerce storage through a port; the same contract
 * (@commerceworker/test-kit/commerce) holds this and the in-memory store.
 */
import {
  BASE_CURRENCY,
  matchCustomerByName,
  PROMOTION_KINDS,
  type PriceRule,
  type PriceSource,
  type PriceSourceKind,
  type Promotion,
} from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type { PricingStore, Redemption } from '@commerceworker/ports/commerce';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { createDb } from './index';
import { endsWith } from './match';
import {
  contractPrices,
  customers,
  fxRates,
  priceRules,
  priceSources,
  products,
  promotionRedemptions,
  promotions,
} from './schema';

type PromotionRow = typeof promotions.$inferSelect;

/** D1 binds at most 100 parameters per statement: SKU lists are read in runs under that. */
const SKUS_PER_QUERY = 90;

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
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
  };
}

type ProductRow = typeof products.$inferSelect;
type FxRow = typeof fxRates.$inferSelect;
type SourceRow = typeof priceSources.$inferSelect;
type RuleRow = typeof priceRules.$inferSelect;
type ContractRow = typeof contractPrices.$inferSelect;

/** The price chain from its rows: contract prices become the contract source's entries. */
function chainOf(
  sources: SourceRow[],
  rules: RuleRow[],
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
      ...rules.map((r): PriceRule => ({ ...r, source: r.sourceId as PriceSourceKind })),
      ...contracts.map(
        (c): PriceRule => ({
          id: `contract_${c.customerId}_${c.sku}`,
          source: 'contract',
          name: 'Contract price',
          sku: c.sku,
          customerId: c.customerId,
          price: c.price,
        }),
      ),
    ],
    tier: customer?.tier ?? null,
  };
}

export function d1PricingStore(d1: D1Database, clock: Clock): PricingStore {
  const db = createDb(d1);

  /**
   * The price chain's four reads, as one batch's statements. With no customer, the contract and
   * tier reads match nothing (a customer id is never empty), so the batch keeps its shape.
   */
  const chainReads = (customerId: string | undefined) =>
    [
      db.select().from(priceSources).where(eq(priceSources.active, true)),
      db.select().from(priceRules),
      db
        .select()
        .from(contractPrices)
        .where(eq(contractPrices.customerId, customerId ?? '')),
      db
        .select({ tier: customers.tier })
        .from(customers)
        .where(eq(customers.id, customerId ?? ''))
        .limit(1),
    ] as const;

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

    async setFxRates(rates, at) {
      const rows = rates.filter(
        (r) => r.currency !== BASE_CURRENCY && Number.isFinite(r.rate) && r.rate > 0,
      );
      if (!rows.length) return 0;
      // Three bound parameters a row, so at most 33 rows a statement (D1 allows 100); the
      // statements go in one batch, so the rates change together or not at all.
      const writes = [];
      for (let i = 0; i < rows.length; i += 33)
        writes.push(
          db
            .insert(fxRates)
            .values(
              rows
                .slice(i, i + 33)
                .map((r) => ({ currency: r.currency, rate: r.rate, updatedAt: at })),
            )
            .onConflictDoUpdate({
              target: fxRates.currency,
              set: { rate: sql`excluded.rate`, updatedAt: sql`excluded.updated_at` },
            }),
        );
      await db.batch(writes as unknown as Parameters<typeof db.batch>[0]);
      return rows.length;
    },

    async pricingFor(customerId) {
      const [sources, rules, contracts, customer] = await db.batch(chainReads(customerId));
      return chainOf(sources, rules, contracts, customer[0]);
    },

    async priceInputs(skus, currency, customerId, chain) {
      const runs = chunk([...new Set(skus)], SKUS_PER_QUERY);
      const productReads = runs.map((run) =>
        db.select().from(products).where(inArray(products.sku, run)),
      );
      const rate =
        currency === BASE_CURRENCY
          ? []
          : [db.select().from(fxRates).where(eq(fxRates.currency, currency))];
      const reads = chain ? chainReads(customerId) : [];
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
        chain: chain
          ? chainOf(
              c[0] as SourceRow[],
              c[1] as RuleRow[],
              c[2] as ContractRow[],
              (c[3] as { tier: string }[])[0],
            )
          : null,
      };
    },
  };
}
