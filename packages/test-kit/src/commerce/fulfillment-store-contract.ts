/**
 * The behaviour every `FulfillmentStore` keeps: in memory in node, on D1 in workerd
 * (packages/db). Order ids are distinctive per case, so cases don't see each other's rows.
 */
import type { FulfillmentStore, StoreLocation } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { FulfillmentFixture } from './fulfillment-store';

const store = (over: Partial<StoreLocation> & { id: string; name: string }): StoreLocation => ({
  kind: 'store',
  postalCode: '',
  pickup: true,
  ships: false,
  latitude: null,
  longitude: null,
  ...over,
});

export const FULFILLMENT_FIXTURE: FulfillmentFixture = {
  locations: [
    store({
      id: 'fc_store_b',
      name: 'Fulfillment Contract B',
      ships: true,
      latitude: 40.7,
      longitude: -74,
    }),
    store({ id: 'fc_store_a', name: 'Fulfillment Contract A', pickup: false }),
  ],
};

export function describeFulfillmentStoreContract(
  name: string,
  make: (fixture: FulfillmentFixture) => Promise<FulfillmentStore>,
) {
  describe(`${name}: the fulfillment store contract`, () => {
    const fresh = () => make(FULFILLMENT_FIXTURE);

    it('lists the stores in id order', async () => {
      const s = await fresh();
      const mine = (await s.locations()).filter((l) => l.id.startsWith('fc_'));
      expect(mine.map((l) => [l.id, l.pickup, l.ships])).toEqual([
        ['fc_store_a', false, false],
        ['fc_store_b', true, true],
      ]);
    });

    it('stages a pickup once, with the same code on a retry', async () => {
      const s = await fresh();
      const a = await s.stagePickup('fc_ord_pickup', 'pickup#1');
      expect(a.pickupCode).toMatch(/^[0-9A-Z]{6}$/);
      expect(await s.stagePickup('fc_ord_pickup', 'pickup#1')).toEqual(a);
      expect(await s.shipments('fc_ord_pickup')).toEqual([
        expect.objectContaining({
          id: a.shipmentId,
          carrier: 'pickup',
          tracking: a.pickupCode,
          status: 'ready_for_pickup',
        }),
      ]);
    });

    it('collects a staged pickup, and a retried hand-over still reports the pickup', async () => {
      const s = await fresh();
      await s.stagePickup('fc_ord_collect', 'pickup#1');
      expect(await s.handOver({ id: 'fc_ord_collect' }, 'handover#1')).toEqual({
        collected: 'pickup',
      });
      expect(await s.handOver({ id: 'fc_ord_collect' }, 'handover#1')).toEqual({
        collected: 'pickup',
      });
      expect((await s.shipments('fc_ord_collect')).map((x) => [x.carrier, x.status])).toEqual([
        ['pickup', 'collected'],
      ]);
    });

    it('records a carry-out once when nothing was staged', async () => {
      const s = await fresh();
      const order = { id: 'fc_ord_carry', fulfillment: { locationId: 'fc_store_b' } as never };
      expect(await s.handOver(order, 'handover#1')).toEqual({ collected: 'carry_out' });
      expect(await s.handOver(order, 'handover#1')).toEqual({ collected: 'carry_out' });
      expect(
        (await s.shipments('fc_ord_carry')).map((x) => [x.carrier, x.tracking, x.status]),
      ).toEqual([['carry_out', 'fc_store_b', 'collected']]);
    });

    it('issues one code per unit, the same on a retry, and revokes them once', async () => {
      const s = await fresh();
      const lines = [
        { index: 0, sku: 'FC-EBOOK', qty: 2 },
        { index: 2, sku: 'FC-SONG', qty: 1 },
      ];
      const codes = await s.issueEntitlements('fc_ord_digital', 'deliver#1', lines);
      expect(codes.map((c) => c.sku)).toEqual(['FC-EBOOK', 'FC-EBOOK', 'FC-SONG']);
      expect(new Set(codes.map((c) => c.code)).size).toBe(3);
      expect(await s.issueEntitlements('fc_ord_digital', 'deliver#1', lines)).toEqual(codes);
      expect((await s.entitlements('fc_ord_digital')).map((e) => e.status)).toEqual([
        'issued',
        'issued',
        'issued',
      ]);
      expect(await s.revokeEntitlements('fc_ord_digital')).toBe(3);
      expect(await s.revokeEntitlements('fc_ord_digital')).toBe(0);
    });

    it('issues nothing for an order with no digital lines', async () => {
      const s = await fresh();
      expect(await s.issueEntitlements('fc_ord_none', 'deliver#1', [])).toEqual([]);
      expect(await s.entitlements('fc_ord_none')).toEqual([]);
    });
  });
}
