/**
 * The address book port in memory, seeded with the orders still marked for the backfill. The
 * contract in ./address-book-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { ShipAddress } from '@commerceworker/core';
import type { AddressBook } from '@commerceworker/ports/commerce';

type Place = {
  id: string;
  key: string;
  name: string | null;
  line1: string;
  line2: string | null;
  region: string | null;
  city: string;
  postalCode: string;
  country: string;
  orders: number;
  firstUsedAt: number;
  lastUsedAt: number;
  lastOrderId: string;
};

export interface AddressBookFixture {
  pending?: { id: string; customerId: string | null; createdAt: number; erasedAt: number | null }[];
}

export class InMemoryAddressBook implements AddressBook {
  private readonly places = new Map<string, Map<string, Place>>();
  private pending: NonNullable<AddressBookFixture['pending']>;

  constructor(fixture: AddressBookFixture = {}) {
    this.pending = structuredClone(fixture.pending ?? []);
  }

  async remember(e: {
    customerId: string;
    orderId: string;
    key: string;
    address: ShipAddress;
    at: number;
  }) {
    let mine = this.places.get(e.customerId);
    if (!mine) {
      mine = new Map();
      this.places.set(e.customerId, mine);
    }
    const had = mine.get(e.key);
    if (!had) {
      mine.set(e.key, {
        id: `adr_${e.customerId}_${e.key}`,
        key: e.key,
        name: e.address.name ?? null,
        line1: e.address.line1,
        line2: e.address.line2 ?? null,
        region: e.address.region ?? null,
        city: e.address.city,
        postalCode: e.address.postalCode,
        country: e.address.country,
        orders: 1,
        firstUsedAt: e.at,
        lastUsedAt: e.at,
        lastOrderId: e.orderId,
      });
      return;
    }
    const newer = e.at >= had.lastUsedAt;
    mine.set(e.key, {
      ...had,
      name: newer ? (e.address.name ?? null) : had.name,
      orders: had.orders + 1,
      firstUsedAt: Math.min(had.firstUsedAt, e.at),
      lastUsedAt: Math.max(had.lastUsedAt, e.at),
      lastOrderId: newer ? e.orderId : had.lastOrderId,
    });
  }

  async addresses(customerId: string, limit = Number.POSITIVE_INFINITY) {
    return [...(this.places.get(customerId)?.values() ?? [])]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, limit);
  }

  async pendingBackfill(limit: number) {
    return this.pending.slice(0, limit);
  }

  async clearPending(orderId: string) {
    this.pending = this.pending.filter((o) => o.id !== orderId);
  }
}
