import { type BulkKind, csvLine, csvRecords } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import {
  InMemoryCompanyDirectory,
  InMemoryInventoryStore,
  InMemoryPriceBookStore,
  InMemoryPricingStore,
  PRICING_FIXTURE,
  PriceBookData,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  applyBulkRows,
  type BulkPorts,
  bulkCustomerId,
  createPriceBook,
  readBulkChunk,
  setPriceBookStatus,
} from '../src/commerce';

const NOW = Date.parse('2026-11-01T00:00:00Z');

function ports(): BulkPorts {
  const data = new PriceBookData();
  return {
    books: new InMemoryPriceBookStore(data),
    pricing: new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock(new Date(NOW)), data),
    companies: new InMemoryCompanyDirectory({ customers: PRICING_FIXTURE.customers }),
    inventory: new InMemoryInventoryStore({
      products: [
        { sku: 'PC-SKU-1', stock: 5 },
        { sku: 'PC-SKU-2', stock: 5, reserved: 2 },
      ],
    }),
  };
}

const file = (rows: string[][]) =>
  new Blob([rows.map(csvLine).join('')]).stream() as unknown as ReadableStream<Uint8Array>;

/** The whole file read a chunk at a time, as the import Workflow reads it. */
async function readAll(kind: BulkKind, rows: string[][], max = 2) {
  const bytes = new TextEncoder().encode(rows.map(csvLine).join(''));
  let at = { header: [] as string[], offset: 0, nextRow: 1 };
  const chunks = [];
  for (;;) {
    const stream = new Blob([
      bytes.slice(at.offset),
    ]).stream() as unknown as ReadableStream<Uint8Array>;
    const r = await readBulkChunk(csvRecords(stream, at.offset), kind, at, max);
    if (!r.ok) return r;
    chunks.push(r);
    at = { header: r.header ?? at.header, offset: r.offset, nextRow: r.nextRow };
    if (r.done) return { ok: true as const, chunks };
  }
}

const job = (kind: BulkKind, checkOnly = false) => ({ id: 'blk_t1', kind, checkOnly });

describe('reading an import a chunk at a time', () => {
  it('reads the header first, then rows numbered as a spreadsheet numbers them', async () => {
    const r = await readAll('stock', [
      ['sku', 'stock'],
      ['PC-SKU-1', '3'],
      ['PC-SKU-2', 'x'],
      ['PC-SKU-1', '4'],
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.chunks.map((c) => c.rows.map((x) => x.row))).toEqual([[2, 3], [4]]);
    expect(r.chunks[0]!.header).toEqual(['sku', 'stock']);
    expect(r.chunks[1]!.header).toBeUndefined();
    expect(r.chunks[0]!.rows[1]!.read).toMatchObject({ ok: false });
  });

  it('stops the import on a header it can’t read, or an empty file', async () => {
    expect(await readAll('stock', [['sku', 'qty']])).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown column "qty"'),
    });
    expect(
      await readBulkChunk(csvRecords(file([])), 'stock', { header: [], offset: 0, nextRow: 1 }, 10),
    ).toEqual({
      ok: false,
      error: 'The file is empty: it needs a header row.',
    });
  });
});

/** Rows as the reader hands them on, from a header and its rows. */
async function rowsOf(kind: BulkKind, rows: string[][]) {
  const r = await readAll(kind, rows, 1000);
  if (!r.ok) throw new Error(r.error);
  return r.chunks.flatMap((c) => c.rows);
}

describe('importing customers', () => {
  it('creates and changes customers, and refuses an email already in use by its row', async () => {
    const p = ports();
    const rows = await rowsOf('customers', [
      ['id', 'name', 'email', 'tier'],
      ['', 'New Co', 'ap@newco.test', 'gold'],
      ['pc_twin_a', 'Twin A, renamed', 'pc_twin_a@example.com', ''],
      ['', 'Clash', 'pc_northwind@example.com', ''],
      ['pc_gone', 'Gone', 'gone@example.com', ''],
    ]);
    const r = await applyBulkRows(p, job('customers'), rows, NOW);
    expect(r).toEqual({
      applied: 2,
      failed: 2,
      errors: [
        { row: 4, error: 'A customer with the email pc_northwind@example.com already exists.' },
        { row: 5, error: 'No such customer.' },
      ],
    });
    expect(await p.companies.customer({ all: true }, bulkCustomerId('blk_t1', 2))).toMatchObject({
      name: 'New Co',
      tier: 'gold',
    });
    expect((await p.companies.customer({ all: true }, 'pc_twin_a'))?.name).toBe('Twin A, renamed');
    // The same chunk again: the customer it made is found by its row's id, not refused.
    expect(await applyBulkRows(p, job('customers'), rows.slice(0, 1), NOW)).toEqual({
      applied: 1,
      failed: 0,
      errors: [],
    });
  });

  it('checks rows without writing when asked to only check', async () => {
    const p = ports();
    const rows = await rowsOf('customers', [
      ['name', 'email'],
      ['New Co', 'ap@newco.test'],
      ['Clash', 'pc_northwind@example.com'],
    ]);
    expect(await applyBulkRows(p, job('customers', true), rows, NOW)).toMatchObject({
      applied: 1,
      failed: 1,
    });
    expect(await p.companies.customer({ all: true }, bulkCustomerId('blk_t1', 2))).toBeUndefined();
  });
});

describe('importing price book entries', () => {
  async function book(p: BulkPorts, code: string) {
    const made = await createPriceBook(
      p,
      { code, name: `Book ${code}` },
      'ann@example.com',
      NOW,
      `pb_${code}`,
    );
    if (!made.ok) throw new Error(made.error);
    return made.book;
  }

  it('puts each book’s good rows, refusing unknown books and products, the last row of a key winning', async () => {
    const p = ports();
    await book(p, 'WHOLESALE');
    const rows = await rowsOf('price_book_entries', [
      ['book', 'sku', 'minQty', 'price'],
      ['WHOLESALE', 'PC-SKU-1', '', '9'],
      ['pb_WHOLESALE', 'PC-SKU-2', '10', '20'],
      ['pb_WHOLESALE', 'PC-SKU-1', '', '7'],
      ['WHOLESALE', 'PC-SKU-1', '', '8'],
      ['WHOLESALE', 'NOPE', '', '1'],
      ['RETAIL', 'PC-SKU-1', '', '1'],
    ]);
    const r = await applyBulkRows(p, job('price_book_entries'), rows, NOW);
    expect(r).toEqual({
      applied: 4,
      failed: 2,
      errors: [
        { row: 6, error: 'No such product: NOPE.' },
        { row: 7, error: 'No price book RETAIL.' },
      ],
    });
    const entries = await p.books.entries('pb_WHOLESALE', { limit: 50 });
    expect(entries.rows.map((e) => [e.sku, e.minQty, e.price])).toEqual([
      ['PC-SKU-1', 1, 8],
      ['PC-SKU-2', 10, 20],
    ]);
  });

  it('refuses rows for an archived book', async () => {
    const p = ports();
    const b = await book(p, 'OLD');
    await setPriceBookStatus(p, { bookId: b.id, status: 'archived' }, NOW);
    const rows = await rowsOf('price_book_entries', [
      ['book', 'sku', 'price'],
      ['OLD', 'PC-SKU-1', '9'],
    ]);
    expect((await applyBulkRows(p, job('price_book_entries'), rows, NOW)).errors).toEqual([
      { row: 2, error: 'Book OLD is archived and can’t change.'.replace('’', "'") },
    ]);
  });
});

describe('importing stock', () => {
  it('sets each SKU to its count once, the last row of a SKU winning', async () => {
    const p = ports();
    const rows = await rowsOf('stock', [
      ['sku', 'stock', 'reorderPoint'],
      ['PC-SKU-1', '40', ''],
      ['PC-SKU-2', '12', '3'],
      ['PC-SKU-1', '41', ''],
      ['GHOST', '1', ''],
    ]);
    expect(await applyBulkRows(p, job('stock'), rows, NOW)).toEqual({
      applied: 3,
      failed: 1,
      errors: [{ row: 5, error: 'No such product: GHOST.' }],
    });
    const levels = await p.inventory.levels(['PC-SKU-1', 'PC-SKU-2']);
    expect(levels.get('PC-SKU-1')).toEqual({ stock: 41, reserved: 0 });
    // Reserved stock stays with the orders holding it.
    expect(levels.get('PC-SKU-2')).toEqual({ stock: 12, reserved: 2 });
    // Run again (a retried step), after stock moved: nothing is counted twice.
    await p.inventory.restock('ord_x', 'restock#1', [{ sku: 'PC-SKU-1', qty: 1 }]);
    await applyBulkRows(p, job('stock'), rows, NOW);
    expect((await p.inventory.levels(['PC-SKU-1'])).get('PC-SKU-1')?.stock).toBe(42);
  });

  it('changes nothing when asked to only check', async () => {
    const p = ports();
    const rows = await rowsOf('stock', [
      ['sku', 'stock'],
      ['PC-SKU-1', '0'],
    ]);
    expect(await applyBulkRows(p, job('stock', true), rows, NOW)).toMatchObject({ applied: 1 });
    expect((await p.inventory.levels(['PC-SKU-1'])).get('PC-SKU-1')?.stock).toBe(5);
  });
});
