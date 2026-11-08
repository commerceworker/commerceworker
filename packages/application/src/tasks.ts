import {
  NotFoundError,
  reassignTask as reassignTaskState,
  reopenTask as reopenTaskState,
  resolveTask as resolveTaskState,
  type Scope,
  type Task,
} from '@commerceworker/domain';
import type { AppContext } from './context';

export interface CreateTaskInput {
  readonly entryId: string;
  readonly body: string;
  readonly assignee?: string;
}

/** Creates an open task on an entry. */
export async function createTask(
  ctx: AppContext,
  scope: Scope,
  input: CreateTaskInput,
): Promise<Task> {
  if (!(await ctx.store.entries.get(scope, input.entryId))) {
    throw new NotFoundError('Entry', input.entryId);
  }
  const task: Task = {
    id: ctx.ids.newId(),
    entryId: input.entryId,
    assignee: input.assignee ?? null,
    body: input.body,
    status: 'open',
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.tasks.create(scope, task);
  return task;
}

export async function listTasks(ctx: AppContext, scope: Scope, entryId: string): Promise<Task[]> {
  return ctx.store.tasks.listForEntry(scope, entryId);
}

async function loadTask(ctx: AppContext, scope: Scope, id: string): Promise<Task> {
  const task = await ctx.store.tasks.get(scope, id);
  if (!task) throw new NotFoundError('Task', id);
  return task;
}

export async function resolveTask(ctx: AppContext, scope: Scope, id: string): Promise<Task> {
  const updated = resolveTaskState(await loadTask(ctx, scope, id), ctx.clock.now().toISOString());
  await ctx.store.tasks.save(scope, updated);
  return updated;
}

export async function reopenTask(ctx: AppContext, scope: Scope, id: string): Promise<Task> {
  const updated = reopenTaskState(await loadTask(ctx, scope, id));
  await ctx.store.tasks.save(scope, updated);
  return updated;
}

export async function reassignTask(
  ctx: AppContext,
  scope: Scope,
  id: string,
  assignee: string | null,
): Promise<Task> {
  const updated = reassignTaskState(await loadTask(ctx, scope, id), assignee);
  await ctx.store.tasks.save(scope, updated);
  return updated;
}

export async function deleteTask(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await loadTask(ctx, scope, id);
  await ctx.store.tasks.delete(scope, id);
}
