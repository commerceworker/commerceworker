/**
 * The bulk import jobs port (`BulkJobStore`, @commerceworker/ports/commerce) on D1. A chunk's
 * progress is one guarded update: it lands only while the job is running and still at the offset
 * the chunk began at, so a Workflow step retried after its progress was recorded adds nothing. The
 * contract in @commerceworker/test-kit/commerce holds this and the in-memory store to the same
 * behaviour.
 */
import { BULK_KEPT_ERRORS, type BulkKind } from '@commerceworker/core';
import type {
  BulkJob,
  BulkJobStatus,
  BulkJobStore,
  BulkRowError,
} from '@commerceworker/ports/commerce';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from './index';
import { bulkJobs } from './schema';

type Row = typeof bulkJobs.$inferSelect;

const view = (r: Row): BulkJob => ({
  id: r.id,
  kind: r.kind as BulkKind,
  checkOnly: r.checkOnly,
  fileName: r.fileName,
  sourceKey: r.sourceKey,
  reportKey: r.reportKey,
  status: r.status as BulkJobStatus,
  header: JSON.parse(r.header) as string[],
  offset: r.offset,
  nextRow: r.nextRow,
  applied: r.applied,
  failed: r.failed,
  errors: JSON.parse(r.errors) as BulkRowError[],
  error: r.error,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const sqlAdd = (c: unknown, n: number) => sql`${c} + ${n}`;

export function d1BulkJobStore(d1: D1Database): BulkJobStore {
  const d = createDb(d1);
  return {
    async create(job) {
      await d.insert(bulkJobs).values({ ...job, updatedAt: job.createdAt });
    },

    async get(id) {
      const [r] = await d.select().from(bulkJobs).where(eq(bulkJobs.id, id));
      return r ? view(r) : undefined;
    },

    async list(limit) {
      const rows = await d.select().from(bulkJobs).orderBy(desc(bulkJobs.createdAt)).limit(limit);
      return rows.map(view);
    },

    async start(id, at) {
      const r = await d
        .update(bulkJobs)
        .set({ status: 'running', updatedAt: at })
        .where(and(eq(bulkJobs.id, id), eq(bulkJobs.status, 'queued')))
        .returning({ id: bulkJobs.id });
      return r.length > 0;
    },

    async advance(id, from, chunk, at) {
      // The errors kept are merged here, read then written under the same offset guard: a write
      // that lost a race to another changes nothing.
      const current = and(
        eq(bulkJobs.id, id),
        eq(bulkJobs.status, 'running'),
        eq(bulkJobs.offset, from),
      );
      const [r] = await d.select({ errors: bulkJobs.errors }).from(bulkJobs).where(current);
      if (!r) return false;
      const kept = [...(JSON.parse(r.errors) as BulkRowError[]), ...chunk.errors]
        .sort((a, b) => a.row - b.row)
        .slice(0, BULK_KEPT_ERRORS);
      const done = await d
        .update(bulkJobs)
        .set({
          ...(chunk.header ? { header: JSON.stringify(chunk.header) } : {}),
          offset: chunk.offset,
          nextRow: chunk.nextRow,
          applied: sqlAdd(bulkJobs.applied, chunk.applied),
          failed: sqlAdd(bulkJobs.failed, chunk.failed),
          errors: JSON.stringify(kept),
          updatedAt: at,
        })
        .where(current)
        .returning({ id: bulkJobs.id });
      return done.length > 0;
    },

    async finish(id, status, at, end = {}) {
      const r = await d
        .update(bulkJobs)
        .set({
          status,
          updatedAt: at,
          ...(end.reportKey !== undefined ? { reportKey: end.reportKey } : {}),
          ...(end.error !== undefined ? { error: end.error } : {}),
        })
        .where(and(eq(bulkJobs.id, id), inArray(bulkJobs.status, ['queued', 'running'])))
        .returning({ id: bulkJobs.id });
      return r.length > 0;
    },
  };
}
