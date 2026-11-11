/**
 * The zod schemas for what the integration routes answer (integrations.ts): an integration as the
 * admin API shows it, never a secret except the once it is minted. Apart from integrations.ts,
 * which stays free of zod; `apps/web/tests/rest-responses.test.ts` holds them to the view the
 * use-case builds.
 */

import { z } from 'zod';
import { ORDER_CHANNELS } from './types';

/** An integration, the signing key of an external system, as the admin API shows it. */
export const integrationViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  events: z.array(z.string()).describe('The events it may deliver; `*` is any'),
  startOrders: z.boolean().describe('Whether it may start orders'),
  flows: z.array(z.string()).describe('The flows an order may name; `*` is any'),
  channel: z.enum(ORDER_CHANNELS).nullable().describe('The one channel it may reach, if any'),
  createdAt: z.number().int().describe('Epoch ms'),
  createdBy: z.string().nullable(),
  lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
  previousExpiresAt: z
    .number()
    .int()
    .nullable()
    .describe('When the secret before a rotation stops working; null when none is'),
});

export const integrationsSchema = z.object({ integrations: z.array(integrationViewSchema) });

/** A new or rotated integration with its signing secret, shown only once. */
export const integrationSecretSchema = z.object({
  integration: integrationViewSchema,
  secret: z.string().describe('The signing secret, `whsec_…`. It is shown only once'),
});

/** A deletion or revocation that took effect. */
export const okSchema = z.object({ ok: z.literal(true) });
