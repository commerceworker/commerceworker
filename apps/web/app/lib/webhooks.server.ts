/** Outbound webhook subscriptions. The engine's outbox (apps/engine/src/outbox.ts) delivers. */

import { newId, ROTATION_GRACE_MS, secretContext } from '@commerceworker/core';
import type { SubscriptionView } from '@commerceworker/ports/commerce';
import type { z } from 'zod';
import type { subscriptionInput } from './api-schemas';
import { sealSecret } from './data-key.server';
import { pluginInstalls, webhookOutbox } from './wire.server';

/** What the API shows: never a secret. */
const view = ({ previousExpiresAt, events, ...s }: SubscriptionView) => ({
  ...s,
  events: JSON.parse(events) as string[],
  /** When the previous secret stops signing deliveries, while a rotation is under way. */
  previousExpiresAt: previousExpiresAt && previousExpiresAt > Date.now() ? previousExpiresAt : null,
});

export async function listSubscriptions() {
  return (await webhookOutbox().listSubscriptions(500)).map(view);
}

function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The secret is returned once, here; afterwards only the receiver holds it. */
export async function createSubscription(input: z.infer<typeof subscriptionInput>) {
  const secret = newSecret();
  const id = newId('whs');
  const row = {
    id,
    url: input.url,
    events: JSON.stringify(input.events),
    createdAt: Date.now(),
  };
  await webhookOutbox().addSubscription({
    ...row,
    secret: await sealSecret(secret, secretContext.webhookSubscription(id)),
  });
  return { subscription: view({ ...row, active: true, previousExpiresAt: null }), secret };
}

/**
 * A new signing secret, returned once. For `ROTATION_GRACE_MS` deliveries carry a signature from
 * the old secret too, so the receiver can switch without rejecting any. Null for an unknown id.
 */
export async function rotateSubscription(id: string) {
  const secret = newSecret();
  const row = await webhookOutbox().rotateSubscription(
    id,
    await sealSecret(secret, secretContext.webhookSubscription(id)),
    Date.now() + ROTATION_GRACE_MS,
  );
  return row ? { subscription: view(row), secret } : null;
}

export async function deleteSubscription(id: string) {
  return webhookOutbox().deleteSubscription(id);
}

/** A sandboxed plugin's latest exceptions (its Tail Worker keeps them, scrubbed), newest first. */
export async function listPluginErrors(pluginId: string, limit = 10) {
  return (await pluginInstalls().errors(pluginId, limit)).map((e) => ({ ...e, pluginId }));
}

export async function listDeliveries(subscriptionId: string, limit = 50) {
  const rows = await webhookOutbox().deliveries(subscriptionId, limit);
  return rows.map(({ payload, ...r }) => ({ ...r, payload: JSON.parse(payload) as unknown }));
}
