/**
 * The commerce fixtures as D1 rows, shared by the store contracts and the query-count snapshot.
 * Each seed replaces the rows it wrote before, so every case starts the same.
 */
import { env } from 'cloudflare:workers';
import type {
  FulfillmentFixture,
  InventoryFixture,
  MarketplaceFixture,
  PricingFixture,
} from '@commerceworker/test-kit/commerce';
import { inArray, like, or } from 'drizzle-orm';
import { createDb } from '../src/index';
import {
  contractPrices,
  customers,
  entitlements,
  fxRates,
  locationStock,
  locations,
  payouts,
  priceRules,
  priceSources,
  products,
  promotionRedemptions,
  promotions,
  reservations,
  sellerOrders,
  sellers,
  shipments,
  stockMovements,
} from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

/** Writes the fixture as rows, replacing any it wrote before, so each test starts the same. */
export async function seedPricing(f: PricingFixture) {
  const db = createDb(DB);
  const t = Date.parse('2026-10-01T00:00:00Z');
  const ids = <T>(xs: T[] | undefined, key: (x: T) => string) => (xs ?? []).map(key);
  await db.delete(promotionRedemptions).where(
    inArray(
      promotionRedemptions.promotionId,
      ids(f.promotions, (p) => p.id),
    ),
  );
  await db.delete(customers).where(
    inArray(
      customers.id,
      ids(f.customers, (c) => c.id),
    ),
  );
  await db.delete(products).where(
    inArray(
      products.sku,
      ids(f.products, (p) => p.sku),
    ),
  );
  // Every contract promotion, including those a case added.
  await db.delete(promotionRedemptions).where(like(promotionRedemptions.promotionId, 'pc_%'));
  await db.delete(promotions).where(
    or(
      like(promotions.id, 'pc_%'),
      inArray(
        promotions.id,
        ids(f.promotions, (p) => p.id),
      ),
    ),
  );
  await db.delete(priceRules).where(
    inArray(
      priceRules.id,
      ids(f.priceRules, (r) => r.id),
    ),
  );
  await db.delete(contractPrices).where(
    inArray(
      contractPrices.customerId,
      ids(f.contractPrices, (c) => c.customerId),
    ),
  );
  if (f.customers?.length) await db.insert(customers).values(f.customers);
  if (f.products?.length) await db.insert(products).values(f.products);
  // One row a statement: a promotion has 20 columns and D1 binds at most 100 parameters.
  for (const p of f.promotions ?? [])
    await db.insert(promotions).values({
      ...p,
      skus: p.skus ? JSON.stringify(p.skus) : null,
      condition: p.condition ? JSON.stringify(p.condition) : null,
      createdAt: t,
      updatedAt: t,
    });
  for (const r of f.fxRates ?? [])
    await db
      .insert(fxRates)
      .values({ ...r, updatedAt: t })
      .onConflictDoUpdate({ target: fxRates.currency, set: { rate: r.rate } });
  for (const s of f.priceSources ?? [])
    await db
      .insert(priceSources)
      .values({ ...s, active: s.active !== false })
      .onConflictDoUpdate({
        target: priceSources.id,
        set: {
          label: s.label,
          priority: s.priority,
          stopProcessing: s.stopProcessing,
          active: s.active !== false,
        },
      });
  if (f.priceRules?.length)
    await db
      .insert(priceRules)
      .values(f.priceRules.map(({ source, ...r }) => ({ ...r, sourceId: source, createdAt: t })));
  if (f.contractPrices?.length) await db.insert(contractPrices).values(f.contractPrices);
}

/** Resets the fixture's SKUs and shipments, so each contract case starts from the same stock. */
export async function seedInventory(f: InventoryFixture) {
  const db = createDb(DB);
  const skus = [...new Set([...(f.products ?? []), ...(f.locationStock ?? [])].map((p) => p.sku))];
  const orders = (f.shipments ?? []).map((s) => s.orderId);
  await db.delete(reservations).where(inArray(reservations.sku, skus));
  await db.delete(stockMovements).where(inArray(stockMovements.sku, skus));
  await db.delete(products).where(inArray(products.sku, skus));
  await db.delete(locationStock).where(inArray(locationStock.sku, skus));
  if (orders.length) await db.delete(shipments).where(inArray(shipments.orderId, orders));
  for (const p of f.products ?? [])
    await db.insert(products).values({
      sku: p.sku,
      name: p.sku,
      price: 1,
      cost: 1,
      stock: p.stock,
      reserved: p.reserved ?? 0,
      kind: p.kind ?? 'physical',
      reorderPoint: p.reorderPoint ?? 0,
    });
  for (const s of f.locationStock ?? [])
    await db.insert(locationStock).values({ ...s, reserved: s.reserved ?? 0 });
  for (const [i, s] of (f.shipments ?? []).entries())
    await db.insert(shipments).values({
      id: `shp_contract_${i}`,
      orderId: s.orderId,
      carrier: 'test',
      tracking: `T${i}`,
      status: s.status,
      createdAt: 0,
    });
}

/** Resets the fixture's stores and every contract order's rows, so each case starts the same. */
export async function seedFulfillment(f: FulfillmentFixture) {
  const db = createDb(DB);
  await db.delete(shipments).where(like(shipments.orderId, 'fc_%'));
  await db.delete(entitlements).where(like(entitlements.orderId, 'fc_%'));
  const ids = (f.locations ?? []).map((l) => l.id);
  if (ids.length) await db.delete(locations).where(inArray(locations.id, ids));
  if (f.locations?.length) await db.insert(locations).values(f.locations);
}

/** Resets the fixture's sellers and every contract order's parts and payouts. */
export async function seedMarketplace(f: MarketplaceFixture) {
  const db = createDb(DB);
  await db.delete(sellerOrders).where(like(sellerOrders.orderId, 'mc_%'));
  await db.delete(payouts).where(like(payouts.orderId, 'mc_%'));
  const ids = (f.sellers ?? []).map((s) => s.id);
  if (ids.length) await db.delete(sellers).where(inArray(sellers.id, ids));
  if (f.sellers?.length) await db.insert(sellers).values(f.sellers);
}
