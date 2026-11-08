import type { DeliveredEntry, DeliveryClient, Fields } from '@commerceworker/sdk-core';

/**
 * Key-value persistence the offline client writes through. Matches React
 * Native's `AsyncStorage` (async) and MMKV (sync) — both satisfy this, so apps
 * inject their store of choice; tests use `InMemoryStorage`.
 */
export interface Storage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export class InMemoryStorage implements Storage {
  private readonly m = new Map<string, string>();
  getItem(key: string) {
    return this.m.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.m.set(key, value);
  }
  removeItem(key: string) {
    this.m.delete(key);
  }
}

export interface OfflineOptions {
  readonly client: DeliveryClient;
  readonly storage: Storage;
  readonly contentType: string;
  readonly locale?: string;
  /** Page size for the sync fetch loop. */
  readonly pageSize?: number;
}

export interface SyncResult {
  readonly synced: number;
  readonly cursor: string | null;
}

/**
 * Offline-first delivery for mobile. `sync()` performs **delta sync** — it asks
 * the Delivery API only for entries published since the last cursor, persists
 * them locally, and advances the cursor; `get`/`list` read from local storage so
 * the app works offline. (Deletion tracking would need a server tombstone feed —
 * unpublished entries are not removed locally yet.)
 */
export function createOfflineDelivery<F extends Fields = Fields>(opts: OfflineOptions) {
  const { client, storage, contentType, locale } = opts;
  const pageSize = opts.pageSize ?? 100;
  const entryKey = (id: string) => `commerceworker:entry:${contentType}:${id}`;
  const indexKey = `commerceworker:index:${contentType}`;
  const cursorKey = `commerceworker:cursor:${contentType}`;

  const readIndex = async (): Promise<string[]> => {
    const raw = await storage.getItem(indexKey);
    return raw ? (JSON.parse(raw) as string[]) : [];
  };

  return {
    /** Delta-sync from the server into local storage. Returns count + new cursor. */
    async sync(): Promise<SyncResult> {
      const since = (await storage.getItem(cursorKey)) ?? undefined;
      const fetched: DeliveredEntry<F>[] = [];
      for (let skip = 0; ; skip += pageSize) {
        const { items } = await client.listEntries<F>({
          contentType,
          locale,
          since,
          limit: pageSize,
          skip,
        });
        fetched.push(...items);
        if (items.length < pageSize) break;
      }

      const index = new Set(await readIndex());
      let cursor = since ?? null;
      for (const entry of fetched) {
        await storage.setItem(entryKey(entry.id), JSON.stringify(entry));
        index.add(entry.id);
        if (!cursor || entry.publishedAt > cursor) cursor = entry.publishedAt;
      }
      await storage.setItem(indexKey, JSON.stringify([...index]));
      if (cursor) await storage.setItem(cursorKey, cursor);
      return { synced: fetched.length, cursor };
    },

    /** Read a cached entry (offline). */
    async get(id: string): Promise<DeliveredEntry<F> | null> {
      const raw = await storage.getItem(entryKey(id));
      return raw ? (JSON.parse(raw) as DeliveredEntry<F>) : null;
    },

    /** Read all cached entries for the content type (offline). */
    async list(): Promise<DeliveredEntry<F>[]> {
      const ids = await readIndex();
      const out: DeliveredEntry<F>[] = [];
      for (const id of ids) {
        const e = await this.get(id);
        if (e) out.push(e);
      }
      return out;
    },

    /** Clears local cache + cursor for this content type. */
    async reset(): Promise<void> {
      for (const id of await readIndex()) await storage.removeItem(entryKey(id));
      await storage.removeItem(indexKey);
      await storage.removeItem(cursorKey);
    },
  };
}

export type OfflineDelivery<F extends Fields = Fields> = ReturnType<
  typeof createOfflineDelivery<F>
>;
