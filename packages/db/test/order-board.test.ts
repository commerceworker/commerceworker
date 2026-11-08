import { env } from 'cloudflare:workers';
import {
  approvalRecord,
  describeOrderBoardContract,
  indexedOrder,
  type OrderBoardFixture,
} from '@commerceworker/test-kit/commerce';
import { eq, like } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from '../src/index';
import { d1OrderBoard } from '../src/order-board';
import {
  approvals,
  customers,
  documents,
  entitlements,
  flows,
  flowVersions,
  inboundEmails,
  invoices,
  locations,
  messages,
  nodeRuns,
  orders,
  payments,
  payouts,
  reservations,
  sellerOrders,
  sellers,
  shipments,
} from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

/** The fixture as the only rows the board reads in this file's database. */
async function seed(f: OrderBoardFixture) {
  const db = createDb(DB);
  for (const t of [
    approvals,
    orders,
    nodeRuns,
    documents,
    messages,
    payments,
    shipments,
    sellerOrders,
    payouts,
    invoices,
    reservations,
    entitlements,
    inboundEmails,
  ])
    await db.delete(t);
  await db.delete(customers).where(like(customers.id, 'ob_%'));
  await db.delete(sellers).where(like(sellers.id, 'ob_%'));
  await db.delete(locations).where(like(locations.id, 'ob_%'));
  await db.delete(flows).where(like(flows.id, 'ob_%'));
  const each = async <T>(xs: T[] | undefined, write: (x: T, i: number) => Promise<unknown>) => {
    for (const [i, x] of (xs ?? []).entries()) await write(x, i);
  };
  await each(f.customers, (c) =>
    db.insert(customers).values({ ...c, email: `${c.id}@example.com` }),
  );
  await each(f.flows, (fl) =>
    db.insert(flows).values({ ...fl, model: 'b2b', graphJson: '{}', createdAt: 0, updatedAt: 0 }),
  );
  await each(f.flowVersions, (v) =>
    db.insert(flowVersions).values({
      flowId: v.flowId,
      version: v.version,
      flowJson: JSON.stringify({ id: v.flowId, nodes: v.nodes, edges: [] }),
      publishedAt: 0,
    }),
  );
  await each(f.orders, (o) => db.insert(orders).values(indexedOrder(o)));
  await each(f.approvals, (a) => db.insert(approvals).values(approvalRecord(a)));
  await each(f.runs, (r) => db.insert(nodeRuns).values(r));
  await each(f.documents, (x) => db.insert(documents).values(x));
  await each(f.messages, (x) => db.insert(messages).values(x));
  await each(f.payments, (x) => db.insert(payments).values(x));
  await each(f.shipments, (x) => db.insert(shipments).values(x));
  await each(f.sellers, (x) => db.insert(sellers).values({ ...x, email: `${x.id}@example.com` }));
  await each(f.sellerOrders, (x, i) =>
    db.insert(sellerOrders).values({ id: `ob_so_${i}`, lines: '[]', ...x }),
  );
  await each(f.locations, (x) => db.insert(locations).values(x));
  await each(f.payouts, (x, i) =>
    db.insert(payouts).values({ id: `ob_po_${i}`, gross: x.net + x.commission, ...x }),
  );
  await each(f.invoices, (x) =>
    db.insert(invoices).values({ provider: 'mock', terms: 'net_30', ...x }),
  );
  await each(f.reservations, (x, i) =>
    db
      .insert(reservations)
      .values({ id: `ob_res_${i}`, sku: 'OB-SKU', qty: 1, createdAt: 1, ...x }),
  );
  await each(f.entitlements, (x, i) =>
    db
      .insert(entitlements)
      .values({ id: `ob_ent_${i}`, sku: 'OB-SKU', code: `code-${i}`, createdAt: 1, ...x }),
  );
  await each(f.inboundEmails, (x) => db.insert(inboundEmails).values(x));
}

describeOrderBoardContract('D1', async (fixture) => {
  await seed(fixture);
  return d1OrderBoard(DB);
});

it('keeps a later page of approvals in place when a row before it is decided', async () => {
  const at = (id: string, requestedAt: number) => ({
    orders: [{ id: `ob_${id}`, status: 'waiting', createdAt: requestedAt }],
    approvals: [
      { id: `apr_ob_${id}`, orderId: `ob_${id}`, nodeId: 'mgr', title: 'x', requestedAt },
    ],
  });
  const parts = [at('a', 100), at('b', 200), at('c', 300), at('d', 400)];
  await seed({
    orders: parts.flatMap((p) => p.orders),
    approvals: parts.flatMap((p) => p.approvals),
  });
  const board = d1OrderBoard(DB);
  const one = await board.approvals('pending', null, 2);
  await createDb(DB)
    .update(approvals)
    .set({ status: 'approved' })
    .where(eq(approvals.id, 'apr_ob_a'));
  const two = await board.approvals('pending', one.next, 2);
  // An offset would now skip apr_ob_c; the keyset starts after the last row shown.
  expect(two.rows.map((r) => r.id)).toEqual(['apr_ob_c', 'apr_ob_d']);
  expect(two).toMatchObject({ from: 1, total: 3, next: null });
});
