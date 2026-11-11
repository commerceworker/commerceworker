import type { Company, CompanyMember } from '@commerceworker/core';
import {
  InMemoryCompanyDirectory,
  InMemoryPurchaseOrderStore,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  cancelPo,
  createPoDraft,
  getPurchaseOrder,
  listPurchaseOrders,
  type PoOrderDeps,
  planSubmitPo,
  recordInboundPo,
  submitPo,
  syncPoFromOrder,
  updatePoDraft,
} from '../src/commerce';

const ALL = { all: true } as const;
const NOW = Date.UTC(2026, 10, 10, 12);
let n = 0;
const nextId = () => `po_${++n}`;

const customer = (id: string) => ({
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
});
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

function setup(companies: Company[] = [company('acme'), company('globex')]) {
  return {
    purchaseOrders: new InMemoryPurchaseOrderStore(),
    companies: new InMemoryCompanyDirectory({
      customers: [customer('acme'), customer('globex')],
      companies,
      members: [
        member('m_ann', 'acme'),
        member('m_off', 'acme', { status: 'inactive' }),
        member('m_gx', 'globex'),
      ],
    }),
  };
}

const draftInput = (over: object = {}) => ({
  companyId: 'acme',
  poNumber: 'PO-100',
  buyerId: 'm_ann',
  lines: [
    { sku: 'WID-1', qty: 2 },
    { sku: 'WID-2', name: 'Widget two', qty: 5, unitPrice: 3.5 },
  ],
  ...over,
});

/** The engine's two order calls, recorded; one per set of ports, so its order ids run on. */
const engines = new WeakMap<object, ReturnType<typeof newEngine>>();
function engine(ports: ReturnType<typeof setup>) {
  const held = engines.get(ports);
  if (held) return held;
  const made = newEngine(ports);
  engines.set(ports, made);
  return made;
}

function newEngine(ports: ReturnType<typeof setup>) {
  const started: Parameters<PoOrderDeps['start']>[0][] = [];
  const cancelled: { orderId: string; reason: string }[] = [];
  const keys = new Map<string, string>();
  const deps: PoOrderDeps & { fail?: string; onStart?: () => Promise<void>; finished?: boolean } = {
    async start(req) {
      if (deps.fail) return { ok: false, error: deps.fail };
      started.push(req);
      const replayed = keys.has(req.key);
      const orderId = keys.get(req.key) ?? `ord_${keys.size + 1}`;
      keys.set(req.key, orderId);
      // The engine ties the PO to the order before the flow runs.
      await ports.purchaseOrders.linkOrder(ALL, req.purchaseOrder.link, orderId, NOW);
      await deps.onStart?.();
      return { ok: true, orderId, replayed };
    },
    async cancel(orderId, reason) {
      if (deps.finished) return { ok: true, outcome: 'finished' };
      cancelled.push({ orderId, reason });
      // The OrderAgent follows its cancelled order with the PO.
      await syncPoFromOrder(ports, orderId, 'cancelled', NOW);
      return { ok: true, outcome: 'cancelled' };
    },
  };
  return { deps, started, cancelled };
}

async function draft(ports: ReturnType<typeof setup>, over: object = {}) {
  const r = await createPoDraft(ports, ALL, draftInput(over), nextId, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.purchaseOrder;
}

describe('drafting a purchase order', () => {
  it('saves a draft with its lines, trimmed number and an audit draft', async () => {
    const ports = setup();
    const r = await createPoDraft(
      ports,
      ALL,
      draftInput({ poNumber: ' PO-100 ', currency: 'eur' }),
      nextId,
      NOW,
      'app',
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.purchaseOrder).toMatchObject({
      companyId: 'acme',
      poNumber: 'PO-100',
      status: 'draft',
      currency: 'EUR',
      buyerId: 'm_ann',
      source: 'app',
      orderId: null,
      createdAt: NOW,
    });
    expect(r.purchaseOrder.lines).toEqual([
      { sku: 'WID-1', name: null, qty: 2, unitPrice: null },
      { sku: 'WID-2', name: 'Widget two', qty: 5, unitPrice: 3.5 },
    ]);
    expect(r.audit).toMatchObject({
      action: 'purchase_order.created',
      target: r.purchaseOrder.id,
      detail: { company: 'acme', poNumber: 'PO-100', lines: 2, source: 'app' },
    });
    expect(await ports.purchaseOrders.get(ALL, r.purchaseOrder.id)).toEqual(r.purchaseOrder);
  });

  it('refuses a duplicate number, an inactive company or buyer, and a bad draft', async () => {
    const ports = setup([company('acme'), company('globex', { status: 'suspended' })]);
    await draft(ports);
    const refused = async (over: object) => {
      const r = await createPoDraft(ports, ALL, draftInput(over), nextId, NOW);
      return r.ok ? null : r.error;
    };
    expect(await refused({ poNumber: 'po-100' })).toMatch(/has that number/);
    expect(await refused({ poNumber: 'PO-2', buyerId: 'm_off' })).toMatch(/isn't an active member/);
    // Another company's member isn't a buyer here.
    expect(await refused({ poNumber: 'PO-2', buyerId: 'm_gx' })).toMatch(/isn't an active member/);
    expect(await refused({ companyId: 'globex', buyerId: null })).toMatch(
      /isn't active \(suspended\)/,
    );
    expect(await refused({ companyId: 'nobody', buyerId: null })).toMatch(/isn't a company/);
    expect(await refused({ lines: [] })).toMatch(/lines/);
    expect(await refused({ poNumber: '' })).toMatch(/poNumber/);
    expect(await ports.purchaseOrders.list(ALL, {}, { limit: 10 })).toMatchObject({ total: 1 });
  });

  it('keeps a company’s scope: another company’s drafts are neither made nor read', async () => {
    const ports = setup();
    const scoped = { companyId: 'globex' };
    const r = await createPoDraft(ports, scoped, draftInput(), nextId, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/isn't a company/) });
    const po = await draft(ports);
    expect(await getPurchaseOrder(ports, scoped, po.id)).toEqual({
      ok: false,
      error: 'No such purchase order.',
    });
    expect((await listPurchaseOrders(ports, scoped, {})).purchaseOrders).toEqual([]);
  });

  it('edits only a draft, and says what changed', async () => {
    const ports = setup();
    const po = await draft(ports);
    const r = await updatePoDraft(
      ports,
      ALL,
      { poId: po.id, notes: 'Rush', lines: [{ sku: 'WID-9', qty: 1 }] },
      NOW + 1,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.changed).toBe(true);
    expect(r.audit).toMatchObject({
      action: 'purchase_order.updated',
      detail: { changed: ['notes', 'lines'] },
    });
    expect(r.purchaseOrder).toMatchObject({ notes: 'Rush', updatedAt: NOW + 1 });
    expect((await ports.purchaseOrders.get(ALL, po.id))?.lines).toEqual([
      { sku: 'WID-9', name: null, qty: 1, unitPrice: null },
    ]);
    // The same values again change nothing and record nothing.
    expect(await updatePoDraft(ports, ALL, { poId: po.id, notes: 'Rush' }, NOW + 2)).toMatchObject({
      ok: true,
      changed: false,
      audit: null,
    });
    expect((await ports.purchaseOrders.get(ALL, po.id))?.updatedAt).toBe(NOW + 1);
  });

  it('refuses to edit a PO that isn’t a draft any more, and leaves it as it was', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps } = engine(ports);
    await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
    const r = await updatePoDraft(ports, ALL, { poId: po.id, notes: 'Too late' }, NOW + 1);
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/only a draft can be changed/),
    });
    expect(await ports.purchaseOrders.get(ALL, po.id)).toMatchObject({ notes: null });
  });

  it('refuses an edit to a taken number, an inactive buyer, or no lines', async () => {
    const ports = setup();
    await draft(ports);
    const other = await draft(ports, { poNumber: 'PO-200' });
    const refused = async (over: object) => {
      const r = await updatePoDraft(ports, ALL, { poId: other.id, ...over }, NOW);
      return r.ok ? null : r.error;
    };
    expect(await refused({ poNumber: 'po-100' })).toMatch(/has that number/);
    expect(await refused({ buyerId: 'm_off' })).toMatch(/isn't an active member/);
    expect(await refused({ lines: [] })).toMatch(/lines/);
    expect(await refused({ poId: 'po_none' })).toMatch(/No such purchase order/);
    // Naming its own number is no conflict.
    expect(
      await updatePoDraft(ports, ALL, { poId: other.id, poNumber: 'PO-200' }, NOW),
    ).toMatchObject({
      ok: true,
      changed: false,
    });
  });
});

describe('submitting a purchase order', () => {
  it('moves a draft to submitted and starts its order once, tied to the PO', async () => {
    const ports = setup();
    const po = await draft(ports, {
      shipTo: { line1: '1 Dock Rd', city: 'Austin', postalCode: '78701', country: 'US' },
      notes: 'Rush',
    });
    const { deps, started } = engine(ports);
    const r = await submitPo(ports, ALL, { poId: po.id }, deps, NOW + 1);
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ changed: true, orderId: 'ord_1' });
    expect(r.audit).toMatchObject({
      action: 'purchase_order.submitted',
      detail: { poNumber: 'PO-100', order: 'ord_1', flow: 'tpl-b2b-purchase-order' },
    });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      key: `po:${po.id}`,
      flowId: 'tpl-b2b-purchase-order',
      purchaseOrder: { link: po.id },
      input: {
        model: 'b2b',
        channel: 'api',
        externalId: 'PO-100',
        title: 'PO PO-100',
        customerId: 'acme',
        currency: 'USD',
        meta: {
          poNumber: 'PO-100',
          buyerId: 'm_ann',
          notes: 'Rush',
          shipTo: { line1: '1 Dock Rd' },
        },
      },
    });
    expect(started[0]?.input.lines).toEqual([
      { sku: 'WID-1', qty: 2 },
      { sku: 'WID-2', qty: 5, name: 'Widget two' },
    ]);
    // The meta names no PO: the engine sets that itself.
    expect(started[0]?.input.meta).not.toHaveProperty('purchaseOrderId');
    expect(await ports.purchaseOrders.get(ALL, po.id)).toMatchObject({
      status: 'submitted',
      orderId: 'ord_1',
    });
  });

  it('starts one order however often it is submitted', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps, started } = engine(ports);
    const first = await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
    const again = await submitPo(ports, ALL, { poId: po.id }, deps, NOW + 5);
    expect(first).toMatchObject({ ok: true, orderId: 'ord_1', changed: true });
    // The engine replays the key: the same order, nothing new to record.
    expect(again).toMatchObject({ ok: true, orderId: 'ord_1', changed: false, audit: null });
    expect(started.map((s) => s.key)).toEqual([`po:${po.id}`, `po:${po.id}`]);
    expect((await ports.purchaseOrders.list(ALL, {}, { limit: 10 })).total).toBe(1);
  });

  it('finishes a submit whose order never started, on the next try', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps } = engine(ports);
    deps.fail = 'Flow tpl-b2b-purchase-order has no published version';
    const failed = await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
    expect(failed).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no published version/),
    });
    // It is submitted with no order, so it can't be edited, and submitting again starts it.
    expect(await ports.purchaseOrders.get(ALL, po.id)).toMatchObject({
      status: 'submitted',
      orderId: null,
    });
    deps.fail = undefined;
    const retry = await submitPo(ports, ALL, { poId: po.id }, deps, NOW + 1);
    expect(retry).toMatchObject({ ok: true, orderId: 'ord_1' });
    expect((await ports.purchaseOrders.get(ALL, po.id))?.orderId).toBe('ord_1');
  });

  it('checks the company and buyer again at submit', async () => {
    const ports = setup();
    const po = await draft(ports);
    await ports.companies.transitionCompany(ALL, 'acme', 'active', 'suspended', NOW);
    const { deps, started } = engine(ports);
    const r = await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/isn't active \(suspended\)/),
    });
    expect(started).toHaveLength(0);
    expect((await ports.purchaseOrders.get(ALL, po.id))?.status).toBe('draft');
  });

  it('refuses a cancelled or rejected PO and an unknown one', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps, started } = engine(ports);
    await cancelPo(ports, ALL, { poId: po.id }, deps, NOW);
    expect(await submitPo(ports, ALL, { poId: po.id }, deps, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is cancelled/),
    });
    expect(await planSubmitPo(ports, ALL, { poId: 'po_none' })).toEqual({
      ok: false,
      error: 'No such purchase order.',
    });
    expect(started).toHaveLength(0);
  });

  it('cancels the order it just started when a cancel got in between the submit and the link', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps, cancelled } = engine(ports);
    // The cancel reads the PO after the submit, finds no order to cancel, and ends the PO.
    deps.onStart = async () => {
      await ports.purchaseOrders.transition(ALL, po.id, 'submitted', 'cancelled', NOW);
    };
    const r = await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled meanwhile/) });
    expect(cancelled).toEqual([
      { orderId: 'ord_1', reason: 'Purchase order PO-100 was cancelled' },
    ]);
  });
});

describe('cancelling a purchase order', () => {
  it('cancels a draft and a submitted PO with no order, once', async () => {
    const ports = setup();
    const a = await draft(ports);
    const { deps, cancelled } = engine(ports);
    const r = await cancelPo(ports, ALL, { poId: a.id, reason: 'Wrong supplier' }, deps, NOW);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.ok && r.audit).toMatchObject({
      action: 'purchase_order.cancelled',
      detail: { reason: 'Wrong supplier' },
    });
    // Again: nothing to do, nothing to record.
    expect(await cancelPo(ports, ALL, { poId: a.id }, deps, NOW)).toMatchObject({
      ok: true,
      changed: false,
      audit: null,
    });
    const b = await draft(ports, { poNumber: 'PO-101' });
    deps.fail = 'down';
    await submitPo(ports, ALL, { poId: b.id }, deps, NOW);
    expect(await cancelPo(ports, ALL, { poId: b.id }, deps, NOW)).toMatchObject({ ok: true });
    expect((await ports.purchaseOrders.get(ALL, b.id))?.status).toBe('cancelled');
    expect(cancelled).toEqual([]);
  });

  it('cancels the running order with the PO, which then follows it', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps, cancelled } = engine(ports);
    await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
    await syncPoFromOrder(ports, 'ord_1', 'awaiting_approval', NOW);
    const r = await cancelPo(ports, ALL, { poId: po.id }, deps, NOW + 1);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(cancelled).toEqual([
      { orderId: 'ord_1', reason: 'Purchase order PO-100 was cancelled' },
    ]);
    expect((await ports.purchaseOrders.get(ALL, po.id))?.status).toBe('cancelled');
  });

  it('cancels an ordered PO through its order, and gives its number back', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps } = engine(ports);
    await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
    await syncPoFromOrder(ports, 'ord_1', 'proceeding', NOW);
    expect((await ports.purchaseOrders.get(ALL, po.id))?.status).toBe('ordered');
    expect(await cancelPo(ports, ALL, { poId: po.id }, deps, NOW)).toMatchObject({ ok: true });
    expect((await ports.purchaseOrders.get(ALL, po.id))?.status).toBe('cancelled');
    expect((await createPoDraft(ports, ALL, draftInput(), nextId, NOW)).ok).toBe(true);
  });

  it('refuses when the order has already ended, and for a fulfilled or rejected PO', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps } = engine(ports);
    await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
    deps.finished = true;
    expect(await cancelPo(ports, ALL, { poId: po.id }, deps, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already ended/),
    });
    expect((await ports.purchaseOrders.get(ALL, po.id))?.status).toBe('submitted');
    await syncPoFromOrder(ports, 'ord_1', 'completed', NOW);
    expect(await cancelPo(ports, ALL, { poId: po.id }, deps, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/fulfilled, which is final/),
    });
    const other = await draft(ports, { poNumber: 'PO-102' });
    await submitPo(ports, ALL, { poId: other.id }, deps, NOW);
    await syncPoFromOrder(ports, 'ord_2', 'declined', NOW);
    expect(await cancelPo(ports, ALL, { poId: other.id }, deps, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/rejected, which is final/),
    });
  });

  it('cancels an order a submit started after the cancel read the PO and linked before it landed', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps, cancelled } = engine(ports);
    // The cancel's plan read finds a draft with no order; the submit then runs to its link, and the
    // cancel's first look at the PO sees a submitted one with an order it didn't plan for.
    const real = ports.purchaseOrders.get.bind(ports.purchaseOrders);
    let reads = 0;
    ports.purchaseOrders.get = async (scope, id) => {
      reads++;
      if (reads === 2) {
        ports.purchaseOrders.get = real;
        await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
      }
      return real(scope, id);
    };
    const r = await cancelPo(ports, ALL, { poId: po.id }, deps, NOW + 1);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.ok && r.audit?.detail).toMatchObject({ order: 'ord_1' });
    expect(cancelled.map((c) => c.orderId)).toEqual(['ord_1']);
    expect((await ports.purchaseOrders.get(ALL, po.id))?.status).toBe('cancelled');
  });

  it('keeps a company’s scope', async () => {
    const ports = setup();
    const po = await draft(ports);
    const { deps } = engine(ports);
    expect(await cancelPo(ports, { companyId: 'globex' }, { poId: po.id }, deps, NOW)).toEqual({
      ok: false,
      error: 'No such purchase order.',
    });
    expect((await ports.purchaseOrders.get(ALL, po.id))?.status).toBe('draft');
  });
});

describe('following the order', () => {
  async function submitted(ports: ReturnType<typeof setup>, poNumber = 'PO-100') {
    const po = await draft(ports, { poNumber });
    const { deps } = engine(ports);
    const r = await submitPo(ports, ALL, { poId: po.id }, deps, NOW);
    if (!r.ok) throw new Error(r.error);
    return { po, orderId: r.orderId };
  }
  const status = async (ports: ReturnType<typeof setup>, id: string) =>
    (await ports.purchaseOrders.get(ALL, id))?.status;

  it('walks an approval through every state, in turn', async () => {
    const ports = setup();
    const { po, orderId } = await submitted(ports);
    expect(await syncPoFromOrder(ports, orderId, 'running', NOW)).toMatchObject({ moved: [] });
    expect(await syncPoFromOrder(ports, orderId, 'awaiting_approval', NOW)).toMatchObject({
      status: 'pending_approval',
      moved: ['pending_approval'],
    });
    expect(await syncPoFromOrder(ports, orderId, 'proceeding', NOW)).toMatchObject({
      status: 'ordered',
      moved: ['approved', 'ordered'],
    });
    expect(await syncPoFromOrder(ports, orderId, 'completed', NOW + 9)).toMatchObject({
      status: 'fulfilled',
      moved: ['fulfilled'],
    });
    expect(await ports.purchaseOrders.get(ALL, po.id)).toMatchObject({
      status: 'fulfilled',
      updatedAt: NOW + 9,
    });
  });

  it('takes a PO with no approval straight through approved to ordered', async () => {
    const ports = setup();
    const { po, orderId } = await submitted(ports);
    expect(await syncPoFromOrder(ports, orderId, 'proceeding', NOW)).toMatchObject({
      moved: ['approved', 'ordered'],
    });
    expect(await status(ports, po.id)).toBe('ordered');
  });

  it('is safe to replay: a repeated or stale report moves nothing', async () => {
    const ports = setup();
    const { po, orderId } = await submitted(ports);
    await syncPoFromOrder(ports, orderId, 'proceeding', NOW);
    const before = await ports.purchaseOrders.get(ALL, po.id);
    for (const p of ['proceeding', 'awaiting_approval', 'running', 'queued'] as const)
      expect(await syncPoFromOrder(ports, orderId, p, NOW + 50)).toMatchObject({
        status: 'ordered',
        moved: [],
      });
    expect(await ports.purchaseOrders.get(ALL, po.id)).toEqual(before);
    await syncPoFromOrder(ports, orderId, 'completed', NOW);
    // A late report from before can't undo the end.
    expect(await syncPoFromOrder(ports, orderId, 'awaiting_approval', NOW)).toMatchObject({
      status: 'fulfilled',
      moved: [],
    });
    expect(await syncPoFromOrder(ports, orderId, 'cancelled', NOW)).toMatchObject({
      status: 'fulfilled',
      moved: [],
    });
  });

  it('rejects a declined PO that waited, and cancels one that was ordered', async () => {
    const ports = setup();
    const a = await submitted(ports, 'PO-A');
    await syncPoFromOrder(ports, a.orderId, 'awaiting_approval', NOW);
    expect(await syncPoFromOrder(ports, a.orderId, 'declined', NOW)).toMatchObject({
      status: 'rejected',
    });
    const b = await submitted(ports, 'PO-B');
    await syncPoFromOrder(ports, b.orderId, 'proceeding', NOW);
    expect(await syncPoFromOrder(ports, b.orderId, 'failed', NOW)).toMatchObject({
      status: 'cancelled',
    });
    const c = await submitted(ports, 'PO-C');
    expect(await syncPoFromOrder(ports, c.orderId, 'rolled_back', NOW)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('lets two agents report at once to one result', async () => {
    const ports = setup();
    const { po, orderId } = await submitted(ports);
    const results = await Promise.all([
      syncPoFromOrder(ports, orderId, 'proceeding', NOW),
      syncPoFromOrder(ports, orderId, 'proceeding', NOW),
      syncPoFromOrder(ports, orderId, 'cancelled', NOW),
    ]);
    // Whatever the interleaving, the PO ends in a state the lifecycle allows and every writer saw one.
    const end = await status(ports, po.id);
    expect(['ordered', 'cancelled']).toContain(end);
    for (const r of results) expect(r.found).toBe(true);
  });

  it('acts only on the PO the order is linked to', async () => {
    const ports = setup();
    const po = await draft(ports);
    expect(await syncPoFromOrder(ports, 'ord_nope', 'completed', NOW)).toEqual({
      found: false,
      status: null,
      moved: [],
    });
    // A draft with no order moves for nothing.
    expect(await status(ports, po.id)).toBe('draft');
  });
});

describe('recording an inbound purchase order', () => {
  const edi = (over: object = {}) => ({
    orderId: 'ord_abc',
    companyId: 'acme',
    poNumber: 'NW-77',
    source: 'edi' as const,
    currency: 'USD',
    lines: [{ sku: 'WID-1', qty: 3, unitPrice: 9.5 }],
    shipTo: { line1: '9 Yard St', city: 'Reno', postalCode: '89501', country: 'US' },
    ...over,
  });

  it('records it submitted, with its source, lines and order', async () => {
    const ports = setup();
    const r = await recordInboundPo(ports, edi(), NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.recorded).toBe(true);
    expect(r.audit).toMatchObject({
      action: 'purchase_order.received',
      detail: { source: 'edi', order: 'ord_abc', poNumber: 'NW-77' },
    });
    expect(await ports.purchaseOrders.get(ALL, 'po_abc')).toMatchObject({
      companyId: 'acme',
      poNumber: 'NW-77',
      status: 'submitted',
      source: 'edi',
      orderId: 'ord_abc',
      buyerId: null,
      shipTo: { line1: '9 Yard St', city: 'Reno' },
      lines: [{ sku: 'WID-1', name: null, qty: 3, unitPrice: 9.5 }],
    });
    // And it follows its order like any other.
    expect(await syncPoFromOrder(ports, 'ord_abc', 'awaiting_approval', NOW)).toMatchObject({
      status: 'pending_approval',
    });
  });

  it('is safe to repeat', async () => {
    const ports = setup();
    await recordInboundPo(ports, edi(), NOW);
    expect(await recordInboundPo(ports, edi(), NOW + 1)).toMatchObject({
      ok: true,
      recorded: false,
      audit: null,
    });
    expect((await ports.purchaseOrders.list(ALL, {}, { limit: 10 })).total).toBe(1);
  });

  it('keeps an email PO with no lines yet, and drops a text address', async () => {
    const ports = setup();
    await recordInboundPo(
      ports,
      edi({
        orderId: 'ord_mail',
        source: 'email',
        poNumber: 'EML-1',
        lines: [],
        shipTo: '1 Main St',
      }),
      NOW,
    );
    expect(await ports.purchaseOrders.get(ALL, 'po_mail')).toMatchObject({
      source: 'email',
      shipTo: null,
      lines: [],
    });
  });

  it('says why it isn’t recorded, and never gets in the order’s way', async () => {
    const ports = setup();
    expect(await recordInboundPo(ports, edi({ companyId: undefined }), NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no customer/),
    });
    expect(await recordInboundPo(ports, edi({ companyId: 'nobody' }), NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a company/),
    });
    await recordInboundPo(ports, edi(), NOW);
    expect(await recordInboundPo(ports, edi({ orderId: 'ord_other' }), NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already has a purchase order NW-77/),
    });
    expect((await ports.purchaseOrders.list(ALL, {}, { limit: 10 })).total).toBe(1);
  });
});

describe('listing purchase orders', () => {
  it('pages newest first with a total, filters by company, status and day, and refuses a bad cursor', async () => {
    const ports = setup();
    for (const [i, day] of ['2026-11-01', '2026-11-02', '2026-11-03'].entries()) {
      const r = await createPoDraft(
        ports,
        ALL,
        draftInput({ poNumber: `PO-${i}`, companyId: i === 1 ? 'globex' : 'acme', buyerId: null }),
        nextId,
        Date.parse(`${day}T15:00:00Z`),
      );
      if (!r.ok) throw new Error(r.error);
    }
    const first = await listPurchaseOrders(ports, ALL, { limit: 2 });
    if (!first.ok) throw new Error(first.error);
    expect(first.purchaseOrders.map((p) => p.poNumber)).toEqual(['PO-2', 'PO-1']);
    expect(first.total).toBe(3);
    expect(first.purchaseOrders[0]).toMatchObject({
      lineCount: 2,
      href: expect.stringMatching(/^\/purchase-orders\/po_/),
    });
    const second = await listPurchaseOrders(ports, ALL, { limit: 2, cursor: first.cursor ?? '' });
    expect(second.ok && second.purchaseOrders.map((p) => p.poNumber)).toEqual(['PO-0']);
    expect(second.ok && second.cursor).toBeNull();

    const company = await listPurchaseOrders(ports, ALL, { companyId: 'globex' });
    expect(company.ok && company.purchaseOrders.map((p) => p.poNumber)).toEqual(['PO-1']);
    // A day bound takes the whole day: the 2nd, 15:00 is on or before the 2nd.
    const days = await listPurchaseOrders(ports, ALL, { from: '2026-11-02', to: '2026-11-02' });
    expect(days.ok && days.purchaseOrders.map((p) => p.poNumber)).toEqual(['PO-1']);
    expect(await listPurchaseOrders(ports, ALL, { from: 'soon' })).toMatchObject({ ok: false });
    expect(await listPurchaseOrders(ports, ALL, { cursor: 'junk' })).toMatchObject({ ok: false });
    expect(
      await listPurchaseOrders(ports, { companyId: 'acme' }, { companyId: 'globex' }),
    ).toMatchObject({
      ok: true,
      total: 0,
    });
  });
});
