import { type Principal, SCOPES } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addEntryToRelease,
  cancelScheduledAction,
  createContentType,
  createEntry,
  createRelease,
  getPublishedEntry,
  publishContentType,
  publishEntry,
  runDueScheduledActions,
  SYSTEM_CALLER,
  scheduleAction,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };
const T0 = '2026-01-01T00:00:00.000Z';

function makeContext(): { ctx: AppContext; clock: FixedClock } {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  const clock = new FixedClock(new Date(T0));
  return { ctx: { store, clock, ids: new SequenceIdGenerator('e') }, clock };
}

async function seedDraft(ctx: AppContext, title: string) {
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  await publishContentType(ctx, scope, 'article');
  return createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title } },
  });
}

describe('scheduled publishing', () => {
  let ctx: AppContext;
  let clock: FixedClock;
  beforeEach(() => {
    ({ ctx, clock } = makeContext());
  });

  it('does not fire an action before its time, then publishes once due', async () => {
    const entry = await seedDraft(ctx, 'Scheduled');
    await scheduleAction(ctx, scope, {
      action: 'publish',
      entityType: 'Entry',
      entityId: entry.entry.id,
      scheduledFor: '2026-01-01T01:00:00.000Z',
    });

    // Not yet due — runDue is a no-op and the entry stays unpublished.
    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 0 });
    await expect(getPublishedEntry(ctx, scope, entry.entry.id)).rejects.toThrow(/not.*found/i);

    // Advance past the scheduled instant; now it fires.
    clock.advance(60 * 60 * 1000);
    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 1, failed: 0 });
    expect((await getPublishedEntry(ctx, scope, entry.entry.id)).fields.title?.['en-US']).toBe(
      'Scheduled',
    );

    // Idempotent: the completed action does not re-run.
    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 0 });
    const [action] = await ctx.store.scheduledActions.list(scope);
    expect(action?.status).toBe('completed');
  });

  it('authorizes the principal scheduling an action against its role, now', async () => {
    const entry = await seedDraft(ctx, 'Scheduled');
    const keepsLive: Principal = {
      spaceId: scope.spaceId,
      kind: 'cma',
      scopes: [SCOPES.contentPublish],
      contentGrants: [
        { contentTypeApiId: 'article', actions: ['read', 'publish'], deniedActions: ['unpublish'] },
      ],
    };
    const at = (action: 'publish' | 'unpublish', entityType: 'Entry' | 'Release', id: string) =>
      scheduleAction(
        ctx,
        scope,
        { action, entityType, entityId: id, scheduledFor: '2026-01-01T01:00:00.000Z' },
        { principal: keepsLive },
      );
    await expect(at('unpublish', 'Entry', entry.entry.id)).rejects.toThrow(
      /content:unpublish:article/,
    );
    await at('publish', 'Entry', entry.entry.id);
    // A release with a member it would take down is refused too: it fires with no one behind it.
    await publishEntry(ctx, scope, entry.entry.id);
    const release = await createRelease(ctx, scope, { title: 'Takedown' });
    await addEntryToRelease(ctx, scope, release.id, {
      entityId: entry.entry.id,
      action: 'unpublish',
    });
    await expect(at('publish', 'Release', release.id)).rejects.toThrow(/content:unpublish:article/);
    expect(await ctx.store.scheduledActions.list(scope)).toHaveLength(1);
  });

  it('refuses adding a member a role can’t ship to a release already scheduled', async () => {
    const entry = await seedDraft(ctx, 'Live');
    await publishEntry(ctx, scope, entry.entry.id);
    const release = await createRelease(ctx, scope, { title: 'Later' });
    const other = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Other' } },
    });
    await addEntryToRelease(ctx, scope, release.id, { entityId: other.entry.id });
    await scheduleAction(ctx, scope, {
      action: 'publish',
      entityType: 'Release',
      entityId: release.id,
      scheduledFor: '2026-01-01T01:00:00.000Z',
    });
    const keepsLive: Principal = {
      spaceId: scope.spaceId,
      kind: 'cma',
      scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
      contentGrants: [
        {
          contentTypeApiId: 'article',
          actions: ['read', 'write', 'publish'],
          deniedActions: ['unpublish'],
        },
      ],
    };
    // The scheduler would ship it with no one behind it, so the member is authorized on the way in.
    await expect(
      addEntryToRelease(
        ctx,
        scope,
        release.id,
        { entityId: entry.entry.id, action: 'unpublish' },
        { principal: keepsLive },
      ),
    ).rejects.toThrow(/content:unpublish:article/);
    // No grant on the type: neither action goes in.
    await expect(
      addEntryToRelease(
        ctx,
        scope,
        release.id,
        { entityId: entry.entry.id },
        {
          principal: {
            ...keepsLive,
            contentGrants: [{ contentTypeApiId: 'page', actions: ['read', 'publish'] }],
          },
        },
      ),
    ).rejects.toThrow(/content:read:article/);
    clock.advance(60 * 60 * 1000);
    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 1, failed: 0 });
    expect((await ctx.store.entries.get(scope, entry.entry.id))?.entry.publishedVersion).toBe(1);
    // A member it may ship goes in as before.
    const next = await createRelease(ctx, scope, { title: 'Next' });
    await addEntryToRelease(
      ctx,
      scope,
      next.id,
      { entityId: entry.entry.id },
      { principal: keepsLive },
    );
  });

  it('a canceled action never fires', async () => {
    const entry = await seedDraft(ctx, 'Canceled');
    const action = await scheduleAction(ctx, scope, {
      action: 'publish',
      entityType: 'Entry',
      entityId: entry.entry.id,
      scheduledFor: '2026-01-01T01:00:00.000Z',
    });
    await cancelScheduledAction(ctx, scope, action.id);

    clock.advance(2 * 60 * 60 * 1000);
    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 0 });
    await expect(getPublishedEntry(ctx, scope, entry.entry.id)).rejects.toThrow(/not.*found/i);
  });

  it('marks an action failed (not crashing) when its target cannot publish', async () => {
    const entry = await seedDraft(ctx, 'Gone');
    await scheduleAction(ctx, scope, {
      action: 'unpublish', // entry was never published → unpublish throws
      entityType: 'Entry',
      entityId: entry.entry.id,
      scheduledFor: T0,
    });

    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 1 });
    const [action] = await ctx.store.scheduledActions.list(scope);
    expect(action?.status).toBe('failed');
    expect(action?.error).toBeTruthy();
  });
});
