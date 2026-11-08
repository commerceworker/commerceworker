import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  countEntriesByContentType,
  createContentType,
  createEntry,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateEntry,
} from '../src/index.js';

const scope = { spaceId: 's1', environmentId: 'main' };
const other = { spaceId: 's2', environmentId: 'main' };

let ctx: AppContext;

async function defineType(at: typeof scope, apiId: string) {
  await createContentType(ctx, SYSTEM_CALLER, at, {
    apiId,
    name: apiId,
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
    ],
  });
  await publishContentType(ctx, at, apiId);
}

const write = (at: typeof scope, contentTypeApiId: string, title: string) =>
  createEntry(ctx, at, { contentTypeApiId, fields: { title: { 'en-US': title } } });

beforeEach(async () => {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  store.seedSpace({ spaceId: 's2', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await defineType(scope, 'article');
  await defineType(scope, 'author');
});

describe('entry counts by content type', () => {
  it('counts each status, and leaves the trash out of the total', async () => {
    await write(scope, 'article', 'Draft');
    const live = await write(scope, 'article', 'Live');
    await publishEntry(ctx, scope, live.entry.id);
    const edited = await write(scope, 'article', 'Edited');
    await publishEntry(ctx, scope, edited.entry.id);
    await updateEntry(ctx, scope, edited.entry.id, { title: { 'en-US': 'Edited 2' } });
    const binned = await write(scope, 'article', 'Binned');
    await trashEntry(ctx, scope, binned.entry.id);

    const counts = await countEntriesByContentType(ctx, scope);
    expect(counts.find((c) => c.contentType === 'article')).toEqual({
      contentType: 'article',
      total: 3,
      draft: 1,
      changed: 1,
      published: 1,
      archived: 1,
    });
  });

  it('lists a type with no entries as zeros', async () => {
    const counts = await countEntriesByContentType(ctx, scope);
    expect(counts.map((c) => c.contentType).sort()).toEqual(['article', 'author']);
    expect(counts.every((c) => c.total === 0 && c.archived === 0)).toBe(true);
  });

  it('counts only the scope asked about', async () => {
    await defineType(other, 'article');
    await write(other, 'article', 'Elsewhere');
    await write(other, 'article', 'Elsewhere too');
    await write(scope, 'article', 'Here');

    const here = await countEntriesByContentType(ctx, scope);
    const there = await countEntriesByContentType(ctx, other);
    expect(here.find((c) => c.contentType === 'article')?.total).toBe(1);
    expect(there).toEqual([
      { contentType: 'article', total: 2, draft: 2, changed: 0, published: 0, archived: 0 },
    ]);
  });
});
