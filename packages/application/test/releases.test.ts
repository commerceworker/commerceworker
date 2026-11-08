import { ForbiddenError, InvalidStateError, type Principal, SCOPES } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addEntryToRelease,
  createContentType,
  createEntry,
  createRelease,
  getPublishedEntry,
  listReleases,
  publishContentType,
  publishEntry,
  publishRelease,
  removeEntryFromRelease,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function makeContext(): { ctx: AppContext; store: InMemoryContentStore } {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  return { ctx: { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') }, store };
}

async function seedType(ctx: AppContext) {
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
}

const draft = (ctx: AppContext, title: string) =>
  createEntry(ctx, scope, { contentTypeApiId: 'article', fields: { title: { 'en-US': title } } });

describe('releases', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  beforeEach(async () => {
    ({ ctx, store } = makeContext());
    await seedType(ctx);
  });

  it('publishes every member of a release atomically in one transaction', async () => {
    const a = await draft(ctx, 'A');
    const b = await draft(ctx, 'B');
    const release = await createRelease(ctx, scope, { title: 'Launch' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: a.entry.id });
    await addEntryToRelease(ctx, scope, release.id, { entityId: b.entry.id });

    // Neither is on the Delivery read model yet.
    await expect(getPublishedEntry(ctx, scope, a.entry.id)).rejects.toThrow(/not.*found/i);

    const shipped = await publishRelease(ctx, scope, release.id);
    expect(shipped.release.status).toBe('published');
    expect(shipped.release.publishedAt).toBeDefined();

    // Both are now published, each with its own entry.published event.
    expect((await getPublishedEntry(ctx, scope, a.entry.id)).fields.title?.['en-US']).toBe('A');
    expect((await getPublishedEntry(ctx, scope, b.entry.id)).fields.title?.['en-US']).toBe('B');
    const published = store.allEvents().filter((e) => e.type === 'entry.published');
    expect(published).toHaveLength(2);
    expect(store.allEvents().some((e) => e.type === 'release.published')).toBe(true);
  });

  it('rolls back the whole release if any member fails (all-or-nothing)', async () => {
    const a = await draft(ctx, 'A');
    const release = await createRelease(ctx, scope, { title: 'Bad batch' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: a.entry.id });
    // Inject a member that cannot publish (entry does not exist) by writing the
    // item directly, bypassing the existence check addEntryToRelease enforces.
    await store.releases.addItem(scope, release.id, {
      entityType: 'Entry',
      entityId: 'ghost',
      action: 'publish',
    });

    await expect(publishRelease(ctx, scope, release.id)).rejects.toThrow(/not.*found/i);

    // The valid member did NOT publish — the transaction rolled back.
    await expect(getPublishedEntry(ctx, scope, a.entry.id)).rejects.toThrow(/not.*found/i);
    const reloaded = await store.releases.get(scope, release.id);
    expect(reloaded?.status).toBe('open');
  });

  it('supports unpublish actions inside a release', async () => {
    const a = await draft(ctx, 'A');
    await publishEntry(ctx, scope, a.entry.id);
    const release = await createRelease(ctx, scope, { title: 'Takedown' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: a.entry.id, action: 'unpublish' });

    await publishRelease(ctx, scope, release.id);
    await expect(getPublishedEntry(ctx, scope, a.entry.id)).rejects.toThrow(/not.*found/i);
  });

  it('ships only what the principal’s role grants on each member’s type', async () => {
    const live = await draft(ctx, 'Live');
    await publishEntry(ctx, scope, live.entry.id);
    const fresh = await draft(ctx, 'Fresh');
    const release = await createRelease(ctx, scope, { title: 'Mixed' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: fresh.entry.id });
    await addEntryToRelease(ctx, scope, release.id, {
      entityId: live.entry.id,
      action: 'unpublish',
    });
    const role = (deniedActions?: readonly ('delete' | 'unpublish')[]): Principal => ({
      spaceId: scope.spaceId,
      kind: 'cma',
      scopes: [SCOPES.contentPublish],
      contentGrants: [
        {
          contentTypeApiId: 'article',
          actions: ['read', 'write', 'publish'],
          ...(deniedActions ? { deniedActions } : {}),
        },
      ],
    });

    // Publishes but withholds unpublish: the whole release is refused and nothing ships.
    await expect(
      publishRelease(ctx, scope, release.id, { principal: role(['unpublish']) }),
    ).rejects.toThrow(/content:unpublish:article/);
    await expect(getPublishedEntry(ctx, scope, fresh.entry.id)).rejects.toThrow(/not.*found/i);
    expect((await store.entries.get(scope, live.entry.id))?.entry.publishedVersion).toBe(1);
    expect((await store.releases.get(scope, release.id))?.status).toBe('open');
    // No grant on the type at all: refused on the first member, as the entry routes refuse it.
    await expect(
      publishRelease(ctx, scope, release.id, {
        principal: {
          ...role(),
          contentGrants: [{ contentTypeApiId: 'page', actions: ['publish'] }],
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // A grant stored before unpublish existed holds it with publish, and ships as it always did.
    await publishRelease(ctx, scope, release.id, { principal: role() });
    await expect(getPublishedEntry(ctx, scope, live.entry.id)).rejects.toThrow(/not.*found/i);
  });

  it('lists each release with its member count, per scope', async () => {
    const a = await draft(ctx, 'A');
    const b = await draft(ctx, 'B');
    const two = await createRelease(ctx, scope, { title: 'Two' });
    await createRelease(ctx, scope, { title: 'Empty' });
    await addEntryToRelease(ctx, scope, two.id, { entityId: a.entry.id });
    await addEntryToRelease(ctx, scope, two.id, { entityId: b.entry.id });
    // Re-adding a member replaces it rather than counting it twice.
    await addEntryToRelease(ctx, scope, two.id, { entityId: b.entry.id, action: 'unpublish' });
    const counts = async (at = scope) =>
      Object.fromEntries((await listReleases(ctx, at)).map((r) => [r.title, r.itemCount]));
    expect(await counts()).toEqual({ Two: 2, Empty: 0 });
    await removeEntryFromRelease(ctx, scope, two.id, a.entry.id);
    expect(await counts()).toEqual({ Two: 1, Empty: 0 });
    expect(await counts({ spaceId: 'space-1', environmentId: 'staging' })).toEqual({});
  });

  it('rejects publishing an empty release', async () => {
    const release = await createRelease(ctx, scope, { title: 'Empty' });
    await expect(publishRelease(ctx, scope, release.id)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('rejects modifying a release after it has shipped', async () => {
    const a = await draft(ctx, 'A');
    const release = await createRelease(ctx, scope, { title: 'Done' });
    await addEntryToRelease(ctx, scope, release.id, { entityId: a.entry.id });
    await publishRelease(ctx, scope, release.id);
    const b = await draft(ctx, 'B');
    await expect(
      addEntryToRelease(ctx, scope, release.id, { entityId: b.entry.id }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });
});
