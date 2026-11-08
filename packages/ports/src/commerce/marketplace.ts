/**
 * The marketplace: sellers, the part of an order each one fulfils, and what each is paid. A part
 * is opened once per order and seller, decided only while pending, and a payout is scheduled once
 * per step and seller, so a retried step or a replayed seller response changes nothing.
 * `d1MarketplaceStore` (packages/db) and `InMemoryMarketplaceStore` (packages/test-kit) implement
 * it, held to one contract. The split and the payout amounts are core rules
 * (`groupBySeller`, `payoutAmounts`).
 */
import type { OrderLine } from '@commerceworker/core';

export interface SellerRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly commissionPct: number;
  readonly autoAccept: boolean;
  readonly active: boolean;
}

export type SellerOrderStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

/** A part to open: one seller's lines of an order. */
export interface SellerOrderDraft {
  readonly sellerId: string;
  readonly status: 'pending' | 'accepted';
  readonly lines: readonly OrderLine[];
  readonly subtotal: number;
}

/** A seller's part as the order shows it. The first party reads as "Marketplace". */
export interface SellerPart {
  readonly sellerId: string;
  readonly name: string;
  readonly status: string;
  readonly subtotal: number;
  readonly reason: string | null;
}

/** An accepted third-party part, with the seller's commission, for scheduling a payout. */
export interface AcceptedPart {
  readonly sellerId: string;
  readonly subtotal: number;
  readonly commissionPct: number;
}

export interface PayoutRecord {
  readonly id: string;
  readonly orderId: string;
  readonly sellerId: string;
  readonly gross: number;
  readonly commission: number;
  readonly refunded: number;
  readonly net: number;
  readonly status: string;
}

/** A payout's id: `pout_<orderId>_<stepKey>_<sellerId>`, anything but word characters and `-` as `_`. */
export const payoutId = (orderId: string, stepKey: string, sellerId: string) =>
  `pout_${orderId}_${stepKey}_${sellerId}`.replace(/[^\w-]/g, '_');

export interface MarketplaceStore {
  /** The sellers with these ids; unknown ids are absent. */
  sellers(ids: readonly string[]): Promise<SellerRecord[]>;
  /** Opens one part per seller, once: a part that already exists keeps its status and lines. */
  openSellerOrders(orderId: string, drafts: readonly SellerOrderDraft[]): Promise<void>;
  /** The order's parts, by seller id. */
  parts(orderId: string): Promise<SellerPart[]>;
  /** Accepts or rejects a seller's part. Only a pending part changes, so a replay is a no-op. */
  decide(
    orderId: string,
    sellerId: string,
    decision: 'accepted' | 'rejected',
    reason?: string,
  ): Promise<void>;
  /** Rejects every part still pending. Returns how many. */
  expire(orderId: string, reason: string): Promise<number>;
  /** Compensation: cancels every pending or accepted part. Returns how many this call cancelled. */
  cancel(orderId: string): Promise<number>;
  /** Third-party sellers to tell: those still to answer when any are, else those who accepted. */
  contacts(orderId: string): Promise<{ id: string; email: string }[]>;
  /** The order's accepted third-party parts. */
  acceptedParts(orderId: string): Promise<AcceptedPart[]>;
  /** Records payouts, each once by id: a repeat keeps the first. */
  schedulePayouts(payouts: readonly PayoutRecord[]): Promise<void>;
  /** Compensation: reverses the order's scheduled payouts. Returns how many this call reversed. */
  reversePayouts(orderId: string): Promise<number>;
  /** The order's payouts, by id. */
  payouts(orderId: string): Promise<PayoutRecord[]>;
}
