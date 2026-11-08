import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  listPreviewEntries,
  listPublishedEntries,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US', 'de-DE'] });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

/** Seeds the article type and a fixed corpus of published entries. */
async function seedCorpus(ctx: AppContext) {
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
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
      {
        apiId: 'views',
        name: 'Views',
        type: 'Integer',
        localized: false,
        required: false,
        position: 2,
      },
      {
        apiId: 'featured',
        name: 'Featured',
        type: 'Boolean',
        localized: false,
        required: false,
        position: 3,
      },
    ],
  });
  await publishContentType(ctx, scope, 'article');

  const rows = [
    { title: 'Alpha', body: 'about cats', views: 10, featured: true },
    { title: 'Bravo', body: 'about dogs', views: 50, featured: false },
    { title: 'Charlie', body: 'about cats and dogs', views: 100, featured: true },
    { title: 'Delta', body: 'unrelated', views: 5 }, // featured omitted
  ];
  for (const r of rows) {
    const fields: Record<string, Record<string, unknown>> = {
      title: { 'en-US': r.title },
      body: { 'en-US': r.body },
      views: { 'en-US': r.views },
    };
    if ('featured' in r) fields.featured = { 'en-US': r.featured };
    const created = await createEntry(ctx, scope, { contentTypeApiId: 'article', fields });
    await publishEntry(ctx, scope, created.entry.id);
  }
}

/** Extracts the title of each delivered entry (fields stay locale-keyed). */
const titles = (items: { fields: Record<string, unknown> }[]) =>
  items.map((i) => (i.fields.title as Record<string, string>)['en-US']);

describe('delivery query language', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ctx = makeContext();
    await seedCorpus(ctx);
  });

  it('eq / ne filter on a field', async () => {
    const eq = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'title', op: 'eq', value: 'Bravo' }],
    });
    expect(titles(eq)).toEqual(['Bravo']);

    const ne = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'title', op: 'ne', value: 'Bravo' }],
    });
    expect(titles(ne).sort()).toEqual(['Alpha', 'Charlie', 'Delta']);
  });

  it('in / nin filter', async () => {
    const inn = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'title', op: 'in', value: ['Alpha', 'Delta'] }],
    });
    expect(titles(inn).sort()).toEqual(['Alpha', 'Delta']);

    const nin = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'title', op: 'nin', value: ['Alpha', 'Delta'] }],
    });
    expect(titles(nin).sort()).toEqual(['Bravo', 'Charlie']);
  });

  it('numeric range filters (gt / gte / lt / lte)', async () => {
    expect(
      titles(
        await listPublishedEntries(ctx, scope, {
          filters: [{ field: 'views', op: 'gt', value: 50 }],
        }),
      ),
    ).toEqual(['Charlie']);
    expect(
      titles(
        await listPublishedEntries(ctx, scope, {
          filters: [{ field: 'views', op: 'gte', value: 50 }],
        }),
      ).sort(),
    ).toEqual(['Bravo', 'Charlie']);
    expect(
      titles(
        await listPublishedEntries(ctx, scope, {
          filters: [{ field: 'views', op: 'lt', value: 10 }],
        }),
      ),
    ).toEqual(['Delta']);
    expect(
      titles(
        await listPublishedEntries(ctx, scope, {
          filters: [{ field: 'views', op: 'lte', value: 10 }],
        }),
      ).sort(),
    ).toEqual(['Alpha', 'Delta']);
  });

  it('coerces string comparands to the field type (numbers, booleans)', async () => {
    // Query strings arrive untyped; gt against a numeric field must compare numerically.
    const numeric = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'views', op: 'gte', value: '50' }],
    });
    expect(titles(numeric).sort()).toEqual(['Bravo', 'Charlie']);

    const truthy = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'featured', op: 'eq', value: 'true' }],
    });
    expect(titles(truthy).sort()).toEqual(['Alpha', 'Charlie']);
  });

  it('exists filter distinguishes set from unset fields', async () => {
    const present = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'featured', op: 'exists', value: true }],
    });
    expect(titles(present).sort()).toEqual(['Alpha', 'Bravo', 'Charlie']);

    const missing = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'featured', op: 'exists', value: false }],
    });
    expect(titles(missing)).toEqual(['Delta']);
  });

  it('match does a case-insensitive substring filter', async () => {
    const hits = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'body', op: 'match', value: 'CATS' }],
    });
    expect(titles(hits).sort()).toEqual(['Alpha', 'Charlie']);
  });

  it('combines multiple filters with AND semantics', async () => {
    const hits = await listPublishedEntries(ctx, scope, {
      filters: [
        { field: 'body', op: 'match', value: 'dogs' },
        { field: 'views', op: 'gt', value: 60 },
      ],
    });
    expect(titles(hits)).toEqual(['Charlie']);
  });

  it('orders by a field, ascending and descending', async () => {
    const asc = await listPublishedEntries(ctx, scope, {
      order: [{ field: 'views', direction: 'asc' }],
    });
    expect(titles(asc)).toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie']);

    const desc = await listPublishedEntries(ctx, scope, {
      order: [{ field: 'views', direction: 'desc' }],
    });
    expect(titles(desc)).toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta']);
  });

  it('projects to a subset of fields with select', async () => {
    const [item] = await listPublishedEntries(ctx, scope, {
      filters: [{ field: 'title', op: 'eq', value: 'Alpha' }],
      select: ['title'],
    });
    expect(Object.keys(item?.fields ?? {})).toEqual(['title']);
  });

  it('full-text search across string fields', async () => {
    const hits = await listPublishedEntries(ctx, scope, { search: 'unrelated' });
    expect(titles(hits)).toEqual(['Delta']);
  });

  it('paginates filtered results with skip / limit', async () => {
    const page = await listPublishedEntries(ctx, scope, {
      order: [{ field: 'views', direction: 'asc' }],
      skip: 1,
      limit: 2,
    });
    expect(titles(page)).toEqual(['Alpha', 'Bravo']);
  });

  it('applies the same query engine to the preview (draft) read path', async () => {
    // A new, unpublished entry is visible to preview but matched by filters.
    const draft = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Echo' }, views: { 'en-US': 999 } },
    });
    const hits = await listPreviewEntries(ctx, scope, {
      filters: [{ field: 'views', op: 'gt', value: 500 }],
    });
    expect(hits.map((h) => h.id)).toEqual([draft.entry.id]);
  });
});
