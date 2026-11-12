/**
 * Stock and reservations: holding stock for an order, settling the hold when the goods ship or the
 * order ends, and putting stock back. Every write is keyed by the order, the step and the line,
 * and every settlement happens at most once, so a retried step or a compensation racing a cancel
 * changes stock once. `d1InventoryStore` (packages/db) implements it on D1 with a guarded ledger;
 * `InMemoryInventoryStore` (packages/test-kit) in memory; one contract holds both.
 */
import type { Order, StockLine } from '@commerceworker/core';
import type { ProductRecord } from './pricing';

/** Stock on hand and held, for one SKU at one place. Free to hold: `stock - reserved`. */
export interface StockLevel {
  readonly stock: number;
  readonly reserved: number;
}

/** A product's central stock, as the stock list shows it. */
export interface StockRow {
  readonly sku: string;
  readonly name: string;
  readonly stock: number;
  readonly reserved: number;
  /** `stock - reserved`. */
  readonly available: number;
  readonly reorderPoint: number;
  readonly supplier: string;
}

/**
 * Whether a SKU can be had, as far as a buyer is told: the coarse status of its central stock, never
 * a count. `in_stock` is free stock (`stock - reserved`) above zero, or a digital good, which holds
 * none and is always deliverable.
 */
export type StockStatus = 'in_stock' | 'out_of_stock';

export interface ReserveResult {
  /** The reservations the order holds after this step (an earlier step's, when it already had them). */
  readonly reservationIds: string[];
  /** SKUs of lines that couldn't be held. */
  readonly short: string[];
}

export interface InventoryStore {
  /** Levels per SKU: central stock, or a store's when `locationId` is set. Unknown SKUs are absent. */
  levels(skus: readonly string[], locationId?: string): Promise<Map<string, StockLevel>>;
  /**
   * The status of each SKU's central stock, for a read that shows a buyer what is available. One
   * statement per 90 SKUs and nothing written. A SKU with no stock row is absent: nothing is known
   * about it, so nothing is claimed.
   */
  availability(skus: readonly string[]): Promise<Map<string, StockStatus>>;
  /**
   * Holds stock for every physical line (digital goods hold none): at the line's own store when
   * routing split the shipment, else at `order.fulfillment.locationId`, else centrally. A line is
   * held wholly or not at all, and only while the stock is still free, so two orders racing for
   * the last units can't both hold them. A retried step holds nothing more; when an earlier step
   * of the same order already holds stock, that hold is the result. `forceShort` makes every
   * unheld line short (failure simulation).
   */
  reserve(
    order: Pick<Order, 'id' | 'lines' | 'fulfillment'>,
    stepKey: string,
    options?: { forceShort?: boolean },
  ): Promise<ReserveResult>;
  /** Compensation: releases every held reservation of the order. Returns how many this call moved. */
  release(orderId: string): Promise<number>;
  /** Shipping or handing goods over consumes the order's held stock. Returns how many moved. */
  consume(orderId: string): Promise<number>;
  /**
   * Compensation for a cancelled shipment: once none of the order's shipments is still booked or
   * with the customer, stock its shipments consumed goes back, each reservation at most once.
   * Returns how many reservations were restored.
   */
  restoreShipped(orderId: string): Promise<number>;
  /** Products whose free stock (`stock - reserved`) is at or under their reorder point. */
  belowReorderPoint(): Promise<ProductRecord[]>;
  /**
   * Central stock by SKU: those whose SKU or name holds `q`, only those at or under their reorder
   * point when asked, up to `limit`.
   */
  stockList(f: { q?: string; belowReorder?: boolean; limit: number }): Promise<StockRow[]>;
  /** Adds returned or received stock to central stock, once per step and line. */
  restock(orderId: string, stepKey: string, lines: readonly StockLine[]): Promise<void>;
}
