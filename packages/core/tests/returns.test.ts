import { describe, expect, it } from 'vitest';
import { flowReadsGoodsBack, returnRequest, returnValue } from '../src/returns';
import { TEMPLATES } from '../src/templates';

const order = {
  total: 130,
  lines: [
    { sku: 'A', qty: 2, unitPrice: 50 },
    { sku: 'B', qty: 1, unitPrice: 20 },
  ],
};

describe('returnRequest', () => {
  it('values the lines at what was paid and takes the rest from the reason', () => {
    const r = returnRequest(
      { reasonCode: 'damaged', lines: [{ sku: 'A', qty: 1 }], note: '  Crushed box ' },
      order,
    );
    expect(r).toEqual({
      request: {
        kind: 'claim',
        reasonCode: 'damaged',
        reason: 'Arrived damaged',
        goodsBack: true,
        lines: [{ sku: 'A', qty: 1 }],
        amount: 50,
        note: 'Crushed box',
      },
    });
  });

  it('refunds the tax charged on the returned lines, each at its own rate, and not shipping’s', () => {
    // 2 × 50 at 10%, 1 × 20 at its class's 5%, 1 × 30 untaxed, 10 shipping taxed at 10%.
    const taxed = {
      total: 172,
      taxRate: 0.1,
      taxRates: { B: 0.05, C: 0 },
      lines: [
        { sku: 'A', qty: 2, unitPrice: 50 },
        { sku: 'B', qty: 1, unitPrice: 20 },
        { sku: 'C', qty: 1, unitPrice: 30 },
      ],
    };
    const back = (lines: { sku: string; qty: number }[]) =>
      returnRequest({ reasonCode: 'changed_mind', lines }, taxed);
    expect(back([{ sku: 'A', qty: 1 }])).toMatchObject({ request: { amount: 55, tax: 5 } });
    expect(back([{ sku: 'B', qty: 1 }])).toMatchObject({ request: { amount: 21, tax: 1 } });
    const untaxed = back([{ sku: 'C', qty: 1 }]);
    expect(untaxed).toMatchObject({ request: { amount: 30 } });
    expect(untaxed).not.toHaveProperty('request.tax');
    // Everything back is everything paid but the shipping and its tax.
    expect(
      back([
        { sku: 'A', qty: 2 },
        { sku: 'B', qty: 1 },
        { sku: 'C', qty: 1 },
      ]),
    ).toMatchObject({ request: { amount: 161, tax: 11 } });
    expect(returnValue([{ sku: 'A', qty: 1 }], taxed.lines, taxed)).toBe(55);
    // An amount a person set is the refund, with no tax worked out beside it.
    const set = returnRequest(
      { reasonCode: 'changed_mind', lines: [{ sku: 'A', qty: 1 }], amount: 40 },
      taxed,
    );
    expect(set).toMatchObject({ request: { amount: 40 } });
    expect(set).not.toHaveProperty('request.tax');
    // An order no tax node ran on charged nothing, so refunds none.
    expect(returnValue([{ sku: 'B', qty: 1 }], taxed.lines)).toBe(20);
  });

  it('says nothing comes back for a shortage', () => {
    const r = returnRequest({ reasonCode: 'short_shipped', lines: [{ sku: 'B', qty: 1 }] }, order);
    expect(r).toMatchObject({ request: { kind: 'claim', goodsBack: false, amount: 20 } });
  });

  it('refuses a line that is not on the order, or more than was ordered', () => {
    const lines = (sku: string, qty: number) => [{ sku, qty }];
    const req = { reasonCode: 'faulty' as const };
    expect(returnRequest({ ...req, lines: lines('Z', 1) }, order)).toHaveProperty('issue');
    expect(returnRequest({ ...req, lines: lines('A', 3) }, order)).toHaveProperty('issue');
    expect(returnRequest({ ...req, lines: lines('A', 0) }, order)).toHaveProperty('issue');
    expect(returnRequest({ ...req, lines: [] }, order)).toHaveProperty('issue');
    // Split across two entries, it is still three.
    expect(
      returnRequest({ ...req, lines: [...lines('A', 2), ...lines('A', 1)] }, order),
    ).toHaveProperty('issue');
  });

  // The built-in flows read `or: [amount, order.total]`: a zero would refund the whole order.
  it('never lets through an amount a flow would read as the whole order', () => {
    const free = { total: 10, lines: [{ sku: 'F', qty: 1, unitPrice: 0 }] };
    const line = [{ sku: 'F', qty: 1 }];
    expect(returnRequest({ reasonCode: 'faulty', lines: line }, free)).toHaveProperty('issue');
    const unpriced = { total: 10, lines: [{ sku: 'F', qty: 1 }] };
    expect(returnRequest({ reasonCode: 'faulty', lines: line }, unpriced)).toHaveProperty('issue');
    expect(returnRequest({ reasonCode: 'faulty', lines: line, amount: 4 }, unpriced)).toMatchObject(
      { request: { amount: 4 } },
    );
    expect(
      returnRequest({ reasonCode: 'faulty', lines: [{ sku: 'A', qty: 1 }], amount: 0 }, order),
    ).toHaveProperty('issue');
  });

  it('checks the amount as it will be refunded, after rounding', () => {
    const line = [{ sku: 'A', qty: 1 }];
    expect(
      returnRequest({ reasonCode: 'faulty', lines: line, amount: 0.004 }, order),
    ).toHaveProperty('issue');
    expect(
      returnRequest({ reasonCode: 'faulty', lines: line, amount: 130.004 }, order),
    ).toMatchObject({ request: { amount: 130 } });
  });

  it('cleans the note before it is stored', () => {
    const r = returnRequest(
      { reasonCode: 'faulty', lines: [{ sku: 'A', qty: 1 }], note: 'ok\u202Eevil\u200B' },
      order,
    );
    expect(r).toMatchObject({ request: { note: 'okevil' } });
  });

  it('refuses more than the order total', () => {
    const r = returnRequest(
      { reasonCode: 'faulty', lines: [{ sku: 'A', qty: 1 }], amount: 131 },
      order,
    );
    expect(r).toHaveProperty('issue');
  });
});

describe('returnValue', () => {
  it('takes a repeated SKU in order, at each price', () => {
    const lines = [
      { sku: 'A', qty: 1, unitPrice: 10 },
      { sku: 'A', qty: 2, unitPrice: 4 },
    ];
    expect(returnValue([{ sku: 'A', qty: 2 }], lines)).toBe(14);
  });
});

describe('flowReadsGoodsBack', () => {
  it('is true of the built-in flows with a return window, and not of a flow without the branch', () => {
    const graphs = Object.values(TEMPLATES).map((t) => t());
    const withWindow = graphs.filter((g) =>
      g.nodes.some((n) => n.type === 'commerce.return_label'),
    );
    expect(withWindow.length).toBeGreaterThan(0);
    for (const g of withWindow) expect(flowReadsGoodsBack(g)).toBe(true);
    expect(flowReadsGoodsBack({ nodes: [{ id: 'rma', type: 'commerce.return_label' }] })).toBe(
      false,
    );
    expect(flowReadsGoodsBack(null)).toBe(false);
  });
});
