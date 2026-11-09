/**
 * Resuming an order's waits: what an approval decision and a delivered event must look like, and
 * which open wait each resumes. Pure: the OrderAgent checks who is asking and sends the Workflow
 * the event.
 */

import { MAX_EVENT_PAYLOAD_BYTES, payloadFits } from './api';
import type { PendingWait } from './types';

/** The longest note a decision carries. */
export const MAX_DECISION_NOTE = 2000;
/** The longest business event name a wait listens for. */
export const MAX_EVENT_NAME = 100;

/** Why a decision can't be taken as sent, or null: approved or rejected, with a short note. */
export function decisionProblem(decision: unknown, note: unknown): string | null {
  if (decision !== 'approved' && decision !== 'rejected')
    return 'decision must be approved or rejected';
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_DECISION_NOTE))
    return `note must be at most ${MAX_DECISION_NOTE} characters`;
  return null;
}

/** The approval a step is waiting on. */
export const approvalWait = (waits: readonly PendingWait[], nodeId: string) =>
  waits.find((w) => w.kind === 'approval' && w.nodeId === nodeId);

/**
 * Why an event can't be delivered as sent, or null: a short name, and an object payload small
 * enough to keep (it lands in the order's variables, every broadcast and the next generation).
 */
export function eventProblem(event: unknown, payload: unknown): string | null {
  if (typeof event !== 'string' || !event || event.length > MAX_EVENT_NAME)
    return `event must be a name of at most ${MAX_EVENT_NAME} characters`;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payloadFits(payload))
    return `payload must be an object of at most ${MAX_EVENT_PAYLOAD_BYTES} bytes`;
  return null;
}

/** The step waiting for a business event, if any. */
export const eventWait = (waits: readonly PendingWait[], event: string) =>
  waits.find((w) => w.kind === 'event' && w.event === event);

/**
 * What an event's own source writes: who delivered it, when, the outcome, and a provider's
 * receipt. A caller's payload can't set them, so a hand delivery never reads as a verified one.
 */
export const RESERVED_EVENT_FIELDS: ReadonlySet<string> = new Set([
  'by',
  'event',
  'at',
  'outcome',
  'source',
  'provider',
  'invoiceId',
  'paymentIntentId',
  'note',
  'goodsBack',
]);

/** A return or claim, recorded only from the order page so it is checked against the order. */
export const RETURN_EVENT = 'return.requested';

/**
 * Why a delivered event is refused, whoever sends it (REST, a signed webhook, MCP, A2A): a return
 * that must be recorded from the order page, or a payload naming a field its source writes.
 */
export function deliveredEventProblem(
  event: string,
  payload: Record<string, unknown> | undefined,
): string | null {
  if (event === RETURN_EVENT)
    return 'Record a return or claim from the order page, so its card shows the refund.';
  const reserved = Object.keys(payload ?? {}).filter((k) => RESERVED_EVENT_FIELDS.has(k));
  if (reserved.length)
    return `payload can't set ${reserved.join(', ')}: the delivery records who sent it`;
  return null;
}
