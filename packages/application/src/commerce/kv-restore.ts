/**
 * The format of a KV namespace's backup, and the plan that puts one back. No imports: the nightly
 * export (`kv-backup.ts`, in the web app's Workflow) and `scripts/fleet.ts kv-restore` (run by an
 * operator under Node, never in CI) read the same file.
 *
 * A backup is `kv/<date>/<name>/<n>.ndjson.gz`, a gzipped page of keys a line, and
 * `kv/<date>/<name>/manifest.json` written last: every chunk with its SHA-256, and what was left out.
 */

/** The manifest's shape; a restore refuses any other. */
export const KV_BACKUP_FORMAT = 1;
/** The least a KV key may be given to live (`expirationTtl`), in seconds. */
export const KV_MIN_TTL_S = 60;
/** Keys one `wrangler kv bulk put` file may hold, and the most bytes of values it may hold. */
export const KV_BULK_KEYS = 10_000;
export const KV_BULK_BYTES = 90 * 1024 * 1024;

export const kvBackupPrefix = (date: string, name: string) => `kv/${date}/${name}/`;
export const kvManifestKey = (date: string, name: string) =>
  `${kvBackupPrefix(date, name)}manifest.json`;
export const kvChunkKey = (date: string, name: string, n: number) =>
  `${kvBackupPrefix(date, name)}${n}.ndjson.gz`;

/** A key as a backup holds it: `expiration` is seconds since the epoch, absent for a key that lasts. */
export type KvEntry = { key: string; value: string; expiration?: number; metadata?: unknown };

export type KvChunkRecord = { key: string; sha256: string; keys: number; bytes: number };
export type KvManifest = {
  format: typeof KV_BACKUP_FORMAT;
  date: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  /** Keys in the chunks. */
  keys: number;
  /** Listed keys that are not in them: short-lived sign-in state left out on purpose, and keys gone before they were read. */
  skipped: { ephemeral: number; vanished: number };
  /** True when the namespace was larger than one night's copy covers. */
  capped: boolean;
  chunks: KvChunkRecord[];
};

export const encodeKvChunk = (entries: readonly KvEntry[]) =>
  entries.map((e) => JSON.stringify(e)).join('\n');
export const parseKvChunk = (text: string): KvEntry[] =>
  text ? text.split('\n').map((l) => JSON.parse(l) as KvEntry) : [];

/** One `wrangler kv bulk put` item. */
export type KvBulkPut = {
  key: string;
  value: string;
  expiration_ttl?: number;
  metadata?: unknown;
};

export type KvRestorePlan = {
  puts: KvBulkPut[];
  /** Keys that had expired by `now`, left out. */
  expired: number;
};

/**
 * What to write back: every key not yet expired at `now`, with `expiration_ttl` set to the time it
 * has left (a key with under a minute left gets KV's minimum), its metadata, and a key that lasts
 * left to last. Pure: the restore's clock is its argument.
 */
export function planKvRestore(entries: readonly KvEntry[], now: number): KvRestorePlan {
  const nowS = Math.floor(now / 1000);
  const puts: KvBulkPut[] = [];
  let expired = 0;
  for (const e of entries) {
    if (e.expiration !== undefined && e.expiration <= nowS) {
      expired++;
      continue;
    }
    puts.push({
      key: e.key,
      value: e.value,
      ...(e.expiration !== undefined
        ? { expiration_ttl: Math.max(KV_MIN_TTL_S, e.expiration - nowS) }
        : {}),
      ...(e.metadata !== undefined && e.metadata !== null ? { metadata: e.metadata } : {}),
    });
  }
  return { puts, expired };
}

/** Splits a plan into files `kv bulk put` accepts: at most 10,000 keys and about 90 MB each. */
export function splitBulk(puts: readonly KvBulkPut[]): KvBulkPut[][] {
  const files: KvBulkPut[][] = [];
  let current: KvBulkPut[] = [];
  let bytes = 0;
  for (const p of puts) {
    const size = p.key.length + p.value.length + 200;
    if (current.length && (current.length >= KV_BULK_KEYS || bytes + size > KV_BULK_BYTES)) {
      files.push(current);
      current = [];
      bytes = 0;
    }
    current.push(p);
    bytes += size;
  }
  if (current.length) files.push(current);
  return files;
}
