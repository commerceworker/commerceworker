import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createDb, orders } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { SWEEP_QUIET_MS, sweepOrderInstances } from '../src/instance-sweep';
import { startOrder } from '../src/orders';
import { orderRecords } from '../src/wire';

const db = () => createDb(env.DB);
/** Far enough on that every row is quiet. */
const later = () => Date.now() + SWEEP_QUIET_MS + 60_000;

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeAll(async () => {
  await ensureTemplates(env);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await introspector?.dispose();
  introspector = undefined;
});

/** The mismatches an error-level log carried, as the alert sees them. */
type Mismatch = { orderId: string; instanceId: string; workflow: string };
const mismatches = (spy: ReturnType<typeof vi.spyOn>): Mismatch[] =>
  spy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((l: string) => l.includes('order_workflow_mismatch'))
    .map((l: string) => JSON.parse(l));

/** An order with a live Workflow instance, its D1 row saying `running`. */
async function runningOrder() {
  introspector ??= await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const { orderId } = await startOrder(env, {
    flowId: 'tpl-b2b-order',
    input: { model: 'b2b', channel: 'api', currency: 'USD', lines: [], meta: {} },
  });
  await db().update(orders).set({ status: 'running' }).where(eq(orders.id, orderId));
  return orderId;
}

describe('the hourly sweep of running orders against their Workflow instances', () => {
  it('leaves an order whose Workflow is going alone', async () => {
    const orderId = await runningOrder();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await sweepOrderInstances(env, later());
    expect(r.checked).toBeGreaterThanOrEqual(1);
    expect(mismatches(error).map((m) => m.orderId)).not.toContain(orderId);
  });

  it('flags an order whose instance was terminated, at error level, with both statuses', async () => {
    const orderId = await runningOrder();
    await (await env.ORDER_WORKFLOW.get(`${orderId}-g1`)).terminate();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await sweepOrderInstances(env, later());
    expect(r.mismatched).toBeGreaterThanOrEqual(1);
    expect(mismatches(error)).toContainEqual({
      type: 'order_workflow_mismatch',
      orderId,
      instanceId: `${orderId}-g1`,
      order: 'running',
      workflow: 'terminated',
    });
    // Still flagged next hour: nothing here repairs the order, a person does.
    error.mockClear();
    await sweepOrderInstances(env, later());
    expect(mismatches(error).map((m) => m.orderId)).toContain(orderId);
  });

  it('flags a running order that has no instance at all as unknown', async () => {
    await orderRecords(env).create({
      id: 'ord_sweep_noinstance',
      model: 'b2b',
      channel: 'api',
      externalId: null,
      contactEmail: null,
      title: 'No instance',
      flowId: 'tpl-b2b-order',
      flowVersion: 1,
      instanceId: 'ord_sweep_noinstance-g1',
      customerId: null,
      currency: 'USD',
      createdAt: Date.now(),
      idempotencyKey: null,
      idempotencyFingerprint: null,
      startedBy: null,
    });
    await db()
      .update(orders)
      .set({ status: 'running' })
      .where(eq(orders.id, 'ord_sweep_noinstance'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sweepOrderInstances(env, later());
    expect(mismatches(error)).toContainEqual(
      expect.objectContaining({ orderId: 'ord_sweep_noinstance', workflow: 'unknown' }),
    );
  });

  it('does not look at a row that changed a moment ago: its report may be on its way', async () => {
    const orderId = await runningOrder();
    await (await env.ORDER_WORKFLOW.get(`${orderId}-g1`)).terminate();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sweepOrderInstances(env, Date.now());
    expect(mismatches(error).map((m) => m.orderId)).not.toContain(orderId);
  });

  it('checks at most its cap, and says when it stopped there', async () => {
    await runningOrder();
    await runningOrder();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await sweepOrderInstances(env, later(), 1);
    expect(r.checked).toBe(1);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('order_workflow_sweep_capped'),
    );
  });

  it('runs from the hourly cron beside the other sweeps', async () => {
    const orderId = await runningOrder();
    await (await env.ORDER_WORKFLOW.get(`${orderId}-g1`)).terminate();
    // Make the row quiet the way an hour of silence would.
    await db().update(orders).set({ updatedAt: 1 }).where(eq(orders.id, orderId));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await worker.scheduled({ cron: '15 * * * *' } as ScheduledController, env);
    expect(mismatches(error).map((m) => m.orderId)).toContain(orderId);
  });
});
