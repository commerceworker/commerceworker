import {
  authorizeContent,
  InvalidStateError,
  NotFoundError,
  type Principal,
  publishRelease as publishReleaseState,
  type Release,
  type ReleaseItem,
  type ReleaseWithItems,
  type Scope,
} from '@commerceworker/domain';
import type { ContentStoreTx } from '@commerceworker/ports';
import type { AppContext } from './context';
import { assertReleaseUngated, loadPublishGuard, type PublishGrant } from './publish-gate';
import { publishEntryTx, unpublishEntryTx } from './publishing';

export interface CreateReleaseInput {
  readonly title: string;
  readonly description?: string;
}

/** Creates an open (empty) release. */
export async function createRelease(
  ctx: AppContext,
  scope: Scope,
  input: CreateReleaseInput,
): Promise<Release> {
  const release: Release = {
    id: ctx.ids.newId(),
    title: input.title,
    description: input.description,
    status: 'open',
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.releases.create(scope, release);
  return release;
}

/** A release in the list, with how many members it holds (so a list never reads each one). */
export interface ReleaseSummary extends Release {
  readonly itemCount: number;
}

/** Every release, newest first, each with its member count from one grouped query. */
export async function listReleases(ctx: AppContext, scope: Scope): Promise<ReleaseSummary[]> {
  const releases = await ctx.store.releases.list(scope);
  const counts = await ctx.store.releases.countItems(
    scope,
    releases.map((r) => r.id),
  );
  return releases.map((r) => ({ ...r, itemCount: counts.get(r.id) ?? 0 }));
}

/** Returns a release with its members. */
export async function getRelease(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<ReleaseWithItems> {
  const release = await ctx.store.releases.get(scope, id);
  if (!release) throw new NotFoundError('Release', id);
  const items = await ctx.store.releases.listItems(scope, id);
  return { release, items };
}

export interface AddReleaseItemInput {
  readonly entityId: string;
  readonly action?: ReleaseItem['action'];
}

/**
 * Adds (or replaces) an entry in an open release. Given the `principal` adding it, its role must
 * grant `read` and the item's action (`publish` or `unpublish`) on the entry's type: a release can
 * already be scheduled, and the scheduler ships it with no one behind it, so this is where the
 * member's action is authorized for that path.
 */
export async function addEntryToRelease(
  ctx: AppContext,
  scope: Scope,
  releaseId: string,
  input: AddReleaseItemInput,
  opts: { readonly principal?: Principal } = {},
): Promise<ReleaseWithItems> {
  const release = await ctx.store.releases.get(scope, releaseId);
  if (!release) throw new NotFoundError('Release', releaseId);
  if (release.status !== 'open') {
    throw new InvalidStateError(`Cannot modify a ${release.status} release`);
  }
  const found = await ctx.store.entries.get(scope, input.entityId);
  if (!found) throw new NotFoundError('Entry', input.entityId);
  const action = input.action ?? 'publish';
  if (opts.principal) {
    authorizeContent(opts.principal, ['read', action], found.entry.contentTypeApiId);
  }
  await ctx.store.releases.addItem(scope, releaseId, {
    entityType: 'Entry',
    entityId: input.entityId,
    action,
  });
  return getRelease(ctx, scope, releaseId);
}

export async function removeEntryFromRelease(
  ctx: AppContext,
  scope: Scope,
  releaseId: string,
  entityId: string,
): Promise<ReleaseWithItems> {
  const release = await ctx.store.releases.get(scope, releaseId);
  if (!release) throw new NotFoundError('Release', releaseId);
  if (release.status !== 'open') {
    throw new InvalidStateError(`Cannot modify a ${release.status} release`);
  }
  await ctx.store.releases.removeItem(scope, releaseId, entityId);
  return getRelease(ctx, scope, releaseId);
}

export async function deleteRelease(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  const release = await ctx.store.releases.get(scope, id);
  if (!release) throw new NotFoundError('Release', id);
  if (release.status === 'published') {
    throw new InvalidStateError('Cannot delete a published release');
  }
  await ctx.store.releases.delete(scope, id);
}

/**
 * Authorizes `principal` to ship a release's members as it would ship each one: `publish` on the
 * type of every publish member and `unpublish` on every unpublish member's (one narrow batch read
 * of their types). No-op for an unrestricted principal. A member that no longer exists is left to
 * the publish loop's NotFoundError.
 */
export async function authorizeReleaseMembers(
  reader: Pick<ContentStoreTx, 'entries'>,
  scope: Scope,
  items: readonly ReleaseItem[],
  principal: Principal | undefined,
): Promise<void> {
  if (!principal?.contentGrants || items.length === 0) return;
  const types = await reader.entries.contentTypesOf(
    scope,
    items.map((i) => i.entityId),
  );
  for (const item of items) {
    const type = types.get(item.entityId);
    if (type) authorizeContent(principal, item.action, type);
  }
}

/**
 * Ships a release: every member is published/unpublished inside ONE transaction,
 * so the bundle is all-or-nothing. Each member emits its usual `entry.published`
 * event (reusing the full publish fan-out), plus a summary `release.published`
 * event. If any member fails, the whole transaction rolls back and nothing ships.
 *
 * A release holding an entry a gated workflow covers is refused whole, naming every such entry
 * (adding one is allowed: gating can change before the release ships, so it is checked here, at
 * publish time). Only a run of the covering workflow (`content.publish_release`, which passes its
 * `grant`) may ship it.
 *
 * Given the `principal` shipping it, its role must grant each member's action on that member's
 * type ({@link authorizeReleaseMembers}); the scheduler, which ships a release on its own, passes
 * none.
 */
export async function publishRelease(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: { readonly grant?: PublishGrant; readonly principal?: Principal } = {},
): Promise<ReleaseWithItems> {
  return ctx.store.withTransaction(async (tx) => {
    const release = await tx.releases.get(scope, id);
    if (!release) throw new NotFoundError('Release', id);
    const items = await tx.releases.listItems(scope, id);
    if (items.length === 0) throw new InvalidStateError('Cannot publish an empty release');
    await authorizeReleaseMembers(tx, scope, items, opts.principal);

    const guard = await loadPublishGuard(tx.workflowGraphs, scope, opts.grant);
    await assertReleaseUngated(tx, scope, id, items, guard);

    const shipped = publishReleaseState(release, ctx.clock.now().toISOString());

    const entryIds: string[] = [];
    for (const item of items) {
      if (item.action === 'publish') {
        await publishEntryTx(ctx, tx, scope, item.entityId, {}, guard);
      } else {
        await unpublishEntryTx(ctx, tx, scope, item.entityId);
      }
      entryIds.push(item.entityId);
    }

    await tx.releases.save(scope, shipped);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'release.published',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      releaseId: shipped.id,
      entryIds,
    });

    return { release: shipped, items };
  });
}
