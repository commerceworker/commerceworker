import type { DomainEvent } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  dispatchEvent,
  listPublishedEntries,
  publishEntry,
  SYSTEM_CALLER,
  unpublishEntry,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

/** Counts store reads so a cache HIT is provable, not inferred from equality. */
function setup() {
  const store = new InMemoryContentStore();
  const cache = new InMemoryCache();
  let listReads = 0;
  const inner = store.entries.listPublished.bind(store.entries);
  (store.entries as { listPublished: typeof inner }).listPublished = async (s, q) => {
    listReads += 1;
    return inner(s, q);
  };
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
    cache,
  };
  const sender = new RecordingWebhookSender();
  // Drain the outbox through the real dispatcher so invalidation runs exactly
  // as it does in production. Only events appended since the last drain are
  // dispatched — replaying earlier ones would re-invalidate tags that were
  // already settled and mask what a given step actually evicted.
  let dispatched = 0;
  const dispatchAll = async () => {
    const events = store.allEvents();
    for (const event of events.slice(dispatched)) {
      await dispatchEvent(ctx, { sender, cache }, event as DomainEvent);
    }
    dispatched = events.length;
  };
  return { ctx, store, cache, dispatchAll, reads: () => listReads };
}

async function seed(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  for (const apiId of ['article', 'author']) {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId,
      name: apiId,
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
}

const publishArticle = async (ctx: AppContext, title: string) => {
  const e = await createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title } },
  });
  await publishEntry(ctx, scope, e.entry.id);
  return e.entry.id;
};

const titles = (rows: { fields: Record<string, unknown> }[]) =>
  rows.map((r) => (r.fields.title as Record<string, string>)['en-US']).sort();

describe('delivery list cache', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await seed(h.ctx);
  });

  it('serves a repeated typed list from cache without re-reading the store', async () => {
    await publishArticle(h.ctx, 'A');
    const q = { contentTypeApiId: 'article' };
    const first = await listPublishedEntries(h.ctx, scope, q);
    const readsAfterFirst = h.reads();
    const second = await listPublishedEntries(h.ctx, scope, q);
    expect(second).toEqual(first);
    expect(h.reads()).toBe(readsAfterFirst); // no second store read
  });

  it('evicts when a NEW entry of the type is published (per-entry tags would miss this)', async () => {
    await publishArticle(h.ctx, 'A');
    const q = { contentTypeApiId: 'article' };
    expect(titles(await listPublishedEntries(h.ctx, scope, q))).toEqual(['A']);

    // A brand-new entry touches no entry already in the cached list — only the
    // content-type tag can evict it.
    await publishArticle(h.ctx, 'B');
    await h.dispatchAll();
    expect(titles(await listPublishedEntries(h.ctx, scope, q))).toEqual(['A', 'B']);
  });

  it('evicts when a member entry is updated and republished', async () => {
    const id = await publishArticle(h.ctx, 'A');
    const q = { contentTypeApiId: 'article' };
    expect(titles(await listPublishedEntries(h.ctx, scope, q))).toEqual(['A']);

    await updateEntry(h.ctx, scope, id, { title: { 'en-US': 'A-edited' } });
    await publishEntry(h.ctx, scope, id);
    await h.dispatchAll();
    expect(titles(await listPublishedEntries(h.ctx, scope, q))).toEqual(['A-edited']);
  });

  it('evicts when a member entry is unpublished', async () => {
    const id = await publishArticle(h.ctx, 'A');
    await publishArticle(h.ctx, 'B');
    const q = { contentTypeApiId: 'article' };
    expect(titles(await listPublishedEntries(h.ctx, scope, q))).toHaveLength(2);

    await unpublishEntry(h.ctx, scope, id);
    await h.dispatchAll();
    expect(titles(await listPublishedEntries(h.ctx, scope, q))).toEqual(['B']);
  });

  it('does not evict when an unrelated content type publishes', async () => {
    await publishArticle(h.ctx, 'A');
    await h.dispatchAll(); // settle the arrange step
    const q = { contentTypeApiId: 'article' };
    await listPublishedEntries(h.ctx, scope, q);
    const readsBefore = h.reads();

    const other = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'author',
      fields: { title: { 'en-US': 'Ada' } },
    });
    await publishEntry(h.ctx, scope, other.entry.id);
    await h.dispatchAll();

    await listPublishedEntries(h.ctx, scope, q);
    expect(h.reads()).toBe(readsBefore); // still cached — no over-invalidation
  });

  it('keys distinct queries separately and ignores property order', async () => {
    await publishArticle(h.ctx, 'A');
    await publishArticle(h.ctx, 'B');
    const wide = await listPublishedEntries(h.ctx, scope, { contentTypeApiId: 'article' });
    const narrow = await listPublishedEntries(h.ctx, scope, {
      contentTypeApiId: 'article',
      limit: 1,
    });
    expect(wide).toHaveLength(2);
    expect(narrow).toHaveLength(1); // not served the wide result

    // Same query, different key order → same cache entry (no extra read).
    const readsBefore = h.reads();
    await listPublishedEntries(h.ctx, scope, { limit: 1, contentTypeApiId: 'article' });
    expect(h.reads()).toBe(readsBefore);
  });

  it('does not cache untyped or cursor-paged queries', async () => {
    await publishArticle(h.ctx, 'A');
    // Untyped: no content-type tag could invalidate it, so it must stay uncached.
    await listPublishedEntries(h.ctx, scope, {});
    const afterUntyped = h.reads();
    await listPublishedEntries(h.ctx, scope, {});
    expect(h.reads()).toBe(afterUntyped + 1);

    const cursor = { contentTypeApiId: 'article', afterEntryId: '' };
    await listPublishedEntries(h.ctx, scope, cursor);
    const afterCursor = h.reads();
    await listPublishedEntries(h.ctx, scope, cursor);
    expect(h.reads()).toBe(afterCursor + 1);
  });

  it('coalesces repeated tag writes across one batch (KV per-key write limit)', async () => {
    // Count writes to the content-type tag: a batch of same-type publishes
    // must bump it ONCE, not once per event, or a release burst exceeds the
    // backend's ~1 write/s/key ceiling.
    const writes: string[] = [];
    const cache = h.cache as unknown as { invalidateTag: (t: string) => Promise<void> };
    const realInvalidate = cache.invalidateTag.bind(h.cache);
    cache.invalidateTag = async (t: string) => {
      writes.push(t);
      return realInvalidate(t);
    };

    const ids = [
      await publishArticle(h.ctx, 'A'),
      await publishArticle(h.ctx, 'B'),
      await publishArticle(h.ctx, 'C'),
    ];
    expect(ids).toHaveLength(3);
    // One shared set, as a queue consumer passes per batch.
    const shared = new Set<string>();
    const sender = new RecordingWebhookSender();
    for (const event of h.store.allEvents()) {
      await dispatchEvent(
        h.ctx,
        { sender, cache: h.cache, invalidatedTags: shared },
        event as DomainEvent,
      );
    }
    const ctWrites = writes.filter((t) => t.startsWith('ct:'));
    expect(ctWrites).toHaveLength(1); // three publishes, one tag write
  });

  it('never serves a locale-flattened render to an unflattened request', async () => {
    // `render` branches on opts.locale: set → flattened scalars, absent →
    // per-locale maps. Both resolve to the same query locale, so a key that
    // ignored opts.locale would serve one shape to the other's caller.
    await publishArticle(h.ctx, 'Hello');
    const q = { contentTypeApiId: 'article' };
    const flat = await listPublishedEntries(h.ctx, scope, q, { locale: 'en-US' });
    const raw = await listPublishedEntries(h.ctx, scope, q, {});
    expect(typeof flat[0]?.fields.title).toBe('string');
    expect(typeof raw[0]?.fields.title).toBe('object');
    // ...and in the other warm order too.
    const flat2 = await listPublishedEntries(h.ctx, scope, q, { locale: 'en-US' });
    expect(typeof flat2[0]?.fields.title).toBe('string');
  });

  it('keys include depth so a deeper include is not served a shallow render', async () => {
    await publishArticle(h.ctx, 'A');
    const q = { contentTypeApiId: 'article' };
    const d0 = await listPublishedEntries(h.ctx, scope, q, { locale: 'en-US', include: 0 });
    const d2 = await listPublishedEntries(h.ctx, scope, q, { locale: 'en-US', include: 2 });
    expect(d0).toHaveLength(1);
    expect(d2).toHaveLength(1);
  });

  it('evicts when an EMBEDDED entry of another type changes', async () => {
    // article -> author link, so the rendered list contains author fields.
    await createContentType(h.ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'post',
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
        {
          apiId: 'author',
          name: 'Author',
          type: 'Link',
          localized: false,
          required: false,
          position: 1,
          linkType: 'Entry',
        },
      ],
    });
    const author = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'author',
      fields: { title: { 'en-US': 'Ada' } },
    });
    await publishEntry(h.ctx, scope, author.entry.id);
    const post = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'P' },
        author: { 'en-US': { id: author.entry.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(h.ctx, scope, post.entry.id);

    const q = { contentTypeApiId: 'post' };
    const opts = { locale: 'en-US', include: 1 };
    await h.dispatchAll(); // settle arrange
    const first = await listPublishedEntries(h.ctx, scope, q, opts);
    expect((first[0]!.fields.author as { fields: Record<string, unknown> }).fields.title).toBe(
      'Ada',
    );
    // Prove the first call was actually CACHED — otherwise the freshness
    // assertion below would pass even with caching disabled entirely.
    const readsAfterFirst = h.reads();
    await listPublishedEntries(h.ctx, scope, q, opts);
    expect(h.reads()).toBe(readsAfterFirst);

    await updateEntry(h.ctx, scope, author.entry.id, { title: { 'en-US': 'Ada Lovelace' } });
    await publishEntry(h.ctx, scope, author.entry.id);
    await h.dispatchAll();

    const second = await listPublishedEntries(h.ctx, scope, q, opts);
    expect((second[0]!.fields.author as { fields: Record<string, unknown> }).fields.title).toBe(
      'Ada Lovelace',
    );
  });
});
