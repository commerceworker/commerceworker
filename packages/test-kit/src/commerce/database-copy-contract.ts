/**
 * The behaviour every database copy keeps: the in-memory copy runs it in node and the D1 adapter
 * in workerd (packages/db). Each case gets a source and a different, empty target; `seed` creates a
 * table in the source the way a migration would.
 */
import {
  BackupRefusal,
  type CopyRow,
  type DatabaseExport,
  type DatabaseRestoreTarget,
} from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

export interface DatabaseCopyHarness {
  source: DatabaseExport;
  /** A different, empty database. */
  target: DatabaseRestoreTarget;
  /** The seeded source as a restore target: it holds tables no restore made. */
  unmarked: DatabaseRestoreTarget;
  seed(ddl: string, rows?: CopyRow[]): Promise<void>;
}

const ITEMS = 'CREATE TABLE copy_items (id TEXT PRIMARY KEY, label TEXT, qty INTEGER)';
// Declared before its parent, to show the schema puts the parent first.
const LINES =
  'CREATE TABLE copy_lines (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES copy_items(id), note TEXT)';

const items = (n: number): CopyRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    label: `item ${i}`,
    qty: i === 2 ? null : i,
  }));

const keyed: CopyRow[] = ['a', 'b', 'c', 'd', 'e'].map((a, i) => ({ a, b: 'x', v: i }));

export function describeDatabaseCopyContract(
  name: string,
  make: () => Promise<DatabaseCopyHarness>,
) {
  describe(`${name}: the database copy contract`, () => {
    async function seeded() {
      const h = await make();
      await h.seed(LINES);
      await h.seed(ITEMS, items(5));
      await h.seed(`CREATE TABLE copy_empty (id TEXT PRIMARY KEY)`);
      // A table with no rowid is paged by its key.
      await h.seed(
        'CREATE TABLE copy_keyed (a TEXT NOT NULL, b TEXT NOT NULL, v INTEGER, PRIMARY KEY (a, b)) WITHOUT ROWID',
        keyed,
      );
      return h;
    }

    it('lists its tables with their columns, parents before the tables that reference them', async () => {
      const { source } = await seeded();
      const schema = await source.schema();
      const names = schema.tables.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['copy_items', 'copy_lines', 'copy_empty']));
      expect(names.indexOf('copy_items')).toBeLessThan(names.indexOf('copy_lines'));
      expect(schema.tables.find((t) => t.name === 'copy_items')?.columns).toEqual([
        'id',
        'label',
        'qty',
      ]);
    });

    it('pages every row once, in a stable order, and says when more remain', async () => {
      const { source } = await seeded();
      const seen: CopyRow[] = [];
      let cursor = 0;
      const sizes: boolean[] = [];
      for (;;) {
        const page = await source.page('copy_items', cursor, 2);
        seen.push(...page.rows);
        sizes.push(page.more);
        cursor = page.next;
        if (!page.more) break;
      }
      expect(seen).toEqual(items(5));
      expect(sizes).toEqual([true, true, false]);
      const byKey: CopyRow[] = [];
      for (let after = 0; ; ) {
        const page = await source.page('copy_keyed', after, 2);
        byKey.push(...page.rows);
        after = page.next;
        if (!page.more) break;
      }
      expect(byKey).toEqual(keyed);
      expect(await source.page('copy_empty', 0, 10)).toEqual({ rows: [], next: 0, more: false });
      await expect(source.page('sqlite_master', 0, 1)).rejects.toThrow();
    });

    it('restores into a target that holds nothing, and again over its own restore', async () => {
      const { source, target } = await seeded();
      const schema = await source.schema();
      for (const run of [1, 2]) {
        await target.reset();
        await target.createTables(schema);
        for (const t of schema.tables) {
          let cursor = 0;
          for (;;) {
            const page = await source.page(t.name, cursor, 2);
            // A chunk loaded twice (a retried step) leaves one copy of each row.
            await target.load(t.name, t.columns, page.rows);
            await target.load(t.name, t.columns, page.rows);
            cursor = page.next;
            if (!page.more) break;
          }
        }
        await target.finish(schema);
        expect(await target.tableNames(), `run ${run}`).toEqual(
          expect.arrayContaining(['copy_items', 'copy_lines', 'copy_empty', 'copy_keyed']),
        );
        expect(await target.rowCount('copy_items')).toBe(5);
        expect(await target.rowCount('copy_keyed')).toBe(5);
        expect(await target.rowCount('copy_empty')).toBe(0);
        expect(await target.foreignKeyViolations()).toBe(0);
      }
    });

    it('refuses to wipe a database a restore did not make', async () => {
      const { source, unmarked } = await seeded();
      await expect(unmarked.reset()).rejects.toBeInstanceOf(BackupRefusal);
      // Nothing was wiped.
      expect((await source.page('copy_items', 0, 10)).rows).toEqual(items(5));
    });
  });
}
