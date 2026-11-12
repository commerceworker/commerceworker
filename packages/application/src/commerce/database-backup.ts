/**
 * The commerce database's backup and the restore that proves it: a logical copy in the backups
 * bucket, and a drill that rebuilds it in the standby database and checks what came back.
 *
 * A backup is `d1/<date>/<table>/<n>.ndjson.gz`, a gzipped page of rows a line, and
 * `d1/<date>/manifest.json` written last: the schema, every table's chunks with their SHA-256 and
 * row counts, and the newest applied migration. `d1/` is under a bucket lock that refuses an
 * overwrite, so every write looks first and a retried step carries on from the chunks already
 * there (`copyChunk`). Pages are read while writes go on, so a backup isn't one instant across
 * tables; `startedAt` and `finishedAt` bound it, and a Time Travel bookmark for that time is the
 * exact point (the manifest can't carry one: a Worker can't read it).
 *
 * A restore never trusts what it reads: a chunk missing or not matching its hash is refused
 * (`BackupRefusal`), before and again as it loads. `checkRestore` compares the result with the
 * manifest; the engine's Workflows (apps/engine/src/d1-backup.ts) call these one step at a time.
 */
import type { AuditChainCheck } from '@commerceworker/core';
import {
  type AuditLog,
  BackupRefusal,
  type BackupStore,
  type CopyRow,
  type CopySchema,
  type DatabaseExport,
  type DatabaseRestoreTarget,
} from '@commerceworker/ports/commerce';
import { verifyAuditTrail } from './audit-trail';

/** The manifest's shape; a restore refuses any other. */
export const BACKUP_FORMAT = 1;
/** Rows per chunk, at most. */
export const BACKUP_PAGE = 1000;

export const backupPrefix = (date: string) => `d1/${date}/`;
export const manifestKey = (date: string) => `${backupPrefix(date)}manifest.json`;
export const chunkKey = (date: string, table: string, n: number) =>
  `${backupPrefix(date)}${table}/${n}.ndjson.gz`;
export const drillKey = (date: string) => `drills/${date}.json`;

/** The UTC date a backup started on names it. */
export const backupDate = (at: Date) => at.toISOString().slice(0, 10);

export type ChunkRecord = { key: string; sha256: string; rows: number; bytes: number };
export type TableCopy = { rows: number; chunks: ChunkRecord[] };
export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  date: string;
  startedAt: string;
  finishedAt: string;
  /** The newest applied migration when the copy started. */
  migrationHead: string | null;
  /** A Worker can't read a Time Travel bookmark: find one for `startedAt` with `wrangler d1 time-travel info`. */
  timeTravelBookmark: null;
  schema: CopySchema;
  tables: Record<string, TableCopy>;
};

/** What one chunk step returns: the chunk (none for an empty table) and where the next begins. */
export type ChunkCopy = { chunk: ChunkRecord | null; next: number; more: boolean };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const body = new Response(new Uint8Array(bytes)).body!.pipeThrough(
    stream as unknown as TransformStream,
  );
  return new Uint8Array(await new Response(body).arrayBuffer());
}

const gzip = (text: string) => pipe(new TextEncoder().encode(text), new CompressionStream('gzip'));
const gunzip = async (bytes: Uint8Array) =>
  new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip')));

/**
 * Writes `key` unless it exists (the lock refuses an overwrite), and returns what is stored there
 * either way: a put that loses a race to another attempt is taken as the object that won.
 */
async function putOnce(
  store: BackupStore,
  key: string,
  body: string | Uint8Array,
  customMetadata?: Record<string, string>,
) {
  const existing = await store.head(key);
  if (existing) return existing;
  try {
    const put = await store.put(key, body, { customMetadata });
    if (put) return put;
  } catch (err) {
    const won = await store.head(key);
    if (won) return won;
    throw err;
  }
  throw new Error(`${key} was not stored`);
}

/**
 * One chunk of `table`: up to `limit` rows after `cursor`, gzipped under its key. A chunk already
 * stored (an earlier attempt of this step) is not read again; its metadata says where it ends.
 */
export async function copyChunk(
  source: DatabaseExport,
  store: BackupStore,
  at: { date: string; table: string; n: number; cursor: number },
  limit = BACKUP_PAGE,
): Promise<ChunkCopy> {
  const key = chunkKey(at.date, at.table, at.n);
  const kept = await store.head(key);
  if (kept?.customMetadata) {
    const m = kept.customMetadata;
    return {
      chunk: { key, sha256: m.sha256 ?? '', rows: Number(m.rows), bytes: Number(m.bytes) },
      next: Number(m.next),
      more: m.more === 'true',
    };
  }
  const page = await source.page(at.table, at.cursor, limit);
  if (!page.rows.length) return { chunk: null, next: at.cursor, more: false };
  const body = await gzip(page.rows.map((r) => JSON.stringify(r)).join('\n'));
  const sha256 = await sha256Hex(body);
  const stored = await putOnce(store, key, body, {
    sha256,
    rows: String(page.rows.length),
    bytes: String(body.byteLength),
    next: String(page.next),
    more: String(page.more),
  });
  const m = stored.customMetadata ?? {};
  // Another attempt stored this chunk first: carry on from where its rows end.
  return {
    chunk: {
      key,
      sha256: m.sha256 ?? sha256,
      rows: Number(m.rows ?? page.rows.length),
      bytes: Number(m.bytes ?? body.byteLength),
    },
    next: Number(m.next ?? page.next),
    more: (m.more ?? String(page.more)) === 'true',
  };
}

/** Writes the manifest, the last key of a backup: a day without one hasn't finished. */
export async function writeManifest(store: BackupStore, manifest: BackupManifest) {
  await putOnce(store, manifestKey(manifest.date), JSON.stringify(manifest), {
    format: String(BACKUP_FORMAT),
  });
}

/** The manifest of `date`; null when there is none, a refusal when it isn't one a restore reads. */
export async function readManifest(
  store: BackupStore,
  date: string,
): Promise<BackupManifest | null> {
  const object = await store.get(manifestKey(date));
  if (!object) return null;
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
  } catch {
    throw new BackupRefusal(`the manifest of ${date} is not JSON`);
  }
  if (manifest.format !== BACKUP_FORMAT)
    throw new BackupRefusal(
      `the manifest of ${date} is format ${manifest.format}, not ${BACKUP_FORMAT}`,
    );
  for (const t of manifest.schema.tables)
    if (!manifest.tables[t.name])
      throw new BackupRefusal(`the manifest of ${date} has no copy of ${t.name}`);
  return manifest;
}

/** The newest date with a finished backup. */
export async function latestBackupDate(store: BackupStore): Promise<string | null> {
  const dates: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix: 'd1/', delimiter: '/', cursor });
    for (const p of page.delimitedPrefixes) dates.push(p.slice(3, -1));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (const date of dates.sort().reverse()) if (await store.head(manifestKey(date))) return date;
  return null;
}

/** Reads a chunk and checks it against the manifest's hash; a missing or altered one is refused. */
async function readChunk(store: BackupStore, chunk: ChunkRecord): Promise<Uint8Array> {
  const object = await store.get(chunk.key);
  if (!object) throw new BackupRefusal(`${chunk.key} is missing`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== chunk.sha256)
    throw new BackupRefusal(`${chunk.key} does not match its hash in the manifest`);
  return bytes;
}

/** Checks every chunk of `table` against the manifest; returns the rows they hold. */
export async function verifyTable(
  store: BackupStore,
  manifest: BackupManifest,
  table: string,
): Promise<number> {
  const copy = manifest.tables[table];
  if (!copy) throw new BackupRefusal(`the manifest has no copy of ${table}`);
  let rows = 0;
  for (const chunk of copy.chunks) {
    await readChunk(store, chunk);
    rows += chunk.rows;
  }
  if (rows !== copy.rows)
    throw new BackupRefusal(
      `${table}: its chunks hold ${rows} rows, the manifest says ${copy.rows}`,
    );
  return rows;
}

/** Loads chunk `n` of `table` into the target; returns its rows. */
export async function loadChunk(
  store: BackupStore,
  target: DatabaseRestoreTarget,
  manifest: BackupManifest,
  table: string,
  n: number,
): Promise<number> {
  const chunk = manifest.tables[table]?.chunks[n];
  if (!chunk) throw new BackupRefusal(`${table} has no chunk ${n}`);
  const text = await gunzip(await readChunk(store, chunk));
  const rows = text ? (text.split('\n').map((l) => JSON.parse(l)) as CopyRow[]) : [];
  if (rows.length !== chunk.rows)
    throw new BackupRefusal(
      `${chunk.key} holds ${rows.length} rows, the manifest says ${chunk.rows}`,
    );
  const columns = manifest.schema.tables.find((t) => t.name === table)?.columns ?? [];
  return target.load(table, columns, rows);
}

export type RestoreChecks = {
  tables: { ok: boolean; missing: string[]; extra: string[] };
  rowCounts: { ok: boolean; mismatches: { table: string; expected: number; actual: number }[] };
  migrationHead: { ok: boolean; expected: string | null; actual: string | null };
  foreignKeys: { ok: boolean; violations: number };
  auditChain: { ok: boolean; checked: number; reason?: string };
  search: { ok: boolean; mismatches: { index: string; expected: number; actual: number }[] };
};

/** The table a search index reads its documents from (`content='…'`), if it has one. */
const contentTable = (ddl: string) => /content\s*=\s*['"]?(\w+)/i.exec(ddl)?.[1];

/** Compares the restored database with the manifest and runs its own integrity checks. */
export async function checkRestore(
  manifest: BackupManifest,
  target: DatabaseRestoreTarget,
  audit: AuditLog,
): Promise<RestoreChecks> {
  const there = await target.tableNames();
  const want = manifest.schema.tables.map((t) => t.name);
  const missing = want.filter((t) => !there.includes(t));
  const extra = there.filter((t) => !want.includes(t));

  const mismatches: RestoreChecks['rowCounts']['mismatches'] = [];
  for (const t of want.filter((t) => there.includes(t))) {
    const actual = await target.rowCount(t);
    const expected = manifest.tables[t]?.rows ?? 0;
    if (actual !== expected) mismatches.push({ table: t, expected, actual });
  }

  const head = await target.migrationHead();
  const violations = await target.foreignKeyViolations();

  // The chain checked in batches, to its head.
  let chain: AuditChainCheck & { next?: number } = { ok: true, checked: 0, last: null };
  let checked = 0;
  for (let after: number | undefined; ; after = chain.next) {
    chain = await verifyAuditTrail({ audit }, after);
    checked += chain.checked;
    if (!chain.ok || chain.next === undefined) break;
  }

  const searchMismatches: RestoreChecks['search']['mismatches'] = [];
  for (const s of manifest.schema.search) {
    const content = contentTable(s.ddl);
    if (!content || !there.includes(content)) continue;
    const expected = await target.rowCount(content);
    const actual = await target.indexedRows(s.name);
    if (actual !== expected) searchMismatches.push({ index: s.name, expected, actual });
  }

  return {
    tables: { ok: !missing.length && !extra.length, missing, extra },
    rowCounts: { ok: !mismatches.length, mismatches },
    migrationHead: {
      ok: head === manifest.migrationHead,
      expected: manifest.migrationHead,
      actual: head,
    },
    foreignKeys: { ok: violations === 0, violations },
    auditChain: {
      ok: chain.ok,
      checked,
      ...(chain.ok ? {} : { reason: `event ${chain.brokenAt}: ${chain.reason}` }),
    },
    search: { ok: !searchMismatches.length, mismatches: searchMismatches },
  };
}

export const checksPassed = (c: RestoreChecks) =>
  c.tables.ok &&
  c.rowCounts.ok &&
  c.migrationHead.ok &&
  c.foreignKeys.ok &&
  c.auditChain.ok &&
  c.search.ok;

/** What a drill leaves in `drills/<date>.json`. */
export type DrillEvidence = {
  outcome: 'passed' | 'failed';
  /** The day the drill ran, and the backup it restored. */
  date: string;
  backup: string | null;
  instance: string;
  startedAt: string;
  finishedAt: string;
  minutes: number;
  checks: RestoreChecks | null;
  error?: string;
};
