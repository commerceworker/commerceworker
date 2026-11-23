import { describe, expect, it } from 'vitest';
import { BULK_COLUMNS, type BulkKind, bulkTemplateHeader, readBulkRow } from '../src/bulk';
import { csvColumns } from '../src/csv';

const row = (kind: BulkKind, header: string[], record: string[]) => {
  const h = csvColumns(header, BULK_COLUMNS[kind].required, BULK_COLUMNS[kind].optional);
  if (!h.ok) throw new Error(h.error);
  return readBulkRow(kind, h.columns, record);
};

describe('reading a customers row', () => {
  it('creates without an id, and changes the customer with one', () => {
    expect(row('customers', ['name', 'email'], ['Acme', 'ap@acme.test'])).toEqual({
      ok: true,
      value: {
        kind: 'customers',
        row: { op: 'create', input: { name: 'Acme', email: 'ap@acme.test' } },
      },
    });
    expect(
      row('customers', ['id', 'name', 'email', 'tier'], ['cus_1', 'Acme', 'ap@acme.test', 'gold']),
    ).toMatchObject({
      ok: true,
      value: { row: { op: 'update', input: { customerId: 'cus_1', tier: 'gold' } } },
    });
  });

  it('needs a name and an email', () => {
    expect(row('customers', ['name', 'email'], ['', 'a@b.test'])).toEqual({
      ok: false,
      error: 'A customer has a name.',
    });
    expect(row('customers', ['name', 'email'], ['Acme'])).toMatchObject({ ok: false });
  });
});

describe('reading a price book entry row', () => {
  const header = ['book', 'sku', 'minQty', 'price', 'discountPct', 'remove'];

  it('reads a price, or a percentage off, for a quantity', () => {
    expect(
      row('price_book_entries', header, ['WHOLESALE', 'MON-27', '10', '299.5', '', '']),
    ).toEqual({
      ok: true,
      value: {
        kind: 'price_book_entries',
        row: { book: 'WHOLESALE', sku: 'MON-27', minQty: 10, price: 299.5, discountPct: null },
      },
    });
    expect(row('price_book_entries', header, ['W', 'MON-27', '', '', '15', ''])).toMatchObject({
      ok: true,
      value: { row: { discountPct: 15, price: null } },
    });
  });

  it('holds a row to the rules an entry over the API is held to', () => {
    expect(row('price_book_entries', header, ['W', 'MON-27', '', '10', '5', ''])).toMatchObject({
      ok: false,
      error: 'MON-27: give a price or a percentage off, not both.',
    });
    expect(row('price_book_entries', header, ['W', 'MON-27', 'ten', '10', '', ''])).toMatchObject({
      ok: false,
      error: 'MON-27: minQty is a whole number.',
    });
    expect(row('price_book_entries', header, ['W', 'MON-27', '', '1,299', '', ''])).toMatchObject({
      ok: false,
    });
  });

  it('removes an entry by its key alone', () => {
    expect(row('price_book_entries', header, ['W', 'MON-27', '10', '', '', 'yes'])).toEqual({
      ok: true,
      value: {
        kind: 'price_book_entries',
        row: { book: 'W', sku: 'MON-27', minQty: 10, remove: true },
      },
    });
    expect(row('price_book_entries', header, ['W', 'MON-27', '', '', '', 'maybe'])).toMatchObject({
      ok: false,
      error: 'MON-27: remove is yes or no.',
    });
  });
});

describe('reading a stock row', () => {
  it('reads the count on hand and the reorder settings', () => {
    expect(row('stock', ['sku', 'stock', 'reorderPoint'], ['MON-27', '42', '5'])).toEqual({
      ok: true,
      value: { kind: 'stock', row: { sku: 'MON-27', stock: 42, reorderPoint: 5 } },
    });
  });

  it('refuses a count that is missing, negative or not whole', () => {
    for (const stock of ['', '-1', '2.5', 'many'])
      expect(row('stock', ['sku', 'stock'], ['MON-27', stock])).toMatchObject({ ok: false });
  });
});

describe('a template', () => {
  it('lists the columns an import needs, then those it may have', () => {
    expect(bulkTemplateHeader('stock')).toEqual(['sku', 'stock', 'reorderPoint', 'reorderQty']);
  });
});
