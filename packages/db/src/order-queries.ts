/**
 * The order queries port (`OrderQueries`, @commerceworker/ports/commerce) on D1, over the orders
 * index and approvals. Moved here from the workspace assistant. Totals compare in the base
 * currency at each order's own rate. The contract in @commerceworker/test-kit/commerce holds this
 * and the in-memory store to the same behaviour.
 */
import type { OrderQueries } from '@commerceworker/ports/commerce';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { createDb } from './index';
import { contains, endsWith } from './match';
import { approvals, customers, flowVersions, orders } from './schema';

const DAY = 86_400_000;

export function d1OrderQueries(d1: D1Database): OrderQueries {
  const d = createDb(d1);
  const n = sql<number>`count(*)`;
  return {
    async attention(now, cap) {
      const failedWhere = and(
        inArray(orders.status, ['failed', 'rolled_back']),
        gte(orders.updatedAt, now - 3 * DAY),
      );
      // Waiting too long counts from when the current wait opened; an order indexed before
      // `waiting_since` was recorded falls back to its last change.
      const since = sql<number>`coalesce(${orders.waitingSince}, ${orders.updatedAt})`;
      const stalledWhere = and(
        eq(orders.status, 'waiting'),
        isNotNull(orders.waitingOn),
        lte(since, now - DAY),
      );
      const [pending, pendingN, failed, failedN, stalled, stalledN] = await d.batch([
        d
          .select({
            id: approvals.id,
            orderId: approvals.orderId,
            nodeId: approvals.nodeId,
            title: approvals.title,
            amount: approvals.amount,
            requestedAt: approvals.requestedAt,
          })
          .from(approvals)
          .where(eq(approvals.status, 'pending'))
          .orderBy(asc(approvals.requestedAt))
          .limit(cap),
        d.select({ n }).from(approvals).where(eq(approvals.status, 'pending')),
        d
          .select({
            id: orders.id,
            title: orders.title,
            status: orders.status,
            updatedAt: orders.updatedAt,
          })
          .from(orders)
          .where(failedWhere)
          .orderBy(desc(orders.updatedAt))
          .limit(cap),
        d.select({ n }).from(orders).where(failedWhere),
        d
          .select({
            id: orders.id,
            title: orders.title,
            waitingOn: orders.waitingOn,
            waitingSince: orders.waitingSince,
            updatedAt: orders.updatedAt,
          })
          .from(orders)
          .where(stalledWhere)
          .orderBy(asc(since))
          .limit(cap),
        d.select({ n }).from(orders).where(stalledWhere),
      ]);
      return {
        approvals: pending,
        failed,
        stalled,
        counts: {
          approvals: pendingN[0]?.n ?? 0,
          failed: failedN[0]?.n ?? 0,
          stalled: stalledN[0]?.n ?? 0,
        },
      };
    },

    async find(f, now) {
      const base = sql<number>`(${orders.total} / ${orders.fxRate})`;
      const where = and(
        f.status ? eq(orders.status, f.status) : undefined,
        f.model ? eq(orders.model, f.model) : undefined,
        f.channel ? eq(orders.channel, f.channel) : undefined,
        f.customer
          ? or(contains(customers.name, f.customer), eq(orders.customerId, f.customer))
          : undefined,
        f.q
          ? or(contains(orders.id, f.q), contains(orders.title, f.q), contains(customers.name, f.q))
          : undefined,
        f.minTotal !== undefined ? gte(base, f.minTotal) : undefined,
        f.maxTotal !== undefined ? lte(base, f.maxTotal) : undefined,
        f.sinceDays ? gte(orders.createdAt, now - f.sinceDays * DAY) : undefined,
      );
      const sort =
        f.sort === 'largest'
          ? desc(base)
          : f.sort === 'updated'
            ? desc(orders.updatedAt)
            : desc(orders.createdAt);
      const [rows, totals] = await d.batch([
        d
          .select({
            id: orders.id,
            title: orders.title,
            model: orders.model,
            channel: orders.channel,
            status: orders.status,
            customer: customers.name,
            total: orders.total,
            currency: orders.currency,
            waitingOn: orders.waitingOn,
            waitingAt: orders.waitingAt,
            stoppedAt: orders.stoppedAt,
            createdAt: orders.createdAt,
            updatedAt: orders.updatedAt,
          })
          .from(orders)
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .where(where)
          .orderBy(sort)
          .limit(f.limit),
        d
          .select({ n, sum: sql<number>`coalesce(sum(${base}), 0)` })
          .from(orders)
          .leftJoin(customers, eq(customers.id, orders.customerId))
          .where(where),
      ]);
      return { orders: rows, count: totals[0]?.n ?? 0, total: totals[0]?.sum ?? 0 };
    },

    startedWithKey: (key) =>
      d
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(eq(orders.idempotencyKey, key))
        .get(),

    async unfinished(ended) {
      const rows = await d
        .select({
          id: orders.id,
          flowId: orders.flowId,
          version: orders.flowVersion,
          json: flowVersions.flowJson,
        })
        .from(orders)
        .innerJoin(
          flowVersions,
          and(eq(flowVersions.flowId, orders.flowId), eq(flowVersions.version, orders.flowVersion)),
        )
        .where(notInArray(orders.status, [...ended]));
      return rows.map(({ json, ...r }) => ({ ...r, flow: JSON.parse(json) as unknown }));
    },

    async resolveId(ref) {
      const exact = await d.select({ id: orders.id }).from(orders).where(eq(orders.id, ref)).get();
      if (exact) return exact.id;
      const tail = await d
        .select({ id: orders.id })
        .from(orders)
        .where(endsWith(orders.id, ref))
        .limit(2);
      return tail.length === 1 ? tail[0]!.id : null;
    },
  };
}
