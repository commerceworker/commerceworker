/**
 * Purchase orders in the engine (docs/b2b.md, S6), on real Workflows and the B2B PO flow itself:
 * a draft is edited and submitted through the tools REST and MCP run, submitting starts one order
 * tied to the PO by the engine, and from then on the OrderAgent mirrors the order's progress into
 * the PO (an approval wait, the company approvers' votes, the order going ahead, shipped and
 * invoiced, declined, cancelled). An inbound EDI or email PO is recorded beside its order, and
 * nothing a caller sends can point an order at a PO.
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
import { createDb, customers, documents, orders } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { previewAction } from '../src/assistant/data';
import { ensureTemplates } from '../src/flows';
import { startOrderOnce } from '../src/orders';
import { companyDirectory, documentStore, purchaseOrderStore } from '../src/wire';
import { signedActor } from './principal';

const ALL = { all: true } as const;
const db = () => createDb(env.DB);
const dir = () => companyDirectory(env);
const pos = () => purchaseOrderStore(env);
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
/** The PO's status once it is `want` (the mirror runs just after the report that causes it). */
const reaches = (poId: string, want: PoStatus | PoStatus[]) =>
  until(
    async () => {
      const po = await pos().get(ALL, poId);
      return po && [want].flat().includes(po.status) ? po : false;
    },
    `the purchase order to be ${[want].flat().join(' or ')}`,
  );

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

const staff = (role: Role, id = `usr_po_${role}`): RpcActor =>
  ({ kind: 'staff', id, name: `${id}@example.com`, role }) as RpcActor;
/** A tool as REST runs it: signed for that one call. */
const run = async (tool: string, input: unknown, actor: RpcActor = staff('operator')) =>
  api().runOperation(tool, input, await signedActor(actor, await operationCall(tool, input)));
const decide = async (orderId: string, memberId: string) =>
  api().decide(
    orderId,
    'approval',
    'approved',
    await signedActor(staff('approver'), `decide:${orderId}`),
    undefined,
    memberId,
  );

/** A business customer with 100,000 of credit and an active company: a buyer and an approver. */
async function company(over: { status?: 'active' | 'suspended' } = {}) {
  const id = `cpo_${suffix()}`;
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
      status: over.status ?? 'active',
      legalName: `${id} Ltd`,
      taxId: null,
      parentCompanyId: null,
      createdAt: 1,
      updatedAt: 1,
    },
  );
  await db().update(customers).set({ creditLimit: 100_000 }).where(eq(customers.id, id));
  const member = (key: string, role: 'buyer' | 'approver') => ({
    id: `${id}_${key}`,
    name: key,
    email: `${key}@${id}.test`,
    role,
    teamId: null,
    status: 'active' as const,
    orderLimit: null,
  });
  await dir().upsertMembers(id, [member('ann', 'buyer'), member('bo', 'approver')], 1);
  return { id, ann: `${id}_ann`, bo: `${id}_bo` };
}

const SHIP_TO = { line1: '1 Dock Rd', city: 'Austin', postalCode: '78701', country: 'US' };
const draftOf = (c: { id: string; ann: string }, qty: number, over: object = {}) => ({
  companyId: c.id,
  poNumber: `PO-${suffix()}`,
  buyerId: c.ann,
  shipTo: SHIP_TO,
  lines: [{ sku: 'WID-100', qty }],
  ...over,
});

/** Drafts and submits a PO for `qty` widgets through the tools; returns what is needed after. */
async function submitted(c: { id: string; ann: string }, qty: number, over: object = {}) {
  const made = await run('create_po_draft', draftOf(c, qty, over));
  if (!made.ok) throw new Error(made.error);
  const po = (made.value as { purchaseOrder: { id: string; poNumber: string } }).purchaseOrder;
  const sent = await run('submit_po', { poId: po.id });
  if (!sent.ok) throw new Error(sent.error);
  const { orderId } = sent.value as { orderId: string };
  return { poId: po.id, poNumber: po.poNumber, orderId };
}

describe('drafting and submitting through the tools', () => {
  it('edits a draft, submits it once, and follows the order to fulfilled with the PO number on its invoice', async () => {
    await introspect();
    const c = await company();
    const made = await run('create_po_draft', draftOf(c, 10, { poNumber: 'PO-DRAFT' }));
    expect(made).toMatchObject({ ok: true });
    const id =
      (made.ok && (made.value as { purchaseOrder: { id: string } }).purchaseOrder.id) || '';
    expect(await pos().get(ALL, id)).toMatchObject({
      status: 'draft',
      source: 'api',
      orderId: null,
    });

    // A draft is edited with the same tool as many times as it likes.
    expect(
      await run('update_po_draft', {
        poId: id,
        notes: 'Deliver to the dock',
        lines: [{ sku: 'WID-100', qty: 12, name: 'Widgets' }],
      }),
    ).toMatchObject({ ok: true });
    expect(await pos().get(ALL, id)).toMatchObject({
      notes: 'Deliver to the dock',
      lines: [{ sku: 'WID-100', name: 'Widgets', qty: 12, unitPrice: null }],
    });

    const sent = await run('submit_po', { poId: id });
    if (!sent.ok) throw new Error(sent.error);
    const { orderId } = sent.value as { orderId: string };
    // Submitting again is the same order: no second one starts.
    const again = await run('submit_po', { poId: id });
    expect(again).toMatchObject({ ok: true, value: { orderId } });
    expect(
      await db().select({ id: orders.id }).from(orders).where(eq(orders.customerId, c.id)),
    ).toHaveLength(1);

    // The PO is tied to its order by the engine, and carries its number and buyer into it.
    const po = await pos().get(ALL, id);
    expect(po?.orderId).toBe(orderId);
    expect((await state(orderId)).order?.meta).toMatchObject({
      purchaseOrderId: id,
      poNumber: 'PO-DRAFT',
      buyerId: c.ann,
      notes: 'Deliver to the dock',
    });

    // 12 widgets are well under the approval threshold and within credit: it runs straight through.
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.approval?.status).toBe('skipped');
    expect(done.nodes.budget?.branches).toEqual(['within']);
    expect((await reaches(id, 'fulfilled')).status).toBe('fulfilled');

    // The invoice the flow filed names the buyer's PO number, for their accounts payable.
    const invoice = await documentStore(env).text(String(done.vars.invoiceKey));
    expect(invoice).toContain('<b>PO number:</b> PO-DRAFT');
    expect(invoice).toContain('net_30');

    // A PO that went to an order can't be edited, and can't be submitted for another.
    expect(await run('update_po_draft', { poId: id, notes: 'Too late' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/only a draft can be changed/),
    });
    expect((await pos().get(ALL, id))?.notes).toBe('Deliver to the dock');
  });

  it('holds a viewer to reading, and reads a company’s POs through the tools', async () => {
    const c = await company();
    const other = await company();
    const a = await run('create_po_draft', draftOf(c, 1, { poNumber: 'PO-A' }));
    await run('create_po_draft', draftOf(other, 1, { poNumber: 'PO-A' }));
    expect(
      await run('create_po_draft', draftOf(c, 1, { poNumber: 'po-a' }), staff('viewer')),
    ).toMatchObject({ ok: false });
    expect(await run('list_purchase_orders', {}, staff('viewer'))).toMatchObject({ ok: true });
    // The same number is fine in another company; the same company refuses it.
    expect(await run('create_po_draft', draftOf(c, 1, { poNumber: 'po-a' }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/has that number/),
    });
    const list = await run('list_purchase_orders', { companyId: c.id, limit: 5 }, staff('viewer'));
    expect(list).toMatchObject({ ok: true, value: { total: 1 } });
    const id = (a.ok && (a.value as { purchaseOrder: { id: string } }).purchaseOrder.id) || '';
    expect(await run('get_purchase_order', { poId: id }, staff('viewer'))).toMatchObject({
      ok: true,
      value: { purchaseOrder: { poNumber: 'PO-A', lines: [{ sku: 'WID-100' }] } },
    });
    // Submitting and cancelling are an operator's.
    expect(await run('submit_po', { poId: id }, staff('viewer'))).toMatchObject({ ok: false });
    expect(await run('cancel_po', { poId: id }, staff('viewer'))).toMatchObject({ ok: false });
  });
});

describe('following an order that needs approval', () => {
  it('goes pending approval, approved and ordered at the company approver’s vote, then fulfilled', async () => {
    await introspect();
    const c = await company();
    // 300 widgets are over the $5,000 the flow asks a company approver about.
    const { poId, orderId } = await submitted(c, 300);
    // What the PO went through, watched from the submit: each state once, only forward.
    const seen: PoStatus[] = [];
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const status = (await pos().get(ALL, poId))?.status;
        if (status && seen.at(-1) !== status) seen.push(status);
        await new Promise((r) => setTimeout(r, 15));
      }
    })();
    const waiting = await waitingApproval(orderId);
    expect(waiting.waits[0]?.approval).toMatchObject({
      approvers: 'company:approver',
      companyId: c.id,
    });
    expect((await reaches(poId, 'pending_approval')).status).toBe('pending_approval');
    // A PO waiting on its approvers can't be edited either.
    expect(await run('update_po_draft', { poId, notes: 'x' })).toMatchObject({ ok: false });

    expect(await decide(orderId, c.bo)).toMatchObject({ ok: true, outcome: 'approved' });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.approval?.branches).toEqual(['approved']);
    expect((await reaches(poId, 'fulfilled')).status).toBe('fulfilled');
    watching = false;
    await watcher;
    // Forward only, through the approval wait and the votes' outcome to the end. (`approved` and
    // `ordered` follow each other in one report, so a poll may or may not catch them.)
    const order: PoStatus[] = ['submitted', 'pending_approval', 'approved', 'ordered', 'fulfilled'];
    expect(seen).toContain('pending_approval');
    expect(seen.at(-1)).toBe('fulfilled');
    expect(seen.map((s) => order.indexOf(s))).toEqual(
      [...seen.map((s) => order.indexOf(s))].sort((a, b) => a - b),
    );
  });

  it('rejects the PO when its approver says no, and takes nothing for it', async () => {
    await introspect();
    const c = await company();
    const { poId, orderId } = await submitted(c, 300);
    await waitingApproval(orderId);
    await api().decide(
      orderId,
      'approval',
      'rejected',
      await signedActor(staff('approver'), `decide:${orderId}`),
      'Not this quarter',
      c.bo,
    );
    expect((await settled(orderId)).status).toBe('declined');
    expect((await reaches(poId, 'rejected')).status).toBe('rejected');
    // A rejected PO is over: it takes no cancel and no second submit.
    expect(await run('cancel_po', { poId })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/rejected, which is final/),
    });
    expect(await run('submit_po', { poId })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is rejected/),
    });
  });

  it('cancels the PO and its waiting order together, and gives its number back', async () => {
    await introspect();
    const c = await company();
    const { poId, poNumber, orderId } = await submitted(c, 300);
    await waitingApproval(orderId);
    const preview = await run('cancel_po', { poId, reason: 'Duplicate order' });
    expect(preview).toMatchObject({ ok: true });
    expect((await settled(orderId)).status).toBe('cancelled');
    expect((await reaches(poId, 'cancelled')).status).toBe('cancelled');
    // Again: nothing to cancel, and the card says so.
    expect(await run('cancel_po', { poId })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already cancelled/),
    });
    // The number is free for a corrected PO.
    expect(await run('create_po_draft', draftOf(c, 1, { poNumber }))).toMatchObject({ ok: true });
  });

  it('cancels a PO that is still a draft without any order', async () => {
    const c = await company();
    const made = await run('create_po_draft', draftOf(c, 1));
    const id =
      (made.ok && (made.value as { purchaseOrder: { id: string } }).purchaseOrder.id) || '';
    expect(await run('cancel_po', { poId: id })).toMatchObject({ ok: true });
    expect((await pos().get(ALL, id))?.status).toBe('cancelled');
    expect(await run('submit_po', { poId: id })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is cancelled/),
    });
  });
});

describe('what ties an order to a PO', () => {
  it('ignores a caller’s link and a caller’s own purchaseOrderId', async () => {
    await introspect();
    const c = await company();
    const made = await run('create_po_draft', draftOf(c, 1));
    const id =
      (made.ok && (made.value as { purchaseOrder: { id: string } }).purchaseOrder.id) || '';
    // Over the binding, a `link` is dropped: the order starts, and the PO is none the wiser.
    const viaBinding = await api().startOrderOnce({
      flowId: 'tpl-b2b-purchase-order',
      idempotencyKey: `forged-${suffix()}`,
      purchaseOrder: { link: id },
      input: {
        model: 'b2b',
        channel: 'api',
        customerId: c.id,
        lines: [{ sku: 'WID-100', qty: 1 }],
        meta: { shipTo: SHIP_TO, purchaseOrderId: id },
      },
    });
    if ('mismatch' in viaBinding) throw new Error('mismatch');
    expect((await state(viaBinding.orderId)).order?.meta.purchaseOrderId).toBeUndefined();
    await settled(viaBinding.orderId);
    expect(await pos().get(ALL, id)).toMatchObject({ status: 'draft', orderId: null });
  });

  it('refuses to link an order to a PO that isn’t the order’s company’s, or already has an order', async () => {
    const c = await company();
    const other = await company();
    const made = await run('create_po_draft', draftOf(c, 1));
    const id =
      (made.ok && (made.value as { purchaseOrder: { id: string } }).purchaseOrder.id) || '';
    const start = (customerId: string) =>
      startOrderOnce(env, {
        flowId: 'tpl-b2b-purchase-order',
        idempotencyKey: `link-${suffix()}`,
        purchaseOrder: { link: id },
        input: { model: 'b2b', customerId, lines: [{ sku: 'WID-100', qty: 1 }], meta: {} },
      });
    await expect(start(other.id)).rejects.toThrow(/can't start this order/);
    await expect(start(c.id)).resolves.toMatchObject({ orderId: expect.any(String) });
    // The PO has its order now: another start can't take it.
    await expect(start(c.id)).rejects.toThrow(/can't start this order/);
  });
});

describe('an inbound PO is a record too', () => {
  const edi = (c: { id: string }, poNumber: string) => ({
    flowId: 'tpl-b2b-purchase-order',
    idempotencyKey: `edi-${poNumber}-${c.id}`,
    purchaseOrder: { record: { source: 'edi' as const, poNumber } },
    input: {
      model: 'b2b' as const,
      channel: 'edi' as const,
      externalId: `ISA1:${poNumber}`,
      title: `PO ${poNumber}`,
      customerId: c.id,
      currency: 'USD',
      lines: [{ sku: 'WID-100', qty: 4, unitPrice: 20 }],
      meta: { shipTo: SHIP_TO, edi: { sender: 'ISA1', poNumber } },
    },
  });

  it('records an EDI 850 PO submitted, with its source, lines and order, and follows it', async () => {
    await introspect();
    const c = await company();
    const r = await api().startOrderOnce(edi(c, 'NW-1001'));
    if ('mismatch' in r) throw new Error('mismatch');
    const po = await pos().byOrder(r.orderId);
    expect(po).toMatchObject({
      companyId: c.id,
      poNumber: 'NW-1001',
      source: 'edi',
      orderId: r.orderId,
      buyerId: null,
    });
    // The order carries the PO's number for its invoice, beside the EDI document's own.
    expect((await state(r.orderId)).order?.meta).toMatchObject({
      purchaseOrderId: po?.id,
      poNumber: 'NW-1001',
      edi: { poNumber: 'NW-1001' },
    });
    expect((await pos().get(ALL, po?.id ?? ''))?.lines).toEqual([
      { sku: 'WID-100', name: null, qty: 4, unitPrice: 20 },
    ]);
    expect((await settled(r.orderId)).status).toBe('completed');
    expect((await reaches(po?.id ?? '', 'fulfilled')).status).toBe('fulfilled');

    // A retransmission is the same order and the same record, not a second.
    const again = await api().startOrderOnce(edi(c, 'NW-1001'));
    expect(again).toMatchObject({ orderId: r.orderId, replayed: true });
    expect((await pos().list(ALL, { companyId: c.id }, { limit: 10 })).total).toBe(1);
    // It is audited as received.
    const events = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE action = 'purchase_order.received' AND target = ?",
    )
      .bind(po?.id)
      .all<{ detail: string }>();
    expect(events.results).toHaveLength(1);
    expect(JSON.parse(events.results[0]!.detail)).toMatchObject({
      source: 'edi',
      poNumber: 'NW-1001',
    });
  });

  it('starts the order without a record when the company already has that number, or has no company', async () => {
    await introspect();
    const c = await company();
    await run('create_po_draft', draftOf(c, 1, { poNumber: 'NW-DUP' }));
    const dup = await api().startOrderOnce(edi(c, 'NW-DUP'));
    if ('mismatch' in dup) throw new Error('mismatch');
    expect(await pos().byOrder(dup.orderId)).toBeUndefined();
    expect((await state(dup.orderId)).order?.meta.purchaseOrderId).toBeUndefined();

    // A customer that isn't a company: no record, the order carries on.
    const guest = `cus_not_a_company_${suffix()}`;
    await db()
      .insert(customers)
      .values({
        id: guest,
        name: 'Consumer',
        email: `${guest}@example.test`,
        kind: 'consumer',
        creditLimit: 0,
        balance: 0,
      });
    const r = await api().startOrderOnce(edi({ id: guest }, 'NW-NOCO'));
    if ('mismatch' in r) throw new Error('mismatch');
    expect(await pos().byOrder(r.orderId)).toBeUndefined();
  });
});

describe('the documents a PO flow files', () => {
  it('keeps the invoice for the PO in the order’s documents', async () => {
    await introspect();
    const c = await company();
    const { orderId } = await submitted(c, 5, { poNumber: 'PO-DOCS' });
    await settled(orderId);
    const rows = await db().select().from(documents).where(eq(documents.orderId, orderId));
    expect(rows.map((r) => r.kind)).toContain('invoice');
  });
});

describe('the engine’s own starts and mirrors under failure', () => {
  it('shows what a submit does on its card: lines, the buyer’s expectation, ship-to and buyer', async () => {
    const c = await company();
    const made = await run(
      'create_po_draft',
      draftOf(c, 1, {
        lines: [
          { sku: 'WID-100', qty: 2, unitPrice: 10 },
          { sku: 'GSK-010', qty: 3, unitPrice: 5 },
        ],
      }),
    );
    const id =
      (made.ok && (made.value as { purchaseOrder: { id: string } }).purchaseOrder.id) || '';
    const card = await previewAction(
      env,
      {
        kind: 'user',
        id: 'usr_po_operator',
        name: 'op',
        email: 'op@example.com',
        role: 'operator',
      },
      'submit_po',
      { poId: id },
    );
    expect(card.consequences).toEqual(
      expect.arrayContaining([
        'Lines: WID-100 × 2, GSK-010 × 3',
        expect.stringContaining('The buyer expects $35.00'),
        'Ships to: 1 Dock Rd, Austin, 78701, US',
        `Buyer: ${c.ann}`,
      ]),
    );
    expect(card.blocked).toBeUndefined();
  });

  it('seeds the PO flow before it starts, for a deployment that never did', async () => {
    const c = await company();
    await env.DB.exec("DELETE FROM flow_versions WHERE flow_id = 'tpl-b2b-purchase-order'");
    await env.DB.exec("DELETE FROM flows WHERE id = 'tpl-b2b-purchase-order'");
    const { orderId } = await submitted(c, 1);
    expect(orderId).toMatch(/^ord_/);
  });

  it('starts one order for one key asked twice at once, and one winner when two keys want a PO', async () => {
    await introspect();
    const c = await company();
    const made = await run('create_po_draft', draftOf(c, 1));
    const id =
      (made.ok && (made.value as { purchaseOrder: { id: string } }).purchaseOrder.id) || '';
    await pos().transition(ALL, id, 'draft', 'submitted', Date.now());
    const start = (key: string) =>
      startOrderOnce(env, {
        flowId: 'tpl-b2b-purchase-order',
        idempotencyKey: key,
        purchaseOrder: { link: id },
        input: {
          model: 'b2b',
          customerId: c.id,
          lines: [{ sku: 'WID-100', qty: 1 }],
          meta: { shipTo: SHIP_TO },
        },
      });
    // The same key racing itself: both get the one order, neither is refused.
    const same = await Promise.all([start('po:race-same'), start('po:race-same')]);
    const ids = same.map((r) => ('mismatch' in r ? '' : r.orderId));
    expect(ids[0]).toBe(ids[1]);
    expect((await pos().get(ALL, id))?.orderId).toBe(ids[0]);
    // Another key can't take a PO that has its order.
    await expect(start('po:race-other')).rejects.toThrow(/can't start this order/);
  });

  it('leaves the order and its checkInstance running when the PO store is down, and syncs after', async () => {
    await introspect();
    const c = await company();
    const { poId, orderId } = await submitted(c, 300);
    await waitingApproval(orderId);
    await reaches(poId, 'pending_approval');
    // The PO table refuses writes: the mirror fails.
    await env.DB.exec(
      "CREATE TRIGGER po_down BEFORE UPDATE ON purchase_orders BEGIN SELECT RAISE(ABORT, 'down'); END",
    );
    try {
      // A terminal report must still do the rest of its work: forget events, schedule the check.
      await agent(orderId).report({ status: 'failed', reason: 'The Workflow gave up' });
    } finally {
      await env.DB.exec('DROP TRIGGER po_down');
    }
    expect((await state(orderId)).status).toBe('failed');
    expect((await pos().get(ALL, poId))?.status).toBe('pending_approval');
    const queued = (await (agent(orderId).getSchedules() as unknown)) as { callback: string }[];
    expect(queued.map((q) => q.callback)).toEqual(
      expect.arrayContaining(['checkInstance', 'syncPo']),
    );
    // The retry finds the store back and finishes the mirror.
    await agent(orderId).syncPo({ attempt: 1 });
    expect((await pos().get(ALL, poId))?.status).toBe('cancelled');
  });
});
