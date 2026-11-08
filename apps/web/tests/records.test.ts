import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/** Two orders' records, in the in-memory order board. */
const { InMemoryOrderBoard } = await import('@commerceworker/test-kit/commerce');
const board = new InMemoryOrderBoard({
  customers: [{ id: 'cus_1', name: 'Northwind' }],
  orders: [
    { id: 'ord_a', status: 'completed', createdAt: 1, title: 'Desks', customerId: 'cus_1' },
    { id: 'ord_b', status: 'completed', createdAt: 2, contactEmail: 'guest@example.com' },
  ],
  payments: [
    {
      id: 'pay_ord_a_authorize_0',
      orderId: 'ord_a',
      kind: 'authorization:card_present',
      amount: 10,
      status: 'authorized',
      ref: null,
      provider: 'stripe',
      externalId: 'pi_1',
      currency: 'USD',
      createdAt: 5,
    },
    {
      id: 'pay_cap',
      orderId: 'ord_a',
      kind: 'capture',
      amount: 10,
      status: 'captured',
      // Another row's id: says nothing on this page.
      ref: 'pay_ord_a_authorize_0',
      provider: 'mock',
      externalId: null,
      currency: 'USD',
      createdAt: 6,
    },
  ],
  invoices: [
    {
      id: 'inv_1',
      orderId: 'ord_a',
      status: 'open',
      number: 'INV-77',
      hostedUrl: null,
      amount: 10,
      currency: 'USD',
      dueAt: null,
      createdAt: 7,
    },
  ],
  sellers: [{ id: 'sel_1', name: 'Oak & Co' }],
  payouts: [
    {
      id: 'po_1',
      orderId: 'ord_a',
      sellerId: 'sel_1',
      status: 'scheduled',
      net: 8,
      commission: 2,
      createdAt: 4,
    },
  ],
  sellerOrders: [
    {
      id: 'so_1',
      orderId: 'ord_a',
      sellerId: 'sel_gone',
      status: 'rejected',
      subtotal: 5,
      reason: 'Out of stock',
      createdAt: 3,
    },
  ],
  locations: [{ id: 'loc_1', name: 'Downtown' }],
  reservations: [
    {
      id: 'res_1',
      orderId: 'ord_a',
      sku: 'DESK-1',
      qty: 2,
      locationId: 'loc_1',
      status: 'held',
      createdAt: 2,
    },
    {
      id: 'res_2',
      orderId: 'ord_b',
      sku: 'CHAIR-1',
      qty: 1,
      locationId: null,
      status: 'held',
      createdAt: 1,
    },
  ],
  shipments: [
    {
      id: 'shp_1',
      orderId: 'ord_b',
      carrier: 'UPS',
      tracking: '1Z9',
      status: 'label_created',
      provider: null,
      externalId: null,
      createdAt: 8,
    },
  ],
  messages: [
    {
      id: 'msg_1',
      orderId: 'ord_b',
      recipient: 'guest@example.com',
      subject: 'Shipped',
      body: '',
      createdAt: 9,
    },
  ],
  documents: [
    {
      id: 'doc_1',
      orderId: 'ord_a',
      kind: 'purchase_order',
      r2Key: 'k',
      contentType: 'text/plain',
      createdAt: 10,
    },
  ],
});
vi.mock('~/lib/wire.server', () => ({ orderBoard: () => board }));

const { recentRecords } = await import('~/lib/records.server');

describe('the records page', () => {
  it('reads money as one list, newest first, in words', async () => {
    const { money } = await recentRecords();
    expect(money.map((r) => r.id)).toEqual(['inv_1', 'pay_cap', 'pay_ord_a_authorize_0', 'po_1']);
    const [invoice, capture, auth, payout] = money;
    expect(invoice).toMatchObject({ what: 'Invoice INV-77', detail: 'Net 30', amount: 10 });
    expect(capture).toMatchObject({ what: 'Capture', detail: null });
    expect(auth).toMatchObject({
      what: 'Authorization',
      detail: 'Card present · Stripe',
      orderTitle: 'Desks',
      customer: 'Northwind',
    });
    expect(payout).toMatchObject({
      what: 'Payout to Oak & Co',
      detail: '$10.00 gross, $2.00 commission',
      amount: 8,
    });
  });

  it('says what each other record is, and whose order it is', async () => {
    const r = await recentRecords();
    expect(r.holds.map((h) => [h.what, h.detail])).toEqual([
      ['2 × DESK-1', 'at Downtown'],
      ['1 × CHAIR-1', 'at the warehouse'],
    ]);
    expect(r.holds[1]).toMatchObject({ customer: 'guest@example.com' });
    expect(r.shipments[0]).toMatchObject({ what: 'UPS 1Z9' });
    // A seller no longer on file shows by id.
    expect(r.sellers[0]).toMatchObject({ what: 'sel_gone', detail: 'Out of stock', amount: 5 });
    expect(r.messages[0]).toMatchObject({ what: 'Shipped', detail: 'To guest@example.com' });
    expect(r.documents[0]).toMatchObject({ what: 'Purchase order', detail: 'text/plain' });
  });

  it('searches every kind', async () => {
    const r = await recentRecords(' #ord_b ');
    expect(
      Object.values(r)
        .flat()
        .map((x) => x.id)
        .sort(),
    ).toEqual(['msg_1', 'res_2', 'shp_1']);
  });
});
