/**
 * Reading outbound webhook subscriptions and their deliveries, as the admin API and the MCP tools
 * show them: never a secret. Time comes in as `now`.
 */
import type { SubscriptionView, WebhookOutbox } from '@commerceworker/ports/commerce';

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

/** A subscription's latest deliveries, newest first, each with the payload it carried. */
export async function listWebhookDeliveries(
  ports: { outbox: WebhookOutbox },
  subscriptionId: string,
  limit = 50,
) {
  const rows = await ports.outbox.deliveries(subscriptionId, limit);
  return rows.map(({ payload, ...r }) => ({ ...r, payload: JSON.parse(payload) as unknown }));
}
