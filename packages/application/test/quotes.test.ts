import type { Company, CompanyMember } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import {
  InMemoryCompanyDirectory,
  InMemoryPricingStore,
  InMemoryPurchaseOrderStore,
  InMemoryQuoteStore,
  PRICING_FIXTURE,
  PriceBookData,
  QuoteData,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  acceptQuote,
  convertQuote,
  createQuote,
  declineQuote,
  expireQuote,
  getQuote,
  listQuotes,
  planConvertQuote,
  previewPrice,
  priceOrder,
  type QuoteOrderDeps,
  quoteFingerprint,
  reviseQuote,
  sendQuote,
  submitPo,
  updatePoDraft,
  updateQuote,
} from '../src/commerce';

const ALL = { all: true } as const;
const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;
/** A company the pricing fixture knows: gold tier, a contract price of 20 for PC-SKU-2. */
const ACME = 'pc_northwind';
const GLOBEX = 'pc_twin_b';
let n = 0;
const nextId = () => `qt_${++n}`;

const company = (id: string, over: Partial<Company> = {}): Company => ({
  customerId: id,
  status: 'active',
  legalName: `${id} Ltd`,
  taxId: null,
  parentCompanyId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const member = (
  id: string,
  companyId: string,
  over: Partial<CompanyMember> = {},
): CompanyMember => ({
  id,
  companyId,
  name: id,
  email: `${id}@example.test`,
  role: 'buyer',
  teamId: null,
  status: 'active',
  orderLimit: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function setup(companies: Company[] = [company(ACME), company(GLOBEX)]) {
  const data = new QuoteData();
  return {
    quotes: new InMemoryQuoteStore(data),
    purchaseOrders: new InMemoryPurchaseOrderStore(),
    pricing: new InMemoryPricingStore(
      PRICING_FIXTURE,
      new FixedClock(new Date(NOW)),
      new PriceBookData(),
      data,
    ),
    companies: new InMemoryCompanyDirectory({
      customers: PRICING_FIXTURE.customers,
      companies,
      members: [
        member('m_ann', ACME),
        member('m_off', ACME, { status: 'inactive' }),
        member('m_gx', GLOBEX),
      ],
    }),
  };
}
type Ports = ReturnType<typeof setup>;

const EXPIRES_ON = '2026-12-01';
const EXPIRES_AT = Date.parse(EXPIRES_ON) + DAY;

const quoteInput = (over: object = {}) => ({
  companyId: ACME,
  name: 'Spring deal',
  buyerId: 'm_ann',
  expiresOn: EXPIRES_ON,
  lines: [
    { sku: 'PC-SKU-2', qty: 50, unitPrice: 30 },
    { sku: 'PC-SKU-1', name: 'Tens', qty: 5, unitPrice: 4 },
  ],
  ...over,
});

async function draft(p: Ports, over: object = {}) {
  const r = await createQuote(p, ALL, quoteInput(over), nextId, NOW, 'usr_ada');
  if (!r.ok) throw new Error(r.error);
  return r.quote;
}
async function sent(p: Ports, over: object = {}) {
  const q = await draft(p, over);
  const r = await sendQuote(p, ALL, { quoteId: q.id }, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.quote;
}
async function accepted(p: Ports, over: object = {}) {
  const q = await sent(p, over);
  const r = await acceptQuote(p, ALL, { quoteId: q.id }, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.quote;
}

/** The engine's order start, recorded; once per key as the engine does it. */
function engine() {
  const started: Parameters<QuoteOrderDeps['start']>[0][] = [];
  const keys = new Map<string, string>();
  const deps: QuoteOrderDeps & { fail?: string } = {
    async start(req) {
      if (deps.fail) return { ok: false, error: deps.fail };
      started.push(req);
      const replayed = keys.has(req.key);
      const orderId = keys.get(req.key) ?? `ord_${keys.size + 1}`;
      keys.set(req.key, orderId);
      return { ok: true, orderId, replayed };
    },
  };
  return { deps, started };
}

const chain = { basis: 'auto', useContracts: true, usePriceRules: true } as const;
const priced = async (p: Ports, customerId: string, qty: number, now = NOW, sku = 'PC-SKU-2') => {
  const r = await priceOrder(
    p,
    { lines: [{ sku, qty }], currency: 'USD', customerId, model: 'b2b' },
    { ...chain, now },
  );
  return r.priced[0];
};

describe('drafting a quote', () => {
  it('saves a draft with each line’s list price, the expiry as the end of its day and an audit draft', async () => {
    const p = setup();
    const r = await createQuote(p, ALL, quoteInput(), nextId, NOW, 'usr_ada');
    if (!r.ok) throw new Error(r.error);
    expect(r.quote).toMatchObject({
      status: 'draft',
      version: 1,
      rootId: r.quote.id,
      expiresAt: EXPIRES_AT,
      createdBy: 'usr_ada',
      lines: [
        { sku: 'PC-SKU-2', name: 'Product PC-SKU-2', qty: 50, listPrice: 25, unitPrice: 30 },
        { sku: 'PC-SKU-1', name: 'Tens', qty: 5, listPrice: 10, unitPrice: 4 },
      ],
    });
    expect(r.audit).toEqual({
      action: 'quote.created',
      target: r.quote.id,
      detail: { company: ACME, name: 'Spring deal', lines: 2 },
    });
    expect(await p.quotes.get(ALL, r.quote.id)).toEqual(r.quote);
  });

  it('refuses what a quote can’t be: no lines, a SKU twice or unknown, a company or buyer that isn’t active', async () => {
    const p = setup([company(ACME), company(GLOBEX, { status: 'suspended' })]);
    const refused = async (over: object) => {
      const r = await createQuote(p, ALL, quoteInput(over), nextId, NOW, null);
      return r.ok ? null : r.error;
    };
    expect(await refused({ lines: [] })).toMatch(/lines/);
    expect(
      await refused({
        lines: [
          { sku: 'PC-SKU-1', qty: 1, unitPrice: 2 },
          { sku: 'PC-SKU-1', qty: 9, unitPrice: 1 },
        ],
      }),
    ).toBe('PC-SKU-1 is on the quote twice: a quote prices a SKU once.');
    expect(await refused({ lines: [{ sku: 'NOPE', qty: 1, unitPrice: 2 }] })).toBe(
      'No product has the SKU NOPE.',
    );
    expect(await refused({ companyId: GLOBEX, buyerId: null })).toMatch(
      /isn't active \(suspended\)/,
    );
    expect(await refused({ companyId: 'nobody' })).toMatch(/isn't a company/);
    expect(await refused({ buyerId: 'm_off' })).toMatch(/isn't an active member/);
    expect(await refused({ buyerId: 'm_gx' })).toMatch(/isn't an active member/);
    expect(await refused({ expiresOn: 'soon' })).toMatch(/expiresOn/);
    expect(await refused({ lines: [{ sku: 'PC-SKU-1', qty: 0, unitPrice: 2 }] })).toMatch(/qty/);
    expect(await refused({ lines: [{ sku: 'PC-SKU-1', qty: 1, unitPrice: -1 }] })).toMatch(
      /unitPrice/,
    );
    expect((await listQuotes(p, ALL, {})).total).toBe(0);
  });

  it('keeps no quote of another company in a company’s scope', async () => {
    const p = setup();
    const r = await createQuote(p, { companyId: GLOBEX }, quoteInput(), nextId, NOW, null);
    // The company directory's own scope refuses a company the caller isn't bound to.
    expect(r.ok).toBe(false);
  });
});

describe('editing a draft', () => {
  it('changes the header and the whole list of lines, and a repeat changes nothing', async () => {
    const p = setup();
    const q = await draft(p);
    const lines = [{ sku: 'PC-SKU-1', qty: 7, unitPrice: 3 }];
    const r = await updateQuote(
      p,
      ALL,
      { quoteId: q.id, name: 'Renamed', notes: 'Net 30', expiresOn: '2026-12-15', lines },
      NOW + 1,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.changed).toBe(true);
    expect(r.audit).toMatchObject({
      action: 'quote.updated',
      detail: { changed: ['name', 'expiry', 'notes', 'lines'] },
    });
    expect(await p.quotes.get(ALL, q.id)).toMatchObject({
      name: 'Renamed',
      notes: 'Net 30',
      expiresAt: Date.parse('2026-12-15') + DAY,
      updatedAt: NOW + 1,
      lines: [{ sku: 'PC-SKU-1', qty: 7, listPrice: 10, unitPrice: 3 }],
    });
    const again = await updateQuote(p, ALL, { quoteId: q.id, name: 'Renamed' }, NOW + 2);
    expect(again).toMatchObject({ ok: true, changed: false, audit: null });
  });

  it('is only for a draft: a sent quote points to revising, and a stale edit is refused', async () => {
    const p = setup();
    const q = await sent(p);
    const r = await updateQuote(p, ALL, { quoteId: q.id, name: 'Late' }, NOW);
    expect(r).toEqual({
      ok: false,
      error: 'Spring deal is sent: only a draft can be changed; revise it for a new version.',
    });
    // An edit planned on a draft that was sent before it landed is refused by the store.
    const d = await draft(p, { name: 'Other' });
    const write = p.quotes.updateDraft.bind(p.quotes);
    p.quotes.updateDraft = async (...args) => {
      await p.quotes.transition(ALL, d.id, 'draft', 'sent', NOW);
      return write(...args);
    };
    expect(await updateQuote(p, ALL, { quoteId: d.id, name: 'Stale' }, NOW)).toEqual({
      ok: false,
      error: 'Other was sent or ended meanwhile: only a draft can be changed.',
    });
    expect((await p.quotes.get(ALL, d.id))?.name).toBe('Other');
    expect(await updateQuote(p, ALL, { quoteId: 'qt_none', name: 'x' }, NOW)).toEqual({
      ok: false,
      error: 'No such quote.',
    });
  });

  it('refuses a draft edited into something it can’t be', async () => {
    const p = setup();
    const q = await draft(p);
    expect(
      await updateQuote(
        p,
        ALL,
        { quoteId: q.id, lines: [{ sku: 'NOPE', qty: 1, unitPrice: 1 }] },
        NOW,
      ),
    ).toMatchObject({ ok: false, error: 'No product has the SKU NOPE.' });
    expect(await updateQuote(p, ALL, { quoteId: q.id, buyerId: 'm_gx' }, NOW)).toMatchObject({
      ok: false,
    });
  });
});

describe('sending, accepting and declining', () => {
  it('sends a draft once, stamping it, and a repeat sends nothing new', async () => {
    const p = setup();
    const q = await draft(p);
    const r = await sendQuote(p, ALL, { quoteId: q.id }, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.quote).toMatchObject({ status: 'sent', sentAt: NOW });
    expect(r.audit).toMatchObject({ action: 'quote.sent', detail: { version: 1 } });
    expect(await sendQuote(p, ALL, { quoteId: q.id }, NOW + 5)).toMatchObject({
      ok: true,
      changed: false,
      audit: null,
    });
  });

  it('needs an expiry ahead, and the company and buyer still good', async () => {
    const p = setup();
    const noExpiry = await draft(p, { expiresOn: null, name: 'No expiry' });
    expect(await sendQuote(p, ALL, { quoteId: noExpiry.id }, NOW)).toEqual({
      ok: false,
      error: 'A quote needs an expiry before it is sent.',
    });
    const past = await draft(p, { expiresOn: '2026-11-01', name: 'Past' });
    expect(await sendQuote(p, ALL, { quoteId: past.id }, NOW)).toEqual({
      ok: false,
      error: 'The quote’s expiry has passed.',
    });
    const q = await draft(p, { name: 'Suspended since' });
    const late = setup([company(ACME, { status: 'suspended' }), company(GLOBEX)]);
    await late.quotes.create({ ...q, lines: undefined } as never, q.lines);
    expect(await sendQuote(late, ALL, { quoteId: q.id }, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/isn't active/),
    });
  });

  it('accepts a sent quote, and an accept again is a repeat', async () => {
    const p = setup();
    const q = await sent(p);
    const r = await acceptQuote(p, ALL, { quoteId: q.id, note: 'By phone' }, NOW + 10);
    if (!r.ok) throw new Error(r.error);
    expect(r.quote).toMatchObject({ status: 'accepted', decidedAt: NOW + 10 });
    expect(r.audit).toMatchObject({
      action: 'quote.accepted',
      detail: { note: 'By phone', expiresAt: EXPIRES_AT },
    });
    expect(await acceptQuote(p, ALL, { quoteId: q.id }, NOW + 20)).toMatchObject({
      ok: true,
      changed: false,
      audit: null,
    });
  });

  it('refuses to accept a draft, a declined quote or one past its expiry, and makes the lapse official', async () => {
    const p = setup();
    const d = await draft(p);
    expect(await acceptQuote(p, ALL, { quoteId: d.id }, NOW)).toEqual({
      ok: false,
      error: 'Spring deal is draft: only a sent quote can be accepted.',
    });
    const s = await sent(p, { name: 'Lapses' });
    expect(await acceptQuote(p, ALL, { quoteId: s.id }, EXPIRES_AT)).toEqual({
      ok: false,
      error: 'Lapses has expired.',
    });
    expect((await p.quotes.get(ALL, s.id))?.status).toBe('expired');
    const no = await sent(p, { name: 'No thanks' });
    await declineQuote(p, ALL, { quoteId: no.id }, NOW);
    expect(await acceptQuote(p, ALL, { quoteId: no.id }, NOW)).toMatchObject({ ok: false });
  });

  it('lets one of an accept and a decline racing from sent win, and tells the other where it stands', async () => {
    const p = setup();
    const q = await sent(p);
    const [a, b] = await Promise.all([
      acceptQuote(p, ALL, { quoteId: q.id }, NOW),
      declineQuote(p, ALL, { quoteId: q.id }, NOW),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({
      ok: false,
      error: expect.stringMatching(/ now, so it can’t be /),
    });
  });

  it('declines a sent quote or withdraws a draft, and not one that is accepted', async () => {
    const p = setup();
    const q = await sent(p);
    const r = await declineQuote(p, ALL, { quoteId: q.id, reason: 'Too dear' }, NOW);
    expect(r).toMatchObject({
      ok: true,
      quote: { status: 'declined', decidedAt: NOW },
      audit: { action: 'quote.declined', detail: { reason: 'Too dear' } },
    });
    expect(await declineQuote(p, ALL, { quoteId: q.id }, NOW)).toMatchObject({
      ok: true,
      changed: false,
    });
    const d = await draft(p, { name: 'Withdrawn' });
    expect(await declineQuote(p, ALL, { quoteId: d.id }, NOW)).toMatchObject({
      ok: true,
      quote: { status: 'declined' },
    });
    const a = await accepted(p, { name: 'Deal' });
    expect(await declineQuote(p, ALL, { quoteId: a.id }, NOW)).toMatchObject({ ok: false });
  });
});

describe('revising into versions', () => {
  it('supersedes the old version with the next as a draft carrying its lines, and the old one is read-only', async () => {
    const p = setup();
    const v1 = await sent(p);
    const r = await reviseQuote(p, ALL, { quoteId: v1.id }, nextId, NOW + 1, 'usr_bo');
    if (!r.ok) throw new Error(r.error);
    expect(r.quote).toMatchObject({
      rootId: v1.id,
      version: 2,
      status: 'draft',
      // Its expiry still ahead, so it stays.
      expiresAt: EXPIRES_AT,
      createdBy: 'usr_bo',
      sentAt: null,
      lines: v1.lines,
    });
    expect(r.audit).toMatchObject({
      action: 'quote.revised',
      detail: { from: v1.id, version: 2 },
    });
    expect((await p.quotes.get(ALL, v1.id))?.status).toBe('superseded');
    // The old version is read-only: no edit, send, accept or revision.
    expect(await updateQuote(p, ALL, { quoteId: v1.id, name: 'x' }, NOW)).toMatchObject({
      ok: false,
    });
    expect(await sendQuote(p, ALL, { quoteId: v1.id }, NOW)).toMatchObject({ ok: false });
    expect(await acceptQuote(p, ALL, { quoteId: v1.id }, NOW)).toMatchObject({ ok: false });
    // The list shows where the negotiation stands; the versions are on the quote.
    expect((await listQuotes(p, ALL, {})).quotes.map((x) => x.id)).toEqual([r.quote.id]);
    const got = await getQuote(p, ALL, r.quote.id);
    if (!got.ok) throw new Error(got.error);
    expect(got.quote.versions).toEqual([
      { id: v1.id, version: 1, status: 'superseded' },
      { id: r.quote.id, version: 2, status: 'draft' },
    ]);
  });

  it('revises a declined or expired quote, and clears an expiry that has passed', async () => {
    const p = setup();
    const q = await sent(p, { name: 'Declined' });
    await declineQuote(p, ALL, { quoteId: q.id }, NOW);
    expect(await reviseQuote(p, ALL, { quoteId: q.id }, nextId, NOW, null)).toMatchObject({
      ok: true,
      quote: { version: 2 },
    });
    const lapsed = await sent(p, { name: 'Lapsed' });
    await expireQuote(p, ALL, { quoteId: lapsed.id }, NOW);
    const r = await reviseQuote(p, ALL, { quoteId: lapsed.id }, nextId, EXPIRES_AT + 1, null);
    expect(r).toMatchObject({ ok: true, quote: { version: 2, expiresAt: null } });
  });

  it('revises an accepted quote that has lapsed, making the lapse official first', async () => {
    const p = setup();
    const a = await accepted(p, { name: 'Lapsed deal' });
    const r = await reviseQuote(p, ALL, { quoteId: a.id }, nextId, EXPIRES_AT + 1, null);
    expect(r).toMatchObject({ ok: true, changed: true, quote: { version: 2, expiresAt: null } });
    expect((await p.quotes.get(ALL, a.id))?.status).toBe('superseded');
    // Still in force, it is a deal that has to be ended first.
    const live = await accepted(p, { name: 'Live deal' });
    expect(await reviseQuote(p, ALL, { quoteId: live.id }, nextId, NOW, null)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/end it first/),
    });
  });

  it('checks the company again at accept, as at send', async () => {
    const p = setup();
    const q = await sent(p);
    p.companies = new InMemoryCompanyDirectory({
      customers: PRICING_FIXTURE.customers,
      companies: [company(ACME, { status: 'suspended' }), company(GLOBEX)],
      members: [member('m_ann', ACME)],
    });
    expect(await acceptQuote(p, ALL, { quoteId: q.id }, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/isn't active \(suspended\)/),
    });
    expect((await p.quotes.get(ALL, q.id))?.status).toBe('sent');
  });

  it('sends only the draft the person confirmed', async () => {
    const p = setup();
    const q = await draft(p);
    const shown = quoteFingerprint(q);
    await updateQuote(p, ALL, { quoteId: q.id, notes: 'Changed after the card' }, NOW);
    expect(await sendQuote(p, ALL, { quoteId: q.id, heldTo: shown }, NOW)).toEqual({
      ok: false,
      error: 'Spring deal has changed since it was shown to you: look at it again.',
    });
    expect((await p.quotes.get(ALL, q.id))?.status).toBe('draft');
    const now = (await p.quotes.get(ALL, q.id))!;
    expect(
      await sendQuote(p, ALL, { quoteId: q.id, heldTo: quoteFingerprint(now) }, NOW),
    ).toMatchObject({
      ok: true,
      changed: true,
    });
  });

  it('won’t revise a draft, an accepted deal or a superseded quote with no successor', async () => {
    const p = setup();
    const d = await draft(p);
    expect(await reviseQuote(p, ALL, { quoteId: d.id }, nextId, NOW, null)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/only a sent, declined or expired quote can be revised/),
    });
    const a = await accepted(p, { name: 'Deal' });
    expect(await reviseQuote(p, ALL, { quoteId: a.id }, nextId, NOW, null)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/an accepted quote is a deal; end it first/),
    });
  });

  it('makes one version of two revisions racing, and a repeat finds the same one', async () => {
    const p = setup();
    const v1 = await sent(p);
    const results = await Promise.all([
      reviseQuote(p, ALL, { quoteId: v1.id }, nextId, NOW, null),
      reviseQuote(p, ALL, { quoteId: v1.id }, nextId, NOW, null),
    ]);
    // Both are answered with the one version 2; only one of them made it.
    expect(results.every((r) => r.ok)).toBe(true);
    const [a, b] = results.map((r) => (r.ok ? r.quote.id : ''));
    expect(a).toBe(b);
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(1);
    expect((await listQuotes(p, ALL, { rootId: v1.id })).total).toBe(2);
    const again = await reviseQuote(p, ALL, { quoteId: v1.id }, nextId, NOW, null);
    expect(again).toMatchObject({ ok: true, changed: false, audit: null, quote: { id: a } });
  });
});

describe('pricing from an accepted quote', () => {
  it('prices the company’s orders at the quoted price, ahead of its contract price, up to each line’s quantity', async () => {
    const p = setup();
    const before = await priced(p, ACME, 10);
    // The contract price (20) is the lowest the chain finds without a quote.
    expect(before).toMatchObject({ unitPrice: 20, by: 'contract' });
    const q = await accepted(p);
    const quoted = await priced(p, ACME, 10);
    expect(quoted).toMatchObject({ unitPrice: 30, by: 'quote', rule: 'Quote Spring deal' });
    // Right up to the quantity it was agreed for, and not a unit past it.
    expect(await priced(p, ACME, 50)).toMatchObject({ unitPrice: 30, by: 'quote' });
    expect(await priced(p, ACME, 51)).toMatchObject({ unitPrice: 20, by: 'contract' });
    // The other line's SKU is quoted too, against its book price.
    expect(await priced(p, ACME, 5, NOW, 'PC-SKU-1')).toMatchObject({ unitPrice: 4, by: 'quote' });
    expect(q.status).toBe('accepted');
  });

  it('shows in a price preview, naming the quote', async () => {
    const p = setup();
    await accepted(p);
    const r = await previewPrice(
      p,
      { customerId: ACME, lines: [{ sku: 'PC-SKU-2', qty: 10 }] },
      NOW,
    );
    expect(r).toMatchObject({
      ok: true,
      lines: [
        {
          sku: 'PC-SKU-2',
          listPrice: 25,
          unitPrice: 30,
          source: 'quote',
          name: 'Quote Spring deal',
        },
      ],
    });
  });

  it('isn’t for another company, a buyer with no customer or a flow that turns contracts off', async () => {
    const p = setup();
    await accepted(p);
    expect(await priced(p, GLOBEX, 10)).toMatchObject({ by: 'list' });
    const none = await priceOrder(
      p,
      {
        lines: [{ sku: 'PC-SKU-2', qty: 10 }],
        currency: 'USD',
        customerId: undefined,
        model: 'b2b',
      },
      { ...chain, now: NOW },
    );
    expect(none.priced[0]).toMatchObject({ by: 'list' });
    const off = await priceOrder(
      p,
      { lines: [{ sku: 'PC-SKU-2', qty: 10 }], currency: 'USD', customerId: ACME, model: 'b2b' },
      { ...chain, useContracts: false, now: NOW },
    );
    expect(off.priced[0]).toMatchObject({ unitPrice: 25, by: 'list' });
  });

  it('is in force only while accepted and before its expiry', async () => {
    const p = setup();
    const draftQuote = await draft(p, { name: 'Still a draft' });
    expect(await priced(p, ACME, 10)).toMatchObject({ by: 'contract' });
    await sendQuote(p, ALL, { quoteId: draftQuote.id }, NOW);
    // Sent isn't accepted: nothing prices from it yet.
    expect(await priced(p, ACME, 10)).toMatchObject({ by: 'contract' });
    await acceptQuote(p, ALL, { quoteId: draftQuote.id }, NOW);
    expect(await priced(p, ACME, 10)).toMatchObject({ by: 'quote' });
    // The last instant before it expires still counts; the expiry itself doesn't.
    expect(await priced(p, ACME, 10, EXPIRES_AT - 1)).toMatchObject({ by: 'quote' });
    expect(await priced(p, ACME, 10, EXPIRES_AT)).toMatchObject({ by: 'contract' });
  });

  it('stops when the quote is ended, and when it is declined it never started', async () => {
    const p = setup();
    const q = await accepted(p);
    expect(await priced(p, ACME, 10)).toMatchObject({ by: 'quote' });
    const ended = await expireQuote(p, ALL, { quoteId: q.id }, NOW + 1);
    expect(ended).toMatchObject({
      ok: true,
      quote: { status: 'expired' },
      audit: { detail: { was: 'accepted' } },
    });
    expect(await priced(p, ACME, 10)).toMatchObject({ by: 'contract' });
    expect(await expireQuote(p, ALL, { quoteId: q.id }, NOW + 2)).toMatchObject({
      ok: true,
      changed: false,
    });
    const declined = await sent(p, { name: 'Declined' });
    await declineQuote(p, ALL, { quoteId: declined.id }, NOW);
    expect(await priced(p, ACME, 10)).toMatchObject({ by: 'contract' });
  });

  it('takes the lowest of two quotes for a SKU, and a revision’s price replaces the old version’s', async () => {
    const p = setup();
    await accepted(p, { name: 'First' });
    await accepted(p, {
      name: 'Second',
      lines: [{ sku: 'PC-SKU-2', qty: 50, unitPrice: 28 }],
    });
    expect(await priced(p, ACME, 10)).toMatchObject({ unitPrice: 28, rule: 'Quote Second' });
  });
});

describe('converting an accepted quote', () => {
  it('goes to a PO draft when the company uses POs, carrying the quote’s prices and its id', async () => {
    const p = setup();
    const q = await accepted(p);
    // The company has a purchase order, so it uses them (D7).
    await p.purchaseOrders.create(
      {
        id: 'po_old',
        companyId: ACME,
        buyerId: null,
        poNumber: 'OLD-1',
        status: 'cancelled',
        currency: 'USD',
        shipTo: null,
        notes: null,
        quoteId: null,
        orderId: null,
        source: 'app',
        createdAt: 1,
        updatedAt: 1,
      },
      [],
    );
    const { deps, started } = engine();
    const r = await convertQuote(p, ALL, { quoteId: q.id }, deps, NOW + 1);
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ changed: true, to: 'po', resultId: `po_${q.id}` });
    expect(r.audit).toMatchObject({
      action: 'quote.converted',
      detail: { to: 'po', result: `po_${q.id}` },
    });
    const po = await p.purchaseOrders.get(ALL, `po_${q.id}`);
    expect(po).toMatchObject({
      status: 'draft',
      quoteId: q.id,
      buyerId: 'm_ann',
      currency: 'USD',
      poNumber: `Q-${q.id.replace(/^qt_/, '').toUpperCase()}-V1`,
      lines: [
        { sku: 'PC-SKU-2', qty: 50, unitPrice: 30 },
        { sku: 'PC-SKU-1', name: 'Tens', qty: 5, unitPrice: 4 },
      ],
    });
    expect(started).toEqual([]);
    expect(await p.quotes.get(ALL, q.id)).toMatchObject({
      status: 'accepted',
      convertedTo: 'po',
      convertedId: `po_${q.id}`,
    });
    // It still prices, so the PO that comes of it is priced at the quote.
    expect(await priced(p, ACME, 10)).toMatchObject({ by: 'quote' });
  });

  it('goes straight to an order when the company has no POs, started once per quote, unpriced so the chain prices it', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps, started } = engine();
    const r = await convertQuote(p, ALL, { quoteId: q.id }, deps, NOW + 1);
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ changed: true, to: 'order', resultId: 'ord_1' });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      key: `quote:${q.id}`,
      flowId: 'tpl-b2b-order',
      input: {
        model: 'b2b',
        customerId: ACME,
        currency: 'USD',
        meta: { quoteId: q.id, buyerId: 'm_ann' },
        lines: [
          { sku: 'PC-SKU-2', qty: 50, name: 'Product PC-SKU-2' },
          { sku: 'PC-SKU-1', qty: 5, name: 'Tens' },
        ],
      },
    });
    // No line carries a price, or the quote wouldn't be what prices it.
    expect(started[0]?.input.lines.every((l) => !('unitPrice' in l))).toBe(true);
    expect(await p.purchaseOrders.get(ALL, `po_${q.id}`)).toBeUndefined();
  });

  it('can be told where to go, and which PO number a draft takes', async () => {
    const p = setup();
    const a = await accepted(p, { name: 'A' });
    const { deps } = engine();
    const r = await convertQuote(p, ALL, { quoteId: a.id, to: 'po', poNumber: 'PO-77' }, deps, NOW);
    expect(r).toMatchObject({ ok: true, to: 'po' });
    expect((await p.purchaseOrders.get(ALL, `po_${a.id}`))?.poNumber).toBe('PO-77');
  });

  it('is idempotent: converting again, or after a crash before it was recorded, makes nothing new', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps, started } = engine();
    const first = await convertQuote(p, ALL, { quoteId: q.id, to: 'order' }, deps, NOW + 1);
    const again = await convertQuote(p, ALL, { quoteId: q.id }, deps, NOW + 99);
    expect(first).toMatchObject({ ok: true, changed: true, resultId: 'ord_1' });
    expect(again).toMatchObject({
      ok: true,
      changed: false,
      to: 'order',
      resultId: 'ord_1',
      audit: null,
    });
    expect(started).toHaveLength(1);
    // Even asked for the other target: the first conversion stands.
    expect(await convertQuote(p, ALL, { quoteId: q.id, to: 'po' }, deps, NOW + 100)).toMatchObject({
      ok: true,
      changed: false,
      to: 'order',
    });
    expect((await p.purchaseOrders.list(ALL, {}, { limit: 5 })).total).toBe(0);

    // A conversion that made its PO draft and stopped before recording it carries on with it.
    const crashed = await accepted(p, { name: 'Crashed' });
    await p.purchaseOrders.create(
      {
        id: `po_${crashed.id}`,
        companyId: ACME,
        buyerId: 'm_ann',
        poNumber: 'WHATEVER',
        status: 'draft',
        currency: 'USD',
        shipTo: null,
        notes: null,
        quoteId: crashed.id,
        orderId: null,
        source: 'api',
        createdAt: 1,
        updatedAt: 1,
      },
      [],
    );
    const resumed = await convertQuote(p, ALL, { quoteId: crashed.id, to: 'po' }, deps, NOW);
    expect(resumed).toMatchObject({ ok: true, changed: true, resultId: `po_${crashed.id}` });
    expect((await p.purchaseOrders.list(ALL, { companyId: ACME }, { limit: 9 })).total).toBe(1);
  });

  it('makes one result of two conversions racing, and refuses the one that lost with where it went', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps, started } = engine();
    const [a, b] = await Promise.all([
      convertQuote(p, ALL, { quoteId: q.id, to: 'order' }, deps, NOW),
      convertQuote(p, ALL, { quoteId: q.id, to: 'po' }, deps, NOW),
    ]);
    const won = [a, b].filter((r) => r.ok && r.changed);
    expect(won).toHaveLength(1);
    const lost = [a, b].find((r) => !(r.ok && r.changed));
    expect(lost).toMatchObject({
      ok: false,
      error: expect.stringMatching(/was converted meanwhile/),
    });
    const q2 = await p.quotes.get(ALL, q.id);
    // Whatever the loser made beyond the record is the first start's or a draft nobody linked.
    expect(q2?.convertedId).toBeTruthy();
    expect(
      started.length + (await p.purchaseOrders.list(ALL, {}, { limit: 5 })).total,
    ).toBeGreaterThanOrEqual(1);
  });

  it('refuses a quote that isn’t accepted, one that has expired and a PO number the company has', async () => {
    const p = setup();
    const { deps } = engine();
    const s = await sent(p);
    expect(await convertQuote(p, ALL, { quoteId: s.id }, deps, NOW)).toEqual({
      ok: false,
      error: 'Only an accepted quote can be converted (this one is sent).',
    });
    const a = await accepted(p, { name: 'Late' });
    expect(await convertQuote(p, ALL, { quoteId: a.id }, deps, EXPIRES_AT)).toEqual({
      ok: false,
      error: 'The quote has expired.',
    });
    const b = await accepted(p, { name: 'Clash' });
    await p.purchaseOrders.create(
      {
        id: 'po_taken',
        companyId: ACME,
        buyerId: null,
        poNumber: 'PO-1',
        status: 'draft',
        currency: 'USD',
        shipTo: null,
        notes: null,
        quoteId: null,
        orderId: null,
        source: 'app',
        createdAt: 1,
        updatedAt: 1,
      },
      [],
    );
    expect(
      await convertQuote(p, ALL, { quoteId: b.id, poNumber: 'po-1' }, deps, NOW),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/has the number po-1/),
    });
    expect((await p.quotes.get(ALL, b.id))?.convertedId).toBeNull();
    // An order that didn't start leaves the quote unconverted, to try again.
    deps.fail = 'No such flow';
    expect(await convertQuote(p, ALL, { quoteId: b.id, to: 'order' }, deps, NOW)).toEqual({
      ok: false,
      error: 'Clash’s order didn’t start: No such flow',
    });
    // The quote stays claimed for its order, so asking again starts that same order.
    expect((await p.quotes.get(ALL, b.id))?.convertedId).toBe(`quote:${b.id}`);
    deps.fail = undefined;
    expect(await convertQuote(p, ALL, { quoteId: b.id, to: 'order' }, deps, NOW)).toMatchObject({
      ok: true,
      changed: true,
    });
  });

  it('records the order the claim became, so the quote names the order and not its start key', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps } = engine();
    await convertQuote(p, ALL, { quoteId: q.id, to: 'order' }, deps, NOW);
    expect((await p.quotes.get(ALL, q.id))?.convertedId).toBe('ord_1');
  });

  it('makes nothing for a quote that is ended, or accepted no more, between the read and the claim', async () => {
    for (const to of ['order', 'po'] as const) {
      const p = setup();
      const q = await accepted(p, { name: `Racing ${to}` });
      const { deps, started } = engine();
      // The quote is ended after the call read it and before it claims it.
      const claim = p.quotes.markConverted.bind(p.quotes);
      p.quotes.markConverted = async (...args) => {
        await expireQuote(p, ALL, { quoteId: q.id }, NOW);
        return claim(...args);
      };
      const r = await convertQuote(p, ALL, { quoteId: q.id, to }, deps, NOW);
      expect(r, to).toEqual({
        ok: false,
        error: `Racing ${to} is expired: it can’t be converted.`,
      });
      // No order started, no draft made, nothing recorded.
      expect(started, to).toEqual([]);
      expect(await p.purchaseOrders.get(ALL, `po_${q.id}`), to).toBeUndefined();
      expect((await p.quotes.get(ALL, q.id))?.convertedId, to).toBeNull();
    }
  });

  it('refuses a PO draft that was cancelled, and one cancelled as it was made, rather than hand it back', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps } = engine();
    const first = await convertQuote(p, ALL, { quoteId: q.id, to: 'po' }, deps, NOW);
    expect(first).toMatchObject({ ok: true, changed: true });
    await p.purchaseOrders.transition(ALL, `po_${q.id}`, 'draft', 'cancelled', NOW);
    const again = await convertQuote(p, ALL, { quoteId: q.id }, deps, NOW);
    expect(again).toMatchObject({
      ok: false,
      error: expect.stringMatching(/was cancelled: end the quote and revise it/),
    });

    // A cancel landing right after the draft is created, before the call looks again.
    const r = setup();
    const q2 = await accepted(r, { name: 'Cancelled in flight' });
    const make = r.purchaseOrders.create.bind(r.purchaseOrders);
    r.purchaseOrders.create = async (po, lines) => {
      const res = await make(po, lines);
      await r.purchaseOrders.transition(ALL, po.id, 'draft', 'cancelled', NOW);
      return res;
    };
    expect(await convertQuote(r, ALL, { quoteId: q2.id, to: 'po' }, deps, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/was cancelled/),
    });
  });

  it('carries on with the claim of a conversion that stopped before its draft was made', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps } = engine();
    // The claim is recorded; the draft never was.
    await p.quotes.markConverted(ALL, q.id, 'po', `po_${q.id}`, NOW);
    const r = await convertQuote(p, ALL, { quoteId: q.id }, deps, NOW);
    expect(r).toMatchObject({ ok: true, changed: true, resultId: `po_${q.id}` });
    expect(await p.purchaseOrders.get(ALL, `po_${q.id}`)).toMatchObject({ status: 'draft' });
    // Finished once: the next call is a repeat.
    expect(await convertQuote(p, ALL, { quoteId: q.id }, deps, NOW)).toMatchObject({
      changed: false,
    });
  });

  it('refuses to finish an order start once the quote has expired, and says so in the plan', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps, started } = engine();
    // Claimed for an order that never started.
    await p.quotes.markConverted(ALL, q.id, 'order', `quote:${q.id}`, NOW);
    expect(await planConvertQuote(p, ALL, { quoteId: q.id }, NOW)).toMatchObject({
      ok: true,
      repeat: true,
      resume: true,
    });
    const late = await convertQuote(p, ALL, { quoteId: q.id }, deps, EXPIRES_AT);
    expect(late).toEqual({
      ok: false,
      error: 'The quote has expired, so the order it was converting to would not be priced at it.',
    });
    expect(started).toEqual([]);
    // While it is live, the same claim is finished and reported once.
    const done = await convertQuote(p, ALL, { quoteId: q.id }, deps, NOW);
    expect(done).toMatchObject({ ok: true, changed: true, resultId: 'ord_1' });
    expect(started[0]).toMatchObject({ resumed: true });
  });

  it('reports and audits a conversion once when two calls race to the same target', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps } = engine();
    const rs = await Promise.all([
      convertQuote(p, ALL, { quoteId: q.id, to: 'po' }, deps, NOW),
      convertQuote(p, ALL, { quoteId: q.id, to: 'po' }, deps, NOW),
    ]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && r.changed && r.audit)).toHaveLength(1);
    expect(rs.map((r) => (r.ok ? r.resultId : ''))).toEqual([`po_${q.id}`, `po_${q.id}`]);
  });

  it('answers a conversion that a racing call settled to its order as a repeat, not a refusal', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps } = engine();
    const claim = p.quotes.markConverted.bind(p.quotes);
    let raced = false;
    p.quotes.markConverted = async (...args) => {
      if (!raced) {
        raced = true;
        // Another call converts the quote, start and settle, before this one claims.
        await convertQuote(p, ALL, { quoteId: q.id, to: 'order' }, deps, NOW);
      }
      return claim(...args);
    };
    const r = await convertQuote(p, ALL, { quoteId: q.id, to: 'order' }, deps, NOW);
    expect(r).toMatchObject({
      ok: true,
      changed: false,
      to: 'order',
      resultId: 'ord_1',
      audit: null,
    });
  });

  it('lets a PO retry take another number when the first was taken between claim and draft', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps } = engine();
    // The claim is recorded, then the number is taken by another PO before the draft is made.
    await p.quotes.markConverted(ALL, q.id, 'po', `po_${q.id}`, NOW);
    await p.purchaseOrders.create(
      {
        id: 'po_other',
        companyId: ACME,
        buyerId: null,
        poNumber: 'TAKEN',
        status: 'draft',
        currency: 'USD',
        shipTo: null,
        notes: null,
        quoteId: null,
        orderId: null,
        source: 'app',
        createdAt: 1,
        updatedAt: 1,
      },
      [],
    );
    expect(
      await convertQuote(p, ALL, { quoteId: q.id, poNumber: 'taken' }, deps, NOW),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/has the number taken/),
    });
    expect(
      await convertQuote(p, ALL, { quoteId: q.id, poNumber: 'FRESH-1' }, deps, NOW),
    ).toMatchObject({
      ok: true,
      changed: true,
      resultId: `po_${q.id}`,
    });
    expect((await p.purchaseOrders.get(ALL, `po_${q.id}`))?.poNumber).toBe('FRESH-1');
  });

  it('won’t let a PO made from a quote go to its order once the quote is no longer in force, until its quote is cleared', async () => {
    const p = setup();
    const q = await accepted(p);
    const { deps } = engine();
    await convertQuote(p, ALL, { quoteId: q.id, to: 'po' }, deps, NOW);
    const poDeps = {
      start: async () => ({ ok: true as const, orderId: 'ord_p', replayed: false }),
      cancel: async () => ({ ok: true as const, outcome: 'cancelled' as const }),
    };
    await expireQuote(p, ALL, { quoteId: q.id }, NOW + 1);
    const refused = await submitPo(p, ALL, { poId: `po_${q.id}` }, poDeps, NOW + 2);
    expect(refused).toEqual({
      ok: false,
      error: expect.stringMatching(
        /no longer in force \(expired\).*Clear the quote from the draft/,
      ),
    });
    expect((await p.purchaseOrders.get(ALL, `po_${q.id}`))?.status).toBe('draft');
    // A quote still in force goes through, and so does a draft with its quote cleared.
    const live = await accepted(p, { name: 'Live' });
    await convertQuote(p, ALL, { quoteId: live.id, to: 'po' }, deps, NOW);
    expect(await submitPo(p, ALL, { poId: `po_${live.id}` }, poDeps, NOW + 3)).toMatchObject({
      ok: true,
    });
    expect(
      await updatePoDraft(p, ALL, { poId: `po_${q.id}`, quoteId: null }, NOW + 4),
    ).toMatchObject({ ok: true });
    expect(await submitPo(p, ALL, { poId: `po_${q.id}` }, poDeps, NOW + 5)).toMatchObject({
      ok: true,
    });
  });

  it('shows the plan: where it would go, and that a repeat goes nowhere new', async () => {
    const p = setup();
    const q = await accepted(p);
    expect(await planConvertQuote(p, ALL, { quoteId: q.id }, NOW)).toMatchObject({
      ok: true,
      to: 'order',
      repeat: false,
    });
    const { deps } = engine();
    await convertQuote(p, ALL, { quoteId: q.id }, deps, NOW);
    expect(await planConvertQuote(p, ALL, { quoteId: q.id }, EXPIRES_AT + DAY)).toMatchObject({
      ok: true,
      repeat: true,
    });
  });
});

describe('reading quotes', () => {
  it('pages newest first with a cursor, and refuses one a page didn’t return', async () => {
    const p = setup();
    for (const [i, name] of ['One', 'Two', 'Three'].entries())
      await createQuote(p, ALL, quoteInput({ name }), nextId, NOW + i, null);
    const first = await listQuotes(p, ALL, { limit: 2 });
    if (!first.ok) throw new Error(first.error);
    expect(first.quotes.map((q) => q.name)).toEqual(['Three', 'Two']);
    expect(first).toMatchObject({ total: 3, cursor: expect.any(String) });
    expect(first.quotes[0]).toMatchObject({
      lineCount: 2,
      total: 50 * 30 + 5 * 4,
      href: expect.stringMatching(/^\/quotes\/qt_/),
    });
    const second = await listQuotes(p, ALL, { limit: 2, cursor: first.cursor ?? undefined });
    expect(second).toMatchObject({ ok: true, cursor: null });
    expect(await listQuotes(p, ALL, { cursor: 'nonsense' })).toEqual({
      ok: false,
      error: 'That cursor isn’t one a page returned.',
    });
    expect((await listQuotes(p, ALL, { search: 'tw' })).total).toBe(1);
  });

  it('holds a company’s scope to its own quotes', async () => {
    const p = setup();
    const mine = await draft(p, { companyId: GLOBEX, buyerId: 'm_gx', name: 'Globex' });
    await draft(p, { name: 'Acme' });
    const scope = { companyId: ACME } as const;
    expect((await listQuotes(p, scope, {})).total).toBe(1);
    expect(await getQuote(p, scope, mine.id)).toEqual({ ok: false, error: 'No such quote.' });
    expect(await sendQuote(p, scope, { quoteId: mine.id }, NOW)).toEqual({
      ok: false,
      error: 'No such quote.',
    });
    expect(await acceptQuote(p, scope, { quoteId: mine.id }, NOW)).toMatchObject({ ok: false });
    expect(await reviseQuote(p, scope, { quoteId: mine.id }, nextId, NOW, null)).toMatchObject({
      ok: false,
    });
    expect((await p.quotes.get(ALL, mine.id))?.status).toBe('draft');
  });
});
