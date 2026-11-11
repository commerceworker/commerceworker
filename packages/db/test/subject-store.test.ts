import { env } from 'cloudflare:workers';
import {
  describeSubjectStoreContract,
  type SubjectFixture,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import {
  auditEvents,
  carts,
  checkoutSessions,
  companies,
  companyMembers,
  customerAddresses,
  customers,
  documents,
  inboundEmails,
  messages,
  orders,
  purchaseOrders,
  quotes,
  taxCertificates,
  users,
} from '../src/schema';
import { d1SubjectStore } from '../src/subject-store';

const DB = (env as unknown as { DB: D1Database }).DB;

/** Writes the fixture as rows, replacing what an earlier case wrote (audit events only add). */
async function seed(f: SubjectFixture) {
  const db = createDb(DB);
  for (const [t, id] of [
    [customers, customers.id],
    [users, users.id],
    [orders, orders.id],
    [inboundEmails, inboundEmails.id],
    [messages, messages.id],
    [documents, documents.orderId],
    [taxCertificates, taxCertificates.id],
    [customerAddresses, customerAddresses.id],
    [companies, companies.customerId],
    [companyMembers, companyMembers.id],
    [purchaseOrders, purchaseOrders.id],
    [quotes, quotes.id],
    [checkoutSessions, checkoutSessions.id],
    [carts, carts.id],
  ] as const)
    await db.delete(t).where(like(id, 'sc2_%'));
  for (const c of f.customers ?? []) await db.insert(customers).values(c);
  for (const u of f.users ?? [])
    await db.insert(users).values({ ...u, name: u.id, role: 'admin', createdAt: 0 });
  for (const o of f.orders ?? [])
    await db.insert(orders).values({
      ...o,
      model: 'b2c',
      flowId: 'sc2_flow',
      flowVersion: 1,
      reason: 'Named them',
      createdAt: 0,
      updatedAt: 0,
    });
  for (const r of f.inboundEmails ?? [])
    await db.insert(inboundEmails).values({
      ...r,
      messageId: r.id,
      mailbox: 'orders',
      subject: 'PO',
      status: 'accepted',
      attachments: 0,
      receivedAt: 0,
    });
  for (const m of f.messages ?? [])
    await db.insert(messages).values({ ...m, subject: 'Hi', body: 'Hello', createdAt: 0 });
  for (const d of f.documents ?? [])
    await db.insert(documents).values({
      id: d.key,
      orderId: d.orderId,
      kind: d.kind,
      r2Key: d.key,
      contentType: 'text/html',
      createdAt: 0,
    });
  for (const c of f.taxCertificates ?? [])
    await db.insert(taxCertificates).values({
      ...c,
      number: 'TX-1',
      createdBy: 'sc2',
      createdById: 'sc2',
      createdAt: 0,
    });
  for (const a of f.addresses ?? [])
    await db.insert(customerAddresses).values({
      ...a,
      key: a.id,
      line1: '1 Main St',
      city: 'Springfield',
      postalCode: '00000',
      country: 'US',
      firstUsedAt: 0,
      lastUsedAt: 0,
      lastOrderId: 'sc2_o_acct',
    });
  for (const c of f.companies ?? [])
    await db.insert(companies).values({ ...c, status: 'active', createdAt: 0, updatedAt: 0 });
  for (const m of f.companyMembers ?? [])
    await db.insert(companyMembers).values({ ...m, role: 'buyer', createdAt: 0, updatedAt: 0 });
  for (const p of f.purchaseOrders ?? [])
    await db.insert(purchaseOrders).values({
      ...p,
      shipTo: p.shipTo ? JSON.stringify(p.shipTo) : null,
      createdAt: 0,
      updatedAt: 0,
    });
  for (const q of f.quotes ?? [])
    await db.insert(quotes).values({ ...q, rootId: q.id, createdAt: 0, updatedAt: 0 });
  for (const c of f.checkouts ?? [])
    await db.insert(checkoutSessions).values({
      id: c.id,
      ownerId: 'platform',
      status: c.orderId ? 'completed' : 'incomplete',
      data: JSON.stringify({ id: c.id, buyer: { email: c.email }, orderId: c.orderId }),
      orderId: c.orderId,
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
    });
  for (const c of f.carts ?? [])
    await db.insert(carts).values({
      ...c,
      title: c.id,
      status: 'open',
      flowId: 'sc2_flow',
      sessionRef: c.pluginId ? c.id : null,
      createdBy: 'sc2',
      createdAt: 0,
      updatedAt: 0,
    });
  for (const a of f.audit ?? [])
    await db
      .insert(auditEvents)
      .values({ ...a, at: 0 })
      .onConflictDoNothing();
}

describeSubjectStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1SubjectStore(DB);
});
