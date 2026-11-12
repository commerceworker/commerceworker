import type { CheckoutIssue, HostedCheckout } from '@commerceworker/core';
import { describe, expect, it } from 'vitest';
import {
  chosenOption,
  codeStatuses,
  fieldOf,
  isOpen,
  issuesBySection,
  patchFromForm,
  sectionOf,
  totalRows,
  valuesOf,
} from '../app/lib/checkout-form';

const quote = (over: Partial<NonNullable<HostedCheckout['quote']>> = {}) => ({
  currency: 'USD',
  lines: [{ id: 'li_1', sku: 'MON-27', title: 'Monitor', qty: 2, unitPrice: 100, ships: true }],
  subtotal: 200,
  shipping: 10,
  tax: 16.8,
  total: 226.8,
  shippingOptions: [
    { id: 'ground', title: 'Ground', carrier: 'UPS', amount: 10, minDays: 3, maxDays: 5 },
    { id: 'air', title: 'Air', carrier: 'UPS', amount: 25, minDays: 1, maxDays: 2 },
  ],
  shippingOption: 'ground',
  ships: true,
  ...over,
});

const checkout = (over: Partial<HostedCheckout> = {}): HostedCheckout => ({
  id: 'chk_1',
  status: 'incomplete',
  currency: 'USD',
  lines: [{ id: 'li_1', sku: 'MON-27', qty: 2, title: 'Monitor', unitPrice: 100 }],
  buyer: {},
  fulfillment: 'ship',
  shipTo: null,
  shippingOption: null,
  pickupLocationId: null,
  pickupStores: [],
  promoCodes: [],
  quote: quote(),
  issues: [],
  orderId: null,
  expiresAt: 1,
  version: 3,
  ...over,
});

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
  return f;
};

const ADDRESS = {
  'shipTo.name': 'Ada Lovelace',
  'shipTo.line1': '500 Congress Ave',
  'shipTo.line2': '',
  'shipTo.city': 'Austin',
  'shipTo.region': 'TX',
  'shipTo.postalCode': '78701',
  'shipTo.country': 'US',
};
const off = { editLines: false };

describe('the buyer’s form as a patch', () => {
  it('takes the contact and the address, leaving out what was left empty', () => {
    const { patch, errors } = patchFromForm(
      form({
        version: '3',
        intent: 'update',
        email: ' ada@example.com ',
        firstName: 'Ada',
        lastName: '',
        phone: '',
        ...ADDRESS,
      }),
      checkout(),
      off,
    );
    expect(errors).toEqual({});
    expect(patch).toEqual({
      buyer: { email: 'ada@example.com', firstName: 'Ada' },
      shipTo: {
        name: 'Ada Lovelace',
        line1: '500 Congress Ave',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        country: 'US',
      },
      // The address is new, so the option the flow chose before belongs to no address yet.
      shippingOption: null,
    });
  });

  it('sets no price, owner or status, whatever the form posts', () => {
    const { patch } = patchFromForm(
      form({
        email: 'ada@example.com',
        total: '1',
        unitPrice: '0',
        ownerId: 'hosted:x',
        status: 'completed',
        'quote.total': '0',
        shippingOptionPrice: '0',
      }),
      checkout(),
      off,
    );
    expect(Object.keys(patch)).toEqual(['buyer']);
  });

  it('finds an email that is not one and too-long fields without asking the engine', () => {
    const { patch, errors } = patchFromForm(
      form({
        email: 'not an email',
        firstName: 'x'.repeat(101),
        phone: '1'.repeat(41),
        'shipTo.line1': 'y'.repeat(201),
      }),
      checkout(),
      off,
    );
    expect(errors).toMatchObject({
      email: expect.stringContaining('email address'),
      firstName: expect.stringContaining('too long'),
      phone: expect.stringContaining('too long'),
      'shipTo.line1': expect.stringContaining('Address is too long'),
    });
    // A form with an error asks for nothing it got wrong.
    expect(patch).not.toHaveProperty('buyer');
    expect(patch).not.toHaveProperty('shipTo');
  });

  it('clears the ship-to when every field is empty, and keeps the option when the address is unchanged', () => {
    const empty = Object.fromEntries(Object.keys(ADDRESS).map((k) => [k, '']));
    expect(patchFromForm(form(empty), checkout(), off).patch.shipTo).toBeNull();
    const shipped = checkout({
      shipTo: {
        name: 'Ada Lovelace',
        line1: '500 Congress Ave',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        country: 'US',
      },
      shippingOption: 'air',
    });
    const same = patchFromForm(form({ ...ADDRESS, shippingOption: 'air' }), shipped, off).patch;
    expect(same.shippingOption).toBe('air');
    const moved = patchFromForm(
      form({ ...ADDRESS, 'shipTo.city': 'Dallas', shippingOption: 'air' }),
      shipped,
      off,
    ).patch;
    expect(moved.shippingOption).toBeNull();
  });

  it('collects from a store, or ships, and a store is for pickup alone', () => {
    const pickup = patchFromForm(
      form({ fulfillment: 'pickup', pickupLocationId: 'loc_1' }),
      checkout(),
      off,
    ).patch;
    expect(pickup).toMatchObject({ fulfillment: 'pickup', pickupLocationId: 'loc_1' });
    const ship = patchFromForm(
      form({ fulfillment: 'ship', pickupLocationId: 'loc_1' }),
      checkout(),
      off,
    ).patch;
    expect(ship).toMatchObject({ fulfillment: 'ship', pickupLocationId: null });
    // A method the page doesn't offer is no method.
    expect(patchFromForm(form({ fulfillment: 'drone' }), checkout(), off).patch).toEqual({});
  });

  it('adds the typed code, removes the chosen one, and never duplicates', () => {
    const c = checkout({ promoCodes: ['SAVE10', 'SHIPFREE'] });
    expect(patchFromForm(form({ promo: 'welcome' }), c, off).patch.promoCodes).toEqual([
      'SAVE10',
      'SHIPFREE',
      'welcome',
    ]);
    expect(patchFromForm(form({ promo: 'save10' }), c, off).patch.promoCodes).toEqual([
      'SAVE10',
      'SHIPFREE',
    ]);
    expect(patchFromForm(form({ remove: 'SAVE10' }), c, off).patch.promoCodes).toEqual([
      'SHIPFREE',
    ]);
    expect(patchFromForm(form({ promo: '' }), c, off).patch).toEqual({});
    const many = checkout({ promoCodes: Array.from({ length: 10 }, (_, i) => `C${i}`) });
    expect(patchFromForm(form({ promo: 'ONE-MORE' }), many, off).errors.promo).toMatch(
      /at most 10/,
    );
    expect(patchFromForm(form({ promo: 'x'.repeat(61) }), c, off).errors.promo).toMatch(/too long/);
  });

  it('changes lines only where the merchant allows it, as a SKU and a quantity', () => {
    const c = checkout({
      lines: [
        { id: 'li_1', sku: 'MON-27', qty: 2 },
        { id: 'li_2', sku: 'CBL-1', qty: 1 },
      ],
    });
    const posted = form({ 'qty:li_1': '3', 'qty:li_2': '1' });
    expect(patchFromForm(posted, c, off).patch).not.toHaveProperty('lines');
    expect(patchFromForm(posted, c, { editLines: true }).patch.lines).toEqual([
      { id: 'li_1', sku: 'MON-27', qty: 3 },
      { id: 'li_2', sku: 'CBL-1', qty: 1 },
    ]);
    // Unchanged quantities ask for nothing; zero and Remove take a line out.
    expect(
      patchFromForm(form({ 'qty:li_1': '2', 'qty:li_2': '1' }), c, { editLines: true }).patch,
    ).toEqual({});
    expect(
      patchFromForm(form({ 'qty:li_1': '2', 'qty:li_2': '0' }), c, { editLines: true }).patch.lines,
    ).toEqual([{ id: 'li_1', sku: 'MON-27', qty: 2 }]);
    expect(
      patchFromForm(form({ 'qty:li_1': '2', 'qty:li_2': '1', removeLine: 'li_1' }), c, {
        editLines: true,
      }).patch.lines,
    ).toEqual([{ id: 'li_2', sku: 'CBL-1', qty: 1 }]);
    for (const bad of ['1.5', '-1', 'x', '10001'])
      expect(
        patchFromForm(form({ 'qty:li_1': bad, 'qty:li_2': '1' }), c, { editLines: true }).errors,
      ).toMatchObject({ 'qty:li_1': expect.stringContaining('quantity') });
    expect(
      patchFromForm(form({ 'qty:li_1': '0', 'qty:li_2': '0' }), c, { editLines: true }).errors
        .lines,
    ).toMatch(/at least one/);
  });

  it('echoes what was typed, without the version', () => {
    expect(valuesOf(form({ version: '3', email: 'a@b.c', remove: 'X' }))).toEqual({
      email: 'a@b.c',
      remove: 'X',
    });
  });
});

describe('issues by the section they are about', () => {
  const issue = (over: Partial<CheckoutIssue>): CheckoutIssue => ({
    kind: 'error',
    code: 'missing',
    content: 'x',
    ...over,
  });

  it('maps a path to a section, and a shared path by its code', () => {
    const cases: [Partial<CheckoutIssue>, string][] = [
      [{ path: '$.buyer.email' }, 'email'],
      [{ path: '$.buyer.phone' }, 'contact'],
      [{ path: '$.fulfillment', content: 'A complete shipping address is required.' }, 'address'],
      [{ path: '$.fulfillment', content: 'Choose a shipping option.' }, 'shipping'],
      [{ path: '$.fulfillment', code: 'fulfillment_option_unavailable' }, 'shipping'],
      [{ path: '$.fulfillment', code: 'pickup_unavailable' }, 'pickup'],
      [{ path: '$.line_items' }, 'lines'],
      [{ path: '$.promoCodes', kind: 'warning', code: 'promotion' }, 'promo'],
      [{ path: '$.payment', code: 'payment_failed' }, 'payment'],
      [{ path: '$', code: 'policy' }, 'general'],
      [{ code: 'expired', kind: 'info' }, 'general'],
    ];
    for (const [i, section] of cases) expect(sectionOf(issue(i)), JSON.stringify(i)).toBe(section);
  });

  it('holds back what is still to fill in until the buyer has tried to continue', () => {
    const issues = [
      issue({ path: '$.buyer.email', content: "The buyer's email is required." }),
      issue({ path: '$.fulfillment', content: 'A complete shipping address is required.' }),
      issue({ path: '$.line_items', code: 'item_unavailable', content: 'MON-27 is sold out.' }),
      issue({ kind: 'warning', code: 'promotion', path: '$.promoCodes', content: 'No such code.' }),
    ];
    const first = issuesBySection(issues, false);
    expect(first.fields).toEqual({});
    expect(first.address).toEqual([]);
    expect(first.lines).toEqual([{ kind: 'error', content: 'MON-27 is sold out.', todo: false }]);
    expect(first.promo).toEqual([{ kind: 'warning', content: 'No such code.', todo: false }]);
    const tried = issuesBySection(issues, true);
    // An issue that names an input is shown there, not again in its section.
    expect(tried.fields).toEqual({
      email: { kind: 'error', content: "The buyer's email is required.", todo: true },
    });
    expect(tried.email).toEqual([]);
    expect(tried.address).toHaveLength(1);
  });
});

describe('the total', () => {
  const rows = (q: ReturnType<typeof quote>) => totalRows(q).map((r) => [r.key, r.label, r.amount]);

  it('is the subtotal, shipping, tax and total of the quote', () => {
    expect(rows(quote())).toEqual([
      ['subtotal', 'Subtotal', 200],
      ['shipping', 'Shipping', 10],
      ['tax', 'Tax', 16.8],
      ['total', 'Total', 226.8],
    ]);
  });

  it('shows each discount off the list prices, and the subtotal before them', () => {
    const q = quote({
      lines: [
        {
          id: 'li_1',
          sku: 'MON-27',
          title: 'Monitor',
          qty: 2,
          unitPrice: 90,
          listPrice: 100,
          ships: true,
        },
      ],
      listSubtotal: 200,
      subtotal: 180,
      total: 206.8,
      discounts: {
        applied: [{ code: 'SAVE10', title: '10% off', kind: 'pct', amount: 20 }],
        refused: [],
      },
    });
    expect(totalRows(q).slice(0, 3)).toMatchObject([
      { key: 'subtotal', amount: 200 },
      { key: 'discount', label: '10% off', amount: -20, note: 'SAVE10' },
      { key: 'shipping', amount: 10 },
    ]);
  });

  it('adds nothing up itself: without the quote’s subtotal before discounts it shows its subtotal and no discount rows', () => {
    const q = quote({
      subtotal: 150,
      discounts: { applied: [{ code: 'X', title: 'Odd', kind: 'amount', amount: 5 }], refused: [] },
    });
    expect(rows(q)).toEqual([
      ['subtotal', 'Subtotal', 150],
      ['shipping', 'Shipping', 10],
      ['tax', 'Tax', 16.8],
      ['total', 'Total', 226.8],
    ]);
  });

  it('calls free shipping free, with the code, and shows no shipping for digital goods', () => {
    const free = totalRows(
      quote({
        shipping: 0,
        discounts: {
          applied: [
            { code: 'SHIPFREE', title: 'Free shipping', kind: 'free_shipping', amount: 10 },
          ],
          refused: [],
        },
      }),
    );
    expect(free.find((r) => r.key === 'shipping')).toMatchObject({ free: true, note: 'SHIPFREE' });
    expect(free.some((r) => r.key === 'discount')).toBe(false);
    expect(totalRows(quote({ ships: false, shipping: 0 })).some((r) => r.key === 'shipping')).toBe(
      false,
    );
  });
});

describe('promo codes and the shipping choice', () => {
  it('says which codes applied, which were refused and why, and which are not priced yet', () => {
    const c = checkout({
      promoCodes: ['save10', 'BOGUS', 'LATER'],
      quote: quote({
        discounts: {
          applied: [{ code: 'SAVE10', title: '10% off', kind: 'pct', amount: 20 }],
          refused: [{ code: 'BOGUS', reason: 'That code does not exist.' }],
        },
      }),
    });
    expect(codeStatuses(c)).toEqual([
      { code: 'save10', state: 'applied', title: '10% off' },
      { code: 'BOGUS', state: 'refused', reason: 'That code does not exist.' },
      { code: 'LATER', state: 'pending' },
    ]);
    expect(codeStatuses(checkout({ quote: null, promoCodes: undefined as never }))).toEqual([]);
  });

  it('chooses the session’s option, else the one the quote charged', () => {
    expect(chosenOption(checkout({ shippingOption: 'air' }))).toBe('air');
    expect(chosenOption(checkout())).toBe('ground');
    expect(chosenOption(checkout({ quote: null }))).toBeNull();
  });
});

describe('what an issue names, and when the buyer may act', () => {
  const at = (path: string): CheckoutIssue => ({
    kind: 'error',
    code: 'invalid',
    content: 'x',
    path,
  });

  it('maps a path to the input it is about', () => {
    expect(fieldOf(at('$.buyer.email'))).toBe('email');
    expect(fieldOf(at('$.buyer.phone'))).toBe('phone');
    expect(fieldOf(at('$.buyer.first_name'))).toBe('firstName');
    expect(fieldOf(at('$.fulfillment.methods[0].destinations[0].address.postal_code'))).toBe(
      'shipTo.postalCode',
    );
    expect(fieldOf(at('$.fulfillment.address.city'))).toBe('shipTo.city');
    expect(fieldOf(at('$.fulfillment'))).toBeNull();
    expect(fieldOf(at('$.line_items'))).toBeNull();
    expect(fieldOf({ kind: 'info', code: 'x', content: 'x' })).toBeNull();
  });

  it('lets the buyer act on an open checkout only', () => {
    expect(isOpen({ status: 'incomplete' })).toBe(true);
    expect(isOpen({ status: 'ready_for_complete' })).toBe(true);
    for (const status of [
      'requires_escalation',
      'complete_in_progress',
      'completed',
      'canceled',
    ] as const)
      expect(isOpen({ status }), status).toBe(false);
  });
});
