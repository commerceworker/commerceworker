import { env } from 'cloudflare:workers';
import {
  describeRetentionStoreContract,
  type RetentionFixture,
} from '@commerceworker/test-kit/commerce';
import { createDb } from '../src/index';
import { d1RetentionStore } from '../src/retention-store';
import {
  auditEvents,
  carts,
  checkoutSessions,
  customerAddresses,
  inboundEmails,
  nodeRuns,
  orders,
  paymentEvents,
  sessions,
  ucpIdempotency,
  users,
  webhookDeliveries,
  webhookReceipts,
} from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

/** Writes the fixture as rows in each table, clearing what an earlier case left. */
async function seed(f: RetentionFixture) {
  const db = createDb(DB);
  const tables = [
    sessions,
    webhookDeliveries,
    nodeRuns,
    inboundEmails,
    webhookReceipts,
    paymentEvents,
    ucpIdempotency,
    checkoutSessions,
    carts,
    orders,
    customerAddresses,
    auditEvents,
  ];
  for (const t of tables) await db.delete(t);
  await db
    .insert(users)
    .values({ id: 'rc_user', email: 'rc@example.com', name: 'RC', role: 'admin', createdAt: 0 })
    .onConflictDoNothing();
  for (const r of f.rows ?? []) {
    switch (r.table) {
      case 'sessions':
        await db
          .insert(sessions)
          .values({ tokenHash: r.id, userId: 'rc_user', createdAt: 0, expiresAt: r.at });
        break;
      case 'webhookDeliveries':
        await db.insert(webhookDeliveries).values({
          id: r.id,
          subscriptionId: 'rc_sub',
          orderId: 'rc_order',
          event: 'order.completed',
          payload: '{}',
          status: r.pending ? 'pending' : 'delivered',
          attempts: 1,
          createdAt: r.at,
        });
        break;
      case 'nodeRuns':
        await db.insert(nodeRuns).values({
          orderId: r.id,
          generation: 1,
          nodeId: 'n',
          run: 1,
          nodeType: 'commerce.price',
          model: 'b2b',
          status: 'succeeded',
          startedAt: r.at,
          endedAt: r.at,
          durationMs: 0,
        });
        break;
      case 'inboundEmails':
        await db.insert(inboundEmails).values({
          id: r.id,
          messageId: r.id,
          mailbox: 'orders',
          sender: 'a@example.com',
          subject: 'PO',
          status: 'accepted',
          attachments: 0,
          receivedAt: r.at,
        });
        break;
      case 'webhookReceipts':
        await db.insert(webhookReceipts).values({ id: r.id, receivedAt: r.at });
        break;
      case 'paymentEvents':
        await db
          .insert(paymentEvents)
          .values({ id: r.id, provider: 'stripe', type: 'invoice.paid', receivedAt: r.at });
        break;
      case 'ucpIdempotency':
        await db
          .insert(ucpIdempotency)
          .values({ ownerId: 'rc_platform', key: r.id, requestHash: 'h', createdAt: r.at });
        break;
      case 'abandonedCheckouts':
        await db.insert(checkoutSessions).values({
          id: r.id,
          ownerId: 'rc_platform',
          status: r.orderId ? 'completed' : 'incomplete',
          data: '{}',
          orderId: r.orderId ?? null,
          createdAt: r.at,
          updatedAt: r.at,
          expiresAt: r.at,
        });
        break;
    }
  }
  for (const c of f.carts ?? [])
    await db.insert(carts).values({
      id: c.id,
      title: c.id,
      status: c.status,
      flowId: 'rc_flow',
      pluginId: c.pluginId,
      sessionRef: c.pluginId ? c.id : null,
      createdBy: 'rc',
      createdAt: 0,
      updatedAt: c.updatedAt,
      buyerId: c.buyerId,
      purgedAt: c.purgedAt ?? null,
    });
  for (const o of f.orders ?? [])
    await db.insert(orders).values({
      id: o.id,
      model: 'b2b',
      status: o.status,
      title: o.title,
      flowId: 'rc_flow',
      flowVersion: 1,
      createdAt: 0,
      updatedAt: o.updatedAt,
      erasedAt: o.erasedAt ?? null,
    });
  for (const a of f.addresses ?? [])
    await db.insert(customerAddresses).values({
      id: a.id,
      customerId: a.customerId,
      key: a.id,
      line1: '1 Main St',
      city: 'Springfield',
      postalCode: '00000',
      country: 'US',
      firstUsedAt: a.lastUsedAt,
      lastUsedAt: a.lastUsedAt,
      lastOrderId: 'rc_order',
    });
  for (const e of f.audit ?? [])
    await db.insert(auditEvents).values({ id: e.id, at: e.at, action: 'test', seq: e.seq });
}

describeRetentionStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1RetentionStore(DB);
});
