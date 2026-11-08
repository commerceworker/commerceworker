/**
 * A scheduled action defers a publish/unpublish to a future instant. A worker
 * polls for due actions and executes them through the same use-cases a human
 * would call. The target is an entry or a whole release.
 */

import { InvalidStateError } from '../errors';

export type ScheduledActionType = 'publish' | 'unpublish';
export type ScheduledEntityType = 'Entry' | 'Release';
export type ScheduledActionStatus = 'pending' | 'completed' | 'canceled' | 'failed';

export interface ScheduledAction {
  readonly id: string;
  readonly action: ScheduledActionType;
  readonly entityType: ScheduledEntityType;
  readonly entityId: string;
  /** ISO-8601 instant at or after which the action becomes due. */
  readonly scheduledFor: string;
  readonly status: ScheduledActionStatus;
  readonly createdAt: string;
  readonly executedAt?: string;
  /** Failure reason when `status === 'failed'`. */
  readonly error?: string;
}

/** True if the action is pending and its time has arrived (`now >= scheduledFor`). */
export function isDue(action: ScheduledAction, now: string): boolean {
  return action.status === 'pending' && now >= action.scheduledFor;
}

/** Cancels a pending action. Already-run actions cannot be canceled. */
export function cancelAction(action: ScheduledAction): ScheduledAction {
  if (action.status !== 'pending') {
    throw new InvalidStateError(`Cannot cancel a ${action.status} action`);
  }
  return { ...action, status: 'canceled' };
}

/** Marks an action completed at `at`. */
export function completeAction(action: ScheduledAction, at: string): ScheduledAction {
  return { ...action, status: 'completed', executedAt: at };
}

/** Marks an action failed at `at` with a reason. */
export function failAction(action: ScheduledAction, at: string, error: string): ScheduledAction {
  return { ...action, status: 'failed', executedAt: at, error };
}
