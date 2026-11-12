import { auditRow, sealAuditRow } from '@commerceworker/core';
import { BackupRefusal, type BackupStore, type CopyRow } from '@commerceworker/ports/commerce';
import { InMemoryAuditLog, InMemoryDatabaseCopy } from '@commerceworker/test-kit/commerce';
import { describe, expect, it, vi } from 'vitest';
import {
  type BackupManifest,
  checkRestore,
  checksPassed,
  copyChunk,
  latestBackupDate,
  loadChunk,
  manifestKey,
  readManifest,
  verifyTable,
  writeManifest,
} from '../src/commerce/database-backup';

/** A bucket in a map; a put over a key that exists throws, as a locked prefix does. */
function memoryStore() {
  const objects = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>();
  const store: BackupStore = {
    async head(key) {
      return objects.get(key) ?? null;
    },
    async get(key) {
      const o = objects.get(key);
      return o && { arrayBuffer: async () => o.body.slice().buffer as ArrayBuffer };
    },
    async put(key, value, options) {
      if (objects.has(key)) throw new Error('locked');
      const body =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : new Uint8Array(value as ArrayBuffer);
      objects.set(key, { body, customMetadata: options?.customMetadata });
      return objects.get(key)!;
    },
    async list({ prefix, delimiter }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      const prefixes = new Set(
        delimiter ? keys.map((k) => k.slice(0, k.indexOf(delimiter, prefix.length) + 1)) : [],
      );
      return {
        objects: delimiter ? [] : keys.map((key) => ({ key })),
        delimitedPrefixes: [...prefixes],
        truncated: false,
      };
    },
  };
  return { store, objects };
}

const DATE = '2026-11-12';
const ITEMS = 'CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT)';
const rows = (n: number): CopyRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `item ${i}` }));

/** A source with 5 items, backed up in chunks of 2. */
async function backedUp() {
  const source = new InMemoryDatabaseCopy();
  source.seed(ITEMS, rows(5));
  source.head = '0076_x.sql';
  const { store, objects } = memoryStore();
  const manifest: BackupManifest = {
    format: 1,
    date: DATE,
    startedAt: 'a',
    finishedAt: 'b',
    migrationHead: source.head,
    timeTravelBookmark: null,
    schema: await source.schema(),
    tables: { items: { rows: 0, chunks: [] } },
  };
  let cursor = 0;
  for (let n = 0; ; n++) {
    const got = await copyChunk(source, store, { date: DATE, table: 'items', n, cursor }, 2);
    manifest.tables.items!.chunks.push(got.chunk!);
    manifest.tables.items!.rows += got.chunk!.rows;
    cursor = got.next;
    if (!got.more) break;
  }
  await writeManifest(store, manifest);
  return { source, store, objects, manifest };
}

describe('the database backup', () => {
  it('copies a table in chunks a retry resumes instead of reading again', async () => {
    const { source, store, manifest } = await backedUp();
    expect(manifest.tables.items!.chunks.map((c) => [c.key, c.rows])).toEqual([
      [`d1/${DATE}/items/0.ndjson.gz`, 2],
      [`d1/${DATE}/items/1.ndjson.gz`, 2],
      [`d1/${DATE}/items/2.ndjson.gz`, 1],
    ]);
    const page = vi.spyOn(source, 'page');
    // The retried step: the chunk is there, so it is not read or written again.
    const again = await copyChunk(
      source,
      store,
      { date: DATE, table: 'items', n: 1, cursor: 2 },
      2,
    );
    expect(page).not.toHaveBeenCalled();
    expect(again).toEqual({ chunk: manifest.tables.items!.chunks[1], next: 4, more: true });
    // An empty table has no chunk.
    source.seed('CREATE TABLE nothing (id TEXT PRIMARY KEY)');
    expect(
      await copyChunk(source, store, { date: DATE, table: 'nothing', n: 0, cursor: 0 }),
    ).toEqual({
      chunk: null,
      next: 0,
      more: false,
    });
  });

  it('restores what it copied, and a chunk loaded twice leaves one copy of each row', async () => {
    const { store, manifest } = await backedUp();
    const target = new InMemoryDatabaseCopy();
    await target.reset();
    await target.createTables(manifest.schema);
    expect(await verifyTable(store, manifest, 'items')).toBe(5);
    for (const n of [0, 1, 2, 2]) await loadChunk(store, target, manifest, 'items', n);
    expect(await target.rowCount('items')).toBe(5);
  });

  it('refuses a chunk that was changed or is gone, and a manifest it does not read', async () => {
    const { store, objects, manifest } = await backedUp();
    const key = manifest.tables.items!.chunks[1]!.key;
    const original = objects.get(key)!;
    objects.set(key, { ...original, body: new Uint8Array([9, 9, 9]) });
    await expect(verifyTable(store, manifest, 'items')).rejects.toThrow(/does not match its hash/);
    await expect(
      loadChunk(store, new InMemoryDatabaseCopy(), manifest, 'items', 1),
    ).rejects.toBeInstanceOf(BackupRefusal);
    objects.delete(key);
    await expect(verifyTable(store, manifest, 'items')).rejects.toThrow(/is missing/);

    objects.set(manifestKey(DATE), { body: new TextEncoder().encode('{"format":2}') });
    await expect(readManifest(store, DATE)).rejects.toThrow(/format 2/);
    objects.set(manifestKey(DATE), { body: new TextEncoder().encode('nope') });
    await expect(readManifest(store, DATE)).rejects.toThrow(/not JSON/);
    expect(await readManifest(store, '2026-01-01')).toBeNull();
  });

  it('finds the newest backup that finished', async () => {
    const { store, objects } = await backedUp();
    // A later day whose manifest was never written is a backup that did not finish.
    objects.set('d1/2026-11-13/items/0.ndjson.gz', { body: new Uint8Array([1]) });
    expect(await latestBackupDate(store)).toBe(DATE);
    expect(await latestBackupDate(memoryStore().store)).toBeNull();
  });
});

describe('the checks on a restored database', () => {
  async function restored(mutate?: (t: InMemoryDatabaseCopy) => Promise<void> | void) {
    const { store, manifest } = await backedUp();
    const target = new InMemoryDatabaseCopy();
    target.head = manifest.migrationHead;
    await target.reset();
    await target.createTables(manifest.schema);
    for (const n of [0, 1, 2]) await loadChunk(store, target, manifest, 'items', n);
    await mutate?.(target);
    const audit = new InMemoryAuditLog();
    for (const id of ['a1', 'a2', 'a3'])
      await audit.append((h) =>
        sealAuditRow(
          auditRow(id, 'flow.saved', { actor: { kind: 'operator', name: 't' } as never }),
          h,
        ),
      );
    return { manifest, target, audit };
  }

  it('passes a faithful restore', async () => {
    const { manifest, target, audit } = await restored();
    const checks = await checkRestore(manifest, target, audit);
    expect(checksPassed(checks)).toBe(true);
    expect(checks.auditChain).toEqual({ ok: true, checked: 3 });
  });

  it('fails on a row count, another migration head, a stray table or a broken chain', async () => {
    const old = await restored((t) => {
      t.head = '0075_old.sql';
    });
    const checks = await checkRestore(old.manifest, old.target, old.audit);
    expect(checks.migrationHead).toMatchObject({
      ok: false,
      expected: '0076_x.sql',
      actual: '0075_old.sql',
    });

    const fewer = await restored();
    // Rows the manifest counts that never loaded.
    fewer.manifest.tables.items!.rows = 6;
    expect((await checkRestore(fewer.manifest, fewer.target, fewer.audit)).rowCounts).toEqual({
      ok: false,
      mismatches: [{ table: 'items', expected: 6, actual: 5 }],
    });

    const broken = await restored();
    broken.audit.events[1] = { ...broken.audit.events[1]!, detail: '{"edited":true}' } as never;
    const chain = (await checkRestore(broken.manifest, broken.target, broken.audit)).auditChain;
    expect(chain.ok).toBe(false);
    expect(chain.reason).toMatch(/event 2/);

    const extra = await restored(async (t) => t.seed('CREATE TABLE strays (id TEXT PRIMARY KEY)'));
    expect((await checkRestore(extra.manifest, extra.target, extra.audit)).tables).toEqual({
      ok: false,
      missing: [],
      extra: ['strays'],
    });
  });
});
