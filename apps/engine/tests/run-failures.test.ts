/**
 * A throw that reaches the Workflow's `run()` from anywhere but a node's own step still finishes
 * the order as failed: with a reason, an `order.failed` delivery, and the rollbacks Workflows runs
 * for the instance. Without that report the agent never polls the instance, and the order sits
 * running (or waiting, or queued) forever.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Order, OrderInput, OrderState } from '@commerceworker/core';
import {
  auditEvents,
  createDb,
  creditHolds,
  customers,
  publishFlow,
  reservations,
  webhookDeliveries,
  webhookSubscriptions,
} from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadFlowVersion } from '../src/flows';
import { orderAgent } from '../src/namespaces';
import { EXECUTORS } from '../src/nodes';
import { startOrder } from '../src/orders';

const db = () => createDb(env.DB);
const state = async (id: string) => (await orderAgent(env, id).snapshot()) as OrderState;

async function until<T>(fn: () => Promise<T | false>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
/** A failed order reports `failed` first, then `rolled_back` once the agent has polled the instance. */
const failed = (id: string, rolledBack = true) =>
  until(async () => {
    const s = await state(id);
    const done = rolledBack ? s.rollback != null : s.status === 'failed';
    return ['failed', 'rolled_back'].includes(s.status) && done ? s : false;
  }, 'a failed order');

/** Waits for the Workflow instance to end, so a count of deliveries is taken after the last step. */
const instanceEnded = (orderId: string) =>
  until(async () => {
    const id = (await state(orderId)).instanceId;
    if (!id) return false;
    const { status } = await (await env.ORDER_WORKFLOW.get(id)).status();
    return ['errored', 'complete', 'terminated'].includes(status) ? status : false;
  }, 'the instance to end');

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
async function introspect() {
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
}

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

const input = (): OrderInput => ({
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  customerId: 'cus_northwind',
  lines: [{ sku: 'WID-100', qty: 1 }],
  meta: {},
});

const end = (id: string) => node(id, 'control.end', { outcome: 'completed', reason: 'Done' });

beforeAll(async () => {
  await flow(
    'test-run-bad-approval',
    [
      node('start', 'trigger.manual'),
      node('reserve', 'commerce.reserve_inventory'),
      node('mgr', 'control.approval', { approvers: 'nobody:x' }),
      end('done'),
    ],
    [edge('start', 'reserve'), edge('reserve', 'mgr', 'ok'), edge('mgr', 'done', 'approved')],
  );
  await flow(
    'test-run-bad-until',
    [
      node('start', 'trigger.manual'),
      node('reserve', 'commerce.reserve_inventory'),
      node('nap', 'control.wait', { until: { no_such_operation: [1] } }),
      end('done'),
    ],
    [edge('start', 'reserve'), edge('reserve', 'nap', 'ok'), edge('nap', 'done')],
  );
  await flow(
    'test-run-bad-sku',
    [node('start', 'trigger.manual'), node('validate', 'commerce.validate'), end('done')],
    [edge('start', 'validate'), edge('validate', 'done', 'ok')],
  );
  await flow(
    'test-run-parallel',
    [
      node('start', 'trigger.manual'),
      node('reserve', 'commerce.reserve_inventory'),
      node('ghost', 'ghost_node'),
      end('done'),
    ],
    [edge('start', 'reserve'), edge('start', 'ghost'), edge('reserve', 'done', 'ok')],
  );
  await flow(
    'test-run-release',
    [
      node('start', 'trigger.manual'),
      node('price', 'commerce.price', { useContracts: false, usePriceRules: false }),
      node('credit', 'commerce.credit_check'),
      end('done'),
    ],
    [edge('start', 'price'), edge('price', 'credit'), edge('credit', 'done', 'ok')],
  );
  await flow(
    'test-run-two-fail',
    [
      node('start', 'trigger.manual'),
      node('ghost', 'ghost_node'),
      node('phantom', 'phantom_node'),
      end('done'),
    ],
    [edge('start', 'ghost'), edge('start', 'phantom'), edge('ghost', 'done')],
  );
  await flow(
    'test-run-fail-and-bad-wait',
    [
      node('start', 'trigger.manual'),
      node('ghost', 'ghost_node'),
      node('mgr', 'control.approval', { approvers: 'nobody:x' }),
      end('done'),
    ],
    [edge('start', 'ghost'), edge('start', 'mgr'), edge('ghost', 'done')],
  );
  await flow(
    'test-run-two-ways',
    [
      node('start', 'trigger.manual'),
      node('check', 'commerce.validate'),
      node('mgr', 'control.approval', { approvers: 'nobody:x' }),
      end('done'),
    ],
    [edge('start', 'check'), edge('start', 'mgr'), edge('check', 'done', 'ok')],
  );
  await flow(
    'test-run-end-failed',
    [
      node('start', 'trigger.manual'),
      node('boom', 'control.end', { outcome: 'failed', reason: 'Boom' }),
    ],
    [edge('start', 'boom')],
  );
  await flow(
    'test-run-company-approval',
    [
      node('start', 'trigger.manual'),
      node('mgr', 'control.approval', { approvers: 'company:approver' }),
      end('done'),
    ],
    [edge('start', 'mgr'), edge('mgr', 'done', 'approved')],
  );
  await flow(
    'test-run-no-executor',
    [
      node('start', 'trigger.manual'),
      node('reserve', 'commerce.reserve_inventory'),
      node('ghost', 'ghost_node'),
      end('done'),
    ],
    [edge('start', 'reserve'), edge('reserve', 'ghost', 'ok'), edge('ghost', 'done')],
  );
});

describe('a throw outside a node’s own step', () => {
  const received: { event: string; orderId: string; data: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    await db()
      .insert(webhookSubscriptions)
      .values({
        id: 'run-failures',
        url: 'https://hooks.example/run-failures',
        secret: 'whsec_run_failures',
        events: JSON.stringify(['order.failed']),
        createdAt: Date.now(),
      });
  });
  afterEach(async () => {
    await introspector?.dispose();
    received.length = 0;
    vi.restoreAllMocks();
  });
  const capture = () =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      received.push(JSON.parse(String(init?.body)));
      return new Response('ok');
    });
  const deliveries = async (orderId: string) =>
    (await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.orderId, orderId)))
      .filter((d) => d.event === 'order.failed')
      .map((d) => d.status);
  const reserved = async (orderId: string) =>
    (await db().select().from(reservations).where(eq(reservations.orderId, orderId))).filter(
      (r) => r.status === 'held',
    ).length;

  it('fails the order when an approval cannot be opened, and rolls the earlier steps back', async () => {
    capture();
    await introspect();
    const { orderId } = await startOrder(env, { flowId: 'test-run-bad-approval', input: input() });
    const done = await failed(orderId);
    expect(done.reason).toContain('mgr');
    expect(done.nodes.reserve!.status).toBe('rolled_back');
    expect(done.nodes.mgr!.status).toBe('failed');
    await until(async () => received.some((r) => r.orderId === orderId), 'order.failed delivery');
    expect(received.filter((r) => r.orderId === orderId).map((r) => r.event)).toEqual([
      'order.failed',
    ]);
    expect(await deliveries(orderId)).toEqual(['delivered']);
    expect(await reserved(orderId)).toBe(0);
  });

  it('fails the order when a wait’s until cannot be evaluated', async () => {
    capture();
    await introspect();
    const { orderId } = await startOrder(env, { flowId: 'test-run-bad-until', input: input() });
    const done = await failed(orderId);
    expect(done.reason).toContain('nap');
    expect(done.nodes.reserve!.status).toBe('rolled_back');
    await until(async () => received.some((r) => r.orderId === orderId), 'order.failed delivery');
    expect(await deliveries(orderId)).toEqual(['delivered']);
  });

  it('fails the order when a node has no executor', async () => {
    capture();
    await introspect();
    const { orderId } = await startOrder(env, { flowId: 'test-run-no-executor', input: input() });
    const done = await failed(orderId);
    expect(done.reason).toBe('ghost: No executor for ghost_node');
    expect(done.nodes.reserve!.status).toBe('rolled_back');
    await until(async () => received.some((r) => r.orderId === orderId), 'order.failed delivery');
    expect(await deliveries(orderId)).toEqual(['delivered']);
  });

  it('fails an order whose flow version is missing, before its first report', async () => {
    capture();
    await introspect();
    const real = (await loadFlowVersion(env, 'test-run-bad-approval'))!;
    const orderId = `ord_missing_${crypto.randomUUID().slice(0, 8)}`;
    const order: Order = {
      ...input(),
      id: orderId,
      createdAt: Date.now(),
      subtotal: 0,
      shipping: 0,
      tax: 0,
      total: 0,
    };
    await orderAgent(env, orderId).init(order, real, `${orderId}-wf`);
    await env.ORDER_WORKFLOW.create({
      id: `${orderId}-wf`,
      params: { orderId, flowId: 'no-such-flow', version: 1, generation: 1, order, vars: {} },
    });
    const done = await failed(orderId, false);
    expect(done.reason).toBe('Flow no-such-flow v1 not found');
    await until(async () => received.some((r) => r.orderId === orderId), 'order.failed delivery');
    expect(await deliveries(orderId)).toEqual(['delivered']);
  });

  it('emits order.failed once when a node’s own step throws, however many reports there are', async () => {
    capture();
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'test-run-bad-sku',
      input: { ...input(), lines: [{ sku: 'NOPE-404', qty: 1 }] },
    });
    await failed(orderId, false);
    await instanceEnded(orderId);
    expect(await deliveries(orderId)).toEqual(['delivered']);
  });

  it('compensates a sibling still inside its step when another node in the batch throws', async () => {
    capture();
    await introspect();
    // The reservation is made, then the step lingers: the ghost node throws and fails the run
    // while the step is still open, before it has returned its output.
    const real = EXECUTORS['commerce.reserve_inventory']!;
    let landed!: () => void;
    const reservedAt = new Promise<void>((res) => {
      landed = res;
    });
    vi.spyOn(EXECUTORS, 'commerce.reserve_inventory').mockImplementation(async (x) => {
      const r = await real(x);
      landed();
      await new Promise((res) => setTimeout(res, 1_500));
      return r;
    });
    const { orderId } = await startOrder(env, { flowId: 'test-run-parallel', input: input() });
    await failed(orderId, false);
    await Promise.race([reservedAt, new Promise((res) => setTimeout(res, 10_000))]);
    const rows = () => db().select().from(reservations).where(eq(reservations.orderId, orderId));
    expect(await rows()).not.toEqual([]);
    // The compensation runs for a step that finished after its sibling failed the run.
    await until(async () => (await reserved(orderId)) === 0, 'the reservation released', 10_000);
    expect((await state(orderId)).nodes.reserve!.status).toBe('rolled_back');
  });

  it('keeps an order completed when giving back its credit fails for good', async () => {
    capture();
    await introspect();
    const customerId = `cus_rel_${crypto.randomUUID().slice(0, 8)}`;
    await db()
      .insert(customers)
      .values({
        id: customerId,
        name: customerId,
        email: `${customerId}@example.com`,
        kind: 'business',
        creditLimit: 5_000,
        balance: 0,
      });
    // Only this customer's holds can't be released, so no other test sees the trigger fire.
    await env.DB.exec(
      `CREATE TRIGGER no_release_${customerId} BEFORE UPDATE ON credit_holds WHEN OLD.customer_id = '${customerId}' BEGIN SELECT RAISE(ABORT, 'release blocked'); END`,
    );
    try {
      const { orderId } = await startOrder(env, {
        flowId: 'test-run-release',
        input: {
          ...input(),
          customerId,
          lines: [{ sku: 'WID-100', qty: 1, unitPrice: 600 }],
        },
      });
      const done = await until(async () => {
        const s = await state(orderId);
        return s.timeline.some((t) => t.message.includes('releasing its credit holds failed'))
          ? s
          : false;
      }, 'the release problem on the timeline');
      // The outcome stands: no failure, no rollback, no order.failed.
      await until(async () => (await state(orderId)).status === 'completed', 'completed');
      const s = await state(orderId);
      expect(s.rollback ?? null).toBeNull();
      expect(s.reason ?? '').toBe('Done');
      expect(done.timeline.find((t) => t.message.includes('releasing'))).toMatchObject({
        kind: 'rollback',
      });
      expect(
        (await db().select().from(creditHolds).where(eq(creditHolds.orderId, orderId)))[0],
      ).toMatchObject({ status: 'held' });
      const audits = (await db().select().from(auditEvents)).filter(
        (a) => a.action === 'order.release_failed' && a.target === orderId,
      );
      expect(audits).toHaveLength(1);
      await new Promise((res) => setTimeout(res, 500));
      expect(received.filter((r) => r.orderId === orderId)).toEqual([]);
      expect(await deliveries(orderId)).toEqual([]);
    } finally {
      await env.DB.exec(`DROP TRIGGER no_release_${customerId}`);
    }
  });

  it('sends one order.failed when two nodes of a batch fail together', async () => {
    capture();
    await introspect();
    const { orderId } = await startOrder(env, { flowId: 'test-run-two-fail', input: input() });
    await failed(orderId, false);
    await instanceEnded(orderId);
    expect(await deliveries(orderId)).toEqual(['delivered']);
    expect(received.filter((r) => r.orderId === orderId)).toHaveLength(1);
  });

  it('sends one order.failed when a node fails beside a wait that cannot open', async () => {
    capture();
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'test-run-fail-and-bad-wait',
      input: input(),
    });
    const done = await failed(orderId, false);
    await instanceEnded(orderId);
    expect(done.reason).toMatch(/^(ghost|mgr): /);
    expect(await deliveries(orderId)).toEqual(['delivered']);
    expect(received.filter((r) => r.orderId === orderId)).toHaveLength(1);
  });

  it('sends one order.failed for an End node that fails the order', async () => {
    capture();
    await introspect();
    const { orderId } = await startOrder(env, { flowId: 'test-run-end-failed', input: input() });
    const done = await failed(orderId, false);
    await instanceEnded(orderId);
    expect(done.reason).toBe('Boom');
    expect(await deliveries(orderId)).toEqual(['delivered']);
    expect(received.filter((r) => r.orderId === orderId)).toHaveLength(1);
  });

  it('retries an approval whose approvers cannot be read, instead of failing the order', async () => {
    // Real retry delays here: the `:open` step fails once while the company's members are out of reach
    // (nothing before it reads them, so only the approval's own step can fail).
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
    });
    await env.DB.exec('ALTER TABLE company_members RENAME TO company_members_away');
    let back = false;
    const restore = async () => {
      if (back) return;
      back = true;
      await env.DB.exec('ALTER TABLE company_members_away RENAME TO company_members');
    };
    try {
      const { orderId } = await startOrder(env, {
        flowId: 'test-run-company-approval',
        input: input(),
      });
      await new Promise((res) => setTimeout(res, 2_000));
      expect((await state(orderId)).status).not.toBe('failed');
      await restore();
      const s = await until(async () => {
        const x = await state(orderId);
        return x.waits.some((w) => w.nodeId === 'mgr') ? x : false;
      }, 'the approval to open on a retry');
      expect(s.status).not.toBe('failed');
      await orderAgent(env, orderId).cancel('Test over');
    } finally {
      await restore();
    }
  });

  it('marks the blamed node failed even when a sibling’s own step reported first', async () => {
    capture();
    await introspect();
    // `mgr`'s `:open` rejects the batch while `check`'s own step is still working toward its throw.
    // Whichever fails first, the node the reason names ends `failed`, and one order.failed goes out.
    const { orderId } = await startOrder(env, {
      flowId: 'test-run-two-ways',
      input: { ...input(), lines: [{ sku: 'NOPE-404', qty: 1 }] },
    });
    const done = await failed(orderId, false);
    await instanceEnded(orderId);
    const named = /^(\w+): /.exec(done.reason ?? '')?.[1];
    expect(named).toMatch(/^(check|mgr)$/);
    expect(done.nodes[named!]!.status).toBe('failed');
    expect(received.filter((r) => r.orderId === orderId)).toHaveLength(1);
  });
});
