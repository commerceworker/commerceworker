/**
 * Bulk import: a chunk of an uploaded CSV read into rows, and the rows applied. Each row is held
 * to the rules the same change over the API is (creating or changing a customer, a price book's
 * entries, stock), and one refused row refuses only itself: it is reported by its line, and the
 * rest go ahead. Every write is keyed so a chunk run again (a Workflow step retried) changes
 * nothing twice. A check-only import reads and checks every row and writes nothing. Time comes in
 * as `now`.
 */
import {
  BULK_COLUMNS,
  type BulkKind,
  type BulkRow,
  type CsvRecord,
  csvColumns,
  normalizeBookCode,
  type PriceBookEntryRow,
  type ReadRow,
  readBulkRow,
  type StockRow,
} from '@commerceworker/core';
import type {
  BulkChunk,
  BulkRowError,
  CompanyDirectory,
  InventoryStore,
  PriceBookStore,
  PricingStore,
} from '@commerceworker/ports/commerce';
import { createCustomer, updateCustomer } from './companies';
import { putPriceBookEntries } from './price-books';

export type BulkPorts = {
  readonly companies: CompanyDirectory;
  readonly books: PriceBookStore;
  readonly pricing: PricingStore;
  readonly inventory: InventoryStore;
};

/** A row read from the file: its line, and what it asks for or why it can't be read. */
export type ReadBulkRow = { readonly row: number; readonly read: ReadRow<BulkRow> };

/** What a chunk of the file holds, and where the next one starts. */
export type BulkRead =
  | {
      ok: true;
      /** The header, when this chunk read it. */
      header?: string[];
      rows: ReadBulkRow[];
      offset: number;
      nextRow: number;
      /** The file ended within this chunk. */
      done: boolean;
    }
  /** The header can't be read, or the file isn't CSV: the import stops. */
  | { ok: false; error: string };

/**
 * Reads up to `max` rows from `records` (the file read from `from.offset`). Before the first row,
 * `header` is empty and the first record is the header, checked against the kind's columns. Rows
 * are numbered as a spreadsheet numbers lines: the header is 1.
 */
export async function readBulkChunk(
  records: AsyncIterable<CsvRecord>,
  kind: BulkKind,
  from: { header: readonly string[]; offset: number; nextRow: number },
  max: number,
): Promise<BulkRead> {
  const { required, optional } = BULK_COLUMNS[kind];
  let header = from.header.length ? [...from.header] : null;
  let columns: Map<string, number> | null = null;
  if (header) {
    const h = csvColumns(header, required, optional);
    if (!h.ok) return h;
    columns = h.columns;
  }
  const rows: ReadBulkRow[] = [];
  let offset = from.offset;
  let nextRow = from.nextRow;
  let readHeader: string[] | undefined;
  try {
    for await (const r of records) {
      offset = r.end;
      if (!columns) {
        const h = csvColumns(r.record, required, optional);
        if (!h.ok) return h;
        header = r.record;
        readHeader = r.record;
        columns = h.columns;
        nextRow = 2;
        continue;
      }
      rows.push({ row: nextRow, read: readBulkRow(kind, columns, r.record) });
      nextRow++;
      if (rows.length >= max)
        return { ok: true, header: readHeader, rows, offset, nextRow, done: false };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Row ${nextRow}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!header) return { ok: false, error: 'The file is empty: it needs a header row.' };
  return { ok: true, header: readHeader, rows, offset, nextRow, done: true };
}

/** The id a row that creates a customer gives it: the same each time the row is applied. */
export const bulkCustomerId = (jobId: string, row: number) =>
  `cus_${jobId.replace(/^blk_/, '')}_${row}`;

type Job = { readonly id: string; readonly kind: BulkKind; readonly checkOnly: boolean };
type Outcome = Pick<BulkChunk, 'applied' | 'failed' | 'errors'>;

/**
 * Applies a chunk's rows (or, check-only, checks them): what it applied, and each row it refused
 * with why. Rows the file couldn't read are refused as they are.
 */
export async function applyBulkRows(
  ports: BulkPorts,
  job: Job,
  rows: readonly ReadBulkRow[],
  now: number,
): Promise<Outcome> {
  const errors: BulkRowError[] = [];
  const good: { row: number; value: BulkRow }[] = [];
  for (const r of rows)
    if (r.read.ok) good.push({ row: r.row, value: r.read.value });
    else errors.push({ row: r.row, error: r.read.error });
  let applied = 0;
  const refuse = (row: number, error: string) => errors.push({ row, error });
  if (job.kind === 'customers') {
    for (const r of good) {
      if (r.value.kind !== 'customers') continue;
      const ok = await applyCustomer(ports, job, r.row, r.value.row, now);
      if (ok === true) applied++;
      else refuse(r.row, ok);
    }
  } else if (job.kind === 'price_book_entries') {
    const entries = good.flatMap((r) =>
      r.value.kind === 'price_book_entries' ? [{ row: r.row, entry: r.value.row }] : [],
    );
    applied += await applyEntries(ports, job, entries, now, refuse);
  } else {
    const counts = good.flatMap((r) =>
      r.value.kind === 'stock' ? [{ row: r.row, count: r.value.row }] : [],
    );
    applied += await applyCounts(ports, job, counts, refuse);
  }
  errors.sort((a, b) => a.row - b.row);
  return { applied, failed: errors.length, errors };
}

/** True when the row's customer was created or changed (or, check-only, would be); else why not. */
async function applyCustomer(
  ports: BulkPorts,
  job: Job,
  row: number,
  r: Extract<BulkRow, { kind: 'customers' }>['row'],
  now: number,
): Promise<true | string> {
  const all = { all: true } as const;
  if (r.op === 'create') {
    const id = bulkCustomerId(job.id, row);
    // Already created by this row, on a run of this chunk that stopped before it was recorded.
    if (await ports.companies.customer(all, id)) return true;
    if (job.checkOnly) {
      if (await ports.companies.customerByEmail(all, r.input.email))
        return `A customer with the email ${r.input.email} already exists.`;
      return true;
    }
    const made = await createCustomer(ports, r.input, id, now);
    return made.ok ? true : made.error;
  }
  if (job.checkOnly) {
    const found = await ports.companies.customer(all, r.input.customerId);
    if (!found) return 'No such customer.';
    const taken = await ports.companies.customerByEmail(all, r.input.email);
    if (taken && taken.id !== r.input.customerId)
      return `A customer with the email ${r.input.email} already exists.`;
    return true;
  }
  const changed = await updateCustomer(ports, r.input, now);
  return changed.ok ? true : changed.error;
}

/**
 * A chunk's price book entries, a book at a time. A row naming a book that isn't there, or is
 * archived, or a SKU with no product, is refused; the rest of its book's rows are put in one
 * write. A key (SKU and minimum quantity) given twice keeps the later row, as a later chunk's
 * row replaces an earlier chunk's.
 */
async function applyEntries(
  ports: BulkPorts,
  job: Job,
  entries: { row: number; entry: PriceBookEntryRow }[],
  now: number,
  refuse: (row: number, error: string) => void,
): Promise<number> {
  let applied = 0;
  const byBook = new Map<string, typeof entries>();
  const resolved = new Map<string, Awaited<ReturnType<PriceBookStore['find']>>>();
  for (const r of entries) {
    const ref = r.entry.book;
    if (!resolved.has(ref)) {
      const code = normalizeBookCode(ref);
      resolved.set(
        ref,
        (await ports.books.find(ref)) ??
          (code && code !== ref ? await ports.books.find(code) : undefined),
      );
    }
    const book = resolved.get(ref);
    if (!book) refuse(r.row, `No price book ${ref}.`);
    else if (book.status === 'archived')
      refuse(r.row, `${book.name} is archived and can't change.`);
    else {
      const group = byBook.get(book.id);
      if (group) group.push(r);
      else byBook.set(book.id, [r]);
    }
  }
  const skus = [...new Set(entries.filter((e) => !e.entry.remove).map((e) => e.entry.sku))];
  const known = new Set((await ports.pricing.products(skus)).map((p) => p.sku));
  for (const [bookId, rows] of byBook) {
    // A key given twice keeps the later row; the earlier counts as applied, as the file's last
    // word for that key stands.
    const latest = new Map<string, (typeof rows)[number]>();
    const valid: number[] = [];
    for (const r of rows) {
      if (!r.entry.remove && !known.has(r.entry.sku)) {
        refuse(r.row, `No such product: ${r.entry.sku}.`);
        continue;
      }
      const key = `${r.entry.sku}\0${r.entry.minQty ?? 1}`;
      valid.push(r.row);
      latest.set(key, r);
    }
    const kept = [...latest.values()];
    if (!kept.length || job.checkOnly) {
      applied += valid.length;
      continue;
    }
    const put = await putPriceBookEntries(
      ports,
      {
        bookId,
        entries: kept.map(({ entry: { book: _b, ...e } }) => e),
      },
      now,
    );
    if (put.ok) applied += valid.length;
    else for (const row of valid) refuse(row, put.error);
  }
  return applied;
}

/** A chunk's stock counts: a SKU with no product is refused; a SKU counted twice keeps the later. */
async function applyCounts(
  ports: BulkPorts,
  job: Job,
  counts: { row: number; count: StockRow }[],
  refuse: (row: number, error: string) => void,
): Promise<number> {
  const known = new Set(
    (await ports.pricing.products([...new Set(counts.map((c) => c.count.sku))])).map((p) => p.sku),
  );
  const latest = new Map<string, { row: number; count: StockRow }>();
  let applied = 0;
  for (const c of counts) {
    if (!known.has(c.count.sku)) refuse(c.row, `No such product: ${c.count.sku}.`);
    else {
      if (latest.has(c.count.sku)) applied++;
      latest.set(c.count.sku, c);
    }
  }
  if (!latest.size || job.checkOnly) return applied + latest.size;
  const rows = [...latest.values()].map(({ row, count }) => ({ row, ...count }));
  const { unknown } = await ports.inventory.setCounts(job.id, rows);
  for (const r of rows) if (unknown.includes(r.sku)) refuse(r.row, `No such product: ${r.sku}.`);
  return applied + rows.length - unknown.length;
}
