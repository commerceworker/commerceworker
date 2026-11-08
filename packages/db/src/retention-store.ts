/**
 * The retention port (`RetentionStore`, @commerceworker/ports/commerce) on D1. Moved here from the
 * engine's retention sweep. The prune is one batch (one transaction); the due lists are bounded
 * reads in a fixed order, so a sweep that stops part way picks up where it left off. The contract
 * in @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import { FINAL_CART_STATUSES, TERMINAL_ORDER_STATUSES } from '@commerceworker/core';
import type { RetentionStore } from '@commerceworker/ports/commerce';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, or } from 'drizzle-orm';
import { createDb } from './index';
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
  webhookDeliveries,
  webhookReceipts,
} from './schema';

export function d1RetentionStore(d1: D1Database): RetentionStore {
  const d = createDb(d1);
  return {
    async prune(now, policy) {
      const [s, deliveries, runs, emails, receipts, events, replays, checkouts] = await d.batch([
        d.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.tokenHash }),
        d
          .delete(webhookDeliveries)
          .where(
            and(
              lt(webhookDeliveries.createdAt, now - policy.webhookDeliveriesMs),
              ne(webhookDeliveries.status, 'pending'),
            ),
          )
          .returning({ id: webhookDeliveries.id }),
        d
          .delete(nodeRuns)
          .where(lt(nodeRuns.endedAt, now - policy.nodeRunsMs))
          .returning({ id: nodeRuns.nodeId }),
        d
          .delete(inboundEmails)
          .where(lt(inboundEmails.receivedAt, now - policy.inboundEmailsMs))
          .returning({ id: inboundEmails.id }),
        d
          .delete(webhookReceipts)
          .where(lt(webhookReceipts.receivedAt, now - policy.webhookReceiptsMs))
          .returning({ id: webhookReceipts.id }),
        d
          .delete(paymentEvents)
          .where(lt(paymentEvents.receivedAt, now - policy.paymentEventsMs))
          .returning({ id: paymentEvents.id }),
        d
          .delete(ucpIdempotency)
          .where(lt(ucpIdempotency.createdAt, now - policy.ucpIdempotencyMs))
          .returning({ key: ucpIdempotency.key }),
        d
          .delete(checkoutSessions)
          .where(
            and(
              isNull(checkoutSessions.orderId),
              lt(checkoutSessions.expiresAt, now - policy.abandonedCheckoutsMs),
            ),
          )
          .returning({ id: checkoutSessions.id }),
      ]);
      return {
        sessions: s.length,
        webhookDeliveries: deliveries.length,
        nodeRuns: runs.length,
        inboundEmails: emails.length,
        webhookReceipts: receipts.length,
        paymentEvents: events.length,
        ucpIdempotency: replays.length,
        abandonedCheckouts: checkouts.length,
      };
    },

    async endedCarts(before, limit) {
      const rows = await d
        .select({ id: carts.id })
        .from(carts)
        .where(
          and(
            isNull(carts.purgedAt),
            inArray(carts.status, [...FINAL_CART_STATUSES]),
            lt(carts.updatedAt, before),
          ),
        )
        .orderBy(asc(carts.updatedAt))
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async cartsWithoutBuyer(limit) {
      const rows = await d
        .select({ id: carts.id })
        .from(carts)
        .where(and(isNotNull(carts.pluginId), isNull(carts.buyerId)))
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async cartBuyer(id) {
      const row = await d
        .select({ buyerId: carts.buyerId })
        .from(carts)
        .where(eq(carts.id, id))
        .get();
      return row?.buyerId ?? null;
    },

    async markBuyerless(id) {
      await d
        .update(carts)
        .set({ buyerId: '' })
        .where(and(eq(carts.id, id), isNull(carts.buyerId)));
    },

    async ordersEndedBefore(before, limit) {
      return d
        .select({ id: orders.id, title: orders.title })
        .from(orders)
        .where(
          and(
            isNull(orders.erasedAt),
            inArray(orders.status, TERMINAL_ORDER_STATUSES),
            lt(orders.updatedAt, before),
          ),
        )
        .orderBy(asc(orders.updatedAt))
        .limit(limit);
    },

    async expireAddresses(before) {
      const gone = await d
        .delete(customerAddresses)
        .where(lt(customerAddresses.lastUsedAt, before))
        .returning({ id: customerAddresses.id });
      return gone.length;
    },

    unchainedAudit: (before, limit) =>
      d
        .select()
        .from(auditEvents)
        .where(and(isNull(auditEvents.seq), lt(auditEvents.at, before)))
        .orderBy(asc(auditEvents.at), asc(auditEvents.id))
        .limit(limit),

    async deleteUnchainedThrough(last) {
      await d
        .delete(auditEvents)
        .where(
          and(
            isNull(auditEvents.seq),
            or(
              lt(auditEvents.at, last.at),
              and(eq(auditEvents.at, last.at), lte(auditEvents.id, last.id)),
            ),
          ),
        );
    },

    chainedAudit: (limit) =>
      d
        .select()
        .from(auditEvents)
        .where(isNotNull(auditEvents.seq))
        .orderBy(asc(auditEvents.seq))
        .limit(limit),

    async deleteChainedThrough(seq) {
      await d.delete(auditEvents).where(lte(auditEvents.seq, seq));
    },
  };
}
