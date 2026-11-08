/**
 * The back office port in memory, over seeded rows shaped like the D1 tables. The contract in
 * ./back-office-contract.ts holds it to the same behaviour as the D1 store.
 */
import type {
  BackOffice,
  BackOfficePage,
  BookList,
  ContractPriceRow,
  CustomerRecord,
  FxRateRow,
  LocationStockRow,
  Paged,
  PriceEntry,
  PriceRuleRow,
  PriceSourceRow,
  ProductRecord,
  SellerRecord,
  StoreLocation,
} from '@commerceworker/ports/commerce';

export interface BackOfficeFixture {
  products?: ProductRecord[];
  customers?: CustomerRecord[];
  sellers?: SellerRecord[];
  locations?: StoreLocation[];
  stock?: LocationStockRow[];
  sources?: PriceSourceRow[];
  rules?: PriceRuleRow[];
  contracts?: ContractPriceRow[];
  rates?: FxRateRow[];
}

/** SQLite's text order (by code unit), nulls first, as `order by` reads it. */
const cmp = (a: string | number | null, b: string | number | null) =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
const by =
  <T>(...keys: ((x: T) => string | number | null)[]) =>
  (a: T, b: T) => {
    for (const k of keys) {
      const c = cmp(k(a), k(b));
      if (c) return c;
    }
    return 0;
  };

/** SQLite's LIKE: case-insensitive for ASCII. */
const has = (text: string | null | undefined, q: string) =>
  (text ?? '').toLowerCase().includes(q.toLowerCase());

const lastPage = (total: number, size: number) => Math.max(1, Math.ceil(total / size));

export class InMemoryBackOffice implements BackOffice {
  constructor(private readonly f: BackOfficeFixture = {}) {}

  async page(
    rawQ: string,
    asked: (list: BookList) => number,
    sizes: { list: number; group: number },
  ): Promise<BackOfficePage> {
    const q = rawQ.trim().replace(/^#/, '');
    const matches = (...texts: (string | null | undefined)[]) => !q || texts.some((t) => has(t, q));
    const paged = <T>(all: T[], list: BookList, size: number): Paged<T> => {
      const page = Math.min(asked(list), lastPage(all.length, size));
      return {
        rows: all.slice((page - 1) * size, page * size),
        total: all.length,
        page,
        size,
      };
    };
    const product = (sku: string | null) => this.f.products?.find((p) => p.sku === sku);
    const customer = (id: string | null) => this.f.customers?.find((c) => c.id === id);
    const stock = this.f.stock ?? [];

    const inventory = (this.f.products ?? [])
      .filter((p) => matches(p.name, p.sku))
      .sort(by((p) => p.sku))
      .map((p) => ({
        ...p,
        inStores: stock
          .filter((s) => s.sku === p.sku)
          .reduce((n, s) => n + s.stock - s.reserved, 0),
      }));
    const customers = (this.f.customers ?? [])
      .filter((c) => matches(c.name, c.id))
      .sort(
        by(
          (c) => c.name,
          (c) => c.id,
        ),
      );
    const sellers = (this.f.sellers ?? [])
      .filter((s) => matches(s.name, s.email, s.id))
      .sort(
        by(
          (s) => s.name,
          (s) => s.id,
        ),
      );
    const stores = [...(this.f.locations ?? [])].sort(by((l) => l.name));
    const sources = [...(this.f.sources ?? [])].sort(by((s) => s.priority));

    const entries = (sourceId: string): PriceEntry[] =>
      sourceId === 'contract'
        ? (this.f.contracts ?? [])
            .filter((c) => matches(c.sku, product(c.sku)?.name, customer(c.customerId)?.name))
            .map((c) => ({
              key: `${c.customerId}-${c.sku}`,
              name: customer(c.customerId)?.name ?? c.customerId,
              sku: c.sku,
              productName: product(c.sku)?.name ?? null,
              customerTier: null,
              customerName: null,
              minQty: null,
              price: c.price,
              discountPct: null,
              order: customer(c.customerId)?.name ?? null,
            }))
            .sort(
              by(
                (e) => e.order,
                (e) => e.sku,
              ),
            )
            .map(({ order: _o, ...e }) => e)
        : (this.f.rules ?? [])
            .filter(
              (r) =>
                r.sourceId === sourceId &&
                matches(r.name, r.sku, product(r.sku)?.name, customer(r.customerId)?.name),
            )
            .sort(
              by(
                (r) => r.sku,
                (r) => r.minQty,
                (r) => r.id,
              ),
            )
            .map((r) => ({
              key: r.id,
              name: r.name,
              sku: r.sku,
              productName: product(r.sku)?.name ?? null,
              customerTier: r.customerTier,
              customerName: r.customerId ? (customer(r.customerId)?.name ?? r.customerId) : null,
              minQty: r.minQty,
              price: r.price,
              discountPct: r.discountPct,
            }));

    return {
      inventory: paged(inventory, { list: 'inventory' }, sizes.list),
      customers: paged(customers, { list: 'customers' }, sizes.list),
      sellers: paged(sellers, { list: 'sellers' }, sizes.list),
      stores: stores.map((l) => {
        // A search for the store itself shows all it holds; otherwise only the matching items.
        const narrowed = !!q && !l.name.toLowerCase().includes(q.toLowerCase());
        const held = stock
          .filter((s) => s.locationId === l.id)
          .filter((s) => !narrowed || matches(s.sku, product(s.sku)?.name))
          .sort(by((s) => s.sku))
          .map((s) => ({
            sku: s.sku,
            name: product(s.sku)?.name ?? null,
            stock: s.stock,
            reserved: s.reserved,
          }));
        return { ...l, stock: paged(held, { list: 'store', id: l.id }, sizes.group) };
      }),
      sources: sources.map((s) => ({
        ...s,
        entries: paged(entries(s.id), { list: 'prices', sourceId: s.id }, sizes.group),
      })),
    };
  }

  async everything() {
    const stock = [...(this.f.stock ?? [])].sort(by((s) => s.sku));
    return {
      customers: [...(this.f.customers ?? [])].sort(by((c) => c.name)),
      products: [...(this.f.products ?? [])].sort(by((p) => p.sku)),
      sources: [...(this.f.sources ?? [])].sort(by((s) => s.priority)),
      rules: [...(this.f.rules ?? [])].sort(
        by(
          (r) => r.sourceId,
          (r) => r.sku,
          (r) => r.minQty,
        ),
      ),
      contracts: [...(this.f.contracts ?? [])].sort(
        by(
          (c) => c.customerId,
          (c) => c.sku,
        ),
      ),
      sellers: [...(this.f.sellers ?? [])].sort(by((s) => s.name)),
      stores: [...(this.f.locations ?? [])]
        .sort(by((l) => l.name))
        .map((l) => ({ ...l, stock: stock.filter((s) => s.locationId === l.id) })),
    };
  }

  async currencies() {
    return [...(this.f.rates ?? [])]
      .sort(by((r) => r.currency))
      .sort((a, b) => Number(b.rate === 1) - Number(a.rate === 1));
  }
}
