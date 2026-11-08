/**
 * The audit trail port in memory: a seq is refused when it's taken, as the D1 store's unique
 * index refuses it, so racing writers retry. The contract in ./audit-log-contract.ts holds it to
 * the same behaviour as the D1 store.
 */
import type { AuditHead, SealedAuditRow } from '@commerceworker/core';
import type { AuditEvent, AuditLog } from '@commerceworker/ports/commerce';

export class InMemoryAuditLog implements AuditLog {
  readonly events: SealedAuditRow[] = [];
  /** Events from before the chain: no seq, never verified. */
  readonly unsealed: AuditEvent[] = [];

  private head(): AuditHead | null {
    const last = this.events.at(-1);
    return last ? { seq: last.seq, hash: last.hash } : null;
  }

  async append(seal: (head: AuditHead | null) => Promise<SealedAuditRow>) {
    for (;;) {
      const row = await seal(this.head());
      if (this.events.some((e) => e.seq === row.seq)) continue;
      this.events.push(row);
      return row;
    }
  }

  async list(f: { group?: string; before?: number; after?: number; limit: number }) {
    const all: AuditEvent[] = [...this.unsealed, ...this.events];
    const picked = all.filter(
      (e) =>
        (!f.group || e.action.toLowerCase().startsWith(`${f.group.toLowerCase()}.`)) &&
        (!f.before || e.at < f.before) &&
        (f.after === undefined || (e.seq !== null && e.seq > f.after)),
    );
    return picked
      .sort(f.after !== undefined ? (a, b) => a.seq! - b.seq! : (a, b) => b.at - a.at)
      .slice(0, f.limit);
  }

  async sealedAfter(after: number | undefined, limit: number) {
    return this.events
      .filter((e) => after === undefined || e.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async link(seq: number) {
    const e = this.events.find((x) => x.seq === seq);
    return e && { seq: e.seq, hash: e.hash };
  }
}
