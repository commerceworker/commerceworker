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

// ── The order's inbox ──
// An event that arrives before its wait opens (an invoice paid before the flow waits for the
// payment, a second seller answering while the acceptance loop is between passes) is held on the
// order and given to the wait when it opens, instead of being refused and left to the sender to
// try again.

/** At most this many events are held on one order. */
export const MAX_HELD_EVENTS = 20;

/**
 * An event the order holds until a step waits for it. `at` is when it arrived; `takenBy` is the
 * wait (its event type) it was given to, set before the send so a retried open resends the same
 * one, and kept until that wait closes.
 */
export type HeldEvent = {
  id: number;
  event: string;
  payload: Record<string, unknown>;
  at: number;
  takenBy?: string | null;
};

const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
        )
      : v;

/** An event and its payload as one string, whatever the order of the payload's keys. */
export const eventDigest = (event: string, payload: Record<string, unknown>) =>
  `${event}\n${JSON.stringify(stable(payload))}`;

/** Whether the flow has a Wait-for-event step listening for `event`, so holding it can help. */
export function flowAwaits(
  flow: { nodes: readonly { type: string; config?: Record<string, unknown> }[] } | null,
  event: string,
): boolean {
  return !!flow?.nodes.some((n) => n.type === 'control.wait_event' && n.config?.event === event);
}

/**
 * Why an event can't be held, or null. Only on an order still running whose flow waits for it,
 * at most `MAX_HELD_EVENTS`. An event identical to one already held, or to one already delivered
 * (`delivered`, by `eventDigest`), is a resend, not another: so a sender retrying after a lost
 * answer can't feed the next pass of a loop the same response twice. Identical events count once.
 */
export function holdProblem(
  held: readonly HeldEvent[],
  order: { running: boolean; flowAwaits: boolean; delivered?: ReadonlySet<string> },
  event: string,
  payload: Record<string, unknown>,
): 'already held' | 'already delivered' | string | null {
  if (!order.running) return 'the order has finished';
  if (!order.flowAwaits) return `no step of this order's flow waits for ${event}`;
  const digest = eventDigest(event, payload);
  if (order.delivered?.has(digest)) return 'already delivered';
  if (held.some((h) => eventDigest(h.event, h.payload) === digest)) return 'already held';
  if (held.length >= MAX_HELD_EVENTS) return `the order already holds ${MAX_HELD_EVENTS} events`;
  return null;
}

/**
 * The held event a wait that just opened takes: the one it already took (a retried open), else the
 * oldest held for its event that no other wait has taken.
 */
export function heldFor(held: readonly HeldEvent[], wait: PendingWait): HeldEvent | undefined {
  if (wait.kind !== 'event') return undefined;
  const mine = held.find((h) => h.takenBy === wait.eventType);
  if (mine) return mine;
  return [...held]
    .sort((a, b) => a.at - b.at || a.id - b.id)
    .find((h) => h.event === wait.event && !h.takenBy);
}
