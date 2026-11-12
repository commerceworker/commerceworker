/**
 * The database copy ports in memory (`DatabaseExport` and `DatabaseRestoreTarget`): tables of rows
 * kept as `CREATE TABLE` text plus the rows. It reads just enough of the DDL to name a table, find
 * its key (the first column) and order parents before children; the contract in
 * ./database-copy-contract.ts holds it to the same behaviour as the D1 adapter.
 */
import {
  BackupRefusal,
  type CopyPage,
  type CopyRow,
  type CopySchema,
  type CopyTable,
  type DatabaseExport,
  type DatabaseRestoreTarget,
} from '@commerceworker/ports/commerce';

interface Held {
  ddl: string;
  columns: string[];
  rows: CopyRow[];
}

const nameOf = (ddl: string) => /CREATE TABLE\s+"?(\w+)"?/i.exec(ddl)![1]!;
const parentsOf = (ddl: string) =>
  [...ddl.matchAll(/REFERENCES\s+"?(\w+)"?/gi)].map((m) => m[1]!).filter((p) => p !== nameOf(ddl));
const columnsOf = (ddl: string) =>
  ddl
    .slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'))
    .split(/,(?![^(]*\))/)
    .map((c) => c.trim())
    .filter((c) => !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(c))
    .map((c) => c.split(/\s+/)[0]!.replaceAll('"', ''));

export class InMemoryDatabaseCopy implements DatabaseExport, DatabaseRestoreTarget {
  private tables = new Map<string, Held>();
  private search: CopySchema['search'] = [];
  private marked = false;
  /** What `migrationHead` answers. */
  head: string | null = null;

  /** Adds a table the way a migration would have. */
  seed(ddl: string, rows: CopyRow[] = []) {
    const name = nameOf(ddl);
    this.tables.set(name, { ddl, columns: columnsOf(ddl), rows: [...rows] });
  }

  async schema(): Promise<CopySchema> {
    const done = new Set<string>();
    const ordered: CopyTable[] = [];
    const visit = (name: string) => {
      const t = this.tables.get(name);
      if (!t || done.has(name)) return;
      done.add(name);
      for (const p of parentsOf(t.ddl)) visit(p);
      ordered.push({ name, ddl: t.ddl, columns: t.columns });
    };
    for (const name of [...this.tables.keys()].sort()) visit(name);
    return { tables: ordered, search: this.search, indexes: [], triggers: [], views: [] };
  }

  async page(table: string, cursor: number, limit: number): Promise<CopyPage> {
    const t = this.tables.get(table);
    if (!t) throw new RangeError(`${table} is not a table of record`);
    const rows = t.rows.slice(cursor, cursor + limit);
    return { rows, next: cursor + rows.length, more: cursor + rows.length < t.rows.length };
  }

  async migrationHead() {
    return this.head;
  }

  async reset() {
    if (this.tables.size && !this.marked)
      throw new BackupRefusal(
        'the standby database holds tables a restore did not make: it may be the live database, so nothing was wiped',
      );
    this.tables.clear();
    this.search = [];
    this.marked = true;
  }

  async createTables(schema: CopySchema) {
    for (const t of schema.tables) this.seed(t.ddl);
    this.search = schema.search;
  }

  async load(table: string, columns: readonly string[], rows: readonly CopyRow[]) {
    const t = this.tables.get(table);
    if (!t) throw new RangeError(`${table} is not a table of record`);
    const key = columns[0]!;
    for (const row of rows) {
      const kept = Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));
      const at = t.rows.findIndex((r) => r[key] === kept[key]);
      if (at >= 0) t.rows[at] = kept;
      else t.rows.push(kept);
    }
    return rows.length;
  }

  async finish() {}

  async rowCount(table: string) {
    const t = this.tables.get(table);
    if (!t) throw new RangeError(`${table} is not a table of record`);
    return t.rows.length;
  }

  async foreignKeyViolations() {
    let n = 0;
    for (const t of this.tables.values())
      for (const parent of parentsOf(t.ddl)) {
        const keys = new Set(
          this.tables.get(parent)?.rows.map((r) => r[this.tables.get(parent)!.columns[0]!]),
        );
        const fk = new RegExp(`(\\w+)[^,]*REFERENCES\\s+"?${parent}"?`, 'i').exec(t.ddl)?.[1];
        if (fk) n += t.rows.filter((r) => r[fk] !== null && !keys.has(r[fk])).length;
      }
    return n;
  }

  async tableNames() {
    return [...this.tables.keys()];
  }

  async indexedRows(index: string) {
    const content = /content\s*=\s*['"]?(\w+)/i.exec(
      this.search.find((s) => s.name === index)?.ddl ?? '',
    )?.[1];
    return content ? await this.rowCount(content) : 0;
  }
}
