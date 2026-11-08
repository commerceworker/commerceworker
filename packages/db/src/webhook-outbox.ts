/**
 * The outbound webhooks port (`WebhookOutbox`, @commerceworker/ports/commerce) on D1:
 * `webhook_subscriptions` and `webhook_deliveries`. Moved here from the engine's outbox. The
 * contract in @commerceworker/test-kit/commerce holds this and the in-memory store to the same
 * behaviour.
 */
import type { WebhookOutbox } from '@commerceworker/ports/commerce';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { createDb } from './index';
import { webhookDeliveries, webhookSubscriptions } from './schema';

/** A subscription as the admin API shows it: never a secret. */
const view = {
  id: webhookSubscriptions.id,
  url: webhookSubscriptions.url,
  events: webhookSubscriptions.events,
  active: webhookSubscriptions.active,
  createdAt: webhookSubscriptions.createdAt,
  previousExpiresAt: webhookSubscriptions.previousExpiresAt,
};

/** A LIKE pattern for ids starting with `prefix`, its wildcards escaped. */
const startsWith = (prefix: string) => `${prefix.replace(/[\\%_]/g, '\\$&')}%`;

export function d1WebhookOutbox(d1: D1Database): WebhookOutbox {
  const d = createDb(d1);
  return {
    listSubscriptions: (limit) =>
      d
        .select(view)
        .from(webhookSubscriptions)
        .orderBy(desc(webhookSubscriptions.createdAt))
        .limit(limit),
    async addSubscription(sub) {
      await d.insert(webhookSubscriptions).values(sub);
    },
    async rotateSubscription(id, secret, previousUntil) {
      // The current secret moves across in the same statement, still sealed for this row.
      const [row] = await d
        .update(webhookSubscriptions)
        .set({
          previousSecret: sql`${webhookSubscriptions.secret}`,
          secret,
          previousExpiresAt: previousUntil,
        })
        .where(eq(webhookSubscriptions.id, id))
        .returning(view);
      return row;
    },
    async deleteSubscription(id) {
      const gone = await d
        .delete(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, id))
        .returning({ id: webhookSubscriptions.id });
      return gone.length > 0;
    },
    deliveries: (subscriptionId, limit) =>
      d
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit),
    subscriptions: () =>
      d
        .select({
          id: webhookSubscriptions.id,
          url: webhookSubscriptions.url,
          secret: webhookSubscriptions.secret,
          previousSecret: webhookSubscriptions.previousSecret,
          previousExpiresAt: webhookSubscriptions.previousExpiresAt,
          events: webhookSubscriptions.events,
        })
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.active, true)),

    async record(deliveries, now) {
      const [first, ...rest] = deliveries.map((x) =>
        d
          .insert(webhookDeliveries)
          .values({
            id: x.id,
            subscriptionId: x.subscriptionId,
            orderId: x.subject,
            event: x.event,
            payload: x.payload,
            createdAt: now,
          })
          .onConflictDoNothing(),
      );
      if (first) await d.batch([first, ...rest]);
    },

    async undelivered(subject, ids, idPrefix) {
      const rows = await d
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            ne(webhookDeliveries.status, 'delivered'),
            or(
              ids.length ? inArray(webhookDeliveries.id, [...ids]) : undefined,
              and(
                eq(webhookDeliveries.orderId, subject),
                sql`${webhookDeliveries.id} LIKE ${startsWith(idPrefix)} ESCAPE '\\'`,
                sql`${webhookDeliveries.subscriptionId} LIKE 'plugin:%'`,
              ),
            ),
          ),
        );
      return rows.map((r) => ({
        id: r.id,
        subscriptionId: r.subscriptionId,
        subject: r.orderId,
        event: r.event,
        payload: r.payload,
      }));
    },

    async attempted(results, now) {
      const [u, ...us] = results.map((r) =>
        d
          .update(webhookDeliveries)
          .set({
            status: r.ok ? 'delivered' : 'failed',
            attempts: sql`${webhookDeliveries.attempts} + 1`,
            responseStatus: r.status,
            lastError: r.error,
            deliveredAt: r.ok ? now : null,
          })
          .where(eq(webhookDeliveries.id, r.id)),
      );
      if (u) await d.batch([u, ...us]);
    },

    async forget(subject, event) {
      await d
        .delete(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.orderId, subject),
            event ? eq(webhookDeliveries.event, event) : undefined,
          ),
        );
    },
  };
}
