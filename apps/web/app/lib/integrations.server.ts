/**
 * Integrations: the external systems that sign webhooks, each with its own secret and scope
 * (`IntegrationScope` and the checks in @commerceworker/core). Created, rotated and revoked through
 * `/api/v1/integrations`; a signed request names its integration with `k=` in the signature.
 */

import {
  integrationScope,
  integrationView,
  listIntegrations as listIntegrationsUseCase,
  revokeIntegration as revokeIntegrationUseCase,
} from '@commerceworker/application/commerce';
import {
  type IntegrationScope,
  newId,
  newWebhookSecret,
  ROTATION_GRACE_MS,
  secretContext,
} from '@commerceworker/core';
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

export const listIntegrations = () =>
  listIntegrationsUseCase({ integrations: integrationStore() }, Date.now());

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
  return { integration: integrationView(made, Date.now()), secret };
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
  return row ? { integration: integrationView(row, Date.now()), secret } : null;
}

/** Revoked at once, both secrets. The row stays for the audit log. */
export const revokeIntegration = (id: string) =>
  revokeIntegrationUseCase({ integrations: integrationStore() }, id, Date.now());

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
    ...integrationScope(r),
  };
}

export async function touchIntegration(id: string) {
  await integrationStore().touch(id, Date.now());
}

/** The channel of an order, for a channel-bound integration's events. Null when there's no such order. */
export async function orderChannel(orderId: string): Promise<string | null> {
  return (await orderRecords().channel(orderId)) ?? null;
}
