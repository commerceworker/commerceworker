import type { DeliveredEntry, DeliveryClient } from '@commerceworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { createOfflineDelivery, InMemoryStorage } from '../src/index.js';

const entry = (id: string, publishedAt: string): DeliveredEntry => ({
  id,
  contentType: 'article',
  fields: { title: id },
  publishedAt,
});

/** A fake Delivery client honoring `since` + skip/limit over a mutable dataset. */
function fakeClient(data: DeliveredEntry[]): DeliveryClient {
  return {
    async listEntries(
      q: { since?: string; limit?: number; skip?: number; contentType?: string } = {},
    ) {
      let items = data.filter((e) => !q.contentType || e.contentType === q.contentType);
      if (q.since) items = items.filter((e) => e.publishedAt > (q.since as string));
      items = items
        .sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1))
        .slice(q.skip ?? 0, (q.skip ?? 0) + (q.limit ?? 100));
      return { items, total: items.length };
    },
  } as unknown as DeliveryClient;
}

describe('@commerceworker/sdk-react-native offline delivery', () => {
  it('initial sync persists entries and sets the cursor; reads work offline', async () => {
    const data = [entry('a', '2026-01-01T00:00:00Z'), entry('b', '2026-01-02T00:00:00Z')];
    const storage = new InMemoryStorage();
    const store = createOfflineDelivery({
      client: fakeClient(data),
      storage,
      contentType: 'article',
    });

    const r = await store.sync();
    expect(r.synced).toBe(2);
    expect(r.cursor).toBe('2026-01-02T00:00:00Z');

    // Reads come from storage (the fake client is not consulted here).
    expect((await store.get('a'))?.fields.title).toBe('a');
    expect(await store.list()).toHaveLength(2);
  });

  it('delta-syncs only entries published after the cursor', async () => {
    const data = [entry('a', '2026-01-01T00:00:00Z'), entry('b', '2026-01-02T00:00:00Z')];
    const client = fakeClient(data);
    const storage = new InMemoryStorage();
    const store = createOfflineDelivery({ client, storage, contentType: 'article' });
    await store.sync(); // cursor → b's time

    // A new entry published later.
    data.push(entry('c', '2026-01-03T00:00:00Z'));
    const r2 = await store.sync();
    expect(r2.synced).toBe(1); // only 'c' came back (delta)
    expect(r2.cursor).toBe('2026-01-03T00:00:00Z');
    expect(await store.list()).toHaveLength(3);
  });

  it('paginates the sync fetch loop', async () => {
    const data = Array.from({ length: 25 }, (_, i) =>
      entry(`e${i}`, `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    );
    const storage = new InMemoryStorage();
    const store = createOfflineDelivery({
      client: fakeClient(data),
      storage,
      contentType: 'article',
      pageSize: 10,
    });
    const r = await store.sync();
    expect(r.synced).toBe(25);
    expect(await store.list()).toHaveLength(25);
  });

  it('reset clears the local cache and cursor', async () => {
    const data = [entry('a', '2026-01-01T00:00:00Z')];
    const storage = new InMemoryStorage();
    const store = createOfflineDelivery({
      client: fakeClient(data),
      storage,
      contentType: 'article',
    });
    await store.sync();
    await store.reset();
    expect(await store.list()).toHaveLength(0);
    // After reset the cursor is gone → a re-sync pulls everything again.
    expect((await store.sync()).synced).toBe(1);
  });
});
