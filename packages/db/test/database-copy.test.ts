import { env } from 'cloudflare:workers';
import { describeDatabaseCopyContract } from '@commerceworker/test-kit/commerce';
import { d1DatabaseExport, d1RestoreTarget } from '../src/database-copy';

const { COPY_SOURCE, COPY_TARGET } = env as unknown as {
  COPY_SOURCE: D1Database;
  COPY_TARGET: D1Database;
};

const KNOWN = [
  'copy_lines',
  'copy_items',
  'copy_empty',
  'copy_keyed',
  '_cw_standby',
  'orders',
  'audit_events',
  'd1_migrations',
];
const wipe = async (db: D1Database) => {
  await db.batch(KNOWN.map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
};

describeDatabaseCopyContract('D1', async () => {
  await wipe(COPY_SOURCE);
  await wipe(COPY_TARGET);
  return {
    async setTargetHead(name) {
      await COPY_TARGET.batch([
        COPY_TARGET.prepare(
          'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
        ),
        COPY_TARGET.prepare('DELETE FROM d1_migrations'),
        COPY_TARGET.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name),
      ]);
    },
    async writeToTarget(ddl, rows) {
      await COPY_TARGET.prepare(ddl).run();
      const table = /CREATE TABLE (\w+)/.exec(ddl)![1]!;
      for (const row of rows) {
        const cols = Object.keys(row);
        await COPY_TARGET.prepare(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        )
          .bind(...cols.map((c) => row[c] ?? null))
          .run();
      }
    },
    source: d1DatabaseExport(COPY_SOURCE),
    target: d1RestoreTarget(COPY_TARGET),
    unmarked: d1RestoreTarget(COPY_SOURCE),
    async seed(ddl, rows = []) {
      await COPY_SOURCE.prepare(ddl).run();
      const table = /CREATE TABLE (\w+)/.exec(ddl)![1]!;
      for (const row of rows) {
        const cols = Object.keys(row);
        await COPY_SOURCE.prepare(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        )
          .bind(...cols.map((c) => row[c] ?? null))
          .run();
      }
    },
  };
});
