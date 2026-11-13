/**
 * A KV namespace's nightly export: the OAuth provider's storage (`OAUTH_KV`), the only copy of
 * client registrations and grants. A Workflow (apps/web/workers/kv-backup.ts) calls these one step
 * at a time, as the commerce database's backup does (`database-backup.ts`): a page of keys a
 * chunk, gzipped NDJSON under the backups bucket's `kv/<date>/<name>/`, and the manifest last.
 * `kv/` is under a bucket lock that refuses an overwrite, so every write looks first and a retried
 * step carries on from the chunk already there.
 *
 * The values are copied as they are. The provider stores them hashed or encrypted (docs/operations.md,
 * "Restoring OAuth grants"), and the one place this code knows a key's meaning is `skip`: prefixes of
 * short-lived state (a device sign-in's record holds the caller's address and lives ten minutes)
 * that a backup must not keep for weeks and a restore would only resurrect stale.
 *
 * The planner that puts a dump back is `kv-restore.ts`.
 */
import {
  BackupRefusal,
  type BackupStore,
  type KvExport,
  type KvKey,
} from '@commerceworker/ports/commerce';
import { gunzip, gzip, putOnce, sha256Hex } from './database-backup';
import {
  encodeKvChunk,
  KV_BACKUP_FORMAT,
  type KvChunkRecord,
  type KvEntry,
  type KvManifest,
  kvChunkKey,
  kvManifestKey,
  parseKvChunk,
} from './kv-restore';

export * from './kv-restore';

/** Keys a chunk lists at most (KV's page), and keys one bulk read takes. */
export const KV_PAGE = 1000;
export const KV_READ_BATCH = 100;
/** Chunks a night's copy makes at most; the Workflow has 10,000 steps and a namespace of ten million keys is far beyond this one's use. */
export const KV_MAX_CHUNKS = 9_000;

/** The UTC date a backup started on names it. */
export const kvBackupDate = (at: Date) => at.toISOString().slice(0, 10);

/** What one chunk step returns: the chunk (none for an empty namespace), where the next begins. */
export type KvChunkStep = {
  chunk: KvChunkRecord | null;
  next: string | null;
  more: boolean;
  ephemeral: number;
  vanished: number;
};

const metaOf = (s: KvChunkStep, chunk: KvChunkRecord) => ({
  sha256: chunk.sha256,
  keys: String(chunk.keys),
  bytes: String(chunk.bytes),
  next: s.next ?? '',
  more: String(s.more),
  ephemeral: String(s.ephemeral),
  vanished: String(s.vanished),
});

/**
 * One chunk of `source`: a page of keys after `cursor`, their values read in batches, gzipped under
 * its key. A chunk already stored (an earlier attempt of this step) is not read again; its metadata
 * says where it ends.
 */
export async function copyKvChunk(
  source: KvExport,
  store: BackupStore,
  at: { date: string; name: string; n: number; cursor: string | null },
  skip: readonly string[] = [],
  page = KV_PAGE,
): Promise<KvChunkStep> {
  const key = kvChunkKey(at.date, at.name, at.n);
  const fromMeta = (m: Record<string, string>): KvChunkStep => ({
    chunk: { key, sha256: m.sha256 ?? '', keys: Number(m.keys), bytes: Number(m.bytes) },
    next: m.next ? m.next : null,
    more: m.more === 'true',
    ephemeral: Number(m.ephemeral ?? 0),
    vanished: Number(m.vanished ?? 0),
  });
  const kept = await store.head(key);
  if (kept?.customMetadata) return fromMeta(kept.customMetadata);

  const listed = await source.list(at.cursor ?? undefined, page);
  if (!listed.keys.length)
    return { chunk: null, next: null, more: false, ephemeral: 0, vanished: 0 };
  const wanted: KvKey[] = [];
  let ephemeral = 0;
  for (const k of listed.keys)
    if (skip.some((p) => k.name.startsWith(p))) ephemeral++;
    else wanted.push(k);
  const entries: KvEntry[] = [];
  let vanished = 0;
  for (let i = 0; i < wanted.length; i += KV_READ_BATCH) {
    const batch = wanted.slice(i, i + KV_READ_BATCH);
    const values = await source.read(batch.map((k) => k.name));
    for (const k of batch) {
      const value = values.get(k.name);
      if (value === null || value === undefined) vanished++;
      else
        entries.push({
          key: k.name,
          value,
          ...(k.expiration !== undefined ? { expiration: k.expiration } : {}),
          ...(k.metadata !== undefined && k.metadata !== null ? { metadata: k.metadata } : {}),
        });
    }
  }
  const body = await gzip(encodeKvChunk(entries));
  const step: KvChunkStep = {
    chunk: null,
    next: listed.cursor ?? null,
    more: !!listed.cursor,
    ephemeral,
    vanished,
  };
  const sha256 = await sha256Hex(body);
  const stored = await putOnce(
    store,
    key,
    body,
    metaOf(step, { key, sha256, keys: entries.length, bytes: body.byteLength }),
  );
  // Another attempt stored this chunk first: carry on from where its page ends.
  return fromMeta(
    stored.customMetadata ??
      metaOf(step, { key, sha256, keys: entries.length, bytes: body.byteLength }),
  );
}

/** Writes the manifest, the last key of a backup: a day without one hasn't finished. */
export async function writeKvManifest(store: BackupStore, manifest: KvManifest) {
  await putOnce(store, kvManifestKey(manifest.date, manifest.name), JSON.stringify(manifest), {
    format: String(KV_BACKUP_FORMAT),
  });
}

/** The manifest of `date`; null when there is none, a refusal when it isn't one a restore reads. */
export async function readKvManifest(
  store: BackupStore,
  date: string,
  name: string,
): Promise<KvManifest | null> {
  const object = await store.get(kvManifestKey(date, name));
  if (!object) return null;
  let manifest: KvManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
  } catch {
    throw new BackupRefusal(`the manifest of ${name} on ${date} is not JSON`);
  }
  if (manifest.format !== KV_BACKUP_FORMAT)
    throw new BackupRefusal(
      `the manifest of ${name} on ${date} is format ${manifest.format}, not ${KV_BACKUP_FORMAT}`,
    );
  return manifest;
}

/** Reads a chunk, checks it against the manifest's hash and returns its keys; a missing or altered one is refused. */
export async function loadKvChunk(store: BackupStore, chunk: KvChunkRecord): Promise<KvEntry[]> {
  const object = await store.get(chunk.key);
  if (!object) throw new BackupRefusal(`${chunk.key} is missing`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== chunk.sha256)
    throw new BackupRefusal(`${chunk.key} does not match its hash in the manifest`);
  const entries = parseKvChunk(await gunzip(bytes));
  if (entries.length !== chunk.keys)
    throw new BackupRefusal(
      `${chunk.key} holds ${entries.length} keys, the manifest says ${chunk.keys}`,
    );
  return entries;
}
