import { ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  getPublishedEntry,
  listPublishedEntries,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  unpublishEntry,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function makeContext(): { ctx: AppContext; store: InMemoryContentStore } {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx, store };
}

async function seedArticleType(ctx: AppContext) {
  return createContentType(ctx, SYSTEM_CALLER, scope, {
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
    ],
  });
}

describe('tracer-bullet vertical slice', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  beforeEach(() => {
    ({ ctx, store } = makeContext());
  });

  it('models, authors, publishes, and reads back an entry', async () => {
    const type = await seedArticleType(ctx);
    expect(type.apiId).toBe('article');
    await publishContentType(ctx, scope, 'article');

    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello world' }, body: { 'en-US': 'First post.' } },
    });
    expect(created.entry.status).toBe('draft');

    // Not visible on the Delivery read model until published.
    await expect(getPublishedEntry(ctx, scope, created.entry.id)).rejects.toThrow(/not.*found/i);

    const published = await publishEntry(ctx, scope, created.entry.id);
    expect(published.status).toBe('published');
    expect(published.publishedVersion).toBe(1);

    const delivered = await getPublishedEntry(ctx, scope, created.entry.id);
    expect(delivered.fields.title?.['en-US']).toBe('Hello world');

    const list = await listPublishedEntries(ctx, scope, { contentTypeApiId: 'article' });
    expect(list).toHaveLength(1);

    // The publish appended exactly the expected outbox events (content type + entry).
    const types = store.allEvents().map((e) => e.type);
    expect(types).toContain('content_type.published');
    expect(types).toContain('entry.published');
  });

  it('rejects entries that violate the content model', async () => {
    await seedArticleType(ctx);
    await expect(
      createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: { body: { 'en-US': 'no title' } },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('marks an entry "changed" after editing a published entry, then republishes', async () => {
    await seedArticleType(ctx);
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'v1' } },
    });
    await publishEntry(ctx, scope, created.entry.id);

    const edited = await updateEntry(ctx, scope, created.entry.id, { title: { 'en-US': 'v2' } });
    expect(edited.entry.status).toBe('changed');
    expect(edited.entry.currentVersion).toBe(2);
    expect(edited.entry.publishedVersion).toBe(1);

    // Delivery still serves v1 until republish.
    const beforeRepublish = await getPublishedEntry(ctx, scope, created.entry.id);
    expect(beforeRepublish.fields.title?.['en-US']).toBe('v1');

    await publishEntry(ctx, scope, created.entry.id);
    const afterRepublish = await getPublishedEntry(ctx, scope, created.entry.id);
    expect(afterRepublish.fields.title?.['en-US']).toBe('v2');
  });

  it('removes an entry from delivery on unpublish', async () => {
    await seedArticleType(ctx);
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'temp' } },
    });
    await publishEntry(ctx, scope, created.entry.id);
    const updated = await unpublishEntry(ctx, scope, created.entry.id);
    expect(updated.status).toBe('draft');
    await expect(getPublishedEntry(ctx, scope, created.entry.id)).rejects.toThrow(/not.*found/i);
  });
});
