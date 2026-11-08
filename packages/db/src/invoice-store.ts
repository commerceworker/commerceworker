/**
 * The invoices port (`InvoiceStore`, @commerceworker/ports/commerce) on D1. Moved here from the
 * engine's billing. An invoice is inserted only if absent; each status change is guarded by the
 * status it leaves; marking one paid and recording its payment share one batch (one transaction).
 * The contract in @commerceworker/test-kit/commerce holds this and the in-memory store to the same
 * behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import type { InvoiceStore } from '@commerceworker/ports/commerce';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from './index';
import { invoices, payments } from './schema';

export function d1InvoiceStore(d1: D1Database, clock: Clock): InvoiceStore {
  const d = createDb(d1);
  const now = () => clock.now().getTime();
  const find = (id: string) => d.select().from(invoices).where(eq(invoices.id, id)).get();

  return {
    async open(inv) {
      await d
        .insert(invoices)
        .values({ ...inv, createdAt: now() })
        .onConflictDoNothing();
      return (await find(inv.id))!;
    },

    find,

    findByExternalId: (externalId) =>
      d.select().from(invoices).where(eq(invoices.externalId, externalId)).get(),

    forOrder: (orderId) =>
      d
        .select()
        .from(invoices)
        .where(eq(invoices.orderId, orderId))
        .orderBy(asc(invoices.createdAt), asc(invoices.id)),

    async markDraft(id, externalId) {
      await d
        .update(invoices)
        .set({ status: 'draft', externalId })
        .where(and(eq(invoices.id, id), eq(invoices.status, 'pending')));
    },

    async markOpen(id, issued) {
      await d
        .update(invoices)
        .set({ status: 'open', ...issued })
        .where(and(eq(invoices.id, id), inArray(invoices.status, ['pending', 'draft'])));
    },

    async markVoid(id, from) {
      const res = await d
        .update(invoices)
        .set({ status: 'void' })
        .where(and(eq(invoices.id, id), eq(invoices.status, from)))
        .returning({ id: invoices.id });
      return res.length > 0;
    },

    async markPaid(id, p) {
      const at = now();
      const [marked] = await d.batch([
        d
          .update(invoices)
          .set({ status: 'paid', paidAt: at })
          .where(and(eq(invoices.id, id), inArray(invoices.status, ['pending', 'draft', 'open'])))
          .returning({ id: invoices.id }),
        d
          .insert(payments)
          .select(
            d
              .select({
                id: sql`${p.id}`.as('id'),
                orderId: sql`${p.orderId}`.as('order_id'),
                kind: sql`${p.kind}`.as('kind'),
                amount: sql`${p.amount}`.as('amount'),
                status: sql`${p.status}`.as('status'),
                ref: sql`${p.ref ?? null}`.as('ref'),
                createdAt: sql`${at}`.as('created_at'),
                provider: sql`${p.provider}`.as('provider'),
                externalId: sql`${p.externalId ?? null}`.as('external_id'),
                currency: sql`${p.currency ?? null}`.as('currency'),
              })
              .from(invoices)
              .where(and(eq(invoices.id, id), eq(invoices.status, 'paid'))),
          )
          .onConflictDoNothing(),
      ]);
      return marked.length > 0;
    },
  };
}
