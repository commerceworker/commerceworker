/**
 * Where goods come from and how they reach the customer: the stores, a staged pickup, the
 * hand-over, and digital goods' codes. Every write is keyed by the order and the step, so a retried
 * step changes nothing. Stock is not touched here: callers consume or release it through the
 * inventory port. `d1FulfillmentStore` (packages/db) and `InMemoryFulfillmentStore`
 * (packages/test-kit) implement it, held to one contract.
 */
import type { Order } from '@commerceworker/core';

export interface StoreLocation {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly postalCode: string;
  readonly pickup: boolean;
  readonly ships: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface ShipmentRecord {
  readonly id: string;
  readonly orderId: string;
  readonly carrier: string;
  readonly tracking: string;
  readonly status: string;
}

export interface EntitlementRecord {
  readonly id: string;
  readonly orderId: string;
  readonly sku: string;
  readonly code: string;
  readonly status: 'issued' | 'revoked' | (string & {});
}

/** A digital line to issue codes for: its index in the order keys its codes. */
export interface DigitalLine {
  readonly index: number;
  readonly sku: string;
  readonly qty: number;
}

export interface FulfillmentStore {
  /** Every store, ordered by id. */
  locations(): Promise<StoreLocation[]>;
  /** Stages held stock for collection: a pickup shipment whose tracking is the pickup code. */
  stagePickup(
    orderId: string,
    stepKey: string,
  ): Promise<{ shipmentId: string; pickupCode: string }>;
  /** The customer has the goods: a staged pickup is collected, or a carry-out is recorded. */
  handOver(
    order: Pick<Order, 'id' | 'fulfillment'>,
    stepKey: string,
  ): Promise<{ collected: 'pickup' | 'carry_out' }>;
  /** One code per unit of each digital line, keyed by step, line and unit. */
  issueEntitlements(
    orderId: string,
    stepKey: string,
    lines: readonly DigitalLine[],
  ): Promise<{ sku: string; code: string }[]>;
  /** Compensation: revokes the order's issued codes. Returns how many this call revoked. */
  revokeEntitlements(orderId: string): Promise<number>;
  /** The order's shipments, pickups and carry-outs. */
  shipments(orderId: string): Promise<ShipmentRecord[]>;
  /** The order's digital codes. */
  entitlements(orderId: string): Promise<EntitlementRecord[]>;
}
