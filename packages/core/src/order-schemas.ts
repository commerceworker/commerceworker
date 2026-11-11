/**
 * The zod schemas for flows and orders, apart from types.ts so a page that needs only an order
 * status or a label doesn't load zod: these run `z.object(…)` when imported, which a bundler can't
 * drop. Their inferred types are re-exported from `@commerceworker/core` as before.
 */

import { z } from 'zod';
import {
  FULFILLMENT_METHODS,
  ORDER_CHANNELS,
  ORDER_MODELS,
  ORDER_STATUSES,
  PAYMENT_PROVIDERS,
} from './types';

export const flowNodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Node ids are 1–40 letters, digits, _ or -'),
  type: z.string(),
  label: z.string().max(80),
  config: z.record(z.string(), z.unknown()).default({}),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  /** Per-node step retry policy; the catalog supplies a default. */
  retries: z.number().int().min(0).max(10).optional(),
  /** Per-node step timeout, e.g. "30 seconds", "5 minutes". */
  timeout: z.string().optional(),
});
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  /** Output branch of the source, e.g. "true", "approved". Absent means the default "out". */
  sourceHandle: z.string().nullish(),
  /** "next" marks a loop back-edge into a `control.loop` node; anything else is a normal input. */
  targetHandle: z.string().nullish(),
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
});
export type FlowGraph = z.infer<typeof flowGraphSchema>;

export const orderLineSchema = z.object({
  sku: z.string(),
  name: z.string().optional(),
  qty: z.number().positive(),
  unitPrice: z.number().nonnegative().optional(),
  /** Marketplace seller for this line; otherwise the product's seller, or first party. */
  sellerId: z.string().optional(),
  /**
   * The store this line ships from when route fulfillment splits a shipment. Unset lines use
   * `fulfillment.locationId`, or central stock.
   */
  locationId: z.string().optional(),
});
export type OrderLine = z.infer<typeof orderLineSchema>;

/** How to reach a buyer who has no customer account (guest checkout, POS receipt). */
export const contactSchema = z.object({
  email: z.string().email(),
  name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
});
export type Contact = z.infer<typeof contactSchema>;

export const fulfillmentSchema = z.object({
  method: z.enum(FULFILLMENT_METHODS),
  /** Store or warehouse to fulfil from, e.g. the pickup store or the till's store. */
  locationId: z.string().optional(),
});
export type Fulfillment = z.infer<typeof fulfillmentSchema>;

/**
 * How the order is paid, when the caller already knows. `stripe` names a PaymentIntent to adopt,
 * a payment method to confirm, or a Stripe customer to charge off-session; `external` means the
 * channel took the money (a Shopify checkout) and `reference` is its id there.
 */
export const orderPaymentSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDERS),
  intentId: z
    .string()
    .regex(/^pi_\w+$/)
    .optional(),
  paymentMethodId: z
    .string()
    .regex(/^pm_\w+$/)
    .optional(),
  stripeCustomerId: z
    .string()
    .regex(/^cus_\w+$/)
    .optional(),
  reference: z.string().max(200).optional(),
});
export type OrderPayment = z.infer<typeof orderPaymentSchema>;

export const orderInputSchema = z.object({
  model: z.enum(ORDER_MODELS),
  channel: z.enum(ORDER_CHANNELS).default('api'),
  /** The order's id in the channel it came from (storefront, marketplace, POS). */
  externalId: z.string().max(200).optional(),
  title: z.string().max(140).optional(),
  customerId: z.string().optional(),
  currency: z.string().length(3).default('USD'),
  lines: z.array(orderLineSchema).default([]),
  contact: contactSchema.optional(),
  fulfillment: fulfillmentSchema.optional(),
  /** The shipping option the buyer chose, by id; a shipping-rate node set to `from_order` charges it. */
  shippingOption: z.string().max(80).optional(),
  payment: orderPaymentSchema.optional(),
  /** Free-form inbound document text (an email, order form or PO) for the AI extract node. */
  documentText: z.string().max(50_000).optional(),
  /** R2 key of an uploaded document. */
  documentKey: z.string().optional(),
  /** `buyerId` is the company member placing it, held to `companyOrderProblem` when it starts. */
  meta: z
    .record(z.string(), z.unknown())
    .refine((m) => m.buyerId === undefined || (typeof m.buyerId === 'string' && m.buyerId !== ''), {
      message: 'meta.buyerId must be a company member’s id',
    })
    .default({}),
});
export type OrderInput = z.infer<typeof orderInputSchema>;
/** What callers send: `channel`, `currency`, `lines` and `meta` have defaults. */
export type OrderInputDraft = z.input<typeof orderInputSchema>;

/** A request to start an order: POST /api/v1/orders, and A2A's place_order skill. */
export const startOrderSchema = z.object({
  flowId: z.string(),
  version: z.number().int().positive().optional(),
  input: orderInputSchema,
  vars: z.record(z.string(), z.unknown()).optional(),
});

/** An order as the engine holds it: its input plus the totals the pricing nodes compute. */
export const orderSchema = orderInputSchema.extend({
  id: z.string(),
  createdAt: z.number().int().describe('Epoch ms'),
  subtotal: z.number().describe('Sum of the priced lines'),
  shipping: z.number().describe('Shipping charged by a shipping-rate node; 0 when none ran'),
  tax: z.number().describe('Tax on the subtotal, plus shipping when the tax node taxes it'),
  total: z.number().describe('subtotal + shipping + tax'),
  taxRate: z.number().optional().describe('The rate the tax node applied'),
  taxShipping: z.boolean().optional().describe('Whether the tax node taxed shipping'),
  fxRate: z
    .number()
    .optional()
    .describe('Units of the order currency per one unit of the base currency, fixed when priced'),
  baseTotal: z.number().optional().describe('total in the base currency'),
});

/** A flow as the flows list shows it (`GET /api/v1/flows`). */
export const flowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  model: z.enum(ORDER_MODELS),
  channels: z.array(z.enum(ORDER_CHANNELS)),
  publishedVersion: z.number().int().nullable().describe('Null while it has never been published'),
  hasUnpublishedChanges: z.boolean().describe('Published, and the draft has changed since'),
  updatedAt: z.number().int().describe('Epoch ms'),
  nodeCount: z.number().int(),
});

/** A published, immutable flow snapshot: what an order pins. */
export const flowVersionSchema = flowGraphSchema.extend({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  model: z.enum(ORDER_MODELS),
  /** Channels this flow is meant for. */
  channels: z.array(z.enum(ORDER_CHANNELS)),
  version: z.number().int(),
  publishedAt: z.number().int().describe('Epoch ms'),
});

export const flowListSchema = z.object({ flows: z.array(flowSummarySchema) });

/** An order as the orders list shows it (`GET /api/v1/orders`): its index row, less the index's bookkeeping. */
export const orderRowSchema = z.object({
  id: z.string(),
  model: z.enum(ORDER_MODELS),
  channel: z.enum(ORDER_CHANNELS),
  externalId: z.string().nullable().describe('The order’s id in the channel it came from'),
  contactEmail: z.string().nullable(),
  status: z.enum(ORDER_STATUSES),
  title: z.string(),
  flowId: z.string(),
  flowVersion: z.number().int(),
  instanceId: z.string().nullable().describe('Null for a recorded order that has no run'),
  generation: z.number().int(),
  customerId: z.string().nullable(),
  currency: z.string(),
  total: z.number(),
  waitingOn: z.string().nullable(),
  waitingAt: z.string().nullable().describe('The steps holding its open waits, joined with ·'),
  waitingSince: z.number().int().nullable(),
  waitingDue: z.number().int().nullable().describe('When the soonest open wait times out'),
  waitingFor: z
    .string()
    .nullable()
    .describe('What the open waits are on: `person:<role>`, `event:<name>` or `timer`'),
  stoppedAt: z.string().nullable().describe('The steps it failed or stopped at'),
  reason: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  idempotencyKey: z
    .string()
    .nullable()
    .describe('The `Idempotency-Key` that started it, if the caller sent one'),
  fxRate: z
    .number()
    .describe('Units of its currency per unit of the base currency when it started'),
  startedBy: z.string().nullable(),
  erasedAt: z.number().int().nullable(),
});

/**
 * An order's index row as the orders list answers it: the index's own bookkeeping (the fingerprint
 * an idempotent start is matched by, whether an address is awaited) is not the caller's.
 */
export const orderListItem = <
  T extends { idempotencyFingerprint: unknown; addressPending: unknown },
>(
  row: T,
): Omit<T, 'idempotencyFingerprint' | 'addressPending'> => {
  const { idempotencyFingerprint: _f, addressPending: _a, ...item } = row;
  return item;
};

/** A page of orders, newest first. */
export const orderPageSchema = z.object({
  orders: z.array(orderRowSchema),
  nextCursor: z
    .string()
    .nullable()
    .describe('Pass it as `cursor` for the next page; null on the last page'),
});
