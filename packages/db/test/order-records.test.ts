import { env } from 'cloudflare:workers';
import {
  describeOrderRecordsContract,
  type OrderRecordsFixture,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { d1OrderRecords } from '../src/order-records';
import { approvals, nodeRuns, orders } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;
let tick = 0;
// The clock moves on between writes, so approvals read oldest first as the in-memory store does.
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

/** Clears every contract order's rows and starts the fixture's orders. */
async function seed(f: OrderRecordsFixture) {
  const db = createDb(DB);
  await db.delete(approvals).where(like(approvals.orderId, 'oc_%'));
  await db.delete(nodeRuns).where(like(nodeRuns.orderId, 'oc_%'));
  await db.delete(orders).where(like(orders.id, 'oc_%'));
  for (const id of f.orders ?? [])
    await db.insert(orders).values({
      id,
      model: 'b2b',
      status: 'queued',
      flowId: 'flow_contract',
      flowVersion: 1,
      createdAt: 0,
      updatedAt: 0,
      startedBy: f.startedBy?.[id] ?? null,
      ...(f.channels?.[id] ? { channel: f.channels[id] } : {}),
    });
}

describeOrderRecordsContract('D1', async (fixture) => {
  await seed(fixture);
  return d1OrderRecords(DB, clock);
});
