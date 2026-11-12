/**
 * The address book port in memory, seeded with the orders still marked for the backfill. The
 * contract in ./address-book-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { ShipAddress } from '@commerceworker/core';
import type { AddressBook, AddressBookEntry } from '@commerceworker/ports/commerce';

type Place = AddressBookEntry;

export interface AddressBookFixture {
  /** The customers the shopper lookups find by email; only a `consumer` is a shopper. */
  customers?: { id: string; email: string; kind: string }[];
  pending?: { id: string; customerId: string | null; createdAt: number; erasedAt: number | null }[];
}

export class InMemoryAddressBook implements AddressBook {
  private readonly places = new Map<string, Map<string, Place>>();
  private pending: NonNullable<AddressBookFixture['pending']>;
  private readonly customers: NonNullable<AddressBookFixture['customers']>;

  constructor(fixture: AddressBookFixture = {}) {
    this.pending = structuredClone(fixture.pending ?? []);
    this.customers = structuredClone(fixture.customers ?? []);
  }

  private consumerIds(email: string) {
    return this.customers
      .filter((c) => c.kind === 'consumer' && c.email.toLowerCase() === email.toLowerCase())
      .map((c) => c.id);
  }

  async forConsumer(email: string, limit: number) {
    return this.consumerIds(email)
      .flatMap((id) => [...(this.places.get(id)?.values() ?? [])])
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, limit);
  }

  async forgetForConsumer(email: string, id: string) {
    for (const customerId of this.consumerIds(email)) {
      const mine = this.places.get(customerId);
      const place = [...(mine?.values() ?? [])].find((p) => p.id === id);
      if (mine && place) return mine.delete(place.key);
    }
    return false;
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
