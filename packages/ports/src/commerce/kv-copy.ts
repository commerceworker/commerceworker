/**
 * Copying a KV namespace out: `KvExport` lists its keys with their expiration and metadata and
 * reads their values a batch at a time. The nightly OAuth grant export (packages/application,
 * `kv-backup.ts`) takes it, and a Workers KV binding implements it as is (apps/web/workers/kv-backup.ts).
 * The copy waits in the same `BackupStore` as the database's.
 */

/** A key as a listing returns it: `expiration` is seconds since the epoch, absent for a key that lasts. */
export interface KvKey {
  readonly name: string;
  readonly expiration?: number;
  readonly metadata?: unknown;
}

/** One page of a listing; `cursor` continues it and is absent on the last. */
export interface KvPage {
  readonly keys: readonly KvKey[];
  readonly cursor?: string;
}

export interface KvExport {
  /** Up to `limit` keys after `cursor` (unset starts), in key order. */
  list(cursor: string | undefined, limit: number): Promise<KvPage>;
  /** Values of up to 100 keys; `null` for one that expired or was deleted since it was listed. */
  read(names: readonly string[]): Promise<Map<string, string | null>>;
}
