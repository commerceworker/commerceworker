import type { AdminAuditLog, AdminAuditEvent as AuditEvent } from '@commerceworker/ports';

export class InMemoryAdminAuditLog implements AdminAuditLog {
  readonly events: AuditEvent[];
  constructor(seed: AuditEvent[] = []) {
    this.events = structuredClone(seed);
  }
  async append(seal: Parameters<AdminAuditLog['append']>[0]) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const last = this.events
        .filter((e) => e.seq !== null)
        .sort((a, b) => a.seq! - b.seq!)
        .at(-1);
      const row = await seal(last?.seq && last.hash ? { seq: last.seq, hash: last.hash } : null);
      if (this.events.some((e) => e.id === row.id))
        throw new Error('UNIQUE constraint failed: admin_audit.id');
      if (this.events.some((e) => e.seq === row.seq)) continue;
      this.events.push(structuredClone(row));
      return row;
    }
    throw new Error('UNIQUE constraint failed: admin_audit.seq');
  }
  async list(f: Parameters<AdminAuditLog['list']>[0]) {
    const rows = this.events.filter(
      (e) =>
        (!f.group || e.action.toLowerCase().startsWith(`${f.group.toLowerCase()}.`)) &&
        (!f.before ||
          e.at < f.before ||
          (!!f.beforeId && e.at === f.before && e.id < f.beforeId)) &&
        (f.after === undefined || (e.seq !== null && e.seq > f.after)),
    );
    return rows
      .sort(
        f.after !== undefined
          ? (a, b) => a.seq! - b.seq!
          : (a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(0, f.limit)
      .map((e) => structuredClone(e));
  }
  async sealedAfter(after: number | undefined, limit: number) {
    return this.events
      .filter((e) => e.seq !== null && (after === undefined || e.seq > after))
      .sort((a, b) => a.seq! - b.seq!)
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }
  async link(seq: number) {
    const row = this.events.find((e) => e.seq === seq);
    return row?.seq != null && row.hash ? { seq: row.seq, hash: row.hash } : undefined;
  }
}
