/**
 * The back office port over D1. A page of every list is two round trips however many stores and
 * pricing sources there are: one batch counts every list (a store's stock and the rules grouped,
 * one statement each), so a page past the end can show the last, and a second reads each page.
 * The contract (`describeBackOfficeContract` in @commerceworker/test-kit) holds it to the
 * in-memory store.
 */
import type {
  BackOffice,
  BackOfficePage,
  BookList,
  Paged,
  PriceEntry,
} from '@commerceworker/ports/commerce';
import { and, eq, getTableColumns, or, type SQL, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { createDb } from './index';
import { contains } from './match';
import {
  companies,
  contractPrices,
  customers,
  fxRates,
  locationStock,
  locations,
  priceRules,
  priceSources,
  products,
  sellers,
} from './schema';

const n = sql<number>`count(*)`.mapWith(Number);

/** The last page a list has (1 when it is empty). */
const lastPage = (total: number, size: number) => Math.max(1, Math.ceil(total / size));

export function d1BackOffice(d1: D1Database): BackOffice {
  const d = createDb(d1);

  /**
   * A rule or contract price as a pricing source's entry. Every computed column has its own name:
   * D1's batch keys a row by column name, so two unnamed `null`s would overwrite each other and
   * shift every column after them.
   */
  const ruleEntry = {
    key: priceRules.id,
    name: priceRules.name,
    sku: priceRules.sku,
    productName: sql<string | null>`${products.name}`.as('product_name'),
    customerTier: priceRules.customerTier,
    customerName: sql<string | null>`coalesce(${customers.name}, ${priceRules.customerId})`.as(
      'customer_name',
    ),
    minQty: priceRules.minQty,
    price: priceRules.price,
    discountPct: priceRules.discountPct,
  };
  const contractEntry = {
    key: sql<string>`${contractPrices.customerId} || '-' || ${contractPrices.sku}`.as('key'),
    name: sql<string>`coalesce(${customers.name}, ${contractPrices.customerId})`.as('name'),
    sku: contractPrices.sku,
    productName: sql<string | null>`${products.name}`.as('product_name'),
    customerTier: sql<string | null>`null`.as('customer_tier'),
    customerName: sql<string | null>`null`.as('customer_name'),
    minQty: sql<number | null>`null`.as('min_qty'),
    price: contractPrices.price,
    discountPct: sql<number | null>`null`.as('discount_pct'),
  };

  return {
    async page(rawQ, asked, sizes, customerFilter) {
      // "#idz7qp" is how the app writes an order; a search for one shouldn't hide the rest.
      const q = rawQ.trim().replace(/^#/, '');
      const any = (...conds: SQL[]) => (q ? or(...conds) : undefined);
      const inventoryWhere = any(contains(products.name, q), contains(products.sku, q));
      const customerWhere = and(
        any(contains(customers.name, q), contains(customers.id, q)),
        customerFilter?.kind ? eq(customers.kind, customerFilter.kind) : undefined,
        customerFilter?.status ? eq(companies.status, customerFilter.status) : undefined,
      );
      const sellerWhere = any(
        contains(sellers.name, q),
        contains(sellers.email, q),
        contains(sellers.id, q),
      );
      const stockMatch = or(contains(locationStock.sku, q), contains(products.name, q));
      const ruleWhere = any(
        contains(priceRules.name, q),
        contains(priceRules.sku, q),
        contains(products.name, q),
        contains(customers.name, q),
      );
      const contractWhere = any(
        contains(contractPrices.sku, q),
        contains(products.name, q),
        contains(customers.name, q),
      );

      // Every count, and the stores and sources the rest hang off, in one round trip.
      const [inv, cust, sell, stores, sources, stockCounts, ruleCounts, contractCount] =
        await d.batch([
          d.select({ n }).from(products).where(inventoryWhere),
          d
            .select({ n })
            .from(customers)
            .leftJoin(companies, eq(companies.customerId, customers.id))
            .where(customerWhere),
          d.select({ n }).from(sellers).where(sellerWhere),
          d.select().from(locations).orderBy(locations.name),
          d.select().from(priceSources).orderBy(priceSources.priority),
          d
            .select({
              id: locationStock.locationId,
              all: sql<number>`count(*)`.mapWith(Number).as('all_items'),
              matching: (q ? sql<number>`coalesce(sum(${stockMatch}), 0)` : sql<number>`count(*)`)
                .mapWith(Number)
                .as('matching_items'),
            })
            .from(locationStock)
            .leftJoin(products, eq(products.sku, locationStock.sku))
            .groupBy(locationStock.locationId),
          d
            .select({ id: priceRules.sourceId, n })
            .from(priceRules)
            .leftJoin(products, eq(products.sku, priceRules.sku))
            .leftJoin(customers, eq(customers.id, priceRules.customerId))
            .where(ruleWhere)
            .groupBy(priceRules.sourceId),
          d
            .select({ n })
            .from(contractPrices)
            .leftJoin(customers, eq(customers.id, contractPrices.customerId))
            .leftJoin(products, eq(products.sku, contractPrices.sku))
            .where(contractWhere),
        ]);

      /** A list's page, clamped, and the query for its rows when it has any. */
      type Plan<T> = { paged: Omit<Paged<T>, 'rows'>; read: BatchItem<'sqlite'> | null };
      const plan = <T>(
        total: number,
        list: BookList,
        size: number,
        rows: (limit: number, offset: number) => BatchItem<'sqlite'>,
      ): Plan<T> => {
        const page = Math.min(asked(list), lastPage(total, size));
        return {
          paged: { total, page, size },
          read: total ? rows(size, (page - 1) * size) : null,
        };
      };

      const inventory = plan(inv[0]?.n ?? 0, { list: 'inventory' }, sizes.list, (limit, offset) =>
        d
          .select({
            ...getTableColumns(products),
            // What the stores hold, so an item out in the warehouse isn't read as out everywhere.
            // `products.sku` written out: unqualified, it would be the subquery's own column.
            inStores:
              sql<number>`(select coalesce(sum(ls.stock - ls.reserved), 0) from location_stock ls where ls.sku = products.sku)`.as(
                'in_stores',
              ),
          })
          .from(products)
          .where(inventoryWhere)
          .orderBy(products.sku)
          .limit(limit)
          .offset(offset),
      );
      const customerList = plan(
        cust[0]?.n ?? 0,
        { list: 'customers' },
        sizes.list,
        (limit, offset) =>
          d
            .select({ ...getTableColumns(customers), companyStatus: companies.status })
            .from(customers)
            .leftJoin(companies, eq(companies.customerId, customers.id))
            .where(customerWhere)
            .orderBy(customers.name, customers.id)
            .limit(limit)
            .offset(offset),
      );
      const sellerList = plan(sell[0]?.n ?? 0, { list: 'sellers' }, sizes.list, (limit, offset) =>
        d
          .select()
          .from(sellers)
          .where(sellerWhere)
          .orderBy(sellers.name, sellers.id)
          .limit(limit)
          .offset(offset),
      );
      const storeLists = stores.map((l) => {
        // A search for the store itself shows all it holds; otherwise only the matching items.
        const narrowed = !!q && !l.name.toLowerCase().includes(q.toLowerCase());
        const counted = stockCounts.find((c) => c.id === l.id);
        const total = (narrowed ? counted?.matching : counted?.all) ?? 0;
        return plan(total, { list: 'store', id: l.id }, sizes.group, (limit, offset) =>
          d
            .select({
              sku: locationStock.sku,
              name: products.name,
              stock: locationStock.stock,
              reserved: locationStock.reserved,
            })
            .from(locationStock)
            .leftJoin(products, eq(products.sku, locationStock.sku))
            .where(and(eq(locationStock.locationId, l.id), narrowed ? stockMatch : undefined))
            .orderBy(locationStock.sku)
            .limit(limit)
            .offset(offset),
        );
      });
      const sourceLists = sources.map((s) =>
        s.id === 'contract'
          ? plan(
              contractCount[0]?.n ?? 0,
              { list: 'prices', sourceId: s.id },
              sizes.group,
              (limit, offset) =>
                d
                  .select(contractEntry)
                  .from(contractPrices)
                  .leftJoin(customers, eq(customers.id, contractPrices.customerId))
                  .leftJoin(products, eq(products.sku, contractPrices.sku))
                  .where(contractWhere)
                  .orderBy(customers.name, contractPrices.sku)
                  .limit(limit)
                  .offset(offset),
            )
          : plan(
              ruleCounts.find((c) => c.id === s.id)?.n ?? 0,
              { list: 'prices', sourceId: s.id },
              sizes.group,
              (limit, offset) =>
                d
                  .select(ruleEntry)
                  .from(priceRules)
                  .leftJoin(products, eq(products.sku, priceRules.sku))
                  .leftJoin(customers, eq(customers.id, priceRules.customerId))
                  .where(and(eq(priceRules.sourceId, s.id), ruleWhere))
                  .orderBy(priceRules.sku, priceRules.minQty, priceRules.id)
                  .limit(limit)
                  .offset(offset),
            ),
      );

      // Every page's rows in a second round trip (none when every list is empty).
      const plans: Plan<unknown>[] = [
        inventory,
        customerList,
        sellerList,
        ...storeLists,
        ...sourceLists,
      ];
      const reads = plans.flatMap((p) => (p.read ? [p.read] : []));
      const results = reads.length
        ? ((await d.batch(reads as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])) as unknown[][])
        : [];
      let next = 0;
      const rowsOf = <T>(p: Plan<T>): Paged<T> => ({
        ...p.paged,
        rows: p.read ? (results[next++] as T[]) : [],
      });
      // Read back in the order the reads were queued.
      const inventoryPage = rowsOf(inventory) as BackOfficePage['inventory'];
      const customerPage = rowsOf(customerList) as BackOfficePage['customers'];
      const sellerPage = rowsOf(sellerList) as BackOfficePage['sellers'];
      const storePages = storeLists.map((p) => rowsOf(p) as Stock);
      const sourcePages = sourceLists.map((p) => rowsOf(p) as Paged<PriceEntry>);
      return {
        inventory: inventoryPage,
        customers: customerPage,
        sellers: sellerPage,
        stores: stores.map((l, i) => ({ ...l, stock: storePages[i]! })),
        sources: sources.map((s, i) => ({ ...s, entries: sourcePages[i]! })),
      };
    },

    async everything() {
      const [cust, prods, sources, rules, contracts, sellerRows, stores, stock] = await d.batch([
        d.select().from(customers).orderBy(customers.name),
        d.select().from(products).orderBy(products.sku),
        d.select().from(priceSources).orderBy(priceSources.priority),
        d.select().from(priceRules).orderBy(priceRules.sourceId, priceRules.sku, priceRules.minQty),
        d.select().from(contractPrices).orderBy(contractPrices.customerId, contractPrices.sku),
        d.select().from(sellers).orderBy(sellers.name),
        d.select().from(locations).orderBy(locations.name),
        d.select().from(locationStock).orderBy(locationStock.sku),
      ]);
      return {
        customers: cust,
        products: prods,
        sources,
        rules,
        contracts,
        sellers: sellerRows,
        stores: stores.map((l) => ({ ...l, stock: stock.filter((s) => s.locationId === l.id) })),
      };
    },

    async currencies() {
      const rows = await d.select().from(fxRates).orderBy(fxRates.currency);
      return rows.sort((a, b) => Number(b.rate === 1) - Number(a.rate === 1));
    },
  };
}

type Stock = BackOfficePage['stores'][number]['stock'];
