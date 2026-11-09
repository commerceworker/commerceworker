/** Outbound webhook subscriptions. The engine's outbox (apps/engine/src/outbox.ts) delivers. */

import {
  listWebhookDeliveries,
  listWebhookSubscriptions,
  subscriptionView,
} from '@commerceworker/application/commerce';
import { newId, ROTATION_GRACE_MS, secretContext } from '@commerceworker/core';
import type { z } from 'zod';
import type { subscriptionInput } from './api-schemas';
import { sealSecret } from './data-key.server';
import { pluginInstalls, webhookOutbox } from './wire.server';

export const listSubscriptions = () =>
  listWebhookSubscriptions({ outbox: webhookOutbox() }, Date.now());

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
  return {
    subscription: subscriptionView({ ...row, active: true, previousExpiresAt: null }, Date.now()),
    secret,
  };
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
  return row ? { subscription: subscriptionView(row, Date.now()), secret } : null;
}

export async function deleteSubscription(id: string) {
  return webhookOutbox().deleteSubscription(id);
}

/** A sandboxed plugin's latest exceptions (its Tail Worker keeps them, scrubbed), newest first. */
export async function listPluginErrors(pluginId: string, limit = 10) {
  return (await pluginInstalls().errors(pluginId, limit)).map((e) => ({ ...e, pluginId }));
}

export const listDeliveries = (subscriptionId: string, limit = 50) =>
  listWebhookDeliveries({ outbox: webhookOutbox() }, subscriptionId, limit);
