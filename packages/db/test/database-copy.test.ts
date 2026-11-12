import { env } from 'cloudflare:workers';
import { describeDatabaseCopyContract } from '@commerceworker/test-kit/commerce';
import { d1DatabaseExport, d1RestoreTarget } from '../src/database-copy';

const { COPY_SOURCE, COPY_TARGET } = env as unknown as {
  COPY_SOURCE: D1Database;
  COPY_TARGET: D1Database;
};

const KNOWN = ['copy_lines', 'copy_items', 'copy_empty', 'copy_keyed', '_cw_standby'];
const wipe = async (db: D1Database) => {
  await db.batch(KNOWN.map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
};

describeDatabaseCopyContract('D1', async () => {
  await wipe(COPY_SOURCE);
  await wipe(COPY_TARGET);
  return {
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
