import {
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  hybridSearch,
  indexEntryEmbeddings,
  publishEntry,
  type RagDeps,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'kb', environmentId: 'main' };

describe('hybrid search (RRF over semantic + full-text)', () => {
  let ctx: AppContext;
  let deps: RagDeps;

  async function publish(body: string): Promise<string> {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { body: { 'en-US': body } },
    });
    await publishEntry(ctx, scope, entry.id);
    return entry.id;
  }

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('s'),
    };
    deps = { embeddings: new LocalEmbeddingsProvider(512), vectors: new InMemoryVectorStore() };
    await createSpace(ctx, { spaceId: 'kb', name: 'KB', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'body',
      fields: [
        {
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    });
  });

  it('fuses both legs: an entry matching both outranks single-leg matches', async () => {
    const eBoth = await publish('sqlite database performance guide');
    const eLex = await publish('sqlite database backup checklist');
    // Semantic-only entry: indexed for vectors but never published, so the
    // full-text leg cannot see it.
    const { entry: sem } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { body: { 'en-US': 'sqlite database internals deep dive' } },
    });
    await indexEntryEmbeddings(deps, scope, {
      entryId: sem.id,
      entryVersion: 1,
      fields: { body: { 'en-US': 'sqlite database internals deep dive' } },
    });
    await indexEntryEmbeddings(deps, scope, {
      entryId: eBoth,
      entryVersion: 1,
      fields: { body: { 'en-US': 'sqlite database performance guide' } },
    });

    const hits = await hybridSearch(deps, ctx, scope, 'sqlite database', { topK: 5 });
    const ids = hits.map((h) => h.entryId);
    expect(ids[0]).toBe(eBoth);
    expect(ids).toContain(eLex);
    expect(ids).toContain(sem.id);
  });

  it('derives a snippet for lexical-only hits from the published fields', async () => {
    const eLex = await publish('a long treatise about espresso brewing under pressure');
    const hits = await hybridSearch(undefined, ctx, scope, 'espresso', { topK: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entryId).toBe(eLex);
    expect(hits[0]?.snippet).toContain('espresso');
  });

  it('lexical leg requires every query term to match', async () => {
    await publish('espresso brewing');
    const none = await hybridSearch(undefined, ctx, scope, 'espresso ristretto', { topK: 5 });
    expect(none).toHaveLength(0);
  });

  it('works without embeddings (deps undefined) and respects topK', async () => {
    await publish('kubernetes deployment guide one');
    await publish('kubernetes deployment guide two');
    await publish('kubernetes deployment guide three');
    const hits = await hybridSearch(undefined, ctx, scope, 'kubernetes', { topK: 2 });
    expect(hits).toHaveLength(2);
  });

  it('returns nothing for an empty query', async () => {
    await publish('some published content');
    expect(await hybridSearch(deps, ctx, scope, '', { topK: 5 })).toHaveLength(0);
  });
});
