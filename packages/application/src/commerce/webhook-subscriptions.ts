/**
 * Reading outbound webhook subscriptions and their deliveries, as the admin API and the MCP tools
 * show them: never a secret. Time comes in as `now`.
 */
import type { SubscriptionView, WebhookOutbox } from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

/** Subscriptions listed at most. */
const SUBSCRIPTIONS_MAX = 500;

/** What the API shows: never a secret. */
export const subscriptionView = (
  { previousExpiresAt, events, ...s }: SubscriptionView,
  now: number,
) => ({
  ...s,
  events: JSON.parse(events) as string[],
  /** When the previous secret stops signing deliveries, while a rotation is under way. */
  previousExpiresAt: previousExpiresAt && previousExpiresAt > now ? previousExpiresAt : null,
});

export async function listWebhookSubscriptions(ports: { outbox: WebhookOutbox }, now: number) {
  return (await ports.outbox.listSubscriptions(SUBSCRIPTIONS_MAX)).map((s) =>
    subscriptionView(s, now),
  );
}

/** One subscription as the admin API shows it, or undefined for an unknown id. */
export async function getWebhookSubscription(
  ports: { outbox: WebhookOutbox },
  id: string,
  now: number,
) {
  return (await listWebhookSubscriptions(ports, now)).find((s) => s.id === id);
}

/**
 * Removes a subscription, and with it the record of its deliveries. The audit event is the one
 * the REST API and MCP both write; `error` says why nothing was removed.
 */
export async function removeWebhookSubscription(
  ports: { outbox: WebhookOutbox },
  id: string,
): Promise<{ ok: true; audit: AuditDraft } | { ok: false; error: string }> {
  if (!(await ports.outbox.deleteSubscription(id)))
    return { ok: false, error: `No webhook subscription ${id}.` };
  return { ok: true, audit: { action: 'webhook.unsubscribed', target: id, detail: {} } };
}

/** A subscription's latest deliveries, newest first, each with the payload it carried. */
export async function listWebhookDeliveries(
  ports: { outbox: WebhookOutbox },
  subscriptionId: string,
  limit = 50,
) {
  const rows = await ports.outbox.deliveries(subscriptionId, limit);
  return rows.map(({ payload, ...r }) => ({ ...r, payload: JSON.parse(payload) as unknown }));
}
