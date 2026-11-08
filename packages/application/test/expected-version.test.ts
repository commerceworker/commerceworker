import { ConflictError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  getEntry,
  publishContentType,
  publishEntry,
  restoreVersion,
  SYSTEM_CALLER,
  unpublishEntry,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

async function seed(ctx: AppContext) {
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
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': 'Seen' } },
  });
  return entry.id;
}

describe('a write held to the version its caller read', () => {
  let ctx: AppContext;
  let id: string;
  beforeEach(async () => {
    ctx = makeContext();
    id = await seed(ctx);
  });

  it('publishes at the version the caller read', async () => {
    const published = await publishEntry(ctx, scope, id, { expectedVersion: 1 });
    expect(published.publishedVersion).toBe(1);
  });

  it('refuses to publish a draft saved after the caller read it, and publishes nothing', async () => {
    await updateEntry(ctx, scope, id, { title: { 'en-US': 'Unseen' } });
    const err = await publishEntry(ctx, scope, id, { expectedVersion: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.details).toEqual({ currentVersion: 2, expectedVersion: 1 });
    expect((await getEntry(ctx, scope, id)).entry.publishedVersion).toBeNull();
  });

  it('publishes as before when no version is named', async () => {
    await updateEntry(ctx, scope, id, { title: { 'en-US': 'Unseen' } });
    expect((await publishEntry(ctx, scope, id)).publishedVersion).toBe(2);
  });

  it('refuses to unpublish an entry that moved on, and leaves it live', async () => {
    await publishEntry(ctx, scope, id);
    await updateEntry(ctx, scope, id, { title: { 'en-US': 'Edited since' } });
    await expect(unpublishEntry(ctx, scope, id, { expectedVersion: 1 })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await getEntry(ctx, scope, id)).entry.publishedVersion).toBe(1);
    expect((await unpublishEntry(ctx, scope, id, { expectedVersion: 2 })).publishedVersion).toBe(
      null,
    );
  });

  it('refuses a restore over a draft saved after the caller read it', async () => {
    await updateEntry(ctx, scope, id, { title: { 'en-US': 'Second' } });
    await updateEntry(ctx, scope, id, { title: { 'en-US': 'Third, unseen' } });
    await expect(restoreVersion(ctx, scope, id, 1, { expectedVersion: 2 })).rejects.toBeInstanceOf(
      ConflictError,
    );
    const { entry, fields } = await getEntry(ctx, scope, id);
    expect(entry.currentVersion).toBe(3);
    expect(fields.title?.['en-US']).toBe('Third, unseen');
    const restored = await restoreVersion(ctx, scope, id, 1, { expectedVersion: 3 });
    expect(restored.fields.title?.['en-US']).toBe('Seen');
  });
});
