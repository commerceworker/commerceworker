import type { SearchIndex } from '@commerceworker/ports';
import {
  FixedClock,
  InMemoryContentStore,
  InMemorySearchIndex,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  extractTextByLocale,
  publishEntry,
  SYSTEM_CALLER,
  searchIndexHealth,
  unpublishEntry,
} from '../src/index';

const scope = { spaceId: 'kb', environmentId: 'main' };
const other = { spaceId: 'kb', environmentId: 'staging' };

describe('search index health', () => {
  let ctx: AppContext;
  let index: InMemorySearchIndex;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('e'),
    };
    index = new InMemorySearchIndex();
    await createSpace(ctx, { spaceId: 'kb', name: 'kb', defaultLocale: 'en-US' });
    for (const s of [scope, other]) {
      await createContentType(ctx, SYSTEM_CALLER, s, {
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
      await createContentType(ctx, SYSTEM_CALLER, s, {
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
      });
    }
  });

  /** Publishes an entry, and indexes it the way the dispatcher would. */
  async function publish(
    s: typeof scope,
    title: string,
    opts: { indexIt?: boolean; contentType?: string } = {},
  ) {
    const contentTypeApiId = opts.contentType ?? 'article';
    const { entry } = await createEntry(ctx, s, {
      contentTypeApiId,
      fields: { title: { 'en-US': title } },
    });
    await publishEntry(ctx, s, entry.id);
    if (opts.indexIt !== false) {
      await index.index(s, {
        entryId: entry.id,
        contentTypeApiId,
        textByLocale: extractTextByLocale({ title: { 'en-US': title } }),
        entryVersion: 1,
      });
    }
    return entry.id;
  }

  it('reports no external index rather than pretending to measure one', async () => {
    await publish(scope, 'One');
    const health = await searchIndexHealth(ctx, scope);
    // `bound: false` is a configuration answer, not a health problem: lexical
    // search falls back to the store's built-in term matching.
    expect(health.bound).toBe(false);
    expect(health.publishedEntries).toBe(1);
    expect(health.drift).toBeUndefined();
  });

  it('reports in sync when every published entry has a document', async () => {
    await publish(scope, 'One');
    await publish(scope, 'Two');
    const health = await searchIndexHealth(ctx, scope, index);
    expect(health).toMatchObject({ documents: 2, publishedEntries: 2, drift: 0, inSync: true });
  });

  it('reports negative drift when the index is missing entries', async () => {
    await publish(scope, 'Indexed');
    await publish(scope, 'Never indexed', { indexIt: false });
    const health = await searchIndexHealth(ctx, scope, index);
    // The failure this exists to catch: search silently stops finding things
    // that were published while indexing was broken.
    expect(health.drift).toBe(-1);
    expect(health.inSync).toBe(false);
  });

  it('reports positive drift when the index holds unpublished entries', async () => {
    const id = await publish(scope, 'Will be unpublished');
    await unpublishEntry(ctx, scope, id);
    const health = await searchIndexHealth(ctx, scope, index);
    // Stale documents surface as hits that resolve to nothing.
    expect(health.drift).toBe(1);
    expect(health.inSync).toBe(false);
  });

  it('counts only the environment it was asked about', async () => {
    await publish(scope, 'Main one');
    await publish(other, 'Staging one');
    await publish(other, 'Staging two');
    expect(await searchIndexHealth(ctx, scope, index)).toMatchObject({
      documents: 1,
      publishedEntries: 1,
      inSync: true,
    });
    expect(await searchIndexHealth(ctx, other, index)).toMatchObject({
      documents: 2,
      publishedEntries: 2,
    });
  });

  it('withholds drift when asked about one content type', async () => {
    await publish(scope, 'An article');
    await publish(scope, 'A note', { contentType: 'note' });
    const health = await searchIndexHealth(ctx, scope, index, { contentType: 'note' });
    // The entry count narrows to one type but the index-wide document count
    // does not, so subtracting them would report drift that does not exist.
    expect(health.publishedEntries).toBe(1);
    expect(health.documents).toBe(2);
    expect(health.drift).toBeUndefined();
    expect(health.inSync).toBeUndefined();
  });

  it('says the number is unavailable when the engine cannot count', async () => {
    await publish(scope, 'One');
    // Built explicitly rather than by stripping `stats` off the fake: spreading
    // a class instance drops every prototype method, so that object would have
    // had no `stats` whatever the source said.
    const cannotCount: SearchIndex = {
      index: (s, doc, o) => index.index(s, doc, o),
      remove: (s, id) => index.remove(s, id),
      search: (s, q, o) => index.search(s, q, o),
    };
    expect(cannotCount.stats).toBeUndefined();
    const health = await searchIndexHealth(ctx, scope, cannotCount);
    // Inventing a document count would report drift against a number we do not
    // have.
    expect(health.bound).toBe(true);
    expect(health.documents).toBeUndefined();
    expect(health.drift).toBeUndefined();
    expect(health.publishedEntries).toBe(1);
  });

  it('reports the engine, so a drift number has something to blame', async () => {
    expect((await searchIndexHealth(ctx, scope, index)).engine).toBe('in-memory');
  });
});
