/**
 * Bulk import and export: the kinds of file the admin moves in and out as CSV, their columns, and
 * how one row reads. A row is read here only as far as its cells go (a number is a number, a flag
 * is a flag); what it means is checked by the same rules a single change over the API is held to
 * (`planCreateCustomer`, `planUpdateCustomer`, `priceBookEntryProblem`, …), when the import runs.
 * Pure.
 */
import { priceBookEntryProblem } from './price-books';

/** What a file holds. Products come in through catalog feeds, not here. */
export const BULK_KINDS = ['customers', 'price_book_entries', 'stock'] as const;
export type BulkKind = (typeof BULK_KINDS)[number];

export const BULK_KIND_LABELS: Record<BulkKind, string> = {
  customers: 'Customers',
  price_book_entries: 'Price book entries',
  stock: 'Stock',
};

export const isBulkKind = (v: unknown): v is BulkKind =>
  typeof v === 'string' && (BULK_KINDS as readonly string[]).includes(v);

/** The largest file an import takes, in bytes, and the most rows it reads. */
export const BULK_MAX_BYTES = 20 * 1024 * 1024;
export const BULK_MAX_ROWS = 100_000;
/** Rows an import applies in one step, each step one round of writes. */
export const BULK_CHUNK_ROWS = 200;
/** Row errors an import keeps with its job; the full list is its error report file. */
export const BULK_KEPT_ERRORS = 100;

/**
 * Each kind's columns, in the order an export writes them and a template lists them: those an
 * import needs, then those it may have. The first required column is what a row is matched by.
 */
export const BULK_COLUMNS: Record<BulkKind, { required: string[]; optional: string[] }> = {
  // No id: a new customer. With one: that customer, changed.
  customers: { required: ['name', 'email'], optional: ['id', 'kind', 'tier', 'terms'] },
  // A book's entry is its SKU and minimum quantity; `remove` deletes it.
  price_book_entries: {
    required: ['book', 'sku'],
    optional: ['minQty', 'price', 'discountPct', 'remove'],
  },
  // On hand in the warehouse, as counted: the import sets it, it doesn't add to it.
  stock: { required: ['sku', 'stock'], optional: ['reorderPoint', 'reorderQty'] },
};

export type CustomerRow =
  | {
      op: 'create';
      input: { name: string; email: string; kind?: string; tier?: string; terms?: string };
    }
  | {
      op: 'update';
      input: {
        customerId: string;
        name: string;
        email: string;
        kind?: string;
        tier?: string;
        terms?: string;
      };
    };

export type PriceBookEntryRow = {
  /** The book's id or its code. */
  book: string;
  sku: string;
  minQty?: number;
  price?: number | null;
  discountPct?: number | null;
  remove?: boolean;
};

export type StockRow = {
  sku: string;
  /** On hand, as counted. */
  stock: number;
  reorderPoint?: number;
  reorderQty?: number;
};

export type BulkRow =
  | { kind: 'customers'; row: CustomerRow }
  | { kind: 'price_book_entries'; row: PriceBookEntryRow }
  | { kind: 'stock'; row: StockRow };

export type ReadRow<T> = { ok: true; value: T } | { ok: false; error: string };

/** A cell by column name, trimmed; '' when the column is absent or the row is short. */
const cellOf = (columns: Map<string, number>, record: readonly string[]) => (name: string) => {
  const i = columns.get(name);
  return i === undefined ? '' : (record[i] ?? '').trim();
};

/** A decimal cell, or undefined when it's empty; null means it isn't a number. */
function decimal(cell: string): number | undefined | null {
  if (!cell) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(cell)) return null;
  return Number(cell);
}

/** A whole number cell 0 or more, or undefined when it's empty; null means it isn't one. */
function count(cell: string): number | undefined | null {
  if (!cell) return undefined;
  if (!/^\d+$/.test(cell)) return null;
  const n = Number(cell);
  return Number.isSafeInteger(n) ? n : null;
}

/** A yes/no cell: true, yes, 1 or x; empty, false, no or 0 is no; anything else null. */
function flag(cell: string): boolean | null {
  const v = cell.toLowerCase();
  if (['true', 'yes', '1', 'x'].includes(v)) return true;
  if (['', 'false', 'no', '0'].includes(v)) return false;
  return null;
}

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * One row of a file of `kind`, read through its header's `columns` (`csvColumns`): the change it
 * asks for, or why it can't be read. Empty optional cells leave a field as it is.
 */
export function readBulkRow(
  kind: BulkKind,
  columns: Map<string, number>,
  record: readonly string[],
): ReadRow<BulkRow> {
  const cell = cellOf(columns, record);
  if (kind === 'customers') {
    const name = cell('name');
    const email = cell('email');
    if (!name) return bad('A customer has a name.');
    if (!email) return bad('A customer has an email address.');
    const id = cell('id');
    const rest = Object.fromEntries(
      (['kind', 'tier', 'terms'] as const).flatMap((k) => (cell(k) ? [[k, cell(k)]] : [])),
    );
    return {
      ok: true,
      value: {
        kind,
        row: id
          ? { op: 'update', input: { customerId: id, name, email, ...rest } }
          : { op: 'create', input: { name, email, ...rest } },
      },
    };
  }
  if (kind === 'price_book_entries') {
    const book = cell('book');
    const sku = cell('sku');
    if (!book) return bad('An entry names its price book, by id or code.');
    const minQty = count(cell('minQty'));
    if (minQty === null) return bad(`${sku}: minQty is a whole number.`);
    const price = decimal(cell('price'));
    if (price === null) return bad(`${sku}: price is a number, like 12.50.`);
    const discountPct = decimal(cell('discountPct'));
    if (discountPct === null) return bad(`${sku}: discountPct is a number, like 15.`);
    const remove = flag(cell('remove'));
    if (remove === null) return bad(`${sku}: remove is yes or no.`);
    const row: PriceBookEntryRow = {
      book,
      sku,
      ...(minQty !== undefined ? { minQty } : {}),
      ...(remove ? { remove } : { price: price ?? null, discountPct: discountPct ?? null }),
    };
    const problem = priceBookEntryProblem(row, !!remove);
    return problem ? bad(problem) : { ok: true, value: { kind, row } };
  }
  const sku = cell('sku');
  if (!sku) return bad('A stock row names a SKU.');
  const stock = count(cell('stock'));
  if (stock === undefined || stock === null)
    return bad(`${sku}: stock is the count on hand, a whole number 0 or more.`);
  const reorderPoint = count(cell('reorderPoint'));
  if (reorderPoint === null) return bad(`${sku}: reorderPoint is a whole number 0 or more.`);
  const reorderQty = count(cell('reorderQty'));
  if (reorderQty === null) return bad(`${sku}: reorderQty is a whole number 0 or more.`);
  return {
    ok: true,
    value: {
      kind,
      row: {
        sku,
        stock,
        ...(reorderPoint !== undefined ? { reorderPoint } : {}),
        ...(reorderQty !== undefined ? { reorderQty } : {}),
      },
    },
  };
}

/** A blank file of `kind`, its header row only: what an admin fills in. */
export const bulkTemplateHeader = (kind: BulkKind) => [
  ...BULK_COLUMNS[kind].required,
  ...BULK_COLUMNS[kind].optional,
];
