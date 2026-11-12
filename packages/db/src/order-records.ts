/**
 * The order records port (`OrderRecords`, @commerceworker/ports/commerce) on D1: the `orders`
 * index columns, `node_runs` and `approvals`. Moved here from the OrderAgent. Runs and approvals
 * are inserted only if absent (their keys are the run and the wait), so a replayed report writes
 * nothing new. The contract in @commerceworker/test-kit/commerce holds this and the in-memory
 * store to the same behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import type { ApprovalRecord, OrderRecords } from '@commerceworker/ports/commerce';
import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import { createDb } from './index';
import { approvals, approvalVotes, nodeRuns, orders } from './schema';

/** An approvals row as the port names it: the voters' ids as a list. */
export function approvalRecord(row: typeof approvals.$inferSelect): ApprovalRecord {
  const { eligible, ...rest } = row;
  return { ...rest, eligible: eligible ? (JSON.parse(eligible) as string[]) : null };
}

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

    async staleQueued(before, limit) {
      return d
        .select({ id: orders.id, instanceId: orders.instanceId })
        .from(orders)
        .where(
          and(
            eq(orders.status, 'queued'),
            isNull(orders.idempotencyKey),
            lt(orders.createdAt, before),
          ),
        )
        .orderBy(asc(orders.createdAt))
        .limit(limit);
    },

    async failQueued(orderId, reason) {
      const done = await d
        .update(orders)
        .set({ status: 'failed', reason, updatedAt: now() })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'queued')))
        .returning({ id: orders.id });
      return done.length > 0;
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
      const r = await d
        .update(orders)
        .set({ ...row, updatedAt: now() })
        .where(eq(orders.id, orderId))
        .run();
      return (r.meta.changes ?? 0) > 0;
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
      const { eligible, ...rest } = a;
      await d
        .insert(approvals)
        .values({
          ...rest,
          ...(eligible ? { eligible: JSON.stringify(eligible) } : {}),
          status: 'pending',
          requestedAt: now(),
        })
        .onConflictDoNothing();
    },

    async recordVote(orderId, eventType, vote) {
      // The approval's id comes from the wait, in the one statement, so a vote on a wait with no
      // approval row writes nothing.
      const res = await d1
        .prepare(
          `INSERT INTO approval_votes (approval_id, voter_id, voter_kind, on_behalf_by, decision, note, at)
           SELECT id, ?, ?, ?, ?, ?, ? FROM approvals WHERE order_id = ? AND event_type = ?
           ON CONFLICT (approval_id, voter_id) DO NOTHING`,
        )
        .bind(
          vote.voterId,
          vote.voterKind,
          vote.onBehalfBy,
          vote.decision,
          vote.note,
          vote.at,
          orderId,
          eventType,
        )
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async votes(orderId, eventType) {
      return (
        await d
          .select({ vote: approvalVotes })
          .from(approvalVotes)
          .innerJoin(approvals, eq(approvals.id, approvalVotes.approvalId))
          .where(and(eq(approvals.orderId, orderId), eq(approvals.eventType, eventType)))
          .orderBy(asc(approvalVotes.at), asc(approvalVotes.voterId))
      ).map(({ vote }) => ({
        ...vote,
        voterKind: vote.voterKind as 'staff' | 'member',
        decision: vote.decision as 'approved' | 'rejected',
      }));
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
      return (
        await d
          .select()
          .from(approvals)
          .where(eq(approvals.orderId, orderId))
          .orderBy(asc(approvals.requestedAt), asc(approvals.id))
      ).map(approvalRecord);
    },
  };
}
