/**
 * The audit trail port in memory: a seq is refused when it's taken, as the D1 store's unique
 * index refuses it, so racing writers retry. The contract in ./audit-log-contract.ts holds it to
 * the same behaviour as the D1 store.
 */
import {
  type AuditAnchor,
  type AuditHead,
  auditAnchorKey,
  parseAuditCopyKey,
  type SealedAuditRow,
} from '@commerceworker/core';
import type {
  AuditAnchors,
  AuditArchive,
  AuditEvent,
  AuditLog,
  AuditRow,
} from '@commerceworker/ports/commerce';

export class InMemoryAuditLog implements AuditLog {
  readonly events: SealedAuditRow[] = [];
  /** Events from before the chain: no seq, never verified. */
  readonly unsealed: AuditEvent[] = [];

  private tip(): AuditHead | null {
    const last = this.events.at(-1);
    return last ? { seq: last.seq, hash: last.hash } : null;
  }

  async append(seal: (head: AuditHead | null) => Promise<SealedAuditRow>) {
    for (;;) {
      const row = await seal(this.tip());
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

  async head() {
    return this.events.at(-1);
  }

  async link(seq: number) {
    const e = this.events.find((x) => x.seq === seq);
    return e && { seq: e.seq, hash: e.hash };
  }
}

/** The hourly anchors in memory: one per hour, never replaced, as the locked R2 prefix keeps them. */
export class InMemoryAuditAnchors implements AuditAnchors {
  readonly anchors = new Map<string, AuditAnchor>();

  async write(anchor: AuditAnchor) {
    const key = auditAnchorKey(anchor.anchoredAt);
    if (this.anchors.has(key)) return false;
    this.anchors.set(key, anchor);
    return true;
  }

  async latest(now: number) {
    const from = auditAnchorKey(now - 7 * 86_400_000);
    return [...this.anchors.entries()]
      .filter(([key]) => key >= from)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .at(-1)?.[1];
  }
}

/** The audit archive in memory: a key is written once, as the locked prefix allows. */
export class InMemoryAuditArchive implements AuditArchive {
  readonly objects = new Map<string, readonly Record<string, unknown>[]>();

  async has(key: string) {
    return this.objects.has(key);
  }

  async put(key: string, rows: readonly Record<string, unknown>[]) {
    if (this.objects.has(key)) throw new Error(`${key} is locked`);
    this.objects.set(key, [...rows]);
  }

  async read(key: string) {
    return [...(this.objects.get(key) ?? [])] as AuditRow[];
  }

  async copies() {
    return [...this.objects.keys()]
      .map(parseAuditCopyKey)
      .filter((c) => c !== null)
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}
