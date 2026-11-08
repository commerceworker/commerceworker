/**
 * A real SQLite database for the auth tables, for server tests that need the queries themselves
 * to run (conditional updates, joins, batches) rather than a hand-made fake of drizzle. Every
 * migration in packages/store/migrations is applied to an in-memory `node:sqlite` database, and
 * drizzle talks to it through its proxy driver; D1 is SQLite too, so the SQL is the same. `log`
 * keeps every statement in order, so a test can compare the work two requests did.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { authSchema } from '@commerceworker/store/auth';
import { drizzle } from 'drizzle-orm/sqlite-proxy';

const MIGRATIONS = join(import.meta.dirname, '../../../packages/store/migrations');

type Method = 'run' | 'all' | 'values' | 'get';

export function authTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  const log: string[] = [];

  const exec = (sql: string, params: unknown[], method: Method) => {
    log.push(sql);
    const statement = sqlite.prepare(sql);
    const args = params as SQLInputValue[];
    if (method === 'run') {
      statement.run(...args);
      return { rows: [] };
    }
    // Rows as arrays, as the proxy driver expects (the typings still say objects).
    statement.setReturnArrays(true);
    if (method === 'get') return { rows: statement.get(...args) as unknown as unknown[] };
    return { rows: statement.all(...args) as unknown[] };
  };

  const db = drizzle(
    async (sql, params, method) => exec(sql, params, method),
    // A batch commits together or not at all, as a D1 batch does.
    async (queries) => {
      sqlite.exec('BEGIN');
      try {
        const out = queries.map((q) => exec(q.sql, q.params, q.method));
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    { schema: authSchema },
  );
  return { db, sqlite, log };
}
