import { describe, expect, it } from 'vitest';
import { createKvCache, type KvBinding } from '../../src/cache-kv/index';

/** Minimal in-memory KV with TTL capture (no expiry simulation needed here). */
function fakeKv() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv: KvBinding = {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value, options) {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
  };
  return { kv, data, ttls };
}

describe('createKvCache', () => {
  it('round-trips values and misses on unknown keys', async () => {
    const { kv } = fakeKv();
    const cache = createKvCache(kv);
    await cache.set('a', 'hello');
    expect(await cache.get('a')).toBe('hello');
    expect(await cache.get('missing')).toBeNull();
  });

  it('invalidateTag makes tagged entries miss while untagged survive', async () => {
    const { kv } = fakeKv();
    const cache = createKvCache(kv);
    await cache.set('tagged', 'v1', { tags: ['entry:s:e:1'] });
    await cache.set('other', 'v2', { tags: ['entry:s:e:2'] });
    await cache.set('untagged', 'v3');

    await cache.invalidateTag('entry:s:e:1');

    expect(await cache.get('tagged')).toBeNull();
    expect(await cache.get('other')).toBe('v2');
    expect(await cache.get('untagged')).toBe('v3');
  });

  it('a re-set after invalidation snapshots the new tag version', async () => {
    const { kv } = fakeKv();
    const cache = createKvCache(kv);
    await cache.set('k', 'v1', { tags: ['t'] });
    await cache.invalidateTag('t');
    await cache.set('k', 'v2', { tags: ['t'] });
    expect(await cache.get('k')).toBe('v2');
  });

  it('any one stale tag among several invalidates the entry', async () => {
    const { kv } = fakeKv();
    const cache = createKvCache(kv);
    await cache.set('k', 'v', { tags: ['t1', 't2'] });
    await cache.invalidateTag('t2');
    expect(await cache.get('k')).toBeNull();
  });

  it('clamps TTLs to the KV minimum of 60 seconds', async () => {
    const { kv, ttls } = fakeKv();
    const cache = createKvCache(kv);
    await cache.set('short', 'v', { ttlSeconds: 5 });
    await cache.set('long', 'v', { ttlSeconds: 600 });
    expect(ttls.get('c:short')).toBe(60);
    expect(ttls.get('c:long')).toBe(600);
  });
});
