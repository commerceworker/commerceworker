import { env } from 'cloudflare:workers';
import {
  createShardedSearchIndex,
  ftsMatch,
  shardOf,
} from '@commerceworker/platform/do/search-shard';
import { describe, expect, it } from 'vitest';

const index = createShardedSearchIndex(env.SEARCH, 4);
const scope = { spaceId: 'search-space', environmentId: 'main' };
const doc = (entryId: string, text: string, entryVersion = 1, locale = 'en-US') => ({
  entryId,
  contentTypeApiId: 'article',
  textByLocale: { [locale]: text },
  entryVersion,
});

describe('ftsMatch', () => {
  it('quotes every term, ANDs them, and prefixes the last', () => {
    expect(ftsMatch('hello world')).toBe('"hello" "world"*');
  });
  it('makes FTS operators and punctuation inert', () => {
    expect(ftsMatch('a OR "b" NEAR(c) -d')).toBe('"a" "OR" "b" "NEAR" "c" "d"*');
    expect(ftsMatch('  ¿?! ')).toBe('');
  });
});

describe('shardOf', () => {
  it('is stable and in range', () => {
    for (const id of ['a', 'entry-1', '018f-uuid']) {
      const n = shardOf(id, 8);
      expect(n).toBe(shardOf(id, 8));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(8);
    }
  });
});

describe('sharded FTS5 index', () => {
  it('finds entries across shards, ranked, with accent folding and prefix match', async () => {
    await index.index(scope, doc('e1', 'Crème brûlée recipe with vanilla'));
    await index.index(scope, doc('e2', 'Vanilla ice cream and vanilla sugar'));
    await index.index(scope, doc('e3', 'Chocolate cake'));
    const hits = await index.search(scope, 'vanil', { topK: 10 });
    expect(hits.map((h) => h.entryId).sort()).toEqual(['e1', 'e2']);
    expect((await index.search(scope, 'creme', { topK: 10 })).map((h) => h.entryId)).toEqual([
      'e1',
    ]);
  });

  it('replaces on reindex and ignores an older version arriving late', async () => {
    await index.index(scope, doc('v1', 'original words', 2));
    await index.index(scope, doc('v1', 'stale words', 1));
    expect(await index.search(scope, 'stale', { topK: 5 })).toEqual([]);
    await index.index(scope, doc('v1', 'fresh words', 3));
    expect(await index.search(scope, 'original', { topK: 5 })).toEqual([]);
    expect((await index.search(scope, 'fresh', { topK: 5 })).map((h) => h.entryId)).toEqual(['v1']);
  });

  it('removes, counts, and keeps scopes apart', async () => {
    const other = { spaceId: 'search-space', environmentId: 'staging' };
    await index.index(other, doc('o1', 'unique staging text'));
    expect(await index.search(scope, 'unique staging', { topK: 5 })).toEqual([]);
    const before = (await index.stats?.(other))?.documents;
    expect(before).toBe(1);
    await index.remove(other, 'o1');
    expect((await index.stats?.(other))?.documents).toBe(0);
  });
});
