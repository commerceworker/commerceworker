/**
 * The behaviour every `BackOffice` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). `make` seeds a fresh store holding only the fixture's rows. Ids start
 * `bo_`.
 */
import type {
  BackOffice,
  BookList,
  CustomerRecord,
  PriceRuleRow,
  ProductRecord,
} from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { BackOfficeFixture } from './back-office';

const product = (sku: string, name = `Product ${sku}`): ProductRecord => ({
  sku,
  name,
  price: 10,
  cost: 5,
  stock: 0,
  reserved: 0,
  reorderPoint: 0,
  reorderQty: 0,
  supplier: '',
  sellerId: null,
  kind: 'physical',
  catalogAt: null,
  weightKg: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
});

const customer = (id: string, name: string): CustomerRecord => ({
  id,
  name,
  email: `${id}@example.com`,
  kind: 'business',
  tier: 'standard',
  creditLimit: 0,
  balance: 0,
  terms: 'net_30',
  stripeCustomerId: null,
  stripePaymentMethodId: null,
});

const store = (id: string, name: string) => ({
  id,
  name,
  kind: 'store',
  postalCode: '',
  pickup: true,
  ships: false,
  latitude: null,
  longitude: null,
});

const rule = (id: string, over: Partial<PriceRuleRow> = {}): PriceRuleRow => ({
  id,
  sourceId: 'bo_volume',
  name: `Rule ${id}`,
  sku: null,
  customerId: null,
  customerTier: null,
  minQty: null,
  price: null,
  discountPct: null,
  startsAt: null,
  endsAt: null,
  createdAt: 1,
  ...over,
});

const SIZES = { list: 3, group: 2 };
const first = () => 1;
const skus = (rows: { sku: string | null }[]) => rows.map((r) => r.sku);

/** A catalog of seven products, two stores, two customers and two pricing sources. */
const CATALOG: BackOfficeFixture = {
  products: [
    ...['BO-G', 'BO-A', 'BO-C', 'BO-E', 'BO-B', 'BO-D'].map((s) => product(s)),
    product('BO-W', 'Walnut desk'),
  ],
  customers: [customer('bo_z', 'Zephyr'), customer('bo_a', 'Acme')],
  sellers: [
    {
      id: 'bo_s1',
      name: 'Oak & Co',
      email: 'hello@oak.example',
      commissionPct: 0.1,
      autoAccept: false,
      active: true,
    },
  ],
  locations: [store('bo_l2', 'Uptown'), store('bo_l1', 'Downtown')],
  stock: [
    { locationId: 'bo_l1', sku: 'BO-W', stock: 5, reserved: 1 },
    { locationId: 'bo_l1', sku: 'BO-A', stock: 2, reserved: 0 },
    { locationId: 'bo_l1', sku: 'BO-B', stock: 1, reserved: 0 },
    { locationId: 'bo_l2', sku: 'BO-W', stock: 3, reserved: 3 },
  ],
  sources: [
    { id: 'bo_volume', label: 'Volume', priority: 30, stopProcessing: false, active: true },
    { id: 'contract', label: 'Contracts', priority: 20, stopProcessing: true, active: true },
  ],
  rules: [
    rule('bo_r3', { sku: 'BO-W', minQty: 10, discountPct: 5 }),
    rule('bo_r2', { sku: 'BO-W', minQty: 5, customerId: 'bo_gone' }),
    rule('bo_r1', { name: 'Gold tier', customerTier: 'gold' }),
  ],
  contracts: [
    { customerId: 'bo_z', sku: 'BO-A', price: 7 },
    { customerId: 'bo_a', sku: 'BO-W', price: 300 },
  ],
  rates: [
    { currency: 'EUR', rate: 0.92, updatedAt: 1 },
    { currency: 'USD', rate: 1, updatedAt: 1 },
    { currency: 'CAD', rate: 1.36, updatedAt: 1 },
  ],
};

export function describeBackOfficeContract(
  name: string,
  make: (fixture: BackOfficeFixture) => Promise<BackOffice>,
) {
  describe(`${name}: the back office contract`, () => {
    it('pages each list in its order, and shows the last page for one past the end', async () => {
      const s = await make(CATALOG);
      const one = await s.page('', first, SIZES);
      expect(skus(one.inventory.rows)).toEqual(['BO-A', 'BO-B', 'BO-C']);
      expect(one.inventory).toMatchObject({ total: 7, page: 1, size: 3 });
      const asked = (l: BookList) => (l.list === 'inventory' ? 99 : 1);
      const last = await s.page('', asked, SIZES);
      expect(last.inventory).toMatchObject({ total: 7, page: 3 });
      expect(skus(last.inventory.rows)).toEqual(['BO-W']);
      expect(one.customers.rows.map((c) => c.name)).toEqual(['Acme', 'Zephyr']);
      expect(one.stores.map((l) => l.name)).toEqual(['Downtown', 'Uptown']);
      expect(one.sources.map((x) => x.id)).toEqual(['contract', 'bo_volume']);
    });

    it("counts what the stores hold of each product, less what's reserved", async () => {
      const s = await make(CATALOG);
      const page = await s.page('walnut', first, SIZES);
      expect(page.inventory.rows).toMatchObject([{ sku: 'BO-W', inStores: 4 }]);
    });

    it('narrows every list by a search, case-insensitive and literal, without a leading #', async () => {
      const s = await make(CATALOG);
      const page = await s.page('  #WALNUT ', first, SIZES);
      expect(skus(page.inventory.rows)).toEqual(['BO-W']);
      expect(page.customers.total).toBe(0);
      expect(page.customers).toMatchObject({ rows: [], page: 1 });
      // A store holding it shows just that; a contract and rules on it show.
      expect(page.stores.map((l) => skus(l.stock.rows))).toEqual([['BO-W'], ['BO-W']]);
      const [contracts, volume] = page.sources;
      expect(contracts!.entries.rows.map((e) => e.key)).toEqual(['bo_a-BO-W']);
      expect(volume!.entries.rows.map((e) => e.key)).toEqual(['bo_r2', 'bo_r3']);
      expect((await s.page('oak.example', first, SIZES)).sellers.total).toBe(1);
      expect((await s.page('bo_', first, SIZES)).customers.total).toBe(2);
      expect((await s.page('bo%', first, SIZES)).customers.total).toBe(0);
    });

    it('shows all a store holds when the search names the store', async () => {
      const s = await make(CATALOG);
      const page = await s.page('downtown', first, SIZES);
      const downtown = page.stores.find((l) => l.id === 'bo_l1')!;
      expect(downtown.stock).toMatchObject({ total: 3, page: 1, size: 2 });
      expect(skus(downtown.stock.rows)).toEqual(['BO-A', 'BO-B']);
      expect(page.stores.find((l) => l.id === 'bo_l2')!.stock.total).toBe(0);
      const later = await s.page(
        'downtown',
        (l) => (l.list === 'store' && l.id === 'bo_l1' ? 2 : 1),
        SIZES,
      );
      expect(later.stores.find((l) => l.id === 'bo_l1')!.stock.rows).toEqual([
        { sku: 'BO-W', name: 'Walnut desk', stock: 5, reserved: 1 },
      ]);
    });

    it("lists contract prices by customer and a source's rules by SKU and quantity", async () => {
      const s = await make(CATALOG);
      const page = await s.page('', first, { list: 3, group: 5 });
      const [contracts, volume] = page.sources;
      expect(contracts!.entries.rows).toEqual([
        {
          key: 'bo_a-BO-W',
          name: 'Acme',
          sku: 'BO-W',
          productName: 'Walnut desk',
          customerTier: null,
          customerName: null,
          minQty: null,
          price: 300,
          discountPct: null,
        },
        expect.objectContaining({ key: 'bo_z-BO-A', name: 'Zephyr', productName: 'Product BO-A' }),
      ]);
      // A rule for every SKU first; a customer no longer on file shows by id.
      expect(volume!.entries.rows.map((e) => [e.key, e.customerName])).toEqual([
        ['bo_r1', null],
        ['bo_r2', 'bo_gone'],
        ['bo_r3', null],
      ]);
      expect(volume!.entries.rows[0]).toMatchObject({ sku: null, customerTier: 'gold' });
      expect(volume!.entries.rows[2]).toMatchObject({ minQty: 10, discountPct: 5 });
      const paged = await s.page(
        '',
        (l) => (l.list === 'prices' && l.sourceId === 'bo_volume' ? 2 : 1),
        SIZES,
      );
      expect(paged.sources[1]!.entries).toMatchObject({ total: 3, page: 2 });
      expect(paged.sources[1]!.entries.rows.map((e) => e.key)).toEqual(['bo_r3']);
    });

    it('reads empty lists as one empty page', async () => {
      const s = await make({});
      const page = await s.page('anything', first, SIZES);
      expect(page.inventory).toEqual({ rows: [], total: 0, page: 1, size: 3 });
      expect(page.stores).toEqual([]);
      expect(page.sources).toEqual([]);
    });

    it('reads everything for the pickers, each list in its order', async () => {
      const s = await make(CATALOG);
      const all = await s.everything();
      expect(all.customers.map((c) => c.name)).toEqual(['Acme', 'Zephyr']);
      expect(skus(all.products)).toEqual(['BO-A', 'BO-B', 'BO-C', 'BO-D', 'BO-E', 'BO-G', 'BO-W']);
      expect(all.sources.map((x) => x.id)).toEqual(['contract', 'bo_volume']);
      expect(all.rules.map((r) => r.id)).toEqual(['bo_r1', 'bo_r2', 'bo_r3']);
      expect(all.contracts.map((c) => c.customerId)).toEqual(['bo_a', 'bo_z']);
      expect(all.sellers.map((x) => x.id)).toEqual(['bo_s1']);
      expect(all.stores.map((l) => [l.id, skus(l.stock)])).toEqual([
        ['bo_l1', ['BO-A', 'BO-B', 'BO-W']],
        ['bo_l2', ['BO-W']],
      ]);
      expect(all.sellers[0]).toMatchObject({ autoAccept: false, active: true });
      expect(all.stores[0]).toMatchObject({ pickup: true, ships: false });
    });

    it('lists currencies with the base first, then by code', async () => {
      const s = await make(CATALOG);
      expect((await s.currencies()).map((r) => r.currency)).toEqual(['USD', 'CAD', 'EUR']);
    });
  });
}
