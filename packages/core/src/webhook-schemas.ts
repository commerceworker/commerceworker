/**
 * The zod schemas for what the webhook subscription routes answer (webhooks.ts): a subscription
 * and a delivery as the admin API shows them, never a secret except the once it is minted. Apart
 * from webhooks.ts, which stays free of zod; `apps/web/tests/rest-responses.test.ts` holds them to
 * the views the use-cases build.
 */

import { z } from 'zod';

/** A subscription as the admin API shows it. */
export const subscriptionViewSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()).describe('The events it takes; `*` is every one'),
  active: z.boolean(),
  createdAt: z.number().int().describe('Epoch ms'),
  previousExpiresAt: z
    .number()
    .int()
    .nullable()
    .describe('When the secret before a rotation stops signing; null when none is'),
});

export const subscriptionsSchema = z.object({ subscriptions: z.array(subscriptionViewSchema) });

/** A new or rotated subscription with its signing secret, shown only once. */
export const subscriptionSecretSchema = z.object({
  subscription: subscriptionViewSchema,
  secret: z.string().describe('The signing secret, `whsec_…`. It is shown only once'),
});

/** One delivery of one event to one subscription, with the payload it carried. */
export const deliveryRecordSchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  orderId: z.string().describe('The order (or cart) the event is about'),
  event: z.string(),
  payload: z.unknown().describe('The `OrderEvent` or `CartEvent` that was sent'),
  status: z.string().describe('`pending`, `delivered` or `failed`'),
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable().describe('The receiver’s last HTTP status'),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  deliveredAt: z.number().int().nullable(),
});

export const deliveriesSchema = z.object({ deliveries: z.array(deliveryRecordSchema) });
