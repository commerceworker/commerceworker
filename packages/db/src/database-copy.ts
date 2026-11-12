/**
 * The database copy ports (`DatabaseExport`, `DatabaseRestoreTarget`, @commerceworker/ports/commerce)
 * on D1: a logical export, table by table in pages, and a restore into another D1 database. Plain
 * SQL, not Drizzle, since it copies whatever the migrations made. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory copy to the same behaviour.
 *
 * Left out of the copy: SQLite's and D1's own tables, and an FTS5 table with its shadow tables
 * (D1 can't export a virtual table either). The index's definition travels as `search`, and a
 * restore rebuilds it from its content table.
 */
import {
  BackupRefusal,
  type CopyRow,
  type CopySchema,
  type CopyTable,
  type DatabaseExport,
  type DatabaseRestoreTarget,
} from '@commerceworker/ports/commerce';

/** Marks a database a restore made, which may be wiped and restored into again. */
export const RESTORE_MARKER = '_cw_standby';

/** An FTS5 table keeps its data in these shadow tables, named after it. */
const FTS_SHADOWS = ['_data', '_idx', '_content', '_docsize', '_config'];

/** Bytes of rows a page stops at, about. */
const PAGE_BYTES = 4 * 1024 * 1024;
/** D1 binds at most 100 parameters to a statement. */
const MAX_PARAMS = 100;
/** Statements a batch carries. */
const BATCH_STATEMENTS = 200;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

type Master = { type: string; name: string; sql: string };

async function master(db: D1Database): Promise<Master[]> {
  const { results } = await db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'
       ORDER BY rowid`,
    )
    .all<Master>();
  return results;
}

const isVirtual = (m: Master) => m.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(m.sql);

/** The shadow tables of the virtual tables in `objects`. */
function shadowsOf(objects: Master[]): Set<string> {
  const virtual = objects.filter(isVirtual).map((m) => m.name);
  return new Set(virtual.flatMap((v) => FTS_SHADOWS.map((s) => `${v}${s}`)));
}

/** Tables of record: real tables, neither shadows nor the restore's marker. */
function recordTables(objects: Master[]): Master[] {
  const shadows = shadowsOf(objects);
  return objects.filter(
    (m) => m.type === 'table' && !isVirtual(m) && !shadows.has(m.name) && m.name !== RESTORE_MARKER,
  );
}

async function foreignParents(db: D1Database, table: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT DISTINCT "table" AS parent FROM pragma_foreign_key_list(?)')
    .bind(table)
    .all<{ parent: string }>();
  return results.map((r) => r.parent).filter((p) => p !== table);
}

/** Parents before the tables that reference them; a cycle falls back to name order. */
async function loadOrder(db: D1Database, tables: Master[]): Promise<Master[]> {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const parents = new Map<string, string[]>();
  for (const t of tables)
    parents.set(
      t.name,
      (await foreignParents(db, t.name)).filter((p) => byName.has(p)),
    );
  const ordered: Master[] = [];
  const done = new Set<string>();
  const visit = (name: string, path: Set<string>) => {
    if (done.has(name) || path.has(name)) return;
    path.add(name);
    for (const p of parents.get(name) ?? []) visit(p, path);
    done.add(name);
    ordered.push(byName.get(name)!);
  };
  for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name)))
    visit(t.name, new Set());
  return ordered;
}

export function d1DatabaseExport(db: D1Database): DatabaseExport {
  /** The table's definition; only a table of record is read, since its name goes into the SQL. */
  async function tableOf(name: string): Promise<Master> {
    const found = recordTables(await master(db)).find((t) => t.name === name);
    if (!found) throw new RangeError(`${name} is not a table of record`);
    return found;
  }

  return {
    async schema(): Promise<CopySchema> {
      const objects = await master(db);
      const tables: CopyTable[] = [];
      for (const t of await loadOrder(db, recordTables(objects))) {
        const { results } = await db
          .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
          .bind(t.name)
          .all<{ name: string }>();
        tables.push({ name: t.name, ddl: t.sql, columns: results.map((c) => c.name) });
      }
      const search = [];
      for (const v of objects.filter(isVirtual)) {
        const { results } = await db
          .prepare(`SELECT k, v FROM ${quote(`${v.name}_config`)} WHERE k <> 'version'`)
          .all<{ k: string; v: string | number }>();
        search.push({
          name: v.name,
          ddl: v.sql,
          config: Object.fromEntries(results.map((r) => [r.k, String(r.v)])),
        });
      }
      const of = (type: string) => objects.filter((m) => m.type === type).map((m) => m.sql);
      return {
        tables,
        search,
        indexes: of('index'),
        triggers: of('trigger'),
        views: of('view'),
      };
    },

    async page(table, cursor, limit) {
      const t = await tableOf(table);
      const byRowid = !/WITHOUT\s+ROWID\s*;?\s*$/i.test(t.sql);
      let stmt: D1PreparedStatement;
      if (byRowid)
        stmt = db
          .prepare(
            `SELECT rowid AS _rowid, * FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
          )
          .bind(cursor, limit + 1);
      else {
        // No rowid to continue from: the primary key orders the rows and the cursor counts them.
        const { results } = await db
          .prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk')
          .bind(table)
          .all<{ name: string }>();
        stmt = db
          .prepare(
            `SELECT * FROM ${quote(table)} ORDER BY ${results.map((c) => quote(c.name)).join(', ')} LIMIT ? OFFSET ?`,
          )
          .bind(limit + 1, cursor);
      }
      const { results } = await stmt.all<CopyRow & { _rowid?: number }>();
      const rows: CopyRow[] = [];
      let next = cursor;
      let bytes = 0;
      let more = results.length > limit;
      for (const [i, raw] of results.slice(0, limit).entries()) {
        const { _rowid, ...row } = raw;
        for (const [column, value] of Object.entries(row))
          if (value !== null && typeof value !== 'string' && typeof value !== 'number')
            throw new BackupRefusal(`${table}.${column} holds a value a backup can't carry`);
        rows.push(row);
        next = byRowid ? (_rowid as number) : cursor + i + 1;
        bytes += JSON.stringify(row).length;
        if (bytes > PAGE_BYTES) {
          more = more || i + 1 < results.length;
          break;
        }
      }
      return { rows, next, more };
    },

    migrationHead: () => migrationHead(db),
  };
}

async function migrationHead(db: D1Database): Promise<string | null> {
  try {
    const head = await db
      .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
      .first<{ name: string }>();
    return head?.name ?? null;
  } catch {
    return null;
  }
}

async function runAll(db: D1Database, statements: string[], deferForeignKeys = false) {
  for (let i = 0; i < statements.length; i += BATCH_STATEMENTS) {
    const group = statements.slice(i, i + BATCH_STATEMENTS).map((s) => db.prepare(s));
    await db.batch(
      deferForeignKeys ? [db.prepare('PRAGMA defer_foreign_keys = on'), ...group] : group,
    );
  }
}

export function d1RestoreTarget(db: D1Database): DatabaseRestoreTarget {
  return {
    async reset() {
      const objects = await master(db);
      if (objects.length && !objects.some((m) => m.name === RESTORE_MARKER))
        throw new BackupRefusal(
          'the standby database holds tables a restore did not make: it may be the live database, so nothing was wiped',
        );
      const drops = [
        ...objects.filter((m) => m.type === 'trigger').map((m) => `DROP TRIGGER ${quote(m.name)}`),
        ...objects.filter((m) => m.type === 'view').map((m) => `DROP VIEW ${quote(m.name)}`),
        // A virtual table first: it takes its shadow tables with it.
        ...objects.filter(isVirtual).map((m) => `DROP TABLE ${quote(m.name)}`),
        // Children before the tables they reference: a drop that finds its parent gone fails.
        ...(await loadOrder(db, recordTables(objects)))
          .reverse()
          .map((m) => `DROP TABLE ${quote(m.name)}`),
      ];
      await runAll(db, drops, true);
      await db
        .prepare(`CREATE TABLE IF NOT EXISTS ${RESTORE_MARKER} (restored_at TEXT NOT NULL)`)
        .run();
    },

    async createTables(schema) {
      await runAll(db, [...schema.tables.map((t) => t.ddl), ...schema.search.map((s) => s.ddl)]);
    },

    async load(table, columns, rows) {
      if (!rows.length) return 0;
      if (columns.length > MAX_PARAMS) throw new BackupRefusal(`${table} has too many columns`);
      const per = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
      const head = `INSERT OR REPLACE INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES `;
      const group = `(${columns.map(() => '?').join(', ')})`;
      const statements: D1PreparedStatement[] = [];
      for (let i = 0; i < rows.length; i += per) {
        const part = rows.slice(i, i + per);
        statements.push(
          db
            .prepare(head + part.map(() => group).join(', '))
            .bind(...part.flatMap((r) => columns.map((c) => r[c] ?? null))),
        );
      }
      for (let i = 0; i < statements.length; i += BATCH_STATEMENTS)
        await db.batch([
          db.prepare('PRAGMA defer_foreign_keys = on'),
          ...statements.slice(i, i + BATCH_STATEMENTS),
        ]);
      return rows.length;
    },

    async finish(schema) {
      await runAll(db, [...schema.indexes, ...schema.triggers, ...schema.views]);
      for (const s of schema.search) {
        for (const [k, v] of Object.entries(s.config))
          await db
            .prepare(`INSERT INTO ${quote(s.name)} (${quote(s.name)}, rank) VALUES (?, ?)`)
            .bind(k, v)
            .run();
        await db
          .prepare(`INSERT INTO ${quote(s.name)} (${quote(s.name)}) VALUES ('rebuild')`)
          .run();
      }
    },

    async rowCount(table) {
      const t = recordTables(await master(db)).find((x) => x.name === table);
      if (!t) throw new RangeError(`${table} is not a table of record`);
      const row = await db
        .prepare(`SELECT count(*) AS n FROM ${quote(table)}`)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    migrationHead: () => migrationHead(db),

    async foreignKeyViolations() {
      const row = await db
        .prepare('SELECT count(*) AS n FROM pragma_foreign_key_check')
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async tableNames() {
      return recordTables(await master(db)).map((t) => t.name);
    },

    async indexedRows(index) {
      const found = (await master(db)).find((m) => isVirtual(m) && m.name === index);
      if (!found) throw new RangeError(`${index} is not a search index`);
      // FTS5 keeps one row a document in its `_docsize` table.
      const row = await db
        .prepare(`SELECT count(*) AS n FROM ${quote(`${index}_docsize`)}`)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
  };
}
