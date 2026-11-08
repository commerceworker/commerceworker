import type { VectorRow } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import { createKvDevVectorStore, type KvVectorBinding } from '../../src/vector-kv-dev/index';

/** In-memory KV with prefix listing and a small page size, so paging is exercised. */
function fakeKv(pageSize = 2): KvVectorBinding & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async list({ prefix, cursor }) {
      const names = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const keys = names.slice(start, start + pageSize).map((name) => ({ name }));
      const done = start + pageSize >= names.length;
      return { keys, list_complete: done, ...(done ? {} : { cursor: String(start + pageSize) }) };
    },
  };
}

const scope = { spaceId: 's1', environmentId: 'main' };
const row = (entryId: string, embedding: number[], over: Partial<VectorRow> = {}): VectorRow => ({
  scope,
  entryId,
  locale: 'en-US',
  chunkIndex: 0,
  chunkText: `text of ${entryId}`,
  embedding,
  entryVersion: 1,
  ...over,
});

describe('createKvDevVectorStore', () => {
  it('ranks by cosine similarity across every page of keys', async () => {
    const store = createKvDevVectorStore(fakeKv());
    await store.upsert([row('a', [1, 0]), row('b', [0, 1]), row('c', [0.9, 0.1])]);
    const hits = await store.query(scope, [1, 0], { topK: 2 });
    expect(hits.map((h) => h.entryId)).toEqual(['a', 'c']);
  });

  it('replaces a chunk with the same identity and keeps the entry`s other chunks', async () => {
    const kv = fakeKv();
    const store = createKvDevVectorStore(kv);
    await store.upsert([row('a', [1, 0]), row('a', [0, 1], { chunkIndex: 1 })]);
    await store.upsert([row('a', [0.5, 0.5], { chunkText: 'new' })]);
    const stored = JSON.parse(kv.data.get('vec:s1:main:a') ?? '[]') as VectorRow[];
    expect(stored.map((r) => [r.chunkIndex, r.chunkText])).toEqual([
      [1, 'text of a'],
      [0, 'new'],
    ]);
  });

  it('keeps scopes apart and forgets a deleted entry', async () => {
    const store = createKvDevVectorStore(fakeKv());
    const other = { spaceId: 's2', environmentId: 'main' };
    await store.upsert([row('a', [1, 0]), row('b', [1, 0], { scope: other })]);
    expect((await store.query(scope, [1, 0], { topK: 5 })).map((h) => h.entryId)).toEqual(['a']);
    await store.deleteByEntry(scope, 'a');
    expect(await store.query(scope, [1, 0], { topK: 5 })).toEqual([]);
  });

  it('drops matches below minScore', async () => {
    const store = createKvDevVectorStore(fakeKv());
    await store.upsert([row('a', [1, 0]), row('b', [0, 1])]);
    const hits = await store.query(scope, [1, 0], { topK: 5, minScore: 0.5 });
    expect(hits.map((h) => h.entryId)).toEqual(['a']);
  });
});
