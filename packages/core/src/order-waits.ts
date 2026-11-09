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
