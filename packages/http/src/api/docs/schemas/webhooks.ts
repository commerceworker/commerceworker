import { z } from 'zod';

export const webhook = z.object({
  id: z.uuid(),
  url: z.url(),
  topics: z.array(z.string()).describe('Event types, e.g. entry.published'),
  active: z.boolean(),
  environmentId: z
    .string()
    .nullable()
    .describe('The one environment whose events it receives; null for every environment'),
});

export const webhookList = z.object({ items: z.array(webhook) });

export const webhookDelivery = z.object({
  id: z.number().int(),
  webhookId: z.string(),
  eventId: z.string(),
  eventType: z
    .string()
    .optional()
    .describe('The event it carried, e.g. entry.published or webhook.test (absent on old records)'),
  status: z.enum(['success', 'failed']),
  statusCode: z.number().int().optional(),
  attempts: z.number().int().describe('Which attempt this was (1 for the first)'),
  error: z.string().optional(),
  resendOf: z.number().int().optional().describe('The delivery this one resent'),
  createdAt: z.iso.datetime(),
});

export const webhookDeliveryList = z.object({ items: z.array(webhookDelivery) });

export const queuedWebhookDelivery = z.object({
  webhookId: z.string(),
  eventId: z.string().describe('The event it carries: its delivery log line has this eventId'),
  eventType: z.string(),
  resendOf: z.number().int().optional().describe('The delivery a resend repeats'),
});
