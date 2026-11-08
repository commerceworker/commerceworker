/**
 * The behaviour every `ShippingStore` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Each case uses its own order ids (`sc_…`), which the D1 runner clears.
 */
import type { BookedShipment, ShippingStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const shipment = (id: string, over: Partial<BookedShipment> = {}): BookedShipment => ({
  id,
  orderId: 'sc_order',
  carrier: 'ups',
  tracking: `T_${id}`,
  status: 'label_created',
  provider: null,
  externalId: null,
  ...over,
});

const labelled = (id: string, over: Partial<BookedShipment> = {}) =>
  shipment(id, { provider: 'carrier', externalId: `x_${id}`, ...over });

export function describeShippingStoreContract(name: string, make: () => Promise<ShippingStore>) {
  describe(`${name}: the shipping store contract`, () => {
    it('books each shipment once: a repeat keeps the first', async () => {
      const s = await make();
      await s.book([shipment('sc_a')]);
      await s.book([shipment('sc_a', { tracking: 'other' }), shipment('sc_b')]);
      const booked = await s.booked('sc_order');
      expect(booked.map((r) => [r.id, r.tracking])).toEqual([
        ['sc_a', 'T_sc_a'],
        ['sc_b', 'T_sc_b'],
      ]);
      expect(booked[0]!.createdAt).toBeLessThan(booked[1]!.createdAt);
    });

    it('lists provider-labelled shipments not cancelled, by id or by order and status', async () => {
      const s = await make();
      await s.book([
        labelled('sc_l1'),
        labelled('sc_l2', { status: 'return_label' }),
        labelled('sc_l3', { status: 'cancelled' }),
        shipment('sc_plain'),
      ]);
      expect(
        (await s.labelled({ ids: ['sc_l1', 'sc_l3', 'sc_plain', 'sc_none'] })).map((r) => r.id),
      ).toEqual(['sc_l1']);
      expect(
        (
          await s.labelled({ orderId: 'sc_order', statuses: ['label_created', 'return_label'] })
        ).map((r) => r.id),
      ).toEqual(['sc_l1', 'sc_l2']);
    });

    it('records a label outcome, booking a label it never saw', async () => {
      const s = await make();
      await s.book([labelled('sc_v1')]);
      await s.settleLabels(
        [labelled('sc_v1'), labelled('sc_v2', { orderId: 'sc_other' })],
        'void_failed',
      );
      expect((await s.voidFailed(10)).map((r) => r.id)).toEqual(['sc_v1', 'sc_v2']);
      expect(await s.voidFailed(1)).toHaveLength(1);
      expect(await s.voidFailed(10, 'elsewhere')).toEqual([]);
      expect((await s.voidFailed(10, 'carrier')).map((r) => r.id)).toEqual(['sc_v1', 'sc_v2']);
      await s.settleLabels([labelled('sc_v1')], 'cancelled');
      expect((await s.voidFailed(10)).map((r) => r.id)).toEqual(['sc_v2']);
    });

    it('cancels one shipment, or every open one of an order once', async () => {
      const s = await make();
      await s.book([
        shipment('sc_c1'),
        shipment('sc_c2', { status: 'ready_for_pickup' }),
        shipment('sc_c3', { status: 'collected' }),
        shipment('sc_c4', { status: 'return_label' }),
      ]);
      await s.cancel('sc_c4');
      expect(await s.cancelOpen('sc_order')).toBe(2);
      expect(await s.cancelOpen('sc_order')).toBe(0);
      expect((await s.booked('sc_order')).map((r) => [r.id, r.status])).toEqual([
        ['sc_c1', 'cancelled'],
        ['sc_c2', 'cancelled'],
        ['sc_c3', 'collected'],
        ['sc_c4', 'cancelled'],
      ]);
    });
  });
}
