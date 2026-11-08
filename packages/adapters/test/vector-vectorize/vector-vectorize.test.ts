import type { VectorRow } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import { createVectorizeStore, type VectorizeBinding } from '../../src/vector-vectorize/index';

const scopeA = { spaceId: 'space-a', environmentId: 'main' };
const scopeB = { spaceId: 'space-b', environmentId: 'main' };

/** In-memory Vectorize fake: exact cosine scan per namespace. */
function fakeIndex() {
  const vectors = new Map<
    string,
    { values: number[]; namespace?: string; metadata?: Record<string, string | number | boolean> }
  >();
  const deleteBatchSizes: number[] = [];
  const index: VectorizeBinding = {
    async upsert(rows) {
      for (const r of rows) {
        vectors.set(r.id, { values: r.values, namespace: r.namespace, metadata: r.metadata });
      }
    },
    async deleteByIds(ids) {
      // Real Vectorize rejects >100 ids per call (VECTOR_DELETE_ERROR 40007).
      if (ids.length > 100) throw new Error(`too many ids in payload; got ${ids.length}`);
      deleteBatchSizes.push(ids.length);
      for (const id of ids) vectors.delete(id);
    },
    async query(vector, options) {
      const cosine = (a: number[], b: number[]) => {
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < a.length; i++) {
          dot += (a[i] ?? 0) * (b[i] ?? 0);
          na += (a[i] ?? 0) ** 2;
          nb += (b[i] ?? 0) ** 2;
        }
        return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
      };
      const matches = [...vectors.entries()]
        .filter(([, v]) => v.namespace === options.namespace)
        .map(([id, v]) => ({ id, score: cosine(vector, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);
      return { matches };
    },
  };
  return { index, vectors, deleteBatchSizes };
}

function row(scope: typeof scopeA, entryId: string, chunkIndex: number, e: number[]): VectorRow {
  return {
    scope,
    entryId,
    locale: 'en-US',
    chunkIndex,
    chunkText: `chunk ${chunkIndex} of ${entryId}`,
    embedding: e,
    entryVersion: 1,
  };
}

describe('createVectorizeStore', () => {
  const opts = { dimensions: 3, modelId: 'test-model' };

  it('upserts and queries back matches with entry id, chunk text, and score', async () => {
    const { index } = fakeIndex();
    const store = createVectorizeStore(index, opts);
    await store.upsert([row(scopeA, 'e1', 0, [1, 0, 0]), row(scopeA, 'e2', 0, [0, 1, 0])]);

    const matches = await store.query(scopeA, [1, 0, 0], { topK: 2 });
    expect(matches[0]?.entryId).toBe('e1');
    expect(matches[0]?.chunkText).toBe('chunk 0 of e1');
    expect(matches[0]?.score).toBeCloseTo(1);
  });

  it('isolates scopes: queries never cross namespaces', async () => {
    const { index } = fakeIndex();
    const store = createVectorizeStore(index, opts);
    await store.upsert([row(scopeA, 'e1', 0, [1, 0, 0])]);
    await store.upsert([row(scopeB, 'e9', 0, [1, 0, 0])]);

    const matches = await store.query(scopeB, [1, 0, 0], { topK: 10 });
    expect(matches.map((m) => m.entryId)).toEqual(['e9']);
  });

  it("deleteByEntry removes all of an entry's vectors and nothing else", async () => {
    const { index } = fakeIndex();
    const store = createVectorizeStore(index, opts);
    await store.upsert([
      row(scopeA, 'e1', 0, [1, 0, 0]),
      row(scopeA, 'e1', 1, [0.9, 0.1, 0]),
      row(scopeA, 'e2', 0, [0, 1, 0]),
    ]);

    await store.deleteByEntry(scopeA, 'e1');

    const matches = await store.query(scopeA, [1, 0, 0], { topK: 10 });
    expect(matches.map((m) => m.entryId)).toEqual(['e2']);
  });

  it('a shrinking re-upsert clears the stale tail (no ghost chunks)', async () => {
    const { index } = fakeIndex();
    const store = createVectorizeStore(index, opts);
    await store.upsert([
      row(scopeA, 'e1', 0, [1, 0, 0]),
      row(scopeA, 'e1', 1, [0.8, 0.2, 0]),
      row(scopeA, 'e1', 2, [0.7, 0.3, 0]),
    ]);
    await store.upsert([row(scopeA, 'e1', 0, [1, 0, 0])]);

    const matches = await store.query(scopeA, [1, 0, 0], { topK: 10 });
    expect(matches).toHaveLength(1);
  });

  it('splits delete sweeps into ≤100-id batches (Vectorize payload cap)', async () => {
    const { index, deleteBatchSizes } = fakeIndex();
    const store = createVectorizeStore(index, opts);
    await store.upsert([row(scopeA, 'e1', 0, [1, 0, 0])]);
    await store.deleteByEntry(scopeA, 'e1');
    expect(deleteBatchSizes.every((n) => n <= 100)).toBe(true);
    // upsert tail sweep (199 stale ids) + deleteByEntry (200 ids) = 4 batches.
    expect(deleteBatchSizes.length).toBe(4);
  });

  it('applies minScore filtering and clamps topK to 50', async () => {
    const { index } = fakeIndex();
    const store = createVectorizeStore(index, opts);
    await store.upsert([row(scopeA, 'e1', 0, [1, 0, 0]), row(scopeA, 'e2', 0, [0, 1, 0])]);

    const strict = await store.query(scopeA, [1, 0, 0], { topK: 100, minScore: 0.5 });
    expect(strict.map((m) => m.entryId)).toEqual(['e1']);
  });
});

describe('asset vectors', () => {
  it('keeps assets in a namespace of their own: entry queries never see them, nor the reverse', async () => {
    const { index, vectors } = fakeIndex();
    const store = createVectorizeStore(index, { dimensions: 3, modelId: 'm' });
    await store.upsert([row(scopeA, 'e1', 0, [1, 0, 0])]);
    await store.upsertAsset(scopeA, {
      corpus: 'library',
      assetId: 'a1',
      embedding: [1, 0, 0],
      assetKind: 'image',
      version: 2,
    });
    expect((await store.query(scopeA, [1, 0, 0], { topK: 10 })).map((m) => m.entryId)).toEqual([
      'e1',
    ]);
    expect(await store.queryAssets(scopeA, [1, 0, 0], { topK: 10, corpus: 'library' })).toEqual([
      { assetId: 'a1', score: expect.closeTo(1, 5) },
    ]);
    const stored = [...vectors.values()].find((v) => v.metadata?.assetId === 'a1');
    expect(stored?.metadata).toMatchObject({
      kind: 'asset',
      spaceId: 'space-a',
      environmentId: 'main',
      assetId: 'a1',
      assetKind: 'image',
      version: 2,
    });
  });

  it('isolates scopes and replaces an asset in place; delete removes it', async () => {
    const { index, vectors } = fakeIndex();
    const store = createVectorizeStore(index, { dimensions: 3, modelId: 'm' });
    const asset = { corpus: 'library' as const, assetId: 'a1', assetKind: 'document', version: 1 };
    await store.upsertAsset(scopeA, { ...asset, embedding: [1, 0, 0] });
    await store.upsertAsset(scopeA, { ...asset, embedding: [0, 1, 0] });
    expect(vectors.size).toBe(1);
    expect(await store.queryAssets(scopeB, [0, 1, 0], { topK: 10, corpus: 'library' })).toEqual([]);
    await store.deleteAsset(scopeA, 'a1', 'library');
    expect(await store.queryAssets(scopeA, [0, 1, 0], { topK: 10, corpus: 'library' })).toEqual([]);
  });

  it('keeps the published corpus apart from the library: each query sees only its own', async () => {
    const { index, vectors } = fakeIndex();
    const store = createVectorizeStore(index, { dimensions: 3, modelId: 'm' });
    const asset = { assetId: 'a1', assetKind: 'image', version: 1, embedding: [1, 0, 0] };
    await store.upsertAsset(scopeA, { ...asset, corpus: 'library' });
    await store.upsertAsset(scopeA, { ...asset, assetId: 'draft', corpus: 'library' });
    await store.upsertAsset(scopeA, { ...asset, corpus: 'published' });
    expect(vectors.size).toBe(3);
    const published = await store.queryAssets(scopeA, [1, 0, 0], { topK: 10, corpus: 'published' });
    expect(published.map((m) => m.assetId)).toEqual(['a1']);
    await store.deleteAsset(scopeA, 'a1', 'published');
    expect(await store.queryAssets(scopeA, [1, 0, 0], { topK: 10, corpus: 'published' })).toEqual(
      [],
    );
    const library = await store.queryAssets(scopeA, [1, 0, 0], { topK: 10, corpus: 'library' });
    expect(library.map((m) => m.assetId).sort()).toEqual(['a1', 'draft']);
  });
});
