/**
 * The zod schemas for what the engine answers (`EngineRpc`, api.ts), apart from api.ts so a page
 * that needs only `mergeTimeline` doesn't load zod. The REST API's OpenAPI document describes
 * these responses from them; `tests/response-schemas.test.ts` holds each to the TypeScript type
 * it describes, so the two can't drift.
 */

import { z } from 'zod';
import { APPROVAL_MODES } from './b2b/approvals';
import { flowVersionSchema, orderSchema } from './order-schemas';
import { NODE_STATUSES, ORDER_STATUSES } from './types';

export const nodeRunSchema = z.object({
  status: z.enum(NODE_STATUSES),
  runs: z.number().int().describe('How many times the node has started'),
  summary: z.string().optional().describe('One line for the node card, e.g. "Reserved 3 lines"'),
  output: z.unknown().optional(),
  error: z.string().optional(),
  branches: z.array(z.string()).optional().describe('The output branches it chose'),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});

/** What a node needs from the outside world while the Workflow waits on it. */
export const pendingWaitSchema = z.object({
  nodeId: z.string(),
  eventType: z.string().describe('The Workflow event type that resumes this wait'),
  kind: z.enum(['approval', 'event']),
  title: z.string(),
  event: z.string().optional().describe('For event waits, the business event name'),
  amount: z.number().optional(),
  assignee: z.string().optional(),
  approval: z
    .object({
      approvers: z.string().describe('The approvers as the flow wrote them'),
      mode: z.enum(APPROVAL_MODES),
      quorum: z.number().optional(),
      majorityPercent: z.number().optional(),
      companyId: z.string().optional(),
      eligible: z
        .array(z.string())
        .nullable()
        .describe('The ids who may vote; null when any staff with the role may'),
    })
    .optional()
    .describe('For approval waits: who may vote and how many votes decide it'),
  deadline: z.number().optional(),
  since: z.number(),
});

export const timelineEntrySchema = z.object({
  at: z.number(),
  nodeId: z.string().optional(),
  kind: z.enum(['node', 'order', 'event', 'approval', 'ai', 'rollback', 'chat']),
  message: z.string(),
  data: z.unknown().optional(),
  key: z.string().optional().describe('Dedupe key: a repeat with the same key replaces'),
});

/** An order's live state from its agent (`GET /api/v1/orders/{id}`). */
export const orderStateSchema = z.object({
  orderId: z.string().nullable(),
  status: z.enum(ORDER_STATUSES),
  order: orderSchema.nullable(),
  flow: flowVersionSchema.nullable().describe('The flow version the order is pinned to'),
  nodes: z.record(z.string(), nodeRunSchema).describe('Each node’s run, by node id'),
  edges: z.record(z.string(), z.enum(['pending', 'active', 'inactive'])),
  waits: z.array(pendingWaitSchema),
  vars: z.record(z.string(), z.unknown()),
  timeline: z.array(timelineEntrySchema),
  instanceId: z.string().nullable().describe('The Workflow instance currently driving the order'),
  generation: z.number().int().describe('1 for the first run; increments on each continue-as-new'),
  rollback: z
    .object({ outcome: z.enum(['complete', 'failed']), error: z.string().nullable() })
    .nullable(),
  reason: z.string().optional().describe('Why it was cancelled or failed'),
  updatedAt: z.number(),
  seq: z
    .number()
    .int()
    .optional()
    .describe(
      'The sequence of the last Workflow report the agent applied. It rises with each, within a `generation` (a new one restarts it), so of two states of an order the higher `seq` of the same `generation` is the newer: drop an update whose `seq` is lower',
    ),
});

/** `POST /api/v1/orders/{id}/events` and the signed `/webhooks/events`: where the event went. */
export const sendEventResultSchema = z.object({
  delivered: z.boolean().describe('A step that was waiting took it'),
  held: z
    .literal(true)
    .optional()
    .describe('No step waits for it yet; the order holds it until one does'),
  duplicate: z.literal(true).optional().describe('A resend of one already given to a step'),
  nodeId: z.string().optional().describe('The step that took it'),
});

/** A vote on an approval that counted. */
export const decisionResultSchema = z.object({
  ok: z.literal(true),
  outcome: z
    .enum(['recorded', 'approved', 'rejected'])
    .describe(
      '`recorded` when more votes are needed and the order still waits, else `approved` or `rejected`',
    ),
  tally: z.string().describe('The approvals so far of those needed, like "1 of 2"'),
});

/** An order that was cancelled. */
export const cancelResultSchema = z.object({ ok: z.literal(true) });

/** What a verified Stripe event did (`POST /api/v1/webhooks/stripe`). */
export const paymentEventResultSchema = z.object({
  outcome: z
    .enum(['handled', 'duplicate', 'ignored', 'retry'])
    .describe(
      '`handled` (acted on), `duplicate` (this event id was handled before), `ignored` (not one CommerceWorker acts on) or `retry` (the order is not waiting for it yet)',
    ),
  orderId: z.string().optional(),
  delivered: z.string().optional().describe('The order event delivered to a waiting node'),
  reason: z.string().optional(),
  mismatch: z
    .literal(true)
    .optional()
    .describe('What the event says does not match the payments ledger and cannot be fixed from it'),
});

/** What a refused request answers: why, and for an invalid body one issue per field. */
export const errorSchema = z.object({
  error: z.string(),
  issues: z
    .array(z.unknown())
    .optional()
    .describe('What was wrong, when the refusal has several things to say'),
});

/** An order started (`POST /api/v1/orders`). */
export const startOrderResultSchema = z.object({
  orderId: z.string(),
  replayed: z.boolean().optional().describe('True when the Idempotency-Key had started this order'),
});
