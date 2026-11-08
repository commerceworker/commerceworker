import { env } from 'cloudflare:workers';
import {
  describeOrderQueriesContract,
  type OrderQueriesFixture,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { d1OrderQueries } from '../src/order-queries';
import { approvals, customers, flows, flowVersions, orders } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

/** The fixture as the only orders, approvals and contract customers this file's database holds. */
async function seed(f: OrderQueriesFixture) {
  const db = createDb(DB);
  await db.delete(approvals);
  await db.delete(orders);
  for (const c of f.customers ?? [])
    await db
      .insert(customers)
      .values({ ...c, email: `${c.id}@example.com` })
      .onConflictDoNothing();
  await db.delete(flows).where(like(flows.id, 'oq_%'));
  for (const v of f.flowVersions ?? []) {
    await db
      .insert(flows)
      .values({
        id: v.flowId,
        name: v.flowId,
        model: 'b2b',
        graphJson: '{}',
        createdAt: 0,
        updatedAt: 0,
      })
      .onConflictDoNothing();
    await db.insert(flowVersions).values({
      flowId: v.flowId,
      version: v.version,
      flowJson: JSON.stringify(v.flow),
      publishedAt: 0,
    });
  }
  for (const o of f.orders ?? [])
    await db
      .insert(orders)
      .values({ ...o, flowId: o.flowId ?? 'oq_flow', flowVersion: o.flowVersion ?? 1 });
  for (const a of f.approvals ?? [])
    await db.insert(approvals).values({ ...a, eventType: `approval:${a.id}` });
}

describeOrderQueriesContract('D1', async (fixture) => {
  await seed(fixture);
  return d1OrderQueries(DB);
});
