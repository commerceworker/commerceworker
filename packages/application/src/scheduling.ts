import {
  authorizeContent,
  cancelAction,
  completeAction,
  failAction,
  InvalidStateError,
  NotFoundError,
  type Principal,
  type ScheduledAction,
  type ScheduledActionType,
  type ScheduledEntityType,
  type Scope,
  SYSTEM_ACTOR,
} from '@commerceworker/domain';
import { type AppContext, withActor } from './context';
import { assertReleaseUngated, loadPublishGuard } from './publish-gate';
import { publishEntry, unpublishEntry } from './publishing';
import { authorizeReleaseMembers, publishRelease } from './releases';

export interface ScheduleActionInput {
  readonly action: ScheduledActionType;
  readonly entityType: ScheduledEntityType;
  readonly entityId: string;
  /** ISO-8601 instant the action becomes due. */
  readonly scheduledFor: string;
}

/**
 * Schedules a publish/unpublish of an entry or release for a future instant.
 *
 * A publish of something a gated workflow covers is refused now (`PublishGatedError`), and again
 * when it fires, since gating can be turned on in between: a scheduled publish never runs from a
 * workflow run, so it can never pass a gate (not even one a workflow's `content.schedule` node
 * created).
 *
 * The action fires later with no one behind it, so the `principal` scheduling it is authorized now:
 * its role must grant the action (`publish` or `unpublish`) on the entry's type, or on every
 * release member's.
 */
export async function scheduleAction(
  ctx: AppContext,
  scope: Scope,
  input: ScheduleActionInput,
  opts: { readonly principal?: Principal } = {},
): Promise<ScheduledAction> {
  // Validate the target exists now (it may still be deleted before firing — the
  // worker handles that by failing the action rather than crashing).
  if (input.entityType === 'Entry') {
    const found = await ctx.store.entries.get(scope, input.entityId);
    if (!found) throw new NotFoundError('Entry', input.entityId);
    if (opts.principal)
      authorizeContent(opts.principal, input.action, found.entry.contentTypeApiId);
    if (input.action === 'publish') {
      const guard = await loadPublishGuard(ctx.store.workflowGraphs, scope);
      guard.assert(input.entityId, found.entry.contentTypeApiId);
    }
  } else {
    if (!(await ctx.store.releases.get(scope, input.entityId))) {
      throw new NotFoundError('Release', input.entityId);
    }
    if (input.action === 'publish') {
      const guard = await loadPublishGuard(ctx.store.workflowGraphs, scope);
      const items = await ctx.store.releases.listItems(scope, input.entityId);
      await authorizeReleaseMembers(ctx.store, scope, items, opts.principal);
      await assertReleaseUngated(ctx.store, scope, input.entityId, items, guard);
    }
  }

  const action: ScheduledAction = {
    id: ctx.ids.newId(),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    scheduledFor: input.scheduledFor,
    status: 'pending',
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.scheduledActions.create(scope, action);
  return action;
}

export async function listScheduledActions(
  ctx: AppContext,
  scope: Scope,
  query: { status?: string } = {},
): Promise<ScheduledAction[]> {
  return ctx.store.scheduledActions.list(scope, query);
}

/** Cancels a pending scheduled action so it never fires. */
export async function cancelScheduledAction(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<ScheduledAction> {
  const action = await ctx.store.scheduledActions.get(scope, id);
  if (!action) throw new NotFoundError('ScheduledAction', id);
  const canceled = cancelAction(action);
  await ctx.store.scheduledActions.save(scope, canceled);
  return canceled;
}

/** Executes one action's effect through the normal use-cases. */
async function execute(ctx: AppContext, scope: Scope, action: ScheduledAction): Promise<void> {
  if (action.entityType === 'Entry') {
    if (action.action === 'publish') await publishEntry(ctx, scope, action.entityId);
    else await unpublishEntry(ctx, scope, action.entityId);
    return;
  }
  // Release
  if (action.action === 'publish') {
    await publishRelease(ctx, scope, action.entityId);
    return;
  }
  throw new InvalidStateError('Unpublishing a release is not supported');
}

export interface RunDueResult {
  readonly executed: number;
  readonly failed: number;
}

/**
 * Runs every scheduled action whose time has arrived (across all scopes). Each
 * action is executed independently: a failure marks just that action `failed`
 * (a publish a workflow now gates fails with the `PublishGatedError` message
 * naming the workflow) and the loop continues. Called on a timer by the worker. Idempotent by status
 * — a completed/canceled action is never re-run.
 */
export async function runDueScheduledActions(
  ctx: AppContext,
  opts: { limit?: number } = {},
): Promise<RunDueResult> {
  const now = ctx.clock.now().toISOString();
  const due = await ctx.store.scheduledActions.findDue(now, opts.limit);
  let executed = 0;
  let failed = 0;
  // Nobody is at the keyboard when a schedule fires: the publish is written as the system.
  const acting = withActor(ctx, SYSTEM_ACTOR);
  for (const { scope, action } of due) {
    try {
      await execute(acting, scope, action);
      await ctx.store.scheduledActions.save(scope, completeAction(action, now));
      executed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.store.scheduledActions.save(scope, failAction(action, now, message));
      failed += 1;
    }
  }
  return { executed, failed };
}
