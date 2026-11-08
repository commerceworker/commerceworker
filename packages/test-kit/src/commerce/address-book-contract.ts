/**
 * The behaviour every `AddressBook` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). Ids start `ab_`.
 */
import type { ShipAddress } from '@commerceworker/core';
import type { AddressBook } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { AddressBookFixture } from './address-book';

const place = (name: string): ShipAddress =>
  ({
    name,
    line1: '1 Main St',
    city: 'Springfield',
    postalCode: '00001',
    country: 'US',
  }) as ShipAddress;

export const ADDRESS_BOOK_FIXTURE: AddressBookFixture = {
  pending: [
    { id: 'ab_o1', customerId: 'ab_cus', createdAt: 1, erasedAt: null },
    { id: 'ab_o2', customerId: null, createdAt: 2, erasedAt: null },
  ],
};

export function describeAddressBookContract(
  name: string,
  make: (fixture: AddressBookFixture) => Promise<AddressBook>,
) {
  describe(`${name}: the address book contract`, () => {
    it('counts each order at a place, the newest by date naming its recipient', async () => {
      const a = await make(ADDRESS_BOOK_FIXTURE);
      await a.remember({
        customerId: 'ab_cus',
        orderId: 'ab_new',
        key: 'k1',
        address: place('Ann'),
        at: 20,
      });
      // Counted late (the backfill): older, so it doesn't rename or become the last order.
      await a.remember({
        customerId: 'ab_cus',
        orderId: 'ab_old',
        key: 'k1',
        address: place('Old'),
        at: 5,
      });
      await a.remember({
        customerId: 'ab_cus',
        orderId: 'ab_other',
        key: 'k2',
        address: place('Bo'),
        at: 10,
      });
      expect(await a.addresses('ab_cus')).toMatchObject([
        {
          key: 'k1',
          name: 'Ann',
          orders: 2,
          firstUsedAt: 5,
          lastUsedAt: 20,
          lastOrderId: 'ab_new',
        },
        { key: 'k2', name: 'Bo', orders: 1 },
      ]);
      expect(await a.addresses('ab_nobody')).toEqual([]);
      expect((await a.addresses('ab_cus', 1)).map((p) => p.key)).toEqual(['k1']);
      expect((await a.addresses('ab_cus'))[0]?.id).toEqual(expect.any(String));
    });

    it('lists the orders still to backfill, and clears them', async () => {
      const a = await make(ADDRESS_BOOK_FIXTURE);
      const mine = async () =>
        (await a.pendingBackfill(50))
          .filter((o) => o.id.startsWith('ab_'))
          .map((o) => o.id)
          .sort();
      expect(await mine()).toEqual(['ab_o1', 'ab_o2']);
      await a.clearPending('ab_o1');
      expect(await mine()).toEqual(['ab_o2']);
    });
  });
}
