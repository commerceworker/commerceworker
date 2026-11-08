/**
 * The payments ledger port (`PaymentLedger`, @commerceworker/ports/commerce) on D1: the `payments`
 * table and the saved card on `customers`. Moved here from the engine's payment gateway. Rows are
 * inserted only if absent; status changes are guarded by the status they leave, and a capture's two
 * writes share one batch (one transaction). The contract in @commerceworker/test-kit/commerce holds
 * this and the in-memory ledger to the same behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import type { NewPayment, PaymentLedger } from '@commerceworker/ports/commerce';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from './index';
import { customers, payments } from './schema';

/** D1 binds at most 100 parameters per statement. */
const IDS_PER_QUERY = 90;

const row = (p: NewPayment, createdAt: number) => ({
  ...p,
  ref: p.ref ?? null,
  externalId: p.externalId ?? null,
  currency: p.currency ?? null,
  createdAt,
});

export function d1PaymentLedger(d1: D1Database, clock: Clock): PaymentLedger {
  const d = createDb(d1);
  const now = () => clock.now().getTime();
  const find = (id: string) => d.select().from(payments).where(eq(payments.id, id)).get();

  return {
    find,

    async findMany(ids) {
      const unique = [...new Set(ids)];
      const out = [];
      for (let i = 0; i < unique.length; i += IDS_PER_QUERY)
        out.push(
          ...(await d
            .select()
            .from(payments)
            .where(inArray(payments.id, unique.slice(i, i + IDS_PER_QUERY)))
            .orderBy(asc(payments.id))),
        );
      return out;
    },

    async record(p) {
      await d.insert(payments).values(row(p, now())).onConflictDoNothing();
      return (await find(p.id))!;
    },

    async forOrder(orderId) {
      return d
        .select()
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(asc(payments.createdAt), asc(payments.id));
    },

    async forExternalId(externalId) {
      return d
        .select()
        .from(payments)
        .where(eq(payments.externalId, externalId))
        .orderBy(asc(payments.createdAt), asc(payments.id));
    },

    async voidAuthorization(id) {
      const res = await d
        .update(payments)
        .set({ status: 'voided' })
        .where(and(eq(payments.id, id), eq(payments.status, 'authorized')))
        .returning({ id: payments.id });
      return res.length > 0;
    },

    async voidIntent(externalId) {
      const res = await d
        .update(payments)
        .set({ status: 'voided' })
        .where(
          and(
            eq(payments.externalId, externalId),
            eq(payments.provider, 'stripe'),
            eq(payments.status, 'authorized'),
          ),
        )
        .returning({ orderId: payments.orderId });
      return res.map((r) => r.orderId);
    },

    async capture(authorizationId, c) {
      const v = row(c, now());
      await d.batch([
        d
          .update(payments)
          .set({ status: 'captured', ref: c.id })
          .where(and(eq(payments.id, authorizationId), eq(payments.status, 'authorized'))),
        d
          .insert(payments)
          .select(
            d
              .select({
                id: sql`${v.id}`.as('id'),
                orderId: sql`${v.orderId}`.as('order_id'),
                kind: sql`${v.kind}`.as('kind'),
                amount: sql`${v.amount}`.as('amount'),
                status: sql`${v.status}`.as('status'),
                ref: sql`${v.ref}`.as('ref'),
                createdAt: sql`${v.createdAt}`.as('created_at'),
                provider: sql`${v.provider}`.as('provider'),
                externalId: sql`${v.externalId}`.as('external_id'),
                currency: sql`${v.currency}`.as('currency'),
              })
              .from(payments)
              .where(
                and(
                  eq(payments.id, authorizationId),
                  eq(payments.status, 'captured'),
                  eq(payments.ref, c.id),
                ),
              ),
          )
          .onConflictDoNothing(),
      ]);
      return find(c.id);
    },

    async customer(customerId) {
      return d
        .select({
          id: customers.id,
          name: customers.name,
          email: customers.email,
          stripeCustomerId: customers.stripeCustomerId,
          paymentMethodId: customers.stripePaymentMethodId,
        })
        .from(customers)
        .where(eq(customers.id, customerId))
        .get();
    },

    async saveCard(customerId, card) {
      await d
        .update(customers)
        .set({
          stripePaymentMethodId: card.paymentMethodId,
          ...(card.stripeCustomerId ? { stripeCustomerId: card.stripeCustomerId } : {}),
        })
        .where(eq(customers.id, customerId));
    },

    async claimStripeCustomer(customerId, stripeCustomerId) {
      await d
        .update(customers)
        .set({ stripeCustomerId })
        .where(and(eq(customers.id, customerId), sql`${customers.stripeCustomerId} is null`));
      const stored = await d
        .select({ id: customers.stripeCustomerId })
        .from(customers)
        .where(eq(customers.id, customerId))
        .get();
      return stored?.id ?? stripeCustomerId;
    },
  };
}
