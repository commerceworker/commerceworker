import { describe, expect, it } from 'vitest';
import { d1OrderBoard } from '../src/order-board';

/**
 * The SQL the order board sends, over a binding that records each statement and finds nothing:
 * what the contract's results can't show (a batch's column names, a subquery's correlation, how
 * many parameters a statement binds).
 */
const statements: { sql: string; params: unknown[] }[] = [];
const d1 = {
  prepare: (sql: string) => {
    const entry = { sql, params: [] as unknown[] };
    statements.push(entry);
    const stmt = {
      bind: (...values: unknown[]) => {
        entry.params = values;
        return stmt;
      },
      all: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
      first: async () => null,
      run: async () => ({ results: [], success: true, meta: {} }),
    };
    return stmt;
  },
  batch: async (stmts: unknown[]) => stmts.map(() => ({ results: [], success: true, meta: {} })),
} as unknown as D1Database;
const board = d1OrderBoard(d1);

/** The names a select's result columns come back under: its alias, or the column's own name. */
function resultColumns(query: string): string[] {
  const list = query.slice('select '.length, query.indexOf(' from "'));
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  // SQLite names a column by its alias, a column reference by the column, anything else by its text.
  return parts.map((p) => {
    const part = p.trim();
    return (
      part.match(/ as "([^"]+)"$/)?.[1] ?? part.match(/^(?:"[^"]+"\.)?"([^"]+)"$/)?.[1] ?? part
    );
  });
}

describe('the overview batch', () => {
  // D1's batch returns each row as an object keyed by column name, which drizzle reads back by
  // position: a repeated name drops a column and shifts every one after it.
  it('never selects two result columns with the same name', async () => {
    statements.length = 0;
    await board.overview(1_000);
    const selects = statements.filter((s) => s.sql.startsWith('select '));
    expect(selects.length).toBeGreaterThan(5);
    for (const s of selects) {
      const cols = resultColumns(s.sql);
      expect(cols, s.sql).toEqual([...new Set(cols)]);
    }
  });

  it("ties each step's latest reason to its own flow and step", async () => {
    statements.length = 0;
    await board.overview(1_000);
    const sub = statements.find((s) => s.sql.includes('select o2.reason'));
    // Unqualified, "flow_id" inside the subquery would be o2's own, matching every row.
    expect(sub?.sql).toContain('o2.flow_id = orders.flow_id');
    expect(sub?.sql).toContain("coalesce(orders.stopped_at, '')");
  });
});

describe('list lookups', () => {
  it('stay under D1’s 100 bound parameters for a page of 200 ids', async () => {
    statements.length = 0;
    await board.declinedOrderIds(Array.from({ length: 200 }, (_, i) => `id${i}`));
    expect(statements.length).toBeGreaterThan(1);
    expect(Math.max(...statements.map((s) => s.params.length))).toBeLessThanOrEqual(100);
  });

  it('count every page a filter picks, reading at most one row past the cap', async () => {
    statements.length = 0;
    const counted = await board.count(
      { status: 'failed', q: 'ada', after: { createdAt: 1, id: 'ord_x' } },
      50,
    );
    expect(counted).toEqual({ n: 0, more: false });
    const [stmt] = statements;
    expect(stmt!.sql).toMatch(
      /^select count\(\*\) from \(select 1 as "one" from "orders" left join "customers"/,
    );
    // The page's cursor is not a filter: the count is of the whole list.
    expect(stmt!.sql).not.toContain('"created_at" <');
    expect(stmt!.params).toContain('failed');
    expect(stmt!.params.at(-1)).toBe(51);
  });
});
