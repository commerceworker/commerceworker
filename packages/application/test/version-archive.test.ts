import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  archiveSupersededVersions,
  createContentType,
  createEntry,
  getVersion,
  publishContentType,
  publishEntry,
  purgeEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateEntry,
  versionBodyKey,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
let ctx: AppContext;
let store: InMemoryContentStore;
let blob: FakeBlobStore;

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  blob = new FakeBlobStore();
  store.versionBodies = blob;
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('v') };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'note',
    name: 'Note',
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
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'note');
});

describe('archiving superseded version bodies', () => {
  it('moves them to object storage in batches, leaving the current and published ones', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'one' } },
    });
    await publishEntry(ctx, scope, entry.id);
    for (const t of ['two', 'three', 'four']) {
      await updateEntry(ctx, scope, entry.id, { title: { 'en-US': t } });
    }
    const live = (await store.entries.get(scope, entry.id))?.entry;
    if (!live) throw new Error('fixture');

    // A batch of one at a time: the sweep picks up where it left off.
    let total = 0;
    for (let n = await archiveSupersededVersions(ctx, blob, { limit: 1 }); n > 0; ) {
      total += n;
      n = await archiveSupersededVersions(ctx, blob, { limit: 1 });
    }
    const superseded = live.currentVersion - 2; // all but current and published
    expect(total).toBe(superseded);
    expect(blob.keys().filter((k) => k.startsWith('versions/'))).toHaveLength(superseded);
    expect(blob.keys()).not.toContain(versionBodyKey(scope, entry.id, live.currentVersion));
    expect(blob.keys()).not.toContain(
      versionBodyKey(scope, entry.id, live.publishedVersion as number),
    );

    // Every version still reads back with its body.
    for (let v = 1; v <= live.currentVersion; v++) {
      expect(Object.keys((await getVersion(ctx, scope, entry.id, v)).fields)).toEqual(['title']);
    }
  });

  it('go with their entry when it is deleted for good', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'one' } },
    });
    for (const t of ['two', 'three']) {
      await updateEntry(ctx, scope, entry.id, { title: { 'en-US': t } });
    }
    await archiveSupersededVersions(ctx, blob);
    expect(blob.keys().some((k) => k.includes(`/${entry.id}/`))).toBe(true);
    await trashEntry(ctx, scope, entry.id);
    await purgeEntry(ctx, scope, entry.id, { blob });
    expect(blob.keys().filter((k) => k.includes(`/${entry.id}/`))).toEqual([]);
  });
});
