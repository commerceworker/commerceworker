/**
 * B2B procurement end to end (docs/b2b.md, P5), on real Workflows and the real templates: a
 * company with a buyer and an approver, a price book and a contract price, a credit limit and a
 * budget; a quote negotiated (revised once), accepted and converted to a PO draft; the draft
 * submitted through `tpl-b2b-purchase-order`, over the approval threshold, so the company approver
 * votes; the order priced at the quote, a credit hold and budget spend recorded, invoiced net 30
 * with the PO number, and the PO fulfilled. The same company's second order is rejected by its
 * approver, which gives everything it took back.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  type OrderState,
  operationCall,
  type PoStatus,
  type Role,
  type RpcActor,
} from '@commerceworker/core';
import { createDb, creditHolds } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { ensureTemplates } from '../src/flows';
import { companyDirectory, documentStore, purchaseOrderStore, quoteStore } from '../src/wire';
import { signedActor } from './principal';

const ALL = { all: true } as const;
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
const waitingApproval = (id: string) =>
  waitingOn(id, (s) => s.waits.some((w) => w.kind === 'approval'), 'the approval');
const reaches = (poId: string, want: PoStatus) =>
  until(async () => {
    const po = await pos().get(ALL, poId);
    return po?.status === want ? po : false;
  }, `the purchase order to be ${want}`);

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

const staff = (role: Role, over: Partial<RpcActor> = {}): RpcActor =>
  ({
    kind: 'staff',
    id: `usr_b2b_${role}`,
    name: `${role}@example.com`,
    role,
    ...over,
  }) as RpcActor;
/** What changes what a buyer pays or owes is a person's to confirm. */
const person = (role: Role) => staff(role, { person: true } as Partial<RpcActor>);
/** A tool as REST runs it: signed for that one call. */
const run = async (tool: string, input: unknown, actor: RpcActor = staff('operator')) =>
  api().runOperation(tool, input, await signedActor(actor, await operationCall(tool, input)));
const ok = <T = Record<string, unknown>>(r: {
  ok: boolean;
  value?: unknown;
  error?: string;
}): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
};
const vote = async (orderId: string, memberId: string, decision: 'approved' | 'rejected') =>
  api().decide(
    orderId,
    'approval',
    decision,
    await signedActor(staff('approver'), `decide:${orderId}`),
    undefined,
    memberId,
  );

const YEAR = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
const QUOTED = 12.5;
const NEGOTIATED_FIRST = 14;
const CONTRACT_GASKET = 7;
const BOOK_MONITOR = 280;

/**
 * A company set up the way staff would: a customer and its (active) company; a buyer and an
 * approver; a credit limit; a strict monthly budget; a price book assigned to it (the quote's SKU
 * and one that only the book prices) and a contract price (for the quote's SKU, which the quote
 * must beat, and for one that only the contract prices).
 */
async function setup() {
  const made = ok<{ id: string }>(
    await run('create_customer', {
      name: `Procure ${suffix()}`,
      email: `${suffix()}@procure.test`,
      kind: 'business',
      tier: 'standard',
      terms: 'net_30',
    }),
  );
  const companyId = made.id;
  const domain = `procure-${suffix()}.test`;
  ok(
    await run('put_company_members', {
      companyId,
      members: [
        { email: `ann@${domain}`, name: 'Ann Buyer', role: 'buyer', status: 'active' },
        { email: `bo@${domain}`, name: 'Bo Approver', role: 'approver', status: 'active' },
      ],
    }),
  );
  const members = (await dir().members(ALL, { companyId, limit: 10 })).rows;
  const ann = members.find((m) => m.role === 'buyer')!.id;
  const bo = members.find((m) => m.role === 'approver')!.id;

  ok(await run('set_credit_limit', { customerId: companyId, limit: 50_000 }, person('admin')));
  ok(
    await run('put_budget', {
      companyId,
      name: 'Operations',
      amount: 20_000,
      period: 'monthly',
      enforcement: 'strict',
    }),
  );
  const book = ok<{ id: string }>(
    await run(
      'create_price_book',
      { code: `book-${suffix()}`, name: 'Wholesale', priority: 10 },
      person('operator'),
    ),
  );
  ok(
    await run(
      'put_price_book_entries',
      {
        bookId: book.id,
        entries: [
          { sku: 'WID-100', price: 20 },
          { sku: 'MON-27', price: BOOK_MONITOR },
        ],
      },
      person('operator'),
    ),
  );
  ok(
    await run('assign_price_book', { bookId: book.id, customerId: companyId }, person('operator')),
  );
  ok(await run('set_price_book_status', { bookId: book.id, status: 'active' }, person('operator')));
  ok(
    await run(
      'put_contract_prices',
      {
        customerId: companyId,
        prices: [
          { sku: 'WID-100', price: 18 },
          { sku: 'GSK-010', price: CONTRACT_GASKET },
        ],
      },
      person('operator'),
    ),
  );
  return { companyId, ann, bo };
}

/** A quote negotiated (v1 sent at 14, revised, v2 at 12.50 sent), accepted, and made a PO draft. */
async function quotedDraft(c: { companyId: string; ann: string }, poNumber: string) {
  const v1 = ok<{ quote: { id: string } }>(
    await run('create_quote', {
      companyId: c.companyId,
      name: `Deal ${suffix()}`,
      buyerId: c.ann,
      expiresOn: YEAR,
      lines: [{ sku: 'WID-100', qty: 600, unitPrice: NEGOTIATED_FIRST }],
    }),
  );
  ok(await run('send_quote', { quoteId: v1.quote.id }));
  // The company wants it cheaper: a revision supersedes v1 with a draft at the same lines.
  const v2 = ok<{ quote: { id: string; version: number } }>(
    await run('revise_quote', { quoteId: v1.quote.id }),
  ).quote;
  expect(v2.version).toBe(2);
  expect(await quotes().get(ALL, v1.quote.id)).toMatchObject({ status: 'superseded' });
  ok(
    await run('update_quote', {
      quoteId: v2.id,
      lines: [{ sku: 'WID-100', qty: 600, unitPrice: QUOTED }],
    }),
  );
  ok(await run('send_quote', { quoteId: v2.id }));
  ok(await run('accept_quote', { quoteId: v2.id, note: 'By phone, Bo' }));

  const converted = ok<{ href: string }>(
    await run('convert_quote', { quoteId: v2.id, to: 'po', poNumber }),
  );
  const poId = converted.href.replace('/purchase-orders/', '');
  // The quoted lines are the draft's expected prices; add the two the quote doesn't cover.
  ok(
    await run('update_po_draft', {
      poId,
      lines: [
        { sku: 'WID-100', qty: 600, unitPrice: QUOTED },
        { sku: 'GSK-010', qty: 100 },
        { sku: 'MON-27', qty: 2 },
      ],
    }),
  );
  return { quoteId: v2.id, poId };
}

const holds = (orderId: string) =>
  createDb(env.DB).select().from(creditHolds).where(eq(creditHolds.orderId, orderId));

describe('B2B procurement', () => {
  it('runs a negotiated quote to a fulfilled, invoiced PO through credit, budget and approval', async () => {
    await introspect();
    const c = await setup();
    const { quoteId, poId } = await quotedDraft(c, 'PO-ACME-7');
    expect(await pos().get(ALL, poId)).toMatchObject({
      status: 'draft',
      quoteId,
      poNumber: 'PO-ACME-7',
      source: 'api',
    });

    const sent = ok<{ orderId: string }>(await run('submit_po', { poId }));
    const orderId = sent.orderId;
    // Submitting again is the same order.
    expect(ok<{ orderId: string }>(await run('submit_po', { poId })).orderId).toBe(orderId);

    // Over the threshold, within credit and budget: the company approver is asked.
    const waiting = await waitingApproval(orderId);
    expect(waiting.waits[0]?.approval).toMatchObject({
      approvers: 'company:approver',
      companyId: c.companyId,
      eligible: [c.bo],
    });
    expect(waiting.nodes.credit?.branches).toEqual(['ok']);
    expect(waiting.nodes.budget?.branches).toEqual(['within']);
    expect(waiting.nodes.threshold?.branches).toEqual(['true']);
    expect((await reaches(poId, 'pending_approval')).status).toBe('pending_approval');

    // Priced at the quote where it applies, then by the contract and the book where it doesn't.
    const lines = waiting.order!.lines;
    expect(lines.find((l) => l.sku === 'WID-100')?.unitPrice).toBe(QUOTED);
    expect(lines.find((l) => l.sku === 'GSK-010')?.unitPrice).toBe(CONTRACT_GASKET);
    expect(lines.find((l) => l.sku === 'MON-27')?.unitPrice).toBe(BOOK_MONITOR);
    expect(waiting.nodes.price?.output).toMatchObject({
      lines: expect.arrayContaining([
        expect.objectContaining({ sku: 'WID-100', by: 'quote' }),
        expect.objectContaining({ sku: 'GSK-010', by: 'contract' }),
        expect.objectContaining({ sku: 'MON-27', by: 'price_book' }),
      ]),
    });
    const subtotal = 600 * QUOTED + 100 * CONTRACT_GASKET + 2 * BOOK_MONITOR;
    expect(waiting.order?.subtotal).toBe(subtotal);
    const total = waiting.order!.total;

    // The credit hold and the budget's spend are taken before anyone votes.
    expect(await holds(orderId)).toMatchObject([{ status: 'held', amount: total }]);
    expect(
      ok(await run('get_credit_account', { customerId: c.companyId }, staff('viewer'))),
    ).toMatchObject({ balance: 0, held: total, available: 50_000 - total });
    const budget = ok<{ budgets: { id: string; spent: number; remaining: number }[] }>(
      await run('list_budgets', { companyId: c.companyId }, staff('viewer')),
    ).budgets[0]!;
    expect(budget).toMatchObject({ spent: total, remaining: 20_000 - total });

    // A buyer isn't an approver; the company approver's vote decides it.
    expect(await vote(orderId, c.ann, 'approved')).toMatchObject({
      ok: false,
      reason: 'refused',
      error: expect.stringContaining('isn’t one of this approval’s approvers'),
    });
    expect(await vote(orderId, c.bo, 'approved')).toMatchObject({ ok: true, outcome: 'approved' });

    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.approval?.branches).toEqual(['approved']);
    expect(done.nodes.reserve?.branches).toEqual(['ok']);
    expect((await reaches(poId, 'fulfilled')).quoteId).toBe(quoteId);

    // The hold became the charge, once: the company owes the total, nothing is held.
    expect(await holds(orderId)).toMatchObject([{ status: 'charged', amount: total }]);
    expect(
      ok(await run('get_credit_account', { customerId: c.companyId }, staff('viewer'))),
    ).toMatchObject({ balance: total, held: 0, available: 50_000 - total });

    // The spend stays recorded, committed, in the budget's ledger (the REST and MCP twin).
    expect(
      ok(
        await run(
          'list_budget_spend',
          { companyId: c.companyId, budgetId: budget.id },
          staff('viewer'),
        ),
      ),
    ).toMatchObject({
      total: 1,
      entries: [{ orderId, amount: total, status: 'committed' }],
    });

    // Invoiced net 30 with the buyer's PO number.
    const invoice = await documentStore(env).text(String(done.vars.invoiceKey));
    expect(invoice).toContain('<b>PO number:</b> PO-ACME-7');
    expect(invoice).toContain('net_30');

    // The quote is still a deal the company can use, and names what came of it.
    expect(await quotes().get(ALL, quoteId)).toMatchObject({
      status: 'accepted',
      convertedTo: 'po',
      convertedId: poId,
    });
  });

  it('gives the hold, the spend and the PO back when the approver says no', async () => {
    await introspect();
    const c = await setup();
    const { poId } = await quotedDraft(c, 'PO-ACME-8');
    const { orderId } = ok<{ orderId: string }>(await run('submit_po', { poId }));
    const waiting = await waitingApproval(orderId);
    const total = waiting.order!.total;
    expect(await holds(orderId)).toMatchObject([{ status: 'held', amount: total }]);

    expect(await vote(orderId, c.bo, 'rejected')).toMatchObject({ ok: true, outcome: 'rejected' });
    expect((await settled(orderId)).status).toBe('declined');
    expect((await reaches(poId, 'rejected')).status).toBe('rejected');

    // Nothing is owed or held, and the budget's spend nets to nothing: the commit and its reversal.
    expect(await holds(orderId)).toMatchObject([{ status: 'released' }]);
    expect(
      ok(await run('get_credit_account', { customerId: c.companyId }, staff('viewer'))),
    ).toMatchObject({ balance: 0, held: 0, available: 50_000 });
    const budget = ok<{ budgets: { id: string; spent: number }[] }>(
      await run('list_budgets', { companyId: c.companyId }, staff('viewer')),
    ).budgets[0]!;
    expect(budget.spent).toBe(0);
    const ledger = ok<{ entries: { amount: number; status: string }[] }>(
      await run(
        'list_budget_spend',
        { companyId: c.companyId, budgetId: budget.id },
        staff('viewer'),
      ),
    );
    expect(ledger.entries.map((e) => e.status)).toEqual(expect.arrayContaining(['reversed']));
    // Another company's name reads none of this budget's ledger.
    expect(
      ok(
        await run(
          'list_budget_spend',
          { companyId: 'cus_contoso', budgetId: budget.id },
          staff('viewer'),
        ),
      ),
    ).toMatchObject({ total: 0, entries: [] });
  });
});
