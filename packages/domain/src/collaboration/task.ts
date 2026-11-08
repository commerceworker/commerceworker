/**
 * A task attached to an entry — a unit of editorial work ("write alt text",
 * "review copy"). Assignee is a caller-supplied label (no user model yet).
 */
import { InvalidStateError } from '../errors';

export type TaskStatus = 'open' | 'resolved';

export interface Task {
  readonly id: string;
  readonly entryId: string;
  readonly assignee: string | null;
  readonly body: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

/** Marks a task resolved at `at`. Resolving an already-resolved task is a no-op error. */
export function resolveTask(task: Task, at: string): Task {
  if (task.status === 'resolved') throw new InvalidStateError('Task is already resolved');
  return { ...task, status: 'resolved', resolvedAt: at };
}

/** Reopens a resolved task. */
export function reopenTask(task: Task): Task {
  if (task.status === 'open') throw new InvalidStateError('Task is already open');
  return { ...task, status: 'open', resolvedAt: undefined };
}

/** Reassigns a task to a different assignee (or unassigns with null). */
export function reassignTask(task: Task, assignee: string | null): Task {
  return { ...task, assignee };
}
