/**
 * Negotiated quotes in the engine (docs/b2b.md, S7), on real Workflows and the B2B flows
 * themselves: a quote is drafted, sent, accepted and converted through the tools REST and MCP
 * run; an accepted quote is what the company's orders are priced at (the pricing chain's `quote`
 * source, ahead of every other), until it ends or past the quantity it covers; and a PO draft
 * made from a quote submits through the PO flow like any other, priced at the quote.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { type OrderState, operationCall, type Role, type RpcActor } from '@commerceworker/core';
import { createDb, customers, orders, products } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { previewAction, runAction } from '../src/assistant/data';
import { ensureTemplates } from '../src/flows';
import { startOrderOnce } from '../src/orders';
import { companyDirectory, purchaseOrderStore, quoteStore } from '../src/wire';
import { signedActor } from './principal';

const ALL = { all: true } as const;
const db = () => createDb(env.DB);
const dir = () => companyDirectory(env);
const pos = () => purchaseOrderStore(env);
const quotes = () => quoteStore(env);
const suffix = () => crypto.randomUUID().slice(0, 8);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);

async function until<T>(fn: () => Promise<T | false>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const waitingOn = (id: string, pred: (s: OrderState) => boolean, what: string) =>
  until(async () => {
    const s = await state(id);
    return pred(s) ? s : false;
  }, what);
const settled = (id: string) =>
  waitingOn(
    id,
    (s) => ['completed', 'declined', 'cancelled', 'failed', 'rolled_back'].includes(s.status),
    'a terminal status',
  );
/** The order once its price node has run, which is all pricing needs of a flow. */
const priced = (id: string) =>
  waitingOn(id, (s) => s.nodes.price?.status === 'succeeded', 'the price node');

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
async function introspect() {
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
}
afterEach(async () => {
  await introspector?.dispose();
});
beforeAll(async () => {
  await ensureTemplates(env);
});

const staff = (role: Role, id = `usr_qt_${role}`): RpcActor =>
  ({ kind: 'staff', id, name: `${id}@example.com`, role }) as RpcActor;
/** A tool as REST runs it: signed for that one call. */
const run = async (tool: string, input: unknown, actor: RpcActor = staff('operator')) =>
  api().runOperation(tool, input, await signedActor(actor, await operationCall(tool, input)));

/** A business customer with 100,000 of credit and an active company with a buyer. */
async function company() {
  const id = `cqt_${suffix()}`;
  await dir().createCustomer(
    {
      id,
      name: `Co ${id}`,
      email: `${id}@example.test`,
      kind: 'business',
      tier: 'standard',
      terms: 'net_30',
    },
    {
      customerId: id,
      status: 'active',
      legalName: `${id} Ltd`,
      taxId: null,
      parentCompanyId: null,
      createdAt: 1,
      updatedAt: 1,
    },
  );
  await db().update(customers).set({ creditLimit: 100_000 }).where(eq(customers.id, id));
  await dir().upsertMembers(
    id,
    [
      {
        id: `${id}_ann`,
        name: 'ann',
        email: `ann@${id}.test`,
        role: 'buyer',
        teamId: null,
        status: 'active',
        orderLimit: null,
      },
    ],
    1,
  );
  return { id, ann: `${id}_ann` };
}

/** WID-100 lists at 24.00 in the demo data; a quote's price is one nothing else would produce. */
const LIST = 24;
const QUOTED = 7.77;
const YEAR = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

const okValue = <T>(r: { ok: boolean; value?: unknown; error?: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
};

/** A quote for 100 widgets at `QUOTED`, drafted, sent and accepted through the tools. */
async function acceptedQuote(c: { id: string; ann: string }, over: object = {}) {
  const made = okValue<{ quote: { id: string } }>(
    await run('create_quote', {
      companyId: c.id,
      name: `Deal ${suffix()}`,
      buyerId: c.ann,
      expiresOn: YEAR,
      lines: [{ sku: 'WID-100', qty: 100, unitPrice: QUOTED }],
      ...over,
    }),
  );
  okValue(await run('send_quote', { quoteId: made.quote.id }));
  okValue(await run('accept_quote', { quoteId: made.quote.id, note: 'By phone' }));
  return made.quote.id;
}

/** Makes the company one that uses POs: it has one on record. */
async function usesPos(c: { id: string; ann: string }) {
  okValue(
    await run('create_po_draft', {
      companyId: c.id,
      poNumber: `PO-${suffix()}`,
      lines: [{ sku: 'WID-100', qty: 1 }],
    }),
  );
}

/** An order for `qty` widgets on the PO flow, started as any caller would. */
async function startOrder(customerId: string, qty: number) {
  const started = await startOrderOnce(env, {
    flowId: 'tpl-b2b-purchase-order',
    input: {
      model: 'b2b',
      channel: 'manual',
      customerId,
      currency: 'USD',
      lines: [{ sku: 'WID-100', qty }],
    },
    startedBy: 'usr_qt_operator',
    idempotencyKey: `qt-test:${suffix()}`,
  });
  if ('mismatch' in started) throw new Error('mismatch');
  return started.orderId;
}

const unitPriceOf = async (orderId: string) =>
  (await priced(orderId)).order?.lines.find((l) => l.sku === 'WID-100')?.unitPrice;

describe('a quote through the tools', () => {
  it('is drafted, edited, sent, accepted and revised, each move audited and company-scoped', async () => {
    const c = await company();
    const made = okValue<{
      quote: { id: string; version: number; lines: { listPrice: number }[] };
    }>(
      await run('create_quote', {
        companyId: c.id,
        name: 'Spring',
        expiresOn: YEAR,
        lines: [{ sku: 'WID-100', qty: 50, unitPrice: 10 }],
      }),
    );
    const id = made.quote.id;
    // The line keeps the list price it was written against.
    expect(made.quote.lines[0]?.listPrice).toBe(LIST);
    expect(
      await run('update_quote', { quoteId: id, notes: 'Net 30', name: 'Spring deal' }),
    ).toMatchObject({
      ok: true,
    });
    // A draft can't be accepted: it has to be sent first.
    expect(await run('accept_quote', { quoteId: id })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/only a sent quote can be accepted/),
    });
    okValue(await run('send_quote', { quoteId: id }));
    // Sent is read-only: an edit points to revising.
    expect(await run('update_quote', { quoteId: id, name: 'Late' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/revise it for a new version/),
    });
    const v2 = okValue<{ quote: { id: string; version: number; rootId: string } }>(
      await run('revise_quote', { quoteId: id }),
    );
    expect(v2.quote).toMatchObject({ version: 2, rootId: id });
    expect(await quotes().get(ALL, id)).toMatchObject({ status: 'superseded' });
    // The list shows where the negotiation stands, and the quote names its versions.
    const listed = okValue<{ quotes: { id: string }[]; total: number }>(
      await run('list_quotes', { companyId: c.id }, staff('viewer')),
    );
    expect(listed.quotes.map((q) => q.id)).toEqual([v2.quote.id]);
    expect(
      okValue<{ quote: { versions: { version: number; status: string }[] } }>(
        await run('get_quote', { quoteId: v2.quote.id }, staff('viewer')),
      ).quote.versions,
    ).toMatchObject([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'draft' },
    ]);
  });

  it('holds a viewer to reading, and refuses a quote on a SKU that isn’t a product', async () => {
    const c = await company();
    const input = {
      companyId: c.id,
      name: 'Nope',
      expiresOn: YEAR,
      lines: [{ sku: 'WID-100', qty: 5, unitPrice: 9 }],
    };
    for (const tool of [
      'create_quote',
      'update_quote',
      'send_quote',
      'accept_quote',
      'convert_quote',
    ])
      expect(await run(tool, { quoteId: 'qt_x', ...input }, staff('viewer')), tool).toMatchObject({
        ok: false,
      });
    expect(await run('list_quotes', {}, staff('viewer'))).toMatchObject({ ok: true });
    expect(
      await run('create_quote', { ...input, lines: [{ sku: 'NOPE-1', qty: 1, unitPrice: 1 }] }),
    ).toMatchObject({ ok: false, error: 'No product has the SKU NOPE-1.' });
    expect(await run('create_quote', { ...input, companyId: 'cus_nobody' })).toMatchObject({
      ok: false,
    });
  });
});

describe('the confirm cards show what is being committed', () => {
  const operator = {
    kind: 'user',
    id: 'usr_qt_operator',
    name: 'op',
    email: 'op@example.com',
    role: 'operator',
  } as const;

  it('shows the company, lines, quoted prices and quantities, total and expiry on send, accept and convert', async () => {
    const c = await company();
    const made = okValue<{ quote: { id: string } }>(
      await run('create_quote', {
        companyId: c.id,
        name: 'Card deal',
        expiresOn: YEAR,
        lines: [
          { sku: 'WID-100', qty: 100, unitPrice: 7.5 },
          { sku: 'GSK-010', qty: 40, unitPrice: 1.25 },
        ],
      }),
    );
    const quoteId = made.quote.id;
    const shown = [
      `Company ${c.id}, version 1`,
      'Lines: GSK-010 up to 40 at 1.25 (85% off list); WID-100 up to 100 at 7.50 (69% off list)',
      '2 of 2 lines are below list price; deepest 85% off on GSK-010',
      'Total at the quoted quantities: 800.00 (base currency)',
      `Good through ${YEAR} (UTC)`,
    ];
    const card = (tool: 'send_quote' | 'accept_quote' | 'convert_quote') =>
      previewAction(env, operator, tool, { quoteId });
    expect((await card('send_quote')).consequences).toEqual(expect.arrayContaining(shown));
    okValue(await run('send_quote', { quoteId }));
    const accept = await card('accept_quote');
    expect(accept.consequences).toEqual(expect.arrayContaining(shown));
    expect(accept.consequences.join(' ')).toMatch(/ahead of every other price/);
    okValue(await run('accept_quote', { quoteId }));
    const convert = await card('convert_quote');
    expect(convert.consequences).toEqual(expect.arrayContaining(shown));
    expect(convert.consequences.join(' ')).toMatch(/Starts an order of 2 lines/);
    expect(convert.blocked).toBeUndefined();
  });
});

describe('what a person confirms is what is committed', () => {
  const operator = {
    kind: 'user',
    id: 'usr_qt_operator',
    name: 'op',
    email: 'op@example.com',
    role: 'operator',
  } as const;

  it('names a deeply discounted line on the accept card however far down the quote it is', async () => {
    const c = await company();
    const skus = (
      await db().select({ sku: products.sku, price: products.price }).from(products).limit(7)
    ).filter((p) => p.price > 0);
    expect(skus.length).toBe(7);
    const lines = skus.map((p, i) => ({
      sku: p.sku,
      qty: 10,
      // Six lines a little under list; the seventh at 1% of it.
      unitPrice: i === 6 ? Math.round(p.price) / 100 : Math.round(p.price * 0.95 * 100) / 100,
    }));
    const quoteId = okValue<{ quote: { id: string } }>(
      await run('create_quote', { companyId: c.id, name: 'Seven', expiresOn: YEAR, lines }),
    ).quote.id;
    okValue(await run('send_quote', { quoteId }));
    const card = await previewAction(env, operator, 'accept_quote', { quoteId });
    const text = card.consequences.join('\n');
    expect(text).toContain(`${skus[6]?.sku} up to 10 at`);
    expect(text).toContain('(99% off list)');
    expect(text).toMatch(/7 of 7 lines are below list price; deepest 99% off on /);
  });

  it('refuses to send a draft that was changed after the card was shown, and sends the one confirmed', async () => {
    const c = await company();
    const quoteId = okValue<{ quote: { id: string } }>(
      await run('create_quote', {
        companyId: c.id,
        name: 'Bound',
        expiresOn: YEAR,
        lines: [{ sku: 'WID-100', qty: 5, unitPrice: 9 }],
      }),
    ).quote.id;
    const card = await previewAction(env, operator, 'send_quote', { quoteId });
    expect(card.bound).toEqual({ quote: expect.any(String) });
    // The draft's prices are changed after the person saw them.
    okValue(
      await run('update_quote', { quoteId, lines: [{ sku: 'WID-100', qty: 5, unitPrice: 1 }] }),
    );
    await expect(
      runAction(env, operator, 'send_quote', { quoteId }, 'assistant', {
        bound: card.bound ?? null,
      }),
    ).rejects.toThrow(/has changed since it was shown to you/);
    expect((await quotes().get(ALL, quoteId))?.status).toBe('draft');
    // A fresh card is held to the new draft, and it goes.
    const again = await previewAction(env, operator, 'send_quote', { quoteId });
    await runAction(env, operator, 'send_quote', { quoteId }, 'assistant', {
      bound: again.bound ?? null,
    });
    expect((await quotes().get(ALL, quoteId))?.status).toBe('sent');
  });
});

describe('finishing a conversion that stalled', () => {
  it('starts the order on the flow its first try named, without being told it again', async () => {
    await introspect();
    const c = await company();
    const quoteId = await acceptedQuote(c);
    // First try on a flow that isn't the default.
    const first = okValue<{ href: string }>(
      await run('convert_quote', { quoteId, to: 'order', flowId: 'tpl-b2b-purchase-order' }),
    );
    const orderId = first.href.replace('/orders/', '');
    // The record of the order is lost, as when the first call stopped after the start.
    await quotes().settleConversion(ALL, quoteId, orderId, `quote:${quoteId}`, Date.now());
    expect((await quotes().get(ALL, quoteId))?.convertedId).toBe(`quote:${quoteId}`);
    const again = okValue<{ href: string }>(await run('convert_quote', { quoteId }));
    expect(again.href).toBe(first.href);
    expect((await quotes().get(ALL, quoteId))?.convertedId).toBe(orderId);
    expect(
      await db().select({ id: orders.id }).from(orders).where(eq(orders.customerId, c.id)),
    ).toHaveLength(1);
  });

  it('refuses a PO made from a quote that has ended, and submits it once the quote is cleared from it', async () => {
    await introspect();
    const c = await company();
    await usesPos(c);
    const quoteId = await acceptedQuote(c);
    okValue(await run('convert_quote', { quoteId }));
    okValue(await run('expire_quote', { quoteId }));
    expect(await run('submit_po', { poId: `po_${quoteId}` })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no longer in force/),
    });
    okValue(await run('update_po_draft', { poId: `po_${quoteId}`, quoteId: null }));
    const sent = okValue<{ orderId: string }>(await run('submit_po', { poId: `po_${quoteId}` }));
    // No longer priced at the quote: the order is priced as any other.
    expect(await unitPriceOf(sent.orderId)).toBe(LIST);
  });
});

describe('pricing orders from an accepted quote', () => {
  it('prices a PO draft made from the quote at the quoted price when it is submitted through the PO flow', async () => {
    await introspect();
    const c = await company();
    await usesPos(c);
    const quoteId = await acceptedQuote(c);

    // The company uses POs, so the quote becomes a PO draft (D7), with the quoted prices.
    const converted = okValue<{ id: string; href: string }>(
      await run('convert_quote', { quoteId, poNumber: 'PO-FROM-QUOTE' }),
    );
    expect(converted.href).toBe(`/purchase-orders/po_${quoteId}`);
    expect(await pos().get(ALL, `po_${quoteId}`)).toMatchObject({
      status: 'draft',
      quoteId,
      poNumber: 'PO-FROM-QUOTE',
      buyerId: c.ann,
      lines: [{ sku: 'WID-100', qty: 100, unitPrice: QUOTED }],
    });
    // Converting again is the same draft; the quote names it.
    expect(await run('convert_quote', { quoteId })).toMatchObject({ ok: true });
    expect((await pos().list(ALL, { companyId: c.id }, { limit: 10 })).total).toBe(2);
    expect(await quotes().get(ALL, quoteId)).toMatchObject({
      status: 'accepted',
      convertedTo: 'po',
      convertedId: `po_${quoteId}`,
    });

    // Submitting it runs the PO flow, whose price node reads the quote like any order's.
    const sent = okValue<{ orderId: string }>(await run('submit_po', { poId: `po_${quoteId}` }));
    const done = await settled(sent.orderId);
    expect(done.status).toBe('completed');
    const line = done.order?.lines.find((l) => l.sku === 'WID-100');
    expect(line?.unitPrice).toBe(QUOTED);
    expect(done.order?.subtotal).toBe(Math.round(100 * QUOTED * 100) / 100);
    expect(done.nodes.price?.output).toMatchObject({
      lines: [{ sku: 'WID-100', unitPrice: QUOTED, by: 'quote' }],
    });
    // The PO that came of the quote follows its order to the end, and still names the quote.
    const po = await until(async () => {
      const p = await pos().get(ALL, `po_${quoteId}`);
      return p?.status === 'fulfilled' ? p : false;
    }, 'the PO to be fulfilled');
    expect(po.quoteId).toBe(quoteId);
  });

  it('goes straight to an order for a company with no POs, priced at the quote, once however often it is asked', async () => {
    await introspect();
    const c = await company();
    const quoteId = await acceptedQuote(c);
    const first = okValue<{ href: string; id: string }>(await run('convert_quote', { quoteId }));
    const orderId = first.href.replace('/orders/', '');
    expect(first.href).toMatch(/^\/orders\/ord_/);
    expect(await unitPriceOf(orderId)).toBe(QUOTED);
    expect((await state(orderId)).order?.meta).toMatchObject({ quoteId });
    // The same quote again is the same order.
    expect(okValue<{ href: string }>(await run('convert_quote', { quoteId })).href).toBe(
      first.href,
    );
    expect(
      await db().select({ id: orders.id }).from(orders).where(eq(orders.customerId, c.id)),
    ).toHaveLength(1);
    expect(await quotes().get(ALL, quoteId)).toMatchObject({
      convertedTo: 'order',
      convertedId: orderId,
    });
  });

  it('prices every order of the company at the quote while it is accepted, and only that company’s', async () => {
    await introspect();
    const c = await company();
    const other = await company();
    await acceptedQuote(c);
    const start = startOrder;
    expect(await unitPriceOf(await start(c.id, 20))).toBe(QUOTED);
    // The quote is the company's own: another company's order prices as it always did.
    expect(await unitPriceOf(await start(other.id, 20))).toBe(LIST);
    // Past the quantity the quote covers, the line is priced as if there were none.
    expect(await unitPriceOf(await start(c.id, 101))).toBe(LIST);
  });

  it('stops pricing when the quote is ended, and orders already priced keep their price', async () => {
    await introspect();
    const c = await company();
    const quoteId = await acceptedQuote(c);
    const start = () => startOrder(c.id, 10);
    const before = await start();
    expect(await unitPriceOf(before)).toBe(QUOTED);
    okValue(await run('expire_quote', { quoteId }));
    expect(await quotes().get(ALL, quoteId)).toMatchObject({ status: 'expired' });
    expect(await unitPriceOf(await start())).toBe(LIST);
    expect(await unitPriceOf(before)).toBe(QUOTED);
    // An ended quote can't be converted; a revision starts the negotiation again.
    expect(await run('convert_quote', { quoteId })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Only an accepted quote/),
    });
  });

  it('is not what a quote that was only sent, or declined, prices', async () => {
    await introspect();
    const c = await company();
    const made = okValue<{ quote: { id: string } }>(
      await run('create_quote', {
        companyId: c.id,
        name: 'Pending',
        expiresOn: YEAR,
        lines: [{ sku: 'WID-100', qty: 100, unitPrice: QUOTED }],
      }),
    );
    okValue(await run('send_quote', { quoteId: made.quote.id }));
    const order = () => startOrder(c.id, 10);
    expect(await unitPriceOf(await order())).toBe(LIST);
    okValue(await run('decline_quote', { quoteId: made.quote.id, reason: 'Too dear' }));
    expect(await unitPriceOf(await order())).toBe(LIST);
  });
});
