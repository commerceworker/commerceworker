/** Request bodies for /api/v1. Shared by the handlers and the OpenAPI document. */

import {
  isWebhookUrl,
  LINK_REDIRECT_URIS_MAX,
  linkRedirectShapeProblem,
  MAX_EVENT_PAYLOAD_BYTES,
  OPERATION_FIELDS,
  ORDER_CHANNELS,
  OUTBOUND_EVENTS,
  payloadFits,
  WEBHOOK_URL_RULE,
} from '@commerceworker/core';
import { z } from 'zod';

const payload = z
  .record(z.string(), z.unknown())
  .refine(payloadFits, `payload must be at most ${MAX_EVENT_PAYLOAD_BYTES} bytes of JSON`)
  .optional();

export const eventSchema = z.object({
  orderId: z.string().min(1).max(100),
  event: z.string().min(1).max(100),
  payload,
});

export const orderEventInput = eventSchema.omit({ orderId: true });

// The order and cart bodies are built from the fields MCP's tools take (OPERATION_FIELDS in
// @commerceworker/core), so both transports bound them alike; tests/rest-mcp-parity.test.ts holds
// each body to its tool.
const F = OPERATION_FIELDS;

export const decisionInput = z.object({
  decision: F.decision,
  note: F.decisionNote.optional(),
  onBehalfOf: F.onBehalfOf.optional(),
});

/** REST's reason is optional (it defaults to "Cancelled via API"); MCP's assistant asks for one. */
export const cancelInput = z.object({ reason: F.cancelReason.optional() });

/**
 * Holds a submit to the cart version the caller read (`version` in GET /carts/:id, its ETag).
 * `cartVersion`, MCP's name for it, is taken too.
 */
export const submitCartInput = z.object({
  version: F.cartVersion.optional(),
  cartVersion: F.cartVersion.optional(),
});

/** A staff cart: who opens it is the caller, never the body. */
export const createCartInput = z.object({
  title: F.cartTitle,
  /** A published flow with a Price lines step; it prices the cart and runs its order. */
  flowId: F.cartFlowId,
  customerId: F.cartCustomerId.nullable().optional(),
});

export const subscriptionInput = z.object({
  url: z.string().url().refine(isWebhookUrl, WEBHOOK_URL_RULE),
  events: z
    .array(z.enum(['*', ...OUTBOUND_EVENTS]))
    .min(1)
    .default(['*']),
});

/** An integration's name and scope (`IntegrationScope` in @commerceworker/core). */
export const integrationInput = z.object({
  name: z.string().trim().min(1).max(100),
  /** Events it may deliver; `"*"` is any. */
  events: z.array(z.string().min(1).max(100)).max(50).default([]),
  startOrders: z.boolean().default(false),
  /** Flows an order body may name; `"*"` is any. */
  flows: z.array(z.string().min(1).max(100)).max(50).default([]),
  channel: z.enum(ORDER_CHANNELS).nullable().optional(),
});

/** A data subject request: the person, by the email address they're known by. */
export const dataSubjectInput = z.object({ email: z.string().trim().email().max(320) });

/** A UCP platform an admin lets in: its name and the profile it must name in UCP-Agent. */
export const platformInput = z.object({
  name: z.string().trim().min(1).max(100),
  profileUrl: z
    .string()
    .url()
    .max(500)
    .refine((u) => u.startsWith('https://'), 'The profile must be served over https'),
  redirectUris: z
    .array(
      z
        .string()
        .max(2000)
        .superRefine((u, ctx) => {
          const problem = linkRedirectShapeProblem(u);
          if (problem) ctx.addIssue({ code: 'custom', message: problem });
        }),
    )
    .max(LINK_REDIRECT_URIS_MAX)
    .refine((us) => new Set(us).size === us.length, 'Each return address once')
    .default([])
    .describe(
      'The exact return addresses identity linking may send a shopper back to (https, no fragment). A platform with none can’t link a shopper',
    ),
});
