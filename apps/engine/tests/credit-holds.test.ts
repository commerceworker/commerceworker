/**
 * Credit holds through real Workflows: the credit check is a guarded hold, so two orders started
 * together can't both pass a limit; the invoice converts the hold into the charge; and a rollback,
 * a cancel and every end of the order give back what it still holds.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { OrderInput, OrderState } from '@commerceworker/core';
import { createDb, creditHolds, customers, publishFlow } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROLLBACKS } from '../src/nodes';
import { startOrder } from '../src/orders';
import { balanceStore } from '../src/wire';

const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;

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
// A failed order reports `failed` first and `rolled_back` once Workflows has run (and the agent has
// heard of) every compensation, so `failed` only counts as settled when `rollback` has been recorded.
const settled = (id: string) =>
  waitingOn(
    id,
    (s) =>
      ['completed', 'declined', 'cancelled', 'rolled_back'].includes(s.status) ||
      (s.status === 'failed' && s.rollback != null),
    'a terminal status and, for a failed order, its rollback',
  );
const waiting = (id: string) =>
  waitingOn(id, (s) => s.waits.some((w) => w.event === 'go'), 'the go event');

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

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
  id,
  type,
  label: id,
  config,
  position: { x: 0, y: 0 },
});
const edge = (source: string, target: string, sourceHandle: string | null = null) => ({
  id: `${source}.${sourceHandle ?? 'out'}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle: null,
});
const flow = (id: string, nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[]) =>
  publishFlow(db(), { id, name: id, description: '', model: 'b2b', channels: [], nodes, edges });

/** Each order is for 600 at the price it names: the price node keeps given prices. */
const PRICE = node('price', 'commerce.price', { useContracts: false, usePriceRules: false });
const order = (customerId: string): OrderInput => ({
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  customerId,
  lines: [{ sku: 'WID-100', qty: 1, unitPrice: 600 }],
  meta: {},
});

/** A business customer of its own, 1,000 to order on account. */
async function customer(balance = 0) {
  const id = `cus_hold_${crypto.randomUUID().slice(0, 8)}`;
  await db()
    .insert(customers)
    .values({
      id,
      name: `Holds ${id}`,
      email: `${id}@example.com`,
      kind: 'business',
      creditLimit: 1_000,
      balance,
    });
  return id;
}
const holds = (orderId: string) =>
  db().select().from(creditHolds).where(eq(creditHolds.orderId, orderId));

beforeAll(async () => {
  // The hold stays while the order waits on `go`, as it does while an order waits on anything.
  await flow(
    'test-credit-wait',
    [
      node('start', 'trigger.manual'),
      PRICE,
      node('credit', 'commerce.credit_check'),
      node('go', 'control.wait_event', { event: 'go' }),
      node('done', 'control.end', { outcome: 'completed', reason: 'Went' }),
      node('over', 'control.end', { outcome: 'declined', reason: 'Over limit' }),
    ],
    [
      edge('start', 'price'),
      edge('price', 'credit'),
      edge('credit', 'go', 'ok'),
      edge('credit', 'over', 'over_limit'),
      edge('go', 'done', 'received'),
      edge('go', 'over', 'timeout'),
    ],
  );
  await flow(
    'test-credit-invoice',
    [
      node('start', 'trigger.manual'),
      PRICE,
      node('credit', 'commerce.credit_check'),
      node('invoice', 'commerce.invoice', { terms: 'net_30' }),
      node('done', 'control.end', { outcome: 'completed', reason: 'Invoiced' }),
      node('over', 'control.end', { outcome: 'declined', reason: 'Over limit' }),
    ],
    [
      edge('start', 'price'),
      edge('price', 'credit'),
      edge('credit', 'invoice', 'ok'),
      edge('credit', 'over', 'over_limit'),
      edge('invoice', 'done', 'ok'),
    ],
  );
  await flow(
    'test-credit-fail',
    [
      node('start', 'trigger.manual'),
      PRICE,
      node('credit', 'commerce.credit_check'),
      node('boom', 'control.end', { outcome: 'failed', reason: 'Something broke' }),
      node('over', 'control.end', { outcome: 'declined', reason: 'Over limit' }),
    ],
    [
      edge('start', 'price'),
      edge('price', 'credit'),
      edge('credit', 'boom', 'ok'),
      edge('credit', 'over', 'over_limit'),
    ],
  );
  await flow(
    'test-credit-decline',
    [
      node('start', 'trigger.manual'),
      PRICE,
      node('credit', 'commerce.credit_check'),
      node('no', 'control.end', { outcome: 'declined', reason: 'Not wanted' }),
    ],
    [edge('start', 'price'), edge('price', 'credit'), edge('credit', 'no', 'ok')],
  );
  await flow(
    'test-credit-nohold',
    [
      node('start', 'trigger.manual'),
      PRICE,
      node('credit', 'commerce.credit_check', { hold: false }),
      node('go', 'control.wait_event', { event: 'go' }),
      node('done', 'control.end', { outcome: 'completed', reason: 'Went' }),
      node('over', 'control.end', { outcome: 'declined', reason: 'Over limit' }),
    ],
    [
      edge('start', 'price'),
      edge('price', 'credit'),
      edge('credit', 'go', 'ok'),
      edge('credit', 'over', 'over_limit'),
      edge('go', 'done', 'received'),
    ],
  );
});

describe('credit holds in the flow', () => {
  it('lets exactly one of two orders started together pass a limit only one fits in', async () => {
    await introspect();
    const id = await customer();
    const [a, b] = await Promise.all([
      startOrder(env, { flowId: 'test-credit-wait', input: order(id) }),
      startOrder(env, { flowId: 'test-credit-wait', input: order(id) }),
    ]);
    const [sa, sb] = await Promise.all([
      waitingOn(a.orderId, (s) => !!s.nodes.credit?.branches, 'the first check'),
      waitingOn(b.orderId, (s) => !!s.nodes.credit?.branches, 'the second check'),
    ]);
    const branches = [sa.nodes.credit!.branches![0], sb.nodes.credit!.branches![0]].sort();
    // 1,000 to order on, 600 each: one holds, the other is over by 200.
    expect(branches).toEqual(['ok', 'over_limit']);
    const [winner, loser] = sa.nodes.credit!.branches![0] === 'ok' ? [a, b] : [b, a];
    expect((await settled(loser.orderId)).status).toBe('declined');
    expect(await holds(loser.orderId)).toEqual([]);
    expect(await holds(winner.orderId)).toMatchObject([{ status: 'held', amount: 600 }]);
    expect(await balanceStore(env).account(id)).toMatchObject({
      balance: 0,
      held: 600,
      available: 400,
    });
    expect((await state(loser.orderId)).nodes.credit!.summary).toBe('Over limit by $200.00');

    // The order that passed finishes without invoicing: the end gives its credit back.
    await waiting(winner.orderId);
    await agent(winner.orderId).deliver('go', {});
    expect((await settled(winner.orderId)).status).toBe('completed');
    expect(await holds(winner.orderId)).toMatchObject([{ status: 'released' }]);
    expect(await balanceStore(env).account(id)).toMatchObject({ held: 0, available: 1_000 });
    expect(
      (await state(winner.orderId)).timeline.some((t) =>
        t.message.includes('Released 1 credit hold'),
      ),
    ).toBe(true);
  });

  it('holds nothing when the node takes no hold, and so lets both through', async () => {
    await introspect();
    const id = await customer();
    const [a, b] = await Promise.all([
      startOrder(env, { flowId: 'test-credit-nohold', input: order(id) }),
      startOrder(env, { flowId: 'test-credit-nohold', input: order(id) }),
    ]);
    for (const o of [a, b]) {
      const s = await waiting(o.orderId);
      expect(s.nodes.credit!.branches).toEqual(['ok']);
      expect(await holds(o.orderId)).toEqual([]);
    }
    await agent(a.orderId).cancel('Test over');
    await agent(b.orderId).cancel('Test over');
  });

  it('converts the hold into the invoice’s charge, once, and releases nothing at the end', async () => {
    await introspect();
    const id = await customer(100);
    const { orderId } = await startOrder(env, {
      flowId: 'test-credit-invoice',
      input: order(id),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(await holds(orderId)).toMatchObject([{ status: 'charged', amount: 600 }]);
    // Owed 100 + 600; the 600 is no longer held, so it isn't counted twice.
    expect(await balanceStore(env).account(id)).toMatchObject({
      balance: 700,
      held: 0,
      available: 300,
    });
    expect(done.timeline.some((t) => t.message.includes('credit hold'))).toBe(false);
  });

  it('gives the credit back when the order fails and rolls back', async () => {
    await introspect();
    const id = await customer();
    const { orderId } = await startOrder(env, { flowId: 'test-credit-fail', input: order(id) });
    const done = await settled(orderId);
    expect(['failed', 'rolled_back']).toContain(done.status);
    expect(await holds(orderId)).toMatchObject([{ status: 'released' }]);
    expect(await balanceStore(env).account(id)).toMatchObject({ held: 0, available: 1_000 });
    expect(done.nodes.credit!.status).toBe('rolled_back');
  });

  it('gives it back when the order ends declined, and when it is cancelled', async () => {
    await introspect();
    const id = await customer();
    const declined = await startOrder(env, { flowId: 'test-credit-decline', input: order(id) });
    expect((await settled(declined.orderId)).status).toBe('declined');
    expect(await holds(declined.orderId)).toMatchObject([{ status: 'released' }]);

    const open = await startOrder(env, { flowId: 'test-credit-wait', input: order(id) });
    await waiting(open.orderId);
    expect((await balanceStore(env).account(id))?.held).toBe(600);
    await agent(open.orderId).cancel('Changed our mind');
    expect((await settled(open.orderId)).status).toBe('cancelled');
    expect(await holds(open.orderId)).toMatchObject([{ status: 'released' }]);
    expect((await balanceStore(env).account(id))?.held).toBe(0);
  });

  it('releases idempotently as the saga’s compensation', async () => {
    const id = await customer();
    await balanceStore(env).hold({
      orderId: 'ord_saga_credit',
      stepKey: 'credit#1',
      customerId: id,
      amount: 250,
      expiresAt: Date.now() + 60_000,
    });
    expect(await ROLLBACKS['commerce.credit_check']!(env, 'ord_saga_credit', {}, 'credit#1')).toBe(
      'Released 1 credit hold',
    );
    expect(await ROLLBACKS['commerce.credit_check']!(env, 'ord_saga_credit', {}, 'credit#1')).toBe(
      'Released 0 credit holds',
    );
  });
});
