/**
 * Integrations: the external systems that sign webhooks, each with its own secret and scope
 * (`IntegrationScope` and the checks in @commerceworker/core). Created, rotated and revoked through
 * `/api/v1/integrations`; a signed request names its integration with `k=` in the signature.
 */

import {
  type IntegrationScope,
  newId,
  newWebhookSecret,
  type OrderChannel,
  ROTATION_GRACE_MS,
  secretContext,
} from '@commerceworker/core';
import type { IntegrationView } from '@commerceworker/ports/commerce';
import type { z } from 'zod';
import type { integrationInput } from './api-schemas';
import { openSecret, sealSecret } from './data-key.server';
import { integrationStore, orderRecords } from './wire.server';

export type Integration = IntegrationScope & {
  id: string;
  name: string;
  secret: string;
  previousSecret: string | null;
  previousExpiresAt: number | null;
};

const scope = (r: IntegrationView): IntegrationScope => ({
  events: JSON.parse(r.events) as string[],
  startOrders: r.startOrders,
  flows: JSON.parse(r.flows) as string[],
  channel: (r.channel as OrderChannel | null) ?? null,
});

/** What the API shows: never a secret. */
const view = (r: IntegrationView) => ({
  id: r.id,
  name: r.name,
  ...scope(r),
  createdAt: r.createdAt,
  createdBy: r.createdBy,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
  /** When the previous secret stops working, while a rotation is under way. */
  previousExpiresAt:
    r.previousExpiresAt && r.previousExpiresAt > Date.now() ? r.previousExpiresAt : null,
});

export async function listIntegrations() {
  return (await integrationStore().list(500)).map(view);
}

/** The secret is returned once, here; afterwards only the sender holds it. */
export async function createIntegration(input: z.infer<typeof integrationInput>, by: string) {
  const secret = newWebhookSecret();
  const id = newId('int');
  const row = {
    id,
    name: input.name,
    events: JSON.stringify(input.events),
    startOrders: input.startOrders,
    flows: JSON.stringify(input.flows),
    channel: input.channel ?? null,
    createdAt: Date.now(),
    createdBy: by,
  };
  await integrationStore().add({
    ...row,
    secret: await sealSecret(secret, secretContext.integration(id)),
  });
  const made = { ...row, lastUsedAt: null, revokedAt: null, previousExpiresAt: null };
  return { integration: view(made), secret };
}

/**
 * A new secret; the current one keeps working for `ROTATION_GRACE_MS`, so the sender can switch
 * without a gap. Null for an unknown or revoked integration.
 */
export async function rotateIntegration(id: string) {
  const secret = newWebhookSecret();
  // One guarded write: the current secret moves across, only while the integration is live.
  const row = await integrationStore().rotate(
    id,
    await sealSecret(secret, secretContext.integration(id)),
    Date.now() + ROTATION_GRACE_MS,
  );
  return row ? { integration: view(row), secret } : null;
}

/** Revoked at once, both secrets. The row stays for the audit log. */
export async function revokeIntegration(id: string) {
  const row = await integrationStore().revoke(id, Date.now());
  return row ? view(row) : null;
}

/** The integration a signature names, with its secrets, if it exists and isn't revoked. */
export async function findIntegration(id: string): Promise<Integration | null> {
  const r = await integrationStore().active(id);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    secret: await openSecret(r.secret, secretContext.integration(r.id)),
    previousSecret:
      r.previousSecret && (await openSecret(r.previousSecret, secretContext.integration(r.id))),
    previousExpiresAt: r.previousExpiresAt,
    ...scope(r),
  };
}

export async function touchIntegration(id: string) {
  await integrationStore().touch(id, Date.now());
}

/** The channel of an order, for a channel-bound integration's events. Null when there's no such order. */
export async function orderChannel(orderId: string): Promise<string | null> {
  return (await orderRecords().channel(orderId)) ?? null;
}
