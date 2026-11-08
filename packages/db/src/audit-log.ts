/**
 * The audit trail port (`AuditLog`, @commerceworker/ports/commerce) on D1, over `appendAudit`
 * (./audit), whose unique `seq` keeps the chain from forking. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory log to the same behaviour.
 */
import type { SealedAuditRow } from '@commerceworker/core';
import type { AuditLog } from '@commerceworker/ports/commerce';
import { and, asc, desc, eq, gt, isNotNull, lt } from 'drizzle-orm';
import { appendAudit } from './audit';
import { createDb } from './index';
import { startsWith } from './match';
import { auditEvents } from './schema';

export function d1AuditLog(d1: D1Database): AuditLog {
  const d = createDb(d1);
  return {
    append: async (seal) => (await appendAudit(d, seal as never)) as unknown as SealedAuditRow,
    list: (f) => {
      const forward = f.after !== undefined;
      return d
        .select()
        .from(auditEvents)
        .where(
          and(
            f.group ? startsWith(auditEvents.action, `${f.group}.`) : undefined,
            f.before ? lt(auditEvents.at, f.before) : undefined,
            forward ? and(isNotNull(auditEvents.seq), gt(auditEvents.seq, f.after!)) : undefined,
          ),
        )
        .orderBy(forward ? asc(auditEvents.seq) : desc(auditEvents.at))
        .limit(f.limit);
    },
    sealedAfter: async (after, limit) =>
      (await d
        .select()
        .from(auditEvents)
        .where(
          and(
            isNotNull(auditEvents.seq),
            after === undefined ? undefined : gt(auditEvents.seq, after),
          ),
        )
        .orderBy(asc(auditEvents.seq))
        .limit(limit)) as SealedAuditRow[],
    async link(seq) {
      const row = await d
        .select({ seq: auditEvents.seq, hash: auditEvents.hash })
        .from(auditEvents)
        .where(eq(auditEvents.seq, seq))
        .get();
      return row?.seq != null && row.hash ? { seq: row.seq, hash: row.hash } : undefined;
    },
  };
}
