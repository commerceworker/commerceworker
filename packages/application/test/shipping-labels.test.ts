import type { Order } from '@commerceworker/core';
import type { ProductRecord } from '@commerceworker/ports/commerce';
import { FixedClock } from '@commerceworker/test-kit';
import {
  FakeLabelService,
  InMemoryInventoryStore,
  InMemoryPricingStore,
  InMemoryShippingStore,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  bookReturnLabel,
  bookShipment,
  MissingLabelError,
  retryLabelVoids,
  voidOpenLabels,
  voidShipmentLabels,
} from '../src/commerce';

const product = (sku: string, kind = 'physical'): ProductRecord => ({
  sku,
  name: sku,
  price: 10,
  cost: 5,
  stock: 10,
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

const order = (lines: Order['lines'], id = 'o1') => ({ id, lines }) as unknown as Order;
const by = { id: 'carrier', nodeId: 'ship', config: {} };

function ports(labels = new FakeLabelService()) {
  return {
    pricing: new InMemoryPricingStore(
      { products: [product('TEE'), product('MUG'), product('EBOOK', 'digital')] },
      new FixedClock(),
    ),
    inventory: new InMemoryInventoryStore({
      products: [
        { sku: 'TEE', stock: 10 },
        { sku: 'MUG', stock: 10 },
      ],
      locationStock: [{ locationId: 'bk', sku: 'MUG', stock: 5 }],
    }),
    shipping: new InMemoryShippingStore(),
    labels,
  };
}

describe('booking shipments', () => {
  it('books one built-in shipment per place lines ship from, then consumes the stock', async () => {
    const p = ports();
    const o = order([
      { sku: 'TEE', qty: 1 },
      { sku: 'MUG', qty: 2, locationId: 'bk' },
      { sku: 'EBOOK', qty: 1 },
    ]);
    await p.inventory.reserve(o, 'reserve#1');
    const r = await bookShipment(p, o, 'ship#1', 'ups');
    expect(r.shipments.map((s) => [s.shipmentId, s.locationId])).toEqual([
      ['shp_o1_ship_1', null],
      ['shp_o1_ship_1_2', 'bk'],
    ]);
    expect(r.tracking).toMatch(/^UPS\d{10}$/);
    expect((await p.inventory.levels(['TEE'])).get('TEE')).toEqual({ stock: 9, reserved: 0 });
    // A retry books the same and nothing more.
    expect(await bookShipment(p, o, 'ship#1', 'ups')).toEqual(r);
    expect(await p.shipping.booked('o1')).toHaveLength(2);
  });

  it("records a provider's labels, and fails for good when one is missing, voiding the rest", async () => {
    const labels = new FakeLabelService();
    const p = ports(labels);
    const r = await bookShipment(p, order([{ sku: 'TEE', qty: 1 }]), 'ship#1', 'ups', by);
    expect(r).toMatchObject({ provider: 'carrier', carrier: 'fake', tracking: 'TRK1' });
    expect((await p.shipping.booked('o1'))[0]).toMatchObject({
      provider: 'carrier',
      externalId: 'lbl_1',
    });

    const stingy = new FakeLabelService(() => [{ ref: 'unasked', id: 'lbl_x', tracking: 'TX' }]);
    const q = ports(stingy);
    await expect(
      bookShipment(q, order([{ sku: 'TEE', qty: 1 }], 'o2'), 'ship#1', 'ups', by),
    ).rejects.toBeInstanceOf(MissingLabelError);
    expect(stingy.voided).toEqual([{ providerId: 'carrier', stepKey: 'ship#1', ids: ['lbl_x'] }]);
    expect((await q.shipping.booked('o2')).map((s) => s.status)).toEqual(['cancelled']);
  });

  it('books a return label, built in or from the provider', async () => {
    const p = ports();
    const r = await bookReturnLabel(p, order([{ sku: 'TEE', qty: 1 }]), 'rma#1', 'ups');
    expect(r.tracking).toMatch(/^UPSR\d{9}$/);
    const withProvider = await bookReturnLabel(
      p,
      order([{ sku: 'TEE', qty: 1 }], 'o3'),
      'rma#1',
      'ups',
      by,
    );
    expect(withProvider).toMatchObject({ rmaId: 'rma_o3_rma_1', provider: 'carrier' });
  });
});

describe('voiding labels', () => {
  it('voids on a rollback, keeping those the provider refuses for the daily retry', async () => {
    const labels = new FakeLabelService();
    const p = ports(labels);
    const r = await bookShipment(p, order([{ sku: 'TEE', qty: 1 }]), 'ship#1', 'ups', by);
    labels.failVoids = true;
    const ids = r.shipments.map((s) => s.shipmentId);
    expect(await voidShipmentLabels(p, 'o1', 'ship#1', ids)).toEqual({
      voided: 0,
      failed: 1,
      kept: new Set(ids),
    });
    expect(await retryLabelVoids(p)).toEqual({ tried: 1, voided: 0 });
    labels.failVoids = false;
    expect(await retryLabelVoids(p)).toEqual({ tried: 1, voided: 1 });
    expect(await retryLabelVoids(p)).toEqual({ tried: 0, voided: 0 });
  });

  it("voids an order's open labels on a cancel", async () => {
    const labels = new FakeLabelService();
    const p = ports(labels);
    await bookShipment(p, order([{ sku: 'TEE', qty: 1 }]), 'ship#1', 'ups', by);
    await bookReturnLabel(p, order([{ sku: 'TEE', qty: 1 }]), 'rma#1', 'ups', by);
    expect(await voidOpenLabels(p, 'o1')).toEqual({ voided: 2, failed: 0 });
    expect(labels.voided.map((v) => v.stepKey)).toEqual(['cancel']);
    expect(await voidOpenLabels(p, 'o1')).toEqual({ voided: 0, failed: 0 });
  });
});
