import { PO_STATUSES } from '@commerceworker/core';
import {
  InMemoryCompanyDirectory,
  InMemoryPurchaseOrderStore,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it, vi } from 'vitest';
import {
  filterQuery,
  filtersFrom,
  linesFrom,
  PO_TONE,
  shipToFrom,
} from '../app/lib/purchase-orders';

const store = new InMemoryPurchaseOrderStore();
const directory = new InMemoryCompanyDirectory({
  customers: ['acme', 'globex'].map((id) => ({
    id,
    name: `Name ${id}`,
    email: `${id}@example.test`,
    kind: 'business',
    tier: 'standard',
    creditLimit: 0,
    balance: 0,
    terms: 'net_30',
    stripeCustomerId: null,
    stripePaymentMethodId: null,
  })),
  companies: ['acme', 'globex'].map((id) => ({
    customerId: id,
    status: 'active' as const,
    legalName: id,
    taxId: null,
    parentCompanyId: null,
    createdAt: 1,
    updatedAt: 1,
  })),
  members: [
    {
      id: 'm1',
      companyId: 'acme',
      name: 'Ann',
      email: 'ann@example.test',
      role: 'buyer',
      teamId: null,
      status: 'active',
      orderLimit: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
});
vi.mock('../app/lib/wire.server', () => ({
  purchaseOrderStore: () => store,
  companyDirectory: () => directory,
}));
const server = await import('../app/lib/purchase-orders.server');

const po = (id: string, companyId: string, over = {}) => ({
  id,
  companyId,
  buyerId: null,
  poNumber: id.toUpperCase(),
  status: 'draft' as const,
  currency: 'USD',
  shipTo: null,
  notes: null,
  quoteId: null,
  orderId: null,
  source: 'app' as const,
  createdAt: Date.parse('2026-11-02T10:00:00Z'),
  updatedAt: 1,
  ...over,
});
const lines = [{ sku: 'W-1', name: null, qty: 2, unitPrice: null }];

describe('the list’s filters', () => {
  it('reads known values and drops the rest', () => {
    expect(
      filtersFrom(
        new URLSearchParams(
          'status=pending_approval&company= acme &from=2026-11-01&to=2026-11-30&q= PO-7 ',
        ),
      ),
    ).toEqual({
      status: 'pending_approval',
      company: 'acme',
      from: '2026-11-01',
      to: '2026-11-30',
      q: 'PO-7',
    });
    expect(
      filtersFrom(new URLSearchParams('status=bogus&from=soon&to=2026-13-45&company=')),
    ).toEqual({});
  });

  it('keeps the filters in a page link, with the cursor on top, and is empty with none', () => {
    expect(filterQuery({})).toBe('');
    expect(filterQuery({ status: 'draft', q: 'A B' }, { after: 'c1' })).toBe(
      '?status=draft&q=A+B&after=c1',
    );
  });

  it('gives every status a tone', () => {
    for (const s of PO_STATUSES) expect(PO_TONE[s]).toBeTruthy();
  });
});

describe('the draft form’s fields', () => {
  const form = (rows: [string, string, string, string][]) => {
    const f = new FormData();
    for (const [sku, name, qty, price] of rows) {
      f.append('sku', sku);
      f.append('name', name);
      f.append('qty', qty);
      f.append('unitPrice', price);
    }
    return f;
  };

  it('reads lines a row at a time, skipping blank rows', () => {
    expect(
      linesFrom(
        form([
          [' W-1 ', 'Widget', '2', '1.5'],
          ['', '', '', ''],
          ['W-2', '', '4', ''],
        ]),
      ),
    ).toEqual([
      { sku: 'W-1', name: 'Widget', qty: 2, unitPrice: 1.5 },
      { sku: 'W-2', name: null, qty: 4, unitPrice: null },
    ]);
  });

  it('refuses a SKU with no usable quantity or a bad price, naming the line', () => {
    expect(linesFrom(form([['W-1', '', '0', '']]))).toMatch(/Line 1 \(W-1\) needs a quantity/);
    expect(
      linesFrom(
        form([
          ['W-1', '', '1', ''],
          ['W-2', '', 'x', ''],
        ]),
      ),
    ).toMatch(/Line 2/);
    expect(linesFrom(form([['W-1', '', '1', '-3']]))).toMatch(/price/);
  });

  it('reads a ship-to, or none when every field is empty', () => {
    const f = new FormData();
    f.set('shipTo.line1', '1 Dock Rd');
    f.set('shipTo.city', 'Austin');
    f.set('shipTo.postalCode', '78701');
    f.set('shipTo.country', 'US');
    f.set('shipTo.line2', ' ');
    expect(shipToFrom(f)).toEqual({
      line1: '1 Dock Rd',
      city: 'Austin',
      postalCode: '78701',
      country: 'US',
    });
    expect(shipToFrom(new FormData())).toBeNull();
  });
});

describe('what the loaders hand the pages', () => {
  it('pages the list with company names, filters, and a cursor', async () => {
    await store.create(po('po_1', 'acme'), lines);
    await store.create(
      po('po_2', 'globex', { createdAt: Date.parse('2026-11-03T10:00:00Z') }),
      lines,
    );
    const all = await server.purchaseOrderPage({}, undefined, { all: true }, 1);
    expect(all.purchaseOrders.map((p) => p.id)).toEqual(['po_2']);
    expect(all.total).toBe(2);
    expect(all.cursor).toBeTruthy();
    expect(all.companies).toEqual({ globex: 'Name globex' });
    const next = await server.purchaseOrderPage({}, all.cursor ?? undefined, { all: true }, 1);
    expect(next.purchaseOrders.map((p) => p.id)).toEqual(['po_1']);
    const day = await server.purchaseOrderPage({ from: '2026-11-03', to: '2026-11-03' }, undefined);
    expect(day.purchaseOrders.map((p) => p.id)).toEqual(['po_2']);
    const bad = await server.purchaseOrderPage({}, 'junk');
    expect(bad).toMatchObject({ purchaseOrders: [], error: expect.stringMatching(/cursor/) });
  });

  it('reads a company’s own page in its scope only', async () => {
    const mine = await server.companyPurchaseOrders('acme');
    expect(mine.purchaseOrders.map((p) => p.id)).toEqual(['po_1']);
    expect(mine.total).toBe(1);
    // A company can't see another's through a filter.
    const peek = await server.purchaseOrderPage({ company: 'globex' }, undefined, {
      companyId: 'acme',
    });
    expect(peek.purchaseOrders).toEqual([]);
  });

  it('gives a draft its lines and the active members to pick a buyer from, and null for a stranger', async () => {
    const d = await server.purchaseOrderDetail('po_1');
    expect(d?.po.lines).toEqual(lines);
    expect(d?.members).toEqual([{ id: 'm1', name: 'Ann', email: 'ann@example.test' }]);
    expect(d?.company).toMatchObject({ id: 'acme', name: 'Name acme' });
    expect(await server.purchaseOrderDetail('po_nope')).toBeNull();
    expect((await server.activeCompanies()).map((c) => c.id)).toEqual(['acme', 'globex']);
  });
});
