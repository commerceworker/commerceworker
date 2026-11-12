/**
 * The behaviour every `InventoryStore` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Each case seeds its own fresh store from the fixture; SKUs are
 * distinctive so a backend holding other rows can't satisfy an assertion by accident.
 */
import type { OrderLine } from '@commerceworker/core';
import type { InventoryStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { InventoryFixture } from './inventory-store';

export const INVENTORY_FIXTURE: InventoryFixture = {
  products: [
    { sku: 'IC-TEE', stock: 20 },
    { sku: 'IC-LAST', stock: 3 },
    { sku: 'IC-PART', stock: 5 },
    { sku: 'IC-ONE', stock: 1, reorderPoint: 2 },
    { sku: 'IC-EBOOK', stock: 0, kind: 'digital' },
  ],
  locationStock: [{ locationId: 'ic_store_soho', sku: 'IC-TEE', stock: 4 }],
  shipments: [{ orderId: 'ic_live_ship', status: 'label_created' }],
};

const order = (id: string, lines: OrderLine[], locationId?: string) => ({
  id,
  lines,
  fulfillment: locationId ? ({ locationId } as never) : undefined,
});

export function describeInventoryStoreContract(
  name: string,
  make: (fixture: InventoryFixture) => Promise<InventoryStore>,
) {
  describe(`${name}: the inventory store contract`, () => {
    const fresh = () => make(INVENTORY_FIXTURE);
    const level = async (s: InventoryStore, sku: string, loc?: string) =>
      (await s.levels([sku], loc)).get(sku);

    it('reads stock levels centrally and at a store, and nothing for an unknown SKU', async () => {
      const s = await fresh();
      expect(await level(s, 'IC-TEE')).toEqual({ stock: 20, reserved: 0 });
      expect(await level(s, 'IC-TEE', 'ic_store_soho')).toEqual({ stock: 4, reserved: 0 });
      expect(await level(s, 'IC-NONE')).toBeUndefined();
    });

    it('says a SKU is in stock while free stock remains, never a count, and nothing for an unknown SKU', async () => {
      const s = await fresh();
      const skus = ['IC-TEE', 'IC-LAST', 'IC-EBOOK', 'IC-NONE'];
      expect(Object.fromEntries(await s.availability(skus))).toEqual({
        'IC-TEE': 'in_stock',
        'IC-LAST': 'in_stock',
        'IC-EBOOK': 'in_stock',
      });
      // Holding all of it leaves none free; a digital good holds none and stays deliverable.
      await s.reserve(order('ic_avail', [{ sku: 'IC-LAST', qty: 3 }]), 'reserve#1');
      expect((await s.availability(['IC-LAST', 'IC-TEE'])).get('IC-LAST')).toBe('out_of_stock');
      await s.release('ic_avail');
      expect((await s.availability(['IC-LAST'])).get('IC-LAST')).toBe('in_stock');
    });

    it('reads availability in runs under the bound-parameter limit', async () => {
      const s = await fresh();
      const many = Array.from({ length: 250 }, (_, i) => `IC-X${i}`);
      const got = await s.availability([...many, 'IC-TEE']);
      expect([...got.keys()]).toEqual(['IC-TEE']);
    });

    it('holds per order and line, once per step, and a later step keeps the first hold', async () => {
      const s = await fresh();
      const two = [
        { sku: 'IC-TEE', qty: 2 },
        { sku: 'IC-TEE', qty: 3 },
      ];
      const a = await s.reserve(order('ic_a', two), 'reserve#1');
      await s.reserve(order('ic_b', two), 'reserve#1');
      expect(a).toMatchObject({ short: [] });
      expect(a.reservationIds).toHaveLength(2);
      expect((await level(s, 'IC-TEE'))?.reserved).toBe(10);
      // A retried step holds nothing more; a later run keeps the first step's hold.
      expect(await s.reserve(order('ic_a', two), 'reserve#1')).toEqual(a);
      const later = await s.reserve(order('ic_a', two), 'reserve#2');
      expect(later.reservationIds.sort()).toEqual([...a.reservationIds].sort());
      expect((await level(s, 'IC-TEE'))?.reserved).toBe(10);
    });

    it('holds the last units for one of two orders', async () => {
      const s = await fresh();
      const lines = [{ sku: 'IC-LAST', qty: 3 }];
      const [a, b] = await Promise.all([
        s.reserve(order('ic_race_a', lines), 'reserve#1'),
        s.reserve(order('ic_race_b', lines), 'reserve#1'),
      ]);
      expect([a.short, b.short].sort()).toEqual([[], ['IC-LAST']]);
      expect(a.reservationIds.length + b.reservationIds.length).toBe(1);
      expect((await level(s, 'IC-LAST'))?.reserved).toBe(3);
    });

    it('tries every line in turn: a line short of what earlier lines left, a later one that fits', async () => {
      const s = await fresh();
      const r = await s.reserve(
        order('ic_part', [
          { sku: 'IC-PART', qty: 3 },
          { sku: 'IC-PART', qty: 3 },
          { sku: 'IC-PART', qty: 2 },
          { sku: 'IC-ONE', qty: 1 },
        ]),
        'reserve#1',
      );
      expect(r.short).toEqual(['IC-PART']);
      expect(r.reservationIds).toHaveLength(3);
      expect((await level(s, 'IC-PART'))?.reserved).toBe(5);
      expect((await level(s, 'IC-ONE'))?.reserved).toBe(1);
    });

    it('holds nothing for digital goods', async () => {
      const s = await fresh();
      const r = await s.reserve(order('ic_digital', [{ sku: 'IC-EBOOK', qty: 1 }]), 'reserve#1');
      expect(r).toEqual({ reservationIds: [], short: [] });
    });

    it("holds at the order's store, not centrally", async () => {
      const s = await fresh();
      const r = await s.reserve(
        order('ic_pickup', [{ sku: 'IC-TEE', qty: 4 }], 'ic_store_soho'),
        'reserve#1',
      );
      expect(r.short).toEqual([]);
      expect((await level(s, 'IC-TEE', 'ic_store_soho'))?.reserved).toBe(4);
      expect((await level(s, 'IC-TEE'))?.reserved).toBe(0);
      const more = await s.reserve(
        order('ic_pickup_2', [{ sku: 'IC-TEE', qty: 1 }], 'ic_store_soho'),
        'reserve#1',
      );
      expect(more.short).toEqual(['IC-TEE']);
    });

    it('holds nothing when told every line is short', async () => {
      const s = await fresh();
      const r = await s.reserve(order('ic_forced', [{ sku: 'IC-TEE', qty: 1 }]), 'reserve#1', {
        forceShort: true,
      });
      expect(r).toEqual({ reservationIds: [], short: ['IC-TEE'] });
      expect((await level(s, 'IC-TEE'))?.reserved).toBe(0);
    });

    it('releases each hold once', async () => {
      const s = await fresh();
      await s.reserve(
        order('ic_rel', [
          { sku: 'IC-TEE', qty: 2 },
          { sku: 'IC-ONE', qty: 1 },
        ]),
        'reserve#1',
      );
      expect(await s.release('ic_rel')).toBe(2);
      expect(await s.release('ic_rel')).toBe(0);
      expect(await level(s, 'IC-TEE')).toEqual({ stock: 20, reserved: 0 });
      expect(await level(s, 'IC-ONE')).toEqual({ stock: 1, reserved: 0 });
    });

    it('consumes held stock once, after which a release moves nothing', async () => {
      const s = await fresh();
      await s.reserve(order('ic_ship', [{ sku: 'IC-TEE', qty: 2 }]), 'reserve#1');
      expect(await s.consume('ic_ship')).toBe(1);
      expect(await s.release('ic_ship')).toBe(0);
      expect(await s.consume('ic_ship')).toBe(0);
      expect(await level(s, 'IC-TEE')).toEqual({ stock: 18, reserved: 0 });
    });

    it('restores shipped stock once no shipment is live, once', async () => {
      const s = await fresh();
      await s.reserve(order('ic_live_ship', [{ sku: 'IC-TEE', qty: 1 }]), 'reserve#1');
      await s.consume('ic_live_ship');
      expect(await s.restoreShipped('ic_live_ship')).toBe(0);
      expect((await level(s, 'IC-TEE'))?.stock).toBe(19);

      await s.reserve(order('ic_cancelled_ship', [{ sku: 'IC-TEE', qty: 2 }]), 'reserve#1');
      await s.consume('ic_cancelled_ship');
      expect(await s.restoreShipped('ic_cancelled_ship')).toBe(1);
      expect(await s.restoreShipped('ic_cancelled_ship')).toBe(0);
      expect((await level(s, 'IC-TEE'))?.stock).toBe(19);
    });

    it('lists the products at or under their reorder point', async () => {
      const s = await fresh();
      const below = (await s.belowReorderPoint())
        .map((p) => p.sku)
        .filter((sku) => sku.startsWith('IC-'));
      expect(below.sort()).toEqual(['IC-EBOOK', 'IC-ONE']);
    });

    it('lists stock by SKU, by text and at or under the reorder point', async () => {
      const s = await fresh();
      const mine = (rows: { sku: string }[]) =>
        rows.map((r) => r.sku).filter((x) => x.startsWith('IC-'));
      expect(mine(await s.stockList({ q: 'ic-', limit: 50 }))).toEqual([
        'IC-EBOOK',
        'IC-LAST',
        'IC-ONE',
        'IC-PART',
        'IC-TEE',
      ]);
      expect(await s.stockList({ q: 'IC-TEE', limit: 50 })).toMatchObject([
        { sku: 'IC-TEE', stock: 20, reserved: 0, available: 20 },
      ]);
      expect(mine(await s.stockList({ q: 'IC-', belowReorder: true, limit: 50 }))).toEqual([
        'IC-EBOOK',
        'IC-ONE',
      ]);
      expect(await s.stockList({ q: 'IC-', limit: 2 })).toHaveLength(2);
    });

    it('restocks once per step and line', async () => {
      const s = await fresh();
      const lines = [{ sku: 'IC-ONE', qty: 1 }];
      await s.restock('ic_return', 'restock#1', lines);
      await s.restock('ic_return', 'restock#1', lines);
      expect((await level(s, 'IC-ONE'))?.stock).toBe(2);
      await s.restock('ic_return', 'restock#2', lines);
      expect((await level(s, 'IC-ONE'))?.stock).toBe(3);
    });
  });
}
