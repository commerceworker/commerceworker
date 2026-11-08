/**
 * Shipments and their labels. `ShippingStore` records what was booked and what became of each
 * label; `LabelService` asks a provider plugin to make or void labels. Every booking is keyed by
 * the order and the step, so a retried step books nothing more, and a label a provider couldn't
 * void is kept as `void_failed` for a daily retry, never forgotten. `d1ShippingStore`
 * (packages/db) and `InMemoryShippingStore` (packages/test-kit) implement the store, held to one
 * contract; the engine binds `LabelService` to its plugins.
 */
import type { LabelPackage, Order } from '@commerceworker/core';
import type { ShipmentRecord } from './fulfillment';

/** A shipment as booked: who labelled it (null when built in) and their id for the label. */
export interface BookedShipment extends ShipmentRecord {
  readonly provider: string | null;
  readonly externalId: string | null;
}

/** Statuses a shipment is open in: booked, or waiting at a store. */
export const OPEN_SHIPMENT = ['label_created', 'ready_for_pickup'] as const;

export interface ShippingStore {
  /** Records shipments, each once by id: a repeat keeps the first. */
  book(shipments: readonly BookedShipment[]): Promise<void>;
  /**
   * Records what became of labels a provider was asked to void: each shipment is set to `status`,
   * recorded first when it wasn't booked (a label the provider returned unasked).
   */
  settleLabels(
    shipments: readonly BookedShipment[],
    status: 'cancelled' | 'void_failed',
  ): Promise<void>;
  /**
   * Provider-labelled shipments not yet cancelled: these ids, or the order's in these statuses.
   */
  labelled(
    where:
      | { readonly ids: readonly string[] }
      | { readonly orderId: string; readonly statuses: readonly string[] },
  ): Promise<BookedShipment[]>;
  /** Labels a provider (or this one) couldn't void, oldest first, up to `limit`. */
  voidFailed(limit: number, provider?: string): Promise<BookedShipment[]>;
  /** Cancels one shipment. */
  cancel(shipmentId: string): Promise<void>;
  /** Cancels the order's open shipments. Returns how many this call cancelled. */
  cancelOpen(orderId: string): Promise<number>;
  /** The order's shipments, by id, with when each was booked. */
  booked(orderId: string): Promise<(BookedShipment & { readonly createdAt: number })[]>;
}

/** A label a provider made for one package. */
export interface ProviderLabel {
  readonly ref: string;
  readonly id: string;
  readonly tracking: string;
  readonly carrier?: string;
}

/** The node asking: its id, its step, and its config with defaults filled in. */
export interface LabelCaller {
  readonly nodeId: string;
  readonly stepKey: string;
  readonly config: Record<string, unknown>;
}

export interface LabelService {
  /** Asks provider `providerId` for a label per package. */
  create(
    providerId: string,
    caller: LabelCaller,
    order: Order,
    input: { kind: 'shipment' | 'return'; carrier: string; packages: LabelPackage[] },
  ): Promise<ProviderLabel[]>;
  /** Asks provider `providerId` to void labels it made. Throws when it can't. */
  void(
    providerId: string,
    orderId: string,
    stepKey: string,
    labels: readonly { ref: string; id: string }[],
  ): Promise<void>;
}
