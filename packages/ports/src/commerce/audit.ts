/**
 * The audit trail's hash chain: each event is sealed against the newest one (`sealAuditRow` in
 * core) and appended. The web app and the engine both write events, so two writers can read the
 * same head; the store refuses the second, which reads the new head and seals again, so the chain
 * never forks. `d1AuditLog` (packages/db) and `InMemoryAuditLog` (packages/test-kit) implement it,
 * held to one contract.
 */
import type { AuditHead, AuditRow, SealedAuditRow } from '@commerceworker/core';

/** An event as stored: sealed into the chain (`seq` and its hashes), or from before the chain. */
export type AuditEvent = AuditRow & {
  readonly seq: number | null;
  readonly prevHash: string | null;
  readonly hash: string | null;
};

export interface AuditLog {
  /** Appends the event `seal` makes for the current head, retrying on a lost race. */
  append(seal: (head: AuditHead | null) => Promise<SealedAuditRow>): Promise<SealedAuditRow>;
  /**
   * Up to `limit` events, newest first; `group` keeps actions starting `<group>.`, `before` those
   * earlier than a time. With `after` (a `seq`), the sealed events after it, oldest first: the
   * cursor an export pulls by.
   */
  list(f: {
    group?: string;
    before?: number;
    after?: number;
    limit: number;
  }): Promise<AuditEvent[]>;
  /** Up to `limit` sealed events after `after` (from the oldest kept, when unset), oldest first. */
  sealedAfter(after: number | undefined, limit: number): Promise<SealedAuditRow[]>;
  /** The sealed event at `seq`, as a chain link. */
  link(seq: number): Promise<AuditHead | undefined>;
}
