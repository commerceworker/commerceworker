/**
 * The places a customer's orders ship to, for the customer page. An order adds its ship-to when it
 * starts; a known place counts the order and takes the newest recipient's name, by date, so orders
 * counted late (the backfill of orders started before addresses were kept) don't overwrite newer
 * ones. `d1AddressBook` (packages/db) and `InMemoryAddressBook` (packages/test-kit) implement it,
 * held to one contract.
 */
import type { ShipAddress } from '@commerceworker/core';

export interface AddressBook {
  /** Records an order's ship-to (`key` from core's `rememberedAddress`) against its customer. */
  remember(e: {
    customerId: string;
    orderId: string;
    key: string;
    address: ShipAddress;
    at: number;
  }): Promise<void>;
  /** A customer's places, most recently used first, up to `limit`. */
  addresses(
    customerId: string,
    limit?: number,
  ): Promise<
    {
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
    }[]
  >;
  /** Orders started before addresses were kept, still to be added, up to `limit`. */
  pendingBackfill(
    limit: number,
  ): Promise<
    { id: string; customerId: string | null; createdAt: number; erasedAt: number | null }[]
  >;
  /** Marks an order's address added (or found to have none to add). */
  clearPending(orderId: string): Promise<void>;
}
