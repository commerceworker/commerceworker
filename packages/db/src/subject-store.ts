/**
 * The data subject port (`SubjectStore`, @commerceworker/ports/commerce) on D1. Moved here from the
 * engine's data subject requests and its UCP part. Emails are compared lower-cased; id lists are
 * read in runs under D1's 100-parameter limit. The contract in @commerceworker/test-kit/commerce
 * holds this and the in-memory store to the same behaviour.
 */
import {
  type CheckoutSession,
  ERASED,
  erasedCustomerEmail,
  TERMINAL_ORDER_STATUSES,
} from '@commerceworker/core';
import type { Subject, SubjectStore } from '@commerceworker/ports/commerce';
import {
  and,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from 'drizzle-orm';
import { createDb } from './index';
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
  taxCertificates,
  users,
  webhookDeliveries,
} from './schema';

/** D1 binds at most 100 parameters a statement. */
const CHUNK = 90;

const chunks = <T>(xs: readonly T[]) =>
  Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) =>
    xs.slice(i * CHUNK, (i + 1) * CHUNK),
  );

const lower = (column: SQLWrapper, email: string) => sql`lower(${column}) = ${email}`;

/** A member erased: nobody's name or email, no longer able to buy, the row kept for their orders. */
const blankedMember = {
  name: ERASED,
  email: ERASED,
  status: 'removed',
  orderLimit: null,
  teamId: null,
};

/** The ids of the company members with this email, as a subquery. */
const memberIds = (email: string) =>
  sql`(select id from company_members where lower(email) = ${email})`;

const checkoutBuyer = (email: string) =>
  sql`lower(json_extract(${checkoutSessions.data}, '$.buyer.email')) = ${email.toLowerCase()}`;

export function d1SubjectStore(d1: D1Database): SubjectStore {
  const d = createDb(d1);

  /** The subject's orders that aren't erased yet. */
  const theirs = (s: Subject) =>
    and(
      isNull(orders.erasedAt),
      or(
        lower(orders.contactEmail, s.email),
        ...chunks(s.accounts.map((c) => c.id)).map((c) => inArray(orders.customerId, c)),
        ...chunks(s.viaEmail).map((c) => inArray(orders.id, c)),
      ),
    )!;

  const inRuns = <T>(ids: readonly string[], q: (run: string[]) => Promise<T[]>) =>
    Promise.all(chunks(ids).map(q)).then((r) => r.flat());

  return {
    async subject(email) {
      const accounts = await d.select().from(customers).where(lower(customers.email, email));
      const sent = await d
        .select({ orderId: inboundEmails.orderId })
        .from(inboundEmails)
        .where(lower(inboundEmails.sender, email));
      const team = await d
        .select({ id: users.id })
        .from(users)
        .where(lower(users.email, email))
        .get();
      return {
        email,
        accounts,
        viaEmail: sent.flatMap((r) => (r.orderId ? [r.orderId] : [])),
        teamMember: !!team,
      };
    },

    orders: (s, opts) =>
      d
        .select({
          id: orders.id,
          title: orders.title,
          status: orders.status,
          channel: orders.channel,
          externalId: orders.externalId,
          createdAt: orders.createdAt,
          customerId: orders.customerId,
          currency: orders.currency,
          total: orders.total,
        })
        .from(orders)
        .where(
          opts.active
            ? and(theirs(s), notInArray(orders.status, TERMINAL_ORDER_STATUSES))
            : theirs(s),
        )
        .limit(opts.limit),

    async rows(s, orderIds) {
      const accountIds = s.accounts.map((c) => c.id);
      const where = (column: SQLWrapper) => (run: string[]) => inArray(column as never, run) as SQL;
      const [
        msgs,
        sentTo,
        docs,
        inbound,
        certificates,
        addresses,
        accountCompanies,
        memberRows,
        accountPos,
        memberPos,
      ] = await Promise.all([
        inRuns(orderIds, (r) => d.select().from(messages).where(where(messages.orderId)(r))),
        d.select().from(messages).where(lower(messages.recipient, s.email)),
        inRuns(orderIds, (r) => d.select().from(documents).where(where(documents.orderId)(r))),
        d.select().from(inboundEmails).where(lower(inboundEmails.sender, s.email)),
        inRuns(accountIds, (r) =>
          d.select().from(taxCertificates).where(where(taxCertificates.customerId)(r)),
        ),
        inRuns(accountIds, (r) =>
          d.select().from(customerAddresses).where(where(customerAddresses.customerId)(r)),
        ),
        inRuns(accountIds, (r) => d.select().from(companies).where(where(companies.customerId)(r))),
        d.select().from(companyMembers).where(lower(companyMembers.email, s.email)),
        inRuns(accountIds, (r) =>
          d.select().from(purchaseOrders).where(where(purchaseOrders.companyId)(r)),
        ),
        d
          .select()
          .from(purchaseOrders)
          .where(sql`${purchaseOrders.buyerId} in ${memberIds(s.email)}`)
          .limit(500),
      ]);
      return {
        messages: [...new Map([...msgs, ...sentTo].map((m) => [m.id, m])).values()],
        documents: docs.map((x) => ({
          key: x.r2Key,
          kind: x.kind,
          contentType: x.contentType,
          createdAt: x.createdAt,
        })),
        inboundEmails: inbound,
        taxCertificates: certificates,
        addresses,
        companies: accountCompanies,
        companyMembers: memberRows,
        purchaseOrders: [...new Map([...accountPos, ...memberPos].map((p) => [p.id, p])).values()],
      };
    },

    async checkouts(email, limit) {
      const rows = await d
        .select({ data: checkoutSessions.data })
        .from(checkoutSessions)
        .where(checkoutBuyer(email))
        .limit(limit);
      return rows.map((r) => JSON.parse(r.data) as CheckoutSession);
    },

    async buyerCarts(email, limit) {
      // '' marks a cart with no buyer to find (erased, purged or empty): never anyone's.
      if (!email) return [];
      const rows = await d
        .select({ id: carts.id })
        .from(carts)
        .where(eq(carts.buyerId, email))
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async customerCarts(customerIds, limit) {
      const rows = await inRuns(customerIds, (r) =>
        d
          .select({ id: carts.id })
          .from(carts)
          .where(and(inArray(carts.customerId, r), isNull(carts.pluginId)))
          .limit(limit),
      );
      return rows.map((r) => r.id);
    },

    async orderCarts(orderIds) {
      const rows = await inRuns(orderIds, (r) =>
        d.select({ id: carts.id }).from(carts).where(inArray(carts.orderId, r)),
      );
      return rows.map((r) => r.id);
    },

    async wasErased(target) {
      const row = await d
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(eq(auditEvents.action, 'personal_data.erased'), eq(auditEvents.target, target)))
        .limit(1)
        .get();
      return !!row;
    },

    async markOrderErased(orderId, erased, at) {
      await d
        .update(orders)
        .set({
          contactEmail: null,
          title: erased.title,
          ...(erased.clearReason ? { reason: null } : {}),
          erasedAt: at,
        })
        .where(eq(orders.id, orderId));
    },

    async eraseOrderRows(orderIds) {
      let msgs = 0;
      let inbound = 0;
      for (const c of chunks(orderIds)) {
        // The sessions that placed them keep their lines and totals for the order's events.
        for (const r of await d
          .select({ id: checkoutSessions.id, data: checkoutSessions.data })
          .from(checkoutSessions)
          .where(inArray(checkoutSessions.orderId, c))) {
          const s = JSON.parse(r.data) as CheckoutSession;
          await d
            .update(checkoutSessions)
            .set({ data: JSON.stringify({ ...s, buyer: {}, shipTo: null, issues: [] }) })
            .where(eq(checkoutSessions.id, r.id));
        }
        await d.delete(documents).where(inArray(documents.orderId, c));
        await d.delete(webhookDeliveries).where(inArray(webhookDeliveries.orderId, c));
        msgs += (
          await d
            .update(messages)
            .set({ recipient: ERASED, subject: ERASED, body: ERASED })
            .where(inArray(messages.orderId, c))
            .returning({ id: messages.id })
        ).length;
        inbound += (
          await d
            .update(inboundEmails)
            .set({ sender: ERASED, subject: '', r2Key: null })
            .where(inArray(inboundEmails.orderId, c))
            .returning({ id: inboundEmails.id })
        ).length;
      }
      return { messages: msgs, inboundEmails: inbound };
    },

    async unlinkedFiles(email) {
      const rows = await d
        .select({ r2Key: inboundEmails.r2Key })
        .from(inboundEmails)
        .where(lower(inboundEmails.sender, email));
      return rows.flatMap((r) => (r.r2Key ? [r.r2Key] : []));
    },

    async eraseUnlinked(email) {
      const inbound = await d
        .update(inboundEmails)
        .set({ sender: ERASED, subject: '', r2Key: null })
        .where(lower(inboundEmails.sender, email))
        .returning({ id: inboundEmails.id });
      const msgs = await d
        .update(messages)
        .set({ recipient: ERASED, subject: ERASED, body: ERASED })
        .where(lower(messages.recipient, email))
        .returning({ id: messages.id });
      // Sessions that never placed an order: nothing needs them.
      await d
        .delete(checkoutSessions)
        .where(and(isNull(checkoutSessions.orderId), checkoutBuyer(email)));
      return { messages: msgs.length, inboundEmails: inbound.length };
    },

    async eraseAccount(customerId) {
      const certificates = await d
        .delete(taxCertificates)
        .where(eq(taxCertificates.customerId, customerId))
        .returning({ id: taxCertificates.id });
      const addresses = await d
        .delete(customerAddresses)
        .where(eq(customerAddresses.customerId, customerId))
        .returning({ id: customerAddresses.id });
      await d
        .update(customers)
        .set({
          name: 'Erased customer',
          email: erasedCustomerEmail(customerId),
          stripeCustomerId: null,
          stripePaymentMethodId: null,
        })
        .where(eq(customers.id, customerId));
      // The company's legal name and tax id, and its people: blanked, the rows kept.
      await d
        .update(companies)
        .set({ legalName: ERASED, taxId: null })
        .where(eq(companies.customerId, customerId));
      const members = await d
        .update(companyMembers)
        .set(blankedMember)
        .where(and(eq(companyMembers.companyId, customerId), ne(companyMembers.name, ERASED)))
        .returning({ id: companyMembers.id });
      return {
        taxCertificates: certificates.length,
        addresses: addresses.length,
        companyMembers: members.length,
      };
    },

    async erasePurchaseOrders(s) {
      // The ship-to keeps its city, region, postcode and country; the buyer and notes go.
      const blank = `UPDATE purchase_orders SET notes = NULL, buyer_id = NULL,
        ship_to = CASE WHEN ship_to IS NULL THEN NULL
          ELSE json_remove(json_set(ship_to, '$.line1', ''), '$.name', '$.line2') END`;
      const statements = [
        ...chunks(s.accounts.map((c) => c.id)).map((ids) =>
          d1
            .prepare(`${blank} WHERE company_id IN (${ids.map(() => '?').join(', ')})`)
            .bind(...ids),
        ),
        d1
          .prepare(
            `${blank} WHERE buyer_id IN (SELECT id FROM company_members WHERE lower(email) = ?)`,
          )
          .bind(s.email),
      ];
      const done = await d1.batch(statements);
      // A PO of both kinds is blanked by the first statement, which nulls the buyer the second reads.
      return done.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    },

    async eraseMembers(email) {
      const gone = await d
        .update(companyMembers)
        .set(blankedMember)
        .where(lower(companyMembers.email, email))
        .returning({ id: companyMembers.id });
      return gone.length;
    },
  };
}
