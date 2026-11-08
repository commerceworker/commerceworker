import type { ProductRecord, StoreLocation } from '@commerceworker/ports/commerce';
import { FixedClock } from '@commerceworker/test-kit';
import {
  InMemoryFulfillmentStore,
  InMemoryInventoryStore,
  InMemoryPricingStore,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { routeFulfillment } from '../src/commerce';

const product = (sku: string, kind = 'physical'): ProductRecord => ({
  sku,
  name: sku,
  price: 10,
  cost: 5,
  stock: 0,
  reserved: 0,
  reorderPoint: 0,
  reorderQty: 0,
  supplier: '',
  sellerId: null,
  kind,
  catalogAt: null,
  weightKg: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
});
const site = (over: Partial<StoreLocation> & { id: string; name: string }): StoreLocation => ({
  kind: 'store',
  postalCode: '',
  pickup: true,
  ships: true,
  latitude: null,
  longitude: null,
  ...over,
});

/** Central: 1 TEE, 5 MUG. Brooklyn ships 3 TEE. Queens ships 2 TEE, 1 MUG. Soho: pickup only, 1 TEE. */
function ports() {
  return {
    pricing: new InMemoryPricingStore(
      { products: [product('TEE'), product('MUG'), product('EBOOK', 'digital')] },
      new FixedClock(),
    ),
    inventory: new InMemoryInventoryStore({
      products: [
        { sku: 'TEE', stock: 1 },
        { sku: 'MUG', stock: 5 },
        { sku: 'EBOOK', stock: 0, kind: 'digital' },
      ],
      locationStock: [
        { locationId: 'bk', sku: 'TEE', stock: 3 },
        { locationId: 'qn', sku: 'TEE', stock: 2 },
        { locationId: 'qn', sku: 'MUG', stock: 1 },
        { locationId: 'soho', sku: 'TEE', stock: 1 },
      ],
    }),
    fulfillment: new InMemoryFulfillmentStore({
      locations: [
        site({ id: 'bk', name: 'Brooklyn' }),
        site({ id: 'qn', name: 'Queens' }),
        site({ id: 'soho', name: 'Soho', ships: false }),
        site({ id: 'outlet', name: 'Outlet', ships: false, pickup: false }),
      ],
    }),
  };
}
const order = (lines: { sku: string; qty: number }[], locationId?: string) => ({
  lines,
  fulfillment: locationId ? ({ locationId } as never) : undefined,
});

describe('routing fulfillment', () => {
  it('ships from central stock when it covers every line', async () => {
    const r = await routeFulfillment(ports(), order([{ sku: 'MUG', qty: 2 }]), 'ship');
    expect(r).toMatchObject({ branches: ['ship'], method: 'ship' });
    expect(r.locationId).toBeUndefined();
  });

  it('ships from one store that has everything when central stock is short', async () => {
    const r = await routeFulfillment(ports(), order([{ sku: 'TEE', qty: 3 }]), 'ship');
    expect(r).toMatchObject({ branches: ['ship'], locationId: 'bk', locationName: 'Brooklyn' });
  });

  it('splits the shipment when no single source has everything', async () => {
    const r = await routeFulfillment(
      ports(),
      order([
        { sku: 'TEE', qty: 3 },
        { sku: 'MUG', qty: 5 },
      ]),
      'ship',
    );
    expect(r.branches).toEqual(['ship']);
    expect(r.sources?.map((s) => [s.locationId, s.lines])).toEqual(
      expect.arrayContaining([
        [null, [1]],
        ['bk', [0]],
      ]),
    );
  });

  it('is unavailable when nothing can ship a line', async () => {
    const r = await routeFulfillment(ports(), order([{ sku: 'TEE', qty: 9 }]), 'ship');
    expect(r).toMatchObject({
      branches: ['unavailable'],
      reason: 'No warehouse or store has enough TEE',
    });
  });

  it("picks up at the order's store when it has every line", async () => {
    const r = await routeFulfillment(ports(), order([{ sku: 'TEE', qty: 1 }], 'soho'), 'pickup');
    expect(r).toMatchObject({ branches: ['pickup'], locationId: 'soho', locationName: 'Soho' });
  });

  it("refuses pickup at a store that doesn't offer it, or that is missing a line", async () => {
    expect(
      await routeFulfillment(ports(), order([{ sku: 'TEE', qty: 1 }], 'outlet'), 'pickup'),
    ).toMatchObject({
      branches: ['unavailable'],
      reason: 'Outlet does not offer pickup',
    });
    expect(
      await routeFulfillment(ports(), order([{ sku: 'TEE', qty: 2 }], 'soho'), 'carry_out'),
    ).toMatchObject({
      branches: ['unavailable'],
      reason: 'Soho does not have every item',
    });
    expect(
      await routeFulfillment(ports(), order([{ sku: 'TEE', qty: 1 }]), 'pickup'),
    ).toMatchObject({
      reason: 'No store given for the order',
    });
  });

  it('adds the digital branch beside the physical one, and routes digital-only orders to it alone', async () => {
    const both = await routeFulfillment(
      ports(),
      order([
        { sku: 'MUG', qty: 1 },
        { sku: 'EBOOK', qty: 1 },
      ]),
      'ship',
    );
    expect(both.branches).toEqual(['ship', 'digital']);
    expect(await routeFulfillment(ports(), order([{ sku: 'EBOOK', qty: 1 }]), 'ship')).toEqual({
      branches: ['digital'],
      method: null,
    });
  });
});
