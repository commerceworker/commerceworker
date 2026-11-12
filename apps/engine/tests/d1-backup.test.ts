import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { auditRow, sealAuditRow } from '@commerceworker/core';
import { d1AuditLog } from '@commerceworker/db/audit-log';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const today = new Date().toISOString().slice(0, 10);

async function until<T>(fn: () => Promise<T | false>, what: string, ms = 50_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Starts a Workflow instance and waits for it to end. */
async function run(wf: Workflow<never>, id: string, params?: unknown) {
  await wf.create({ id, params: params as never });
  return until(async () => {
    const s = await (await wf.get(id)).status();
    return ['errored', 'complete', 'terminated'].includes(s.status) ? s : false;
  }, `${id} to end`);
}

const dump = async (db: D1Database, sql: string) => (await db.prepare(sql).all()).results;
/** A table's rows in a fixed order (some tables have no rowid to sort by). */
const rowsOf = async (db: D1Database, table: string) =>
  (await dump(db, `SELECT * FROM "${table}"`)).map((r) => JSON.stringify(r)).sort();
const names = async (db: D1Database) =>
  (
    await dump(
      db,
      `SELECT type, name FROM sqlite_master
       WHERE sql IS NOT NULL AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'
         AND name <> '_cw_standby' AND name NOT LIKE 'products_search_%' ORDER BY type, name`,
    )
  ).map((r) => `${r.type} ${r.name}`);
const evidence = async (date = today) =>
  (await (await env.BACKUPS.get(`drills/${date}.json`))!.json()) as Record<string, any>;

const introspectors: Awaited<ReturnType<typeof introspectWorkflow>>[] = [];
beforeAll(async () => {
  for (const wf of [env.D1_BACKUP, env.D1_RESTORE]) {
    const i = await introspectWorkflow(wf);
    await i.modifyAll(async (m) => m.disableRetryDelays());
    introspectors.push(i);
  }
  // A chain the drill has to verify, on top of the demo data.
  const log = d1AuditLog(env.DB);
  for (const id of ['bk_1', 'bk_2', 'bk_3'])
    await log.append((head) =>
      sealAuditRow(
        auditRow(id, 'flow.saved', {
          actor: { kind: 'operator', name: 'test' } as never,
          target: id,
        }),
        head,
      ),
    );
});
afterAll(async () => {
  for (const i of introspectors) await i.dispose();
});

describe('the daily backup and the restore drill', () => {
  it('copies every table, restores it into the standby and writes the drill evidence', async () => {
    // A table past one chunk (1,000 rows), to carry the cursor from step to step.
    await env.DB.prepare('CREATE TABLE zz_bulk (id INTEGER PRIMARY KEY, v TEXT NOT NULL)').run();
    await env.DB.prepare(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2300)
       INSERT INTO zz_bulk SELECT x, 'row ' || x FROM c`,
    ).run();
    const backup = await run(env.D1_BACKUP, 'bk-1');
    expect(backup.status, JSON.stringify(backup.error)).toBe('complete');
    expect(backup.output).toMatchObject({ date: today });

    const manifest = (await (await env.BACKUPS.get(`d1/${today}/manifest.json`))!.json()) as any;
    const tables = manifest.schema.tables.map((t: { name: string }) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['orders', 'products', 'audit_events', 'd1_migrations']),
    );
    // The search index and its shadow tables are rebuilt after a restore, not copied.
    expect(tables.filter((t: string) => t.startsWith('products_search'))).toEqual([]);
    expect(manifest.schema.search.map((s: { name: string }) => s.name)).toEqual([
      'products_search',
    ]);
    expect(manifest.schema.search[0].config.rank).toBe('bm25(8.0, 10.0)');
    expect(manifest.timeTravelBookmark).toBeNull();
    const head = await env.DB.prepare(
      'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    ).first<{ name: string }>();
    expect(manifest.migrationHead).toBe(head!.name);
    expect(manifest.tables.zz_bulk.chunks.map((c: { rows: number }) => c.rows)).toEqual([
      1000, 1000, 300,
    ]);
    // A chunk is a gzipped NDJSON page under d1/<date>/<table>/.
    const chunk = manifest.tables.products.chunks[0];
    expect(chunk.key).toBe(`d1/${today}/products/0.ndjson.gz`);
    expect((await env.BACKUPS.head(chunk.key))?.customMetadata?.sha256).toBe(chunk.sha256);

    // A second run the same day copies nothing.
    expect((await run(env.D1_BACKUP, 'bk-2')).output).toEqual({ date: today, skipped: true });

    const restore = await run(env.D1_RESTORE, 'rs-1');
    expect(restore.status, JSON.stringify(restore.error)).toBe('complete');
    const drill = await evidence();
    expect(drill).toMatchObject({
      outcome: 'passed',
      backup: today,
      instance: 'rs-1',
      checks: {
        tables: { ok: true },
        rowCounts: { ok: true },
        migrationHead: { ok: true, expected: head!.name, actual: head!.name },
        foreignKeys: { ok: true, violations: 0 },
        auditChain: { ok: true },
        search: { ok: true },
      },
    });
    expect(drill.checks.auditChain.checked).toBeGreaterThanOrEqual(3);
    expect(typeof drill.minutes).toBe('number');

    // The standby is the live database's copy: rows, indexes, triggers and the search index.
    for (const t of tables)
      expect(await rowsOf(env.STANDBY_DB, t), t).toEqual(await rowsOf(env.DB, t));
    expect(await names(env.STANDBY_DB)).toEqual(await names(env.DB));
    const word = (
      (await dump(env.DB, 'SELECT name FROM products LIMIT 1'))[0] as { name: string }
    ).name.split(/\W+/)[0]!;
    const find = async (db: D1Database) =>
      dump(
        db,
        `SELECT rowid FROM products_search WHERE products_search MATCH '${word}*' ORDER BY rank, rowid`,
      );
    expect((await find(env.DB)).length).toBeGreaterThan(0);
    expect((await find(env.STANDBY_DB)).length).toBeGreaterThan(0);
    expect(await find(env.STANDBY_DB)).toEqual(await find(env.DB));

    // A drill over a standby that already holds a restore replaces it.
    expect((await run(env.D1_RESTORE, 'rs-2', { date: today })).status).toBe('complete');
    await env.DB.prepare('DROP TABLE zz_bulk').run();
  });

  it('refuses a chunk that was changed, before it wipes anything', async () => {
    const manifest = (await (await env.BACKUPS.get(`d1/${today}/manifest.json`))!.json()) as any;
    const key = manifest.tables.products.chunks[0].key as string;
    const original = await (await env.BACKUPS.get(key))!.arrayBuffer();
    const before = await dump(env.STANDBY_DB, 'SELECT count(*) AS n FROM products');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await env.BACKUPS.put(key, new Uint8Array([1, 2, 3]));
      const r = await run(env.D1_RESTORE, 'rs-tampered', { date: today });
      expect(r.status).toBe('errored');
      expect(await evidence()).toMatchObject({
        outcome: 'failed',
        backup: today,
        instance: 'rs-tampered',
        error: expect.stringContaining('does not match its hash'),
      });
      expect(error).toHaveBeenCalledWith(
        'd1 restore drill failed',
        expect.stringContaining('does not match its hash'),
      );
      // The standby still holds the last good restore.
      expect(await dump(env.STANDBY_DB, 'SELECT count(*) AS n FROM products')).toEqual(before);

      // A chunk gone is refused the same way.
      await env.BACKUPS.delete(key);
      await run(env.D1_RESTORE, 'rs-missing', { date: today });
      expect(await evidence()).toMatchObject({
        outcome: 'failed',
        error: expect.stringContaining('is missing'),
      });
    } finally {
      await env.BACKUPS.put(key, original);
      error.mockRestore();
    }
    expect((await run(env.D1_RESTORE, 'rs-healed', { date: today })).status).toBe('complete');
  });

  it('refuses a day with no manifest, and a backup that did not finish', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run(env.D1_RESTORE, 'rs-none', { date: '2026-01-02' });
    expect(r.status).toBe('errored');
    expect(await evidence()).toMatchObject({
      outcome: 'failed',
      backup: null,
      error: expect.stringContaining('has no manifest'),
    });
    // A day's chunks without a manifest are an unfinished backup: the newest finished one is used.
    await env.BACKUPS.put('d1/2099-01-01/orders/0.ndjson.gz', new Uint8Array([1]));
    expect((await run(env.D1_RESTORE, 'rs-latest')).status).toBe('complete');
    expect(await evidence()).toMatchObject({ outcome: 'passed', backup: today });
    vi.restoreAllMocks();
  });

  it('never restores over a database a restore did not make', async () => {
    // What the standby binding would be if it were pointed at the live database.
    const { d1RestoreTarget } = await import('@commerceworker/db/database-copy');
    await expect(d1RestoreTarget(env.DB).reset()).rejects.toThrow(/may be the live database/);
    expect(await dump(env.DB, 'SELECT count(*) AS n FROM orders')).toBeTruthy();
    expect(
      (
        (
          await dump(env.DB, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'orders'")
        )[0] as any
      ).n,
    ).toBe(1);
  });
});
