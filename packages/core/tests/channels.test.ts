import { describe, expect, it } from 'vitest';
import {
  inboundOrderSchema,
  parseX12,
  paymentSource,
  type ShopifyOrder,
  shopifyToInbound,
  verifyShopifyHmac,
  x12FunctionalAck,
  x12850ToInbound,
} from '../src';
import shopify from './fixtures/shopify-order.json';

const order = shopify as unknown as ShopifyOrder;

describe('Shopify orders', () => {
  it('maps an orders/create payload onto a valid inbound order', () => {
    const r = shopifyToInbound(order, { customerId: 'cus_ada' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(inboundOrderSchema.parse(r.order)).toMatchObject({
      model: 'b2c',
      channel: 'web',
      externalId: '820982911946154500',
      source: 'shopify',
      title: 'Shopify order #1001',
      customerId: 'cus_ada',
      currency: 'USD',
      contact: { email: 'jon@example.com', name: 'Jon Snow' },
      lines: [
        { sku: 'MON-27', name: '27" monitor', qty: 1, unitPrice: 349 },
        { sku: 'TEE-01', name: 'Organic cotton tee', qty: 2, unitPrice: 32 },
      ],
      shipTo: {
        line1: '1 Market St',
        city: 'San Francisco',
        region: 'CA',
        postalCode: '94105',
        country: 'US',
        latitude: 37.7946,
      },
    });
  });

  it('reads the channel and model from the source and company', () => {
    const pos = shopifyToInbound({ ...order, source_name: 'pos' });
    const app = shopifyToInbound({ ...order, source_name: 'iphone' });
    const b2b = shopifyToInbound({ ...order, company: { id: 1 } });
    expect(pos.ok && pos.order.channel).toBe('pos');
    expect(app.ok && app.order.channel).toBe('mobile');
    expect(b2b.ok && b2b.order.model).toBe('b2b');
  });

  it('records that Shopify took the payment', () => {
    const r = shopifyToInbound(order);
    expect(r.ok && r.order.payment).toEqual({
      provider: 'external',
      reference: '820982911946154500',
    });
    expect(r.ok && paymentSource(r.order)).toBe('external');
  });

  it('refuses line items without a SKU', () => {
    const r = shopifyToInbound({
      ...order,
      line_items: [{ sku: '', title: 'Gift wrap', quantity: 1, price: '5.00' }],
    });
    expect(r).toEqual({ ok: false, error: 'Line items without a SKU: Gift wrap' });
  });

  it('verifies the webhook HMAC', async () => {
    const body = JSON.stringify(order);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('shpss_test'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
    );
    const header = btoa(String.fromCharCode(...mac));
    expect(await verifyShopifyHmac('shpss_test', body, header)).toBe(true);
    expect(await verifyShopifyHmac('shpss_test', `${body} `, header)).toBe(false);
    expect(await verifyShopifyHmac('other', body, header)).toBe(false);
    expect(await verifyShopifyHmac('shpss_test', body, null)).toBe(false);
  });
});

const isa = (el: string, term: string) =>
  `ISA${el}00${el}          ${el}00${el}          ${el}ZZ${el}NORTHWIND      ${el}ZZ${el}COMMERCEWORKER ${el}261014${el}1200${el}U${el}00401${el}000000001${el}0${el}P${el}>${term}`;

const po850 = (el: string, term: string, control: string, po: string, lines: string[]) =>
  [
    `ST${el}850${el}${control}`,
    `BEG${el}00${el}SA${el}${po}${el}${el}20261014`,
    `CUR${el}BY${el}USD`,
    `N1${el}ST${el}Northwind Dock 4`,
    `N3${el}500 Harbor Way`,
    `N4${el}Oakland${el}CA${el}94607${el}US`,
    ...lines,
    `CTT${el}${lines.filter((l) => l.startsWith('PO1')).length}`,
    `SE${el}${8 + lines.length}${el}${control}`,
  ].join(term);

const interchange = (el: string, term: string, txs: string[]) =>
  [
    isa(el, term).slice(0, -1),
    `GS${el}PO${el}NORTHWIND${el}COMMERCEWORKER${el}20261014${el}1200${el}1${el}X${el}004010`,
    ...txs,
    `GE${el}${txs.length}${el}1`,
    `IEA${el}1${el}000000001`,
  ].join(term) + term;

describe('X12 850', () => {
  const lines = (el: string) => [
    `PO1${el}1${el}120${el}EA${el}21.50${el}${el}VP${el}WID-100${el}BP${el}NW-77`,
    `PID${el}F${el}${el}${el}${el}Industrial widget`,
    `PO1${el}2${el}40${el}EA${el}${el}${el}BP${el}GSK-010`,
  ];

  it('parses an interchange with the delimiters its ISA declares', () => {
    for (const [el, term] of [
      ['*', '~'],
      ['|', '\n'],
    ] as const) {
      const p = parseX12(interchange(el, term, [po850(el, term, '0001', 'NW-7781', lines(el))]));
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.interchange.sender).toBe('NORTHWIND');
      expect(p.interchange.transactions.map((t) => [t.type, t.control])).toEqual([['850', '0001']]);
    }
  });

  it('maps an 850 onto a B2B inbound order for the partner', () => {
    const p = parseX12(interchange('*', '~', [po850('*', '~', '0001', 'NW-7781', lines('*'))]));
    if (!p.ok) throw new Error(p.error);
    const r = x12850ToInbound(p.interchange.transactions[0]!, {
      sender: 'NORTHWIND',
      customerId: 'cus_northwind',
    });
    if (!r.ok) throw new Error(r.error);
    expect(inboundOrderSchema.parse(r.order)).toMatchObject({
      model: 'b2b',
      channel: 'edi',
      externalId: 'NORTHWIND:NW-7781',
      source: 'x12-850',
      title: 'PO NW-7781',
      customerId: 'cus_northwind',
      currency: 'USD',
      // VP beats BP; a line without a price keeps no unitPrice, so pricing fills it in.
      lines: [
        { sku: 'WID-100', qty: 120, unitPrice: 21.5, name: 'Industrial widget' },
        { sku: 'GSK-010', qty: 40 },
      ],
      shipTo: {
        name: 'Northwind Dock 4',
        line1: '500 Harbor Way',
        city: 'Oakland',
        region: 'CA',
        postalCode: '94607',
        country: 'US',
      },
    });
  });

  it('splits several purchase orders and checks the counts', () => {
    const two = parseX12(
      interchange('*', '~', [
        po850('*', '~', '0001', 'NW-1', lines('*')),
        po850('*', '~', '0002', 'NW-2', lines('*')),
      ]),
    );
    expect(two.ok && two.interchange.transactions.length).toBe(2);
    const badSe = interchange('*', '~', [po850('*', '~', '0001', 'NW-1', lines('*'))]).replace(
      'SE*11*0001',
      'SE*10*0001',
    );
    expect(parseX12(badSe)).toEqual({
      ok: false,
      error: 'SE for 0001 counts 10 segments; the transaction has 11',
    });
    expect(parseX12('hello')).toMatchObject({ ok: false });
  });

  it('refuses an 850 with no PO number, a bad line count or a line without a part number', () => {
    const tx = (segs: string[]) => ({
      type: '850',
      control: '1',
      group: '1',
      segments: segs.map((s) => {
        const [id, ...el] = s.split('*');
        return { id: id!, el };
      }),
    });
    const partner = { sender: 'NORTHWIND', customerId: 'cus_northwind' };
    expect(x12850ToInbound(tx(['PO1*1*1*EA*1**VP*A']), partner)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no BEG03/),
    });
    expect(
      x12850ToInbound(tx(['BEG*00*SA*P1', 'PO1*1*1*EA*1**VP*A', 'CTT*2']), partner),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/CTT says 2/) });
    expect(x12850ToInbound(tx(['BEG*00*SA*P1', 'PO1*1*1*EA*1**ZZ*A']), partner)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no VP, SK, BP or IN/),
    });
  });
});

describe('X12 997', () => {
  const lines = ['PO1*1*120*EA*21.50**VP*WID-100', 'PO1*2*40*EA***BP*GSK-010'];
  const now = new Date(Date.UTC(2026, 10, 9, 14, 5));
  const segs = (x: string, term = '~', el = '*') =>
    x
      .split(term)
      .filter(Boolean)
      .map((s) => s.split(el));

  it('keeps the envelope a reply needs: parties, control number, version, delimiters and groups', () => {
    const p = parseX12(interchange('*', '~', [po850('*', '~', '0001', 'NW-1', lines)]));
    if (!p.ok) throw new Error(p.error);
    expect(p.interchange.envelope).toEqual({
      senderQualifier: 'ZZ',
      receiverQualifier: 'ZZ',
      control: '000000001',
      version: '00401',
      usage: 'P',
      repetition: 'U',
      element: '*',
      component: '>',
      terminator: '~',
    });
    expect(p.interchange.groups).toEqual([
      {
        functionalId: 'PO',
        sender: 'NORTHWIND',
        receiver: 'COMMERCEWORKER',
        control: '1',
        version: '004010',
      },
    ]);
    expect(p.interchange.transactions.map((t) => t.group)).toEqual(['1']);
  });

  it('acknowledges each PO back to its sender: A, R, and a group that is A, P or R', () => {
    const p = parseX12(
      interchange('*', '~', [
        po850('*', '~', '0001', 'NW-1', lines),
        po850('*', '~', '0002', 'NW-2', lines),
      ]),
    );
    if (!p.ok) throw new Error(p.error);
    const ack = x12FunctionalAck(
      p.interchange,
      [
        { control: '0001', accepted: true },
        { control: '0002', accepted: false },
      ],
      now,
    );
    const s = segs(ack);
    // The ISA is fixed width and swaps the parties.
    expect(ack.indexOf('~')).toBe(105);
    expect(s[0]!.slice(5, 9)).toEqual(['ZZ', 'COMMERCEWORKER ', 'ZZ', 'NORTHWIND      ']);
    expect(s[0]!.slice(9, 11)).toEqual(['261109', '1405']);
    expect(s[0]![13]).toBe('000000001');
    expect(s.slice(1).map((x) => x.join('*'))).toEqual([
      'GS*FA*COMMERCEWORKER*NORTHWIND*20261109*1405*1*X*004010',
      'ST*997*0001',
      'AK1*PO*1',
      'AK2*850*0001',
      'AK5*A',
      'AK2*850*0002',
      'AK5*R*5',
      'AK9*P*2*2*1',
      'SE*8*0001',
      'GE*1*1',
      'IEA*1*000000001',
    ]);
    // It parses as an interchange itself, its SE count right.
    const back = parseX12(ack);
    expect(back.ok && back.interchange.transactions.map((t) => [t.type, t.control])).toEqual([
      ['997', '0001'],
    ]);
    const all = (accepted: boolean) =>
      segs(
        x12FunctionalAck(
          p.interchange,
          ['0001', '0002'].map((control) => ({ control, accepted })),
          now,
        ),
      ).find((x) => x[0] === 'AK9')!;
    expect(all(true).join('*')).toBe('AK9*A*2*2*2');
    expect(all(false).join('*')).toBe('AK9*R*2*2*0');
  });

  it('answers in the delimiters the interchange came in', () => {
    const p = parseX12(
      interchange('|', '\n', [
        po850(
          '|',
          '\n',
          '0001',
          'NW-1',
          lines.map((l) => l.replaceAll('*', '|')),
        ),
      ]),
    );
    if (!p.ok) throw new Error(p.error);
    const ack = x12FunctionalAck(p.interchange, [{ control: '0001', accepted: true }], now);
    expect(ack).toContain('\nAK5|A\n');
    expect(parseX12(ack).ok).toBe(true);
  });
});
