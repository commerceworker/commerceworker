/**
 * The behaviour every `CartRecords` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). Cart ids start `crc_`, which the D1 runner clears.
 */
import type { CartIndexRow } from '@commerceworker/core';
import type { CartRecords } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const row = (id: string, over: Partial<CartIndexRow> = {}): CartIndexRow => ({
  id,
  flowId: 'flow_1',
  pluginId: null,
  sessionRef: null,
  createdBy: 'usr_ada',
  createdAt: 1_000,
  title: 'Cart',
  status: 'open',
  customerId: null,
  orderId: null,
  updatedAt: 1_000,
  expiresAt: null,
  buyerId: null,
  ...over,
});

export function describeCartRecordsContract(name: string, make: () => Promise<CartRecords>) {
  describe(`${name}: the cart records contract`, () => {
    it("writes a cart's row and keeps who made it and its session", async () => {
      const r = await make();
      await r.index(row('crc_1', { pluginId: 'shop', sessionRef: 's1', expiresAt: 50 }));
      expect(await r.find('crc_1')).toEqual({
        id: 'crc_1',
        status: 'open',
        pluginId: 'shop',
        expiresAt: 50,
        purgedAt: null,
      });
      await r.index(
        row('crc_1', { status: 'ordered', orderId: 'ord_1', pluginId: null, sessionRef: null }),
      );
      expect(await r.find('crc_1')).toMatchObject({ status: 'ordered', pluginId: 'shop' });
      expect(await r.find('crc_none')).toBeUndefined();
    });

    it("finds a plugin session's cart, and refuses a second cart for it", async () => {
      const r = await make();
      await r.index(row('crc_2', { pluginId: 'shop', sessionRef: 's2' }));
      expect(await r.forSession('shop', 's2')).toMatchObject({ id: 'crc_2' });
      expect(await r.forSession('shop', 'other')).toBeUndefined();
      expect(await r.forSession('elsewhere', 's2')).toBeUndefined();
      await expect(r.index(row('crc_3', { pluginId: 'shop', sessionRef: 's2' }))).rejects.toThrow();
    });

    it('lists staff carts newest first, by status, leaving out plugin carts', async () => {
      const r = await make();
      await r.index(row('crc_s1', { updatedAt: 1 }));
      await r.index(row('crc_s2', { updatedAt: 3, status: 'submitted' }));
      await r.index(row('crc_s3', { updatedAt: 2 }));
      await r.index(row('crc_p1', { updatedAt: 9, pluginId: 'shop', sessionRef: 'p1' }));
      const ids = async (f: { status?: string; limit: number }) =>
        (await r.staffCarts(f)).map((c) => c.id).filter((id) => id.startsWith('crc_'));
      expect(await ids({ limit: 50 })).toEqual(['crc_s2', 'crc_s3', 'crc_s1']);
      expect(await ids({ status: 'open', limit: 50 })).toEqual(['crc_s3', 'crc_s1']);
      expect(await ids({ limit: 1 })).toEqual(['crc_s2']);
      const listed = async (f: { status?: string; external?: boolean; limit: number }) =>
        (await r.list(f)).map((c) => c.id).filter((id) => id.startsWith('crc_'));
      expect(await listed({ limit: 50 })).toEqual(['crc_s2', 'crc_s3', 'crc_s1']);
      expect(await listed({ external: true, limit: 50 })).toEqual([
        'crc_p1',
        'crc_s2',
        'crc_s3',
        'crc_s1',
      ]);
      expect(
        (await r.list({ status: 'submitted', limit: 50 })).find((c) => c.id === 'crc_s2'),
      ).toMatchObject({
        title: 'Cart',
        createdBy: 'usr_ada',
        flowId: 'flow_1',
      });
    });

    it("moves an open cart's expiry on, and leaves an ended one's", async () => {
      const r = await make();
      await r.index(row('crc_e1', { pluginId: 'shop', sessionRef: 'e1', expiresAt: 10 }));
      await r.index(
        row('crc_e2', { pluginId: 'shop', sessionRef: 'e2', expiresAt: 10, status: 'canceled' }),
      );
      await r.extendExpiry('crc_e1', 99);
      await r.extendExpiry('crc_e2', 99);
      expect((await r.find('crc_e1'))?.expiresAt).toBe(99);
      expect((await r.find('crc_e2'))?.expiresAt).toBe(10);
    });

    it('marks a cart purged', async () => {
      const r = await make();
      await r.index(row('crc_4'));
      await r.markPurged('crc_4');
      expect((await r.find('crc_4'))?.purgedAt).toEqual(expect.any(Number));
    });
  });
}
