import type { AdminAuditLog } from '@commerceworker/ports';
import { and, asc, desc, eq, gt, isNotNull, lt, or } from 'drizzle-orm';
import { type AuthDb, appendAudit, authDbOf, startsWith } from './auth';
import { adminAudit as events } from './auth-schema';

export const createAdminAuditLog = (d1: D1Database): AdminAuditLog =>
  adminAuditQueries(authDbOf(d1));
export function adminAuditQueries(db: AuthDb): AdminAuditLog {
  return {
    append: (seal) => appendAudit(db, seal),
    list: (f) => {
      const forward = f.after !== undefined;
      return db
        .select()
        .from(events)
        .where(
          and(
            f.group ? startsWith(events.action, `${f.group}.`) : undefined,
            f.before
              ? f.beforeId
                ? or(
                    lt(events.at, f.before),
                    and(eq(events.at, f.before), lt(events.id, f.beforeId)),
                  )
                : lt(events.at, f.before)
              : undefined,
            forward ? and(isNotNull(events.seq), gt(events.seq, f.after!)) : undefined,
          ),
        )
        .orderBy(...(forward ? [asc(events.seq)] : [desc(events.at), desc(events.id)]))
        .limit(f.limit);
    },
    sealedAfter: (after, limit) =>
      db
        .select()
        .from(events)
        .where(and(isNotNull(events.seq), after === undefined ? undefined : gt(events.seq, after)))
        .orderBy(asc(events.seq))
        .limit(limit),
    async link(seq) {
      const row = await db
        .select({ seq: events.seq, hash: events.hash })
        .from(events)
        .where(eq(events.seq, seq))
        .get();
      return row?.seq != null && row.hash ? { seq: row.seq, hash: row.hash } : undefined;
    },
  };
}
