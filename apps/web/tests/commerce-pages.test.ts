import { describe, expect, it, vi } from 'vitest';
import {
  GROUP_SIZE,
  LIST_SIZE,
  lastPage,
  pageHref,
  pageOf,
  shown,
  storeKey,
} from '../app/lib/commerce-pages';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/** A back office with 1,000 products, two stores of 50 items each and two pricing sources. */
const { InMemoryBackOffice } = await import('@commerceworker/test-kit/commerce');
const sku = (i: number) => `SKU-${String(i).padStart(4, '0')}`;
const product = (i: number) => ({
  sku: sku(i),
  name: `Item ${i}`,
  price: 1,
  cost: 1,
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
const office = new InMemoryBackOffice({
  products: Array.from({ length: 1000 }, (_, i) => product(i)),
  locations: [store('loc_a', 'A store'), store('loc_b', 'B store')],
  stock: ['loc_a', 'loc_b'].flatMap((locationId) =>
    Array.from({ length: 50 }, (_, i) => ({ locationId, sku: sku(i), stock: 1, reserved: 0 })),
  ),
  sources: [
    { id: 'contract', label: 'Contract prices', priority: 20, stopProcessing: true, active: true },
    { id: 'volume', label: 'Volume tiers', priority: 30, stopProcessing: false, active: true },
  ],
  rates: [{ currency: 'USD', rate: 1, updatedAt: 0 }],
});
vi.mock('~/lib/wire.server', () => ({ backOffice: () => office }));

const { commercePage } = await import('../app/lib/commerce.server');

describe('Commerce paging', () => {
  it('reads a page from the URL, and anything else as the first', () => {
    const p = new URLSearchParams('inventory=3&customers=0&sellers=x&store-loc_a=2.5');
    expect(pageOf(p, 'inventory')).toBe(3);
    expect(pageOf(p, 'customers')).toBe(1);
    expect(pageOf(p, 'sellers')).toBe(1);
    expect(pageOf(p, storeKey('loc_a'))).toBe(1);
    expect(pageOf(p, 'missing')).toBe(1);
  });

  it('links to another page of one list, keeping the search and the other lists', () => {
    const p = new URLSearchParams('q=widget&store-loc_a=2');
    expect(pageHref(p, 'inventory', 3, 'stock')).toBe('?q=widget&store-loc_a=2&inventory=3#stock');
    expect(pageHref(p, storeKey('loc_a'), 1, 'stores')).toBe('?q=widget#stores');
    expect(pageHref(new URLSearchParams(), 'inventory', 1, 'stock')).toBe('/commerce#stock');
  });

  it('says which rows a page shows, and how many pages there are', () => {
    expect(shown({ page: 1, size: 25, total: 2000 })).toEqual({ first: 1, last: 25 });
    expect(shown({ page: 80, size: 25, total: 2000 })).toEqual({ first: 1976, last: 2000 });
    expect(shown({ page: 2, size: 10, total: 13 })).toEqual({ first: 11, last: 13 });
    expect(lastPage(0, 25)).toBe(1);
    expect(lastPage(2000, 25)).toBe(80);
    expect(lastPage(2001, 25)).toBe(81);
  });

  it('reads each list at its own page from the URL, and a page past the end as the last', async () => {
    const page = await commercePage(new URLSearchParams('inventory=999&store-loc_b=4'));
    expect(page.inventory).toMatchObject({ total: 1000, page: 40, size: LIST_SIZE });
    expect(page.inventory.rows).toHaveLength(LIST_SIZE);
    expect(page.stores.map((s) => s.stock.page)).toEqual([1, 4]);
    expect(page.stores[1]!.stock.rows[0]?.sku).toBe(sku(30));
    expect(page.pricing.sources.map((s) => s.entries.size)).toEqual([GROUP_SIZE, GROUP_SIZE]);
    expect(page.pricing.rates.map((r) => r.currency)).toEqual(['USD']);
  });

  it('searches every list, dropping the # an order reference starts with', async () => {
    const page = await commercePage(new URLSearchParams('q=%23item 999'));
    expect(page.q).toBe('item 999');
    expect(page.inventory.rows.map((r) => r.sku)).toEqual([sku(999)]);
  });
});
