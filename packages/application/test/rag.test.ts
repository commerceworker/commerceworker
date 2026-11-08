import {
  FixedClock,
  InMemoryContentStore,
  InMemorySearchIndex,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  chunk,
  createContentType,
  createEntry,
  createSpace,
  extractTextByLocale,
  hybridSearch,
  indexEntryEmbeddings,
  MAX_REINDEX_ENTRIES,
  publishEntry,
  type RagDeps,
  reindexEmbeddings,
  removeEntryEmbeddings,
  requestReindex,
  runReindexJob,
  SYSTEM_CALLER,
  semanticSearch,
} from '../src/index';

const scope = { spaceId: 'kb', environmentId: 'main' };

describe('P7: RAG indexing + semantic search', () => {
  let deps: RagDeps;
  beforeEach(() => {
    deps = { embeddings: new LocalEmbeddingsProvider(512), vectors: new InMemoryVectorStore() };
  });

  it('extracts localized text and chunks long text', () => {
    const text = extractTextByLocale({ title: { 'en-US': 'Hello' }, body: { 'en-US': 'World' } });
    expect(text['en-US']).toContain('Hello');
    expect(text['en-US']).toContain('World');
    expect(chunk('a b c d e', 2)).toEqual(['a b', 'c d', 'e']);
  });

  it('extracts text from inside components and repeaters', () => {
    // Content modeled as components would otherwise be invisible to the search
    // the product leads with.
    const text = extractTextByLocale({
      hero: { 'en-US': { heading: 'Welcome', sub: 'to the site' } },
      cards: { 'en-US': [{ title: 'One' }, { title: 'Two' }] },
      tags: { 'en-US': ['alpha', 'beta'] },
    });
    for (const word of ['Welcome', 'to the site', 'One', 'Two', 'alpha', 'beta']) {
      expect(text['en-US']).toContain(word);
    }
  });

  it('leaves links out — an entry id is not something anyone searches for', () => {
    const text = extractTextByLocale({
      author: { 'en-US': { id: 'e-0192f4a1', linkType: 'Entry' } },
      cards: { 'en-US': [{ title: 'Keep me', image: { id: 'a-77', linkType: 'Asset' } }] },
    });
    expect(text['en-US']).toContain('Keep me');
    expect(text['en-US'] ?? '').not.toContain('e-0192f4a1');
    expect(text['en-US'] ?? '').not.toContain('a-77');
  });

  it("leaves a block's _type and _key out, keeping its text", () => {
    const text = extractTextByLocale({
      body: { 'en-US': [{ _type: 'hero', _key: '0192f4a1-key', heading: 'Big news' }] },
    });
    expect(text['en-US']).toBe('Big news');
  });

  it('extracts plain text from rich-text values per locale', () => {
    const body = {
      nodeType: 'document',
      content: [
        { nodeType: 'heading-1', content: [{ nodeType: 'text', value: 'Guide' }] },
        { nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Rich body text' }] },
      ],
    };
    const text = extractTextByLocale({
      title: { 'en-US': 'Hello' },
      body: { 'en-US': body, 'de-DE': body },
    });
    expect(text['en-US']).toContain('Guide');
    expect(text['en-US']).toContain('Rich body text');
    expect(text['de-DE']).toContain('Guide');
  });

  it('indexes an entry whose only text lives in a rich-text body', async () => {
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e-rich',
      entryVersion: 1,
      fields: {
        body: {
          'en-US': {
            nodeType: 'document',
            content: [
              {
                nodeType: 'paragraph',
                content: [{ nodeType: 'text', value: 'Kubernetes orchestrates containers' }],
              },
            ],
          },
        },
      },
    });
    const hits = await semanticSearch(deps, scope, 'kubernetes containers', { topK: 2 });
    expect(hits[0]?.entryId).toBe('e-rich');
  });

  it('indexes entries and ranks the relevant one first', async () => {
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e-sqlite',
      entryVersion: 1,
      fields: {
        body: {
          'en-US': 'SQLite is a relational database with strong SQL support and indexes',
        },
      },
    });
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e-coffee',
      entryVersion: 1,
      fields: {
        body: { 'en-US': 'Espresso is a brewing method for coffee using pressure and hot water' },
      },
    });

    const hits = await semanticSearch(deps, scope, 'database sql indexes', { topK: 2 });
    expect(hits[0]?.entryId).toBe('e-sqlite');
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('replaces stale vectors on re-index (republish)', async () => {
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e1',
      entryVersion: 1,
      fields: { body: { 'en-US': 'aardvark anteater' } },
    });
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e1',
      entryVersion: 2,
      fields: { body: { 'en-US': 'zebra zeppelin' } },
    });
    // Old terms no longer match; new terms do.
    expect((await semanticSearch(deps, scope, 'aardvark', { topK: 5 })).length).toBe(0);
    expect((await semanticSearch(deps, scope, 'zebra', { topK: 5 }))[0]?.entryId).toBe('e1');
  });

  it("clamps the semantic over-fetch to the vector store's declared maxTopK", async () => {
    const requested: number[] = [];
    const cappedVectors = {
      maxTopK: 50,
      upsert: async () => {},
      deleteByEntry: async () => {},
      query: async (_s: unknown, _e: unknown, opts: { topK: number }) => {
        requested.push(opts.topK);
        return [];
      },
    };
    await semanticSearch(
      { embeddings: new LocalEmbeddingsProvider(8), vectors: cappedVectors },
      scope,
      'anything',
      { topK: 100 },
    );
    // Uncapped stores get topK*4 (up to 400); a declared cap clamps it.
    expect(requested).toEqual([50]);
  });

  it('hybrid search reads the external lexical index when bound', async () => {
    const searchIndex = new InMemorySearchIndex();
    await searchIndex.index(scope, {
      entryId: 'e-lex',
      contentTypeApiId: 'article',
      textByLocale: { 'en-US': 'terraform infrastructure provisioning' },
      entryVersion: 1,
    });
    const store = new InMemoryContentStore();
    const ctx: AppContext = {
      store: store as never,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('x'),
    };
    const withIndex: RagDeps = {
      embeddings: new LocalEmbeddingsProvider(64),
      vectors: new InMemoryVectorStore(),
      searchIndex,
    };
    // The store has no published entries at all — a hit can only come from
    // the external index, proving the lexical leg switched over.
    const hits = await hybridSearch(withIndex, ctx, scope, 'terraform provisioning', { topK: 5 });
    expect(hits.map((h) => h.entryId)).toEqual(['e-lex']);
  });

  it('removes embeddings on unpublish', async () => {
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e1',
      entryVersion: 1,
      fields: { body: { 'en-US': 'searchable content here' } },
    });
    await removeEntryEmbeddings(deps, scope, 'e1');
    expect((await semanticSearch(deps, scope, 'searchable', { topK: 5 })).length).toBe(0);
  });
});

describe('reindex embeddings', () => {
  let ctx: AppContext;
  let deps: RagDeps;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('e'),
    };
    deps = { embeddings: new LocalEmbeddingsProvider(512), vectors: new InMemoryVectorStore() };
    for (const spaceId of ['kb', 'other']) {
      await createSpace(ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
      await createContentType(
        ctx,
        SYSTEM_CALLER,
        { spaceId, environmentId: 'main' },
        {
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
        },
      );
    }
  });

  async function publishArticle(scope: { spaceId: string; environmentId: string }, title: string) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': title } },
    });
    await publishEntry(ctx, scope, entry.id);
    return entry.id;
  }

  it('embeds all published entries so they become searchable', async () => {
    const sqlite = await publishArticle(scope, 'SQLite relational database indexes');
    await publishArticle(scope, 'Espresso brewing methods for coffee');

    // Nothing indexed yet — publish alone does not embed in this harness.
    expect((await semanticSearch(deps, scope, 'database', { topK: 5 })).length).toBe(0);

    const result = await reindexEmbeddings(deps, ctx, scope, { batchSize: 1 });
    expect(result.entries).toBe(2);
    expect(result.chunks).toBeGreaterThanOrEqual(2);

    const hits = await semanticSearch(deps, scope, 'relational database', { topK: 5 });
    expect(hits[0]?.entryId).toBe(sqlite);
  });

  it('returns zero counts for a scope with nothing published', async () => {
    expect(await reindexEmbeddings(deps, ctx, scope, {})).toEqual({
      entries: 0,
      chunks: 0,
      truncated: false,
    });
  });

  it('honors an entry budget and reports the resume cursor', async () => {
    await publishArticle(scope, 'first article about databases');
    await publishArticle(scope, 'second article about coffee');
    await publishArticle(scope, 'third article about sailing');

    const first = await reindexEmbeddings(deps, ctx, scope, { maxEntries: 2 });
    expect(first.entries).toBe(2);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const rest = await reindexEmbeddings(deps, ctx, scope, { afterEntryId: first.nextCursor });
    expect(rest.entries).toBe(1);
    expect(rest.truncated).toBe(false);
  });

  it('the cursor survives an unpublish of an already-processed entry', async () => {
    const a = await publishArticle(scope, 'entry one');
    await publishArticle(scope, 'entry two');
    await publishArticle(scope, 'entry three');

    const first = await reindexEmbeddings(deps, ctx, scope, { maxEntries: 1 });
    expect(first.entries).toBe(1);
    // An offset cursor would now skip an entry; the keyset cursor does not.
    await ctx.store.entries.removePublished(scope, a);
    const rest = await reindexEmbeddings(deps, ctx, scope, { afterEntryId: first.nextCursor });
    expect(rest.entries).toBe(2);
    expect(rest.truncated).toBe(false);
  });

  it('runReindexJob re-enqueues a continuation event when a slice is truncated', async () => {
    await publishArticle(scope, 'alpha entry');
    await publishArticle(scope, 'beta entry');
    // Drain the outbox events from publishing so only the continuation remains.
    await ctx.store.withTransaction(async (tx) => {
      const pending = await tx.outbox.readPending(100);
      await tx.outbox.markRelayed(pending.map((e) => e.id));
    });

    // Simulate a slice budget of 1 by claiming the job already processed all
    // but one entry of the whole-job cap.
    const result = await runReindexJob(deps, ctx, {
      id: ctx.ids.newId(),
      type: 'search.reindex_requested',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      entriesSoFar: MAX_REINDEX_ENTRIES - 1,
    });
    expect(result.entries).toBe(1);
    expect(result.truncated).toBe(true);

    // At the whole-job cap, no continuation is enqueued (bounded job).
    const pending = await ctx.store.outbox.readPending(10);
    expect(pending.filter((e) => e.type === 'search.reindex_requested')).toHaveLength(0);
  });

  it('runReindexJob continuation carries the cursor and finishes the job', async () => {
    await publishArticle(scope, 'gamma entry');
    await publishArticle(scope, 'delta entry');
    await ctx.store.withTransaction(async (tx) => {
      const pending = await tx.outbox.readPending(100);
      await tx.outbox.markRelayed(pending.map((e) => e.id));
    });

    const first = await runReindexJob(
      deps,
      ctx,
      {
        id: ctx.ids.newId(),
        type: 'search.reindex_requested',
        scope,
        occurredAt: ctx.clock.now().toISOString(),
      },
      { entriesPerRun: 1 },
    );
    expect(first.entries).toBe(1);
    expect(first.truncated).toBe(true);

    const pending = await ctx.store.outbox.readPending(10);
    const continuation = pending.find((e) => e.type === 'search.reindex_requested');
    expect(continuation).toBeDefined();
    if (continuation?.type !== 'search.reindex_requested') throw new Error('unreachable');
    expect(continuation.afterEntryId).toBeDefined();
    expect(continuation.entriesSoFar).toBe(1);

    const second = await runReindexJob(deps, ctx, continuation);
    expect(second.entries).toBe(1);
    expect(second.truncated).toBe(false);
  });

  it('runReindexJob runs lexical-only when a SearchIndex is bound without embeddings', async () => {
    await publishArticle(scope, 'lexical only backfill entry');
    await ctx.store.withTransaction(async (tx) => {
      const pending = await tx.outbox.readPending(100);
      await tx.outbox.markRelayed(pending.map((e) => e.id));
    });

    const searchIndex = new InMemorySearchIndex();
    const result = await runReindexJob(
      undefined, // no RagDeps: EMBEDDINGS_PROVIDER unset
      ctx,
      {
        id: ctx.ids.newId(),
        type: 'search.reindex_requested',
        scope,
        occurredAt: ctx.clock.now().toISOString(),
      },
      { searchIndex },
    );
    expect(result.entries).toBe(1);
    expect(result.chunks).toBe(0); // no embeddings were written
    expect(await searchIndex.search(scope, 'backfill', { topK: 5 })).toHaveLength(1);
  });

  it('runReindexJob dedupes a redelivered slice via the cache marker', async () => {
    await publishArticle(scope, 'epsilon entry');
    await ctx.store.withTransaction(async (tx) => {
      const pending = await tx.outbox.readPending(100);
      await tx.outbox.markRelayed(pending.map((e) => e.id));
    });

    const entries = new Map<string, string>();
    const cache = {
      get: async (k: string) => entries.get(k) ?? null,
      set: async (k: string, v: string) => void entries.set(k, v),
      invalidateTag: async () => {},
    };
    const guarded: AppContext = { ...ctx, cache };
    const event = {
      id: ctx.ids.newId(),
      type: 'search.reindex_requested' as const,
      scope,
      occurredAt: ctx.clock.now().toISOString(),
    };
    const first = await runReindexJob(deps, guarded, event);
    expect(first.entries).toBe(1);
    // Same event id redelivered: the marker short-circuits the re-run.
    const second = await runReindexJob(deps, guarded, event);
    expect(second.entries).toBe(0);
    expect(second.truncated).toBe(false);
  });

  it('requestReindex enqueues an outbox event and enforces a cooldown', async () => {
    const entries = new Map<string, string>();
    const cache = {
      get: async (k: string) => entries.get(k) ?? null,
      set: async (k: string, v: string) => void entries.set(k, v),
      invalidateTag: async () => {},
    };
    const guarded: AppContext = { ...ctx, cache };
    // First request is accepted and appends a reindex event to the outbox.
    await expect(requestReindex(guarded, scope, {})).resolves.toEqual({ enqueued: true });
    const pending = await ctx.store.outbox.readPending(10);
    expect(pending.some((e) => e.type === 'search.reindex_requested')).toBe(true);
    // A second request within the window is rejected.
    await expect(requestReindex(guarded, scope, {})).rejects.toThrow(/cooldown/i);
  });

  it('only touches the requested scope', async () => {
    const otherScope = { spaceId: 'other', environmentId: 'main' };
    await publishArticle(scope, 'kubernetes container orchestration');
    await publishArticle(otherScope, 'terraform infrastructure as code');

    const result = await reindexEmbeddings(deps, ctx, scope, {});
    expect(result.entries).toBe(1);

    expect((await semanticSearch(deps, scope, 'kubernetes', { topK: 5 })).length).toBe(1);
    expect((await semanticSearch(deps, otherScope, 'terraform', { topK: 5 })).length).toBe(0);
  });
});
