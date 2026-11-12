import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createDb, orders } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { failUnstartedOrders, instanceExists, startOrder, UNSTARTED_ORDER_MS } from '../src/orders';
import { orderRecords } from '../src/wire';

const db = () => createDb(env.DB);
const row = (id: string) => db().select().from(orders).where(eq(orders.id, id)).get();
const later = () => Date.now() + UNSTARTED_ORDER_MS + 60_000;

/** What a REST start with no Idempotency-Key leaves when it fails after the insert. */
const leftBehind = (id: string, over: { idempotencyKey?: string } = {}) =>
  orderRecords(env).create({
    id,
    model: 'b2b',
    channel: 'api',
    externalId: null,
    contactEmail: null,
    title: 'Never started',
    flowId: 'tpl-b2b-order',
    flowVersion: 1,
    instanceId: `${id}-g1`,
    customerId: null,
    currency: 'USD',
    createdAt: Date.now(),
    idempotencyKey: over.idempotencyKey ?? null,
    idempotencyFingerprint: over.idempotencyKey ? 'fp' : null,
    startedBy: null,
  });

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeAll(async () => {
  await ensureTemplates(env);
});
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('orders whose start never got a Workflow', () => {
  it('leaves a recent queued order alone: its start may still be running', async () => {
    await leftBehind('ord_unstarted_recent');
    await failUnstartedOrders(env, Date.now());
    expect(await row('ord_unstarted_recent')).toMatchObject({ status: 'queued', reason: null });
  });

  it('fails an old one with a reason, once, and not the keyed one a retry can finish', async () => {
    await leftBehind('ord_unstarted_old');
    await leftBehind('ord_unstarted_keyed', { idempotencyKey: 'unstarted-keyed' });
    expect(await instanceExists(env, 'ord_unstarted_old-g1')).toBe(false);

    const first = await failUnstartedOrders(env, later());
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect(await row('ord_unstarted_old')).toMatchObject({
      status: 'failed',
      reason: 'The order could not be started; place it again.',
    });
    expect(await row('ord_unstarted_keyed')).toMatchObject({ status: 'queued' });

    // Nothing left to do: the second run changes nothing and fails nothing again.
    const before = (await row('ord_unstarted_old'))!.updatedAt;
    expect((await failUnstartedOrders(env, later())).failed).toBe(0);
    expect((await row('ord_unstarted_old'))!.updatedAt).toBe(before);
  });

  it('leaves an order that has its Workflow, however stale its row', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: { model: 'b2b', channel: 'api', currency: 'USD', lines: [], meta: {} },
    });
    // The agent's report that moves the row past `queued` never arrived.
    await db().update(orders).set({ status: 'queued' }).where(eq(orders.id, orderId));
    expect(await instanceExists(env, `${orderId}-g1`)).toBe(true);

    const r = await failUnstartedOrders(env, later());
    expect(r.started).toBeGreaterThanOrEqual(1);
    expect((await row(orderId))!.status).toBe('queued');
  });

  it('runs from the hourly cron beside the other sweeps', async () => {
    await leftBehind('ord_unstarted_cron');
    await db()
      .update(orders)
      .set({ createdAt: Date.now() - UNSTARTED_ORDER_MS - 60_000 })
      .where(eq(orders.id, 'ord_unstarted_cron'));
    await worker.scheduled({ cron: '15 * * * *' } as ScheduledController, env);
    expect((await row('ord_unstarted_cron'))!.status).toBe('failed');
  });
});
