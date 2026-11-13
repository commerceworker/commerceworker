/**
 * What the daily retention sweep reads and deletes. `RetentionStore` finds what is past its
 * retention across the deployment's tables and deletes it; `AuditArchive` keeps audit events in
 * R2 before their rows go; `CartRuntime` reaches the cart agents whose own storage the sweep
 * clears. `d1RetentionStore` (packages/db) and `InMemoryRetentionStore` (packages/test-kit)
 * implement the store, held to one contract.
 */
import type { RetentionPolicy } from '@commerceworker/core';

/** Rows each table lost to one prune. */
export interface PruneCounts {
  readonly sessions: number;
  readonly webhookDeliveries: number;
  readonly nodeRuns: number;
  readonly inboundEmails: number;
  readonly webhookReceipts: number;
  readonly paymentEvents: number;
  readonly ucpIdempotency: number;
  readonly abandonedCheckouts: number;
  readonly orderViewTokens: number;
}

/** An audit event as archived: every column, its chain place (`seq`) null before the chain. */
export interface AuditRow {
  readonly id: string;
  readonly at: number;
  readonly seq: number | null;
  readonly [column: string]: unknown;
}

export interface RetentionStore {
  /** Deletes every prunable row past its retention, in one transaction. */
  prune(now: number, policy: RetentionPolicy): Promise<PruneCounts>;
  /** Ended carts not yet purged, last changed before `before`, oldest first. */
  endedCarts(before: number, limit: number): Promise<string[]>;
  /** External carts whose buyer was never indexed. */
  cartsWithoutBuyer(limit: number): Promise<string[]>;
  /** The buyer a cart's row names ('' once erased), or null when it names none. */
  cartBuyer(id: string): Promise<string | null>;
  /** Marks a cart that holds nothing as having no buyer to find. */
  markBuyerless(id: string): Promise<void>;
  /** Ended orders not yet erased, last changed before `before`, oldest first. */
  ordersEndedBefore(before: number, limit: number): Promise<{ id: string; title: string }[]>;
  /** Deletes customer addresses last used before `before`. Returns how many. */
  expireAddresses(before: number): Promise<number>;
  /**
   * Blanks the name and email of members removed before `before` (their rows stay, for the orders
   * they placed). Returns how many.
   */
  expireMembers(before: number): Promise<number>;
  /** Audit events from before the chain, older than `before`, by time then id. */
  unchainedAudit(before: number, limit: number): Promise<AuditRow[]>;
  /** Deletes the unchained audit events up to and including `last`, in that order. */
  deleteUnchainedThrough(last: { at: number; id: string }): Promise<void>;
  /** The oldest chained audit events, in chain order. */
  chainedAudit(limit: number): Promise<AuditRow[]>;
  /** Deletes the chained audit events up to and including `seq`. */
  deleteChainedThrough(seq: number): Promise<void>;
}

/** Where archived audit events go. A key, once written, is never written again. */
export interface AuditArchive {
  has(key: string): Promise<boolean>;
  /** Writes `rows` as NDJSON, one event a line. */
  put(key: string, rows: readonly AuditRow[]): Promise<void>;
  /** The daily copies (`auditCopyKey`), in chain order. */
  copies(): Promise<{ key: string; from: number; to: number; hash: string }[]>;
  /** The events an object holds, in the order they were written; none for a key that isn't there. */
  read(key: string): Promise<AuditRow[]>;
}

/** The cart agents the sweep wakes. */
export interface CartRuntime {
  /** Clears an ended cart's chat, files and buyer (`CartAgent.purge`). */
  purge(id: string): Promise<{ purged: boolean }>;
  /** Writes the cart's row again; false when its agent holds no cart. */
  reindex(id: string): Promise<boolean>;
}
