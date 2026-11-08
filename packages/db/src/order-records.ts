/**
 * The order records port (`OrderRecords`, @commerceworker/ports/commerce) on D1: the `orders`
 * index columns, `node_runs` and `approvals`. Moved here from the OrderAgent. Runs and approvals
 * are inserted only if absent (their keys are the run and the wait), so a replayed report writes
 * nothing new. The contract in @commerceworker/test-kit/commerce holds this and the in-memory
 * store to the same behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import type { OrderRecords } from '@commerceworker/ports/commerce';
import { and, asc, eq } from 'drizzle-orm';
import { createDb } from './index';
import { approvals, nodeRuns, orders } from './schema';

export function d1OrderRecords(d1: D1Database, clock: Clock): OrderRecords {
  const d = createDb(d1);
  const now = () => clock.now().getTime();

  return {
    async create(row) {
      await d.insert(orders).values({
        ...row,
        status: 'queued',
        generation: 1,
        total: 0,
        updatedAt: row.createdAt,
      });
    },

    async exists(orderId) {
      return !!(await d.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get());
    },

    byIdempotencyKey: (key) =>
      d
        .select({
          id: orders.id,
          status: orders.status,
          flowId: orders.flowId,
          flowVersion: orders.flowVersion,
          instanceId: orders.instanceId,
          createdAt: orders.createdAt,
          fingerprint: orders.idempotencyFingerprint,
        })
        .from(orders)
        .where(eq(orders.idempotencyKey, key))
        .get(),

    async index(orderId, row) {
      await d
        .update(orders)
        .set({ ...row, updatedAt: now() })
        .where(eq(orders.id, orderId));
    },

    async channel(orderId) {
      const row = await d
        .select({ channel: orders.channel })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();
      return row?.channel;
    },

    async startedBy(orderId) {
      const row = await d
        .select({ startedBy: orders.startedBy })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();
      return row ? row.startedBy : undefined;
    },

    async indexed(orderId) {
      return d
        .select({
          status: orders.status,
          total: orders.total,
          fxRate: orders.fxRate,
          customerId: orders.customerId,
          title: orders.title,
          instanceId: orders.instanceId,
          generation: orders.generation,
          waitingOn: orders.waitingOn,
          waitingAt: orders.waitingAt,
          waitingSince: orders.waitingSince,
          waitingDue: orders.waitingDue,
          waitingFor: orders.waitingFor,
          stoppedAt: orders.stoppedAt,
          reason: orders.reason,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();
    },

    async recordRun(r) {
      await d
        .insert(nodeRuns)
        .values({ ...r, durationMs: r.endedAt - r.startedAt })
        .onConflictDoNothing();
    },

    async runs(orderId) {
      return (
        await d
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.orderId, orderId))
          .orderBy(asc(nodeRuns.generation), asc(nodeRuns.nodeId), asc(nodeRuns.run))
      ).map(({ durationMs: _, ...r }) => ({ ...r, status: r.status as 'succeeded' | 'failed' }));
    },

    async openApproval(a) {
      await d
        .insert(approvals)
        .values({ ...a, status: 'pending', requestedAt: now() })
        .onConflictDoNothing();
    },

    async decideApproval(orderId, eventType, decision) {
      await d
        .update(approvals)
        .set({ ...decision, decidedAt: now() })
        .where(and(eq(approvals.orderId, orderId), eq(approvals.eventType, eventType)));
    },

    async cancelApprovals(orderId) {
      await d
        .update(approvals)
        .set({ status: 'cancelled', decidedAt: now() })
        .where(and(eq(approvals.orderId, orderId), eq(approvals.status, 'pending')));
    },

    async approvals(orderId) {
      return d
        .select()
        .from(approvals)
        .where(eq(approvals.orderId, orderId))
        .orderBy(asc(approvals.requestedAt), asc(approvals.id));
    },
  };
}
