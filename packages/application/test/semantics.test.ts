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
  findDuplicates,
  getEntryEmbedding,
  indexEntryEmbeddings,
  type RagDeps,
  relatedEntries,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'kb', environmentId: 'main' };

describe('content semantics', () => {
  let ctx: AppContext;
  let rag: RagDeps;

  beforeEach(async () => {
    const store = new InMemoryContentStore();
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
    rag = { embeddings: new LocalEmbeddingsProvider(512), vectors: new InMemoryVectorStore() };
    await createSpace(ctx, { spaceId: 'kb', name: 'KB', defaultLocale: 'en-US' });
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
        {
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
  });

  async function addArticle(title: string, body: string) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': title }, body: { 'en-US': body } },
    });
    await indexEntryEmbeddings(rag, scope, {
      entryId: entry.id,
      entryVersion: 1,
      fields: { body: { 'en-US': body } },
    });
    return entry.id;
  }

  it('finds related entries and excludes the source entry', async () => {
    const sqlite = await addArticle(
      'SQLite',
      'SQLite relational database SQL indexes transactions',
    );
    await addArticle('Coffee', 'Espresso brewing beans roast crema barista');
    const cousin = await addArticle('Databases', 'relational database SQL indexes query planner');

    const related = await relatedEntries(rag, ctx, scope, sqlite, { topK: 5 });
    const ids = related.map((h) => h.entryId);
    expect(ids).not.toContain(sqlite);
    expect(ids).toContain(cousin);
  });

  it('flags near-duplicates above the threshold', async () => {
    const a = await addArticle('A', 'identical content about widgets and gadgets and gizmos');
    const b = await addArticle('B', 'identical content about widgets and gadgets and gizmos');
    await addArticle('C', 'a totally unrelated essay on medieval poetry and lutes');

    const dups = await findDuplicates(rag, ctx, scope, a, { threshold: 0.95 });
    expect(dups.map((d) => d.entryId)).toEqual([b]);
    expect(dups[0]?.isDuplicate).toBe(true);
  });

  it('exposes an entry embedding vector', async () => {
    const id = await addArticle('Vectors', 'some text to embed into a representation');
    const rep = await getEntryEmbedding(rag, ctx, scope, id);
    expect(rep.entryId).toBe(id);
    expect(rep.dimensions).toBe(512);
    expect(rep.vector).toHaveLength(512);
    expect(rep.modelId).toBe('local-hash-v1');
  });
});
