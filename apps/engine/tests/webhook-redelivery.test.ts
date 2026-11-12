/**
 * An order's outbound events when a receiver is down: the Workflow records the delivery, makes
 * its first attempt and moves on, the OrderAgent's alarm schedule retries it for about a day with
 * the same delivery id and payload, and an operator may send a delivery that ran out of retries
 * (or one that arrived) again through `redeliver_webhook_delivery`, REST's twin of the MCP tool.
 * Retries are driven by calling the agent's callback with the schedule's own payload, as the cart
 * events' tests do, with the delay each one waited summed as the simulated clock.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { listAuditEvents } from '@commerceworker/application/commerce';
import {
  EVENT_RETRIES,
  eventRetryDelaySec,
  type OrderEventPayload,
  type OrderState,
  operationCall,
  type Role,
  type RpcActor,
  verifyWebhook,
} from '@commerceworker/core';
import { createDb, webhookDeliveries, webhookSubscriptions } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineApi } from '../src/api';
import { ensureTemplates } from '../src/flows';
import { startOrder } from '../src/orders';
import { emit } from '../src/outbox';
import { auditLog, webhookOutbox } from '../src/wire';
import { signedActor } from './principal';

const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const staff = (role: Role): RpcActor =>
  ({ kind: 'staff', id: `usr_redeliver_${role}`, name: `${role}@example.com`, role }) as RpcActor;

type Queued = {
  id: string;
  callback: string;
  time: number;
  payload: { key: string; event: string; attempt: number };
};
/** The order's queued webhook retries (the stub's RPC typing doesn't carry `getSchedules`). */
const queued = async (id: string) =>
  ((await (agent(id).getSchedules() as unknown)) as Queued[]).filter(
    (q) => q.callback === 'retryWebhook',
  );
const unqueue = async (id: string) => {
  for (const q of await queued(id)) await agent(id).cancelSchedule(q.id);
};

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

beforeAll(async () => {
  await ensureTemplates(env);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await introspector?.dispose();
  introspector = undefined;
  await db().delete(webhookSubscriptions);
});

const subscribe = (id: string, events: string[], secret = `whsec_${id}`) =>
  db()
    .insert(webhookSubscriptions)
    .values({
      id,
      url: `https://hooks.example/${id}`,
      secret,
      events: JSON.stringify(events),
      createdAt: Date.now(),
    });

type Received = { body: string; headers: Headers; payload: OrderEventPayload; status: number };

/** What subscribers are sent; `down` says whether the receiver answers 503 right now. */
function receiver() {
  const received: Received[] = [];
  const state = { down: true };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = String(init?.body);
    const status = state.down ? 503 : 200;
    received.push({
      body,
      headers: new Headers(init?.headers),
      payload: JSON.parse(body),
      status,
    });
    return new Response(status === 200 ? 'ok' : 'no', { status });
  });
  return { received, state };
}

async function until<T>(fn: () => Promise<T | undefined | false>, what: string): Promise<T> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const rows = (orderId: string) =>
  db().select().from(webhookDeliveries).where(eq(webhookDeliveries.orderId, orderId));

/** An order that runs to the end and announces `order.paid` once, with the receiver as set. */
async function paidOrder() {
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    await m.forceEventTimeout({ name: 'window#1' });
  });
  const { orderId } = await startOrder(env, {
    flowId: 'tpl-storefront-order',
    input: {
      model: 'b2c',
      channel: 'api',
      currency: 'USD',
      customerId: 'cus_ada',
      lines: [{ sku: 'GSK-010', qty: 5 }],
      meta: {},
    },
  });
  const done = await until(async () => {
    const s = (await agent(orderId).snapshot()) as OrderState;
    return s.status === 'completed' && s;
  }, 'the order to complete');
  return { orderId, done };
}

const run = async (tool: string, input: unknown, actor: RpcActor) =>
  api().runOperation(tool, input, await signedActor(actor, await operationCall(tool, input)));

describe('retrying an order’s event for a day', () => {
  it('delivers order.paid once, with one delivery id, to a receiver that is down for ten minutes', async () => {
    const { received, state } = receiver();
    await subscribe('flaky', ['order.paid']);
    // The order finishes while the receiver is down: the Workflow did not wait on it.
    const { orderId } = await paidOrder();
    const [first] = await rows(orderId);
    expect(first).toMatchObject({ event: 'order.paid', status: 'failed', attempts: 1 });
    expect(received).toHaveLength(1);
    const [next, ...more] = await queued(orderId);
    expect(more).toEqual([]);
    expect(next!.payload.attempt).toBe(1);
    // The first retry is ten seconds out, from the agent's own alarm.
    const wait = next!.time * 1000 - Date.now();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(10_000);

    // Ten simulated minutes of retries, each after the delay the schedule gave it.
    let clock = 0;
    let attempt = 1;
    for (let queue = await queued(orderId); queue.length; queue = await queued(orderId)) {
      const q = queue[0]!;
      expect(q.payload.attempt).toBe(attempt);
      clock += eventRetryDelaySec(attempt - 1);
      state.down = clock < 600;
      await unqueue(orderId);
      await agent(orderId).retryWebhook(q.payload as never);
      attempt++;
    }
    expect(clock).toBeGreaterThanOrEqual(600);

    const [row] = await rows(orderId);
    expect(row).toMatchObject({ status: 'delivered', responseStatus: 200 });
    expect(row!.attempts).toBe(attempt);
    // Every attempt carried the same delivery id and the same bytes; one of them was taken.
    expect(new Set(received.map((r) => r.headers.get('x-commerceworker-delivery')))).toEqual(
      new Set([row!.id]),
    );
    expect(new Set(received.map((r) => r.body)).size).toBe(1);
    expect(received[0]!.payload).toMatchObject({ id: row!.id, event: 'order.paid', orderId });
    expect(received.filter((r) => r.status === 200)).toHaveLength(1);
    expect(received).toHaveLength(attempt);
  });

  it('retries for about a day, then leaves the delivery failed', async () => {
    receiver();
    await subscribe('dead', ['order.completed']);
    const { orderId } = await paidOrder();
    const [q] = await queued(orderId);
    await unqueue(orderId);
    let total = 0;
    for (let n = 0; n < EVENT_RETRIES; n++) total += eventRetryDelaySec(n);
    expect(total / 3600).toBeGreaterThan(23);
    // The last retry fails too and schedules nothing more.
    await agent(orderId).retryWebhook({ ...q!.payload, attempt: EVENT_RETRIES } as never);
    expect(await queued(orderId)).toEqual([]);
    expect((await rows(orderId))[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('queues one series per event, however often the step that hands it over runs', async () => {
    receiver();
    await subscribe('again', ['order.completed']);
    const { orderId } = await paidOrder();
    const [q] = await queued(orderId);
    // A retried step, or a replayed Workflow, hands the same delivery over again.
    await agent(orderId).queueWebhookRetry({ key: q!.payload.key, event: 'order.completed' });
    await agent(orderId).queueWebhookRetry({ key: q!.payload.key, event: 'order.completed' });
    expect(await queued(orderId)).toHaveLength(1);
    // After the series is consumed, a late repeat starts no second one.
    await unqueue(orderId);
    await agent(orderId).queueWebhookRetry({ key: q!.payload.key, event: 'order.completed' });
    expect(await queued(orderId)).toEqual([]);
  });

  it('sends nothing twice when the emit step runs again for a delivery that arrived', async () => {
    const { received, state } = receiver();
    await subscribe('once', ['order.completed']);
    const { orderId } = await paidOrder();
    const [q] = await queued(orderId);
    await unqueue(orderId);
    state.down = false;
    await agent(orderId).retryWebhook(q!.payload as never);
    expect((await rows(orderId))[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    const mine = () => received.filter((r) => r.payload.orderId === orderId && r.status === 200);
    expect(mine()).toHaveLength(1);
    // What a replayed step would do: the same key and event, at another moment, other data.
    const again = await emit(env, q!.payload.key, orderId, 'order.completed', { later: true });
    expect(again).toEqual({ delivered: 1, pending: 0 });
    expect(mine()).toHaveLength(1);
    expect(await queued(orderId)).toEqual([]);
    expect((await rows(orderId))[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('retries an order.cancelled the agent announced the same way', async () => {
    const { received, state } = receiver();
    await subscribe('cancel', ['order.cancelled']);
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-purchase-request',
      input: {
        model: 'procurement',
        channel: 'api',
        currency: 'USD',
        customerId: 'cus_internal',
        title: 'Laptops',
        lines: [{ sku: 'LAP-14', qty: 8 }],
        meta: {},
      },
    });
    await until(async () => {
      const s = (await agent(orderId).snapshot()) as OrderState;
      return s.waits.some((w) => w.nodeId === 'mgr');
    }, 'manager approval');
    await agent(orderId).cancel('Duplicate request');
    const [q] = await until(async () => {
      const queue = await queued(orderId);
      return queue.length > 0 && queue;
    }, 'the retry to be queued');
    expect(await rows(orderId)).toMatchObject([{ event: 'order.cancelled', attempts: 1 }]);
    state.down = false;
    await unqueue(orderId);
    await agent(orderId).retryWebhook(q!.payload as never);
    expect((await rows(orderId))[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(received.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('retries only what was recorded: an erased order has nothing left to send', async () => {
    const { received } = receiver();
    await subscribe('erased', ['order.completed']);
    const { orderId } = await paidOrder();
    const [q] = await queued(orderId);
    await unqueue(orderId);
    await webhookOutbox(env).forget(orderId);
    const before = received.length;
    await agent(orderId).retryWebhook(q!.payload as never);
    expect(received).toHaveLength(before);
    expect(await rows(orderId)).toEqual([]);
    expect(await queued(orderId)).toEqual([]);
  });
});

describe('redelivering a webhook delivery', () => {
  /** A delivery that ran out of retries against a receiver that is still down. */
  async function exhausted(secret?: string) {
    const rx = receiver();
    await subscribe('hook', ['order.completed'], secret);
    const { orderId } = await paidOrder();
    const [q] = await queued(orderId);
    await unqueue(orderId);
    await agent(orderId).retryWebhook({ ...q!.payload, attempt: EVENT_RETRIES } as never);
    const [row] = await rows(orderId);
    expect(row).toMatchObject({ status: 'failed', attempts: 2 });
    return { ...rx, orderId, row: row! };
  }

  it('sends a failed delivery again with its id and payload, and it becomes delivered', async () => {
    const { received, state, orderId, row } = await exhausted();
    const sentBefore = received.length;
    // Still down: the answer says so, and the delivery stays failed with another attempt counted.
    const down = await run('redeliver_webhook_delivery', { deliveryId: row.id }, staff('admin'));
    expect(down).toMatchObject({
      ok: true,
      value: { id: row.id, status: 'failed', attempts: 3, responseStatus: 503 },
    });
    state.down = false;
    const up = await run('redeliver_webhook_delivery', { deliveryId: row.id }, staff('admin'));
    expect(up).toMatchObject({
      ok: true,
      value: { id: row.id, status: 'delivered', attempts: 4, responseStatus: 200, lastError: null },
    });
    expect((await rows(orderId))[0]).toMatchObject({ status: 'delivered', attempts: 4 });
    const sent = received.slice(sentBefore);
    expect(sent).toHaveLength(2);
    for (const r of sent) {
      expect(r.headers.get('x-commerceworker-delivery')).toBe(row.id);
      expect(r.body).toBe(row.payload);
    }
    // No new delivery was made, and nothing was queued: redelivery is an operator's one send.
    expect(await rows(orderId)).toHaveLength(1);
    expect(await queued(orderId)).toEqual([]);
  });

  it('is safe twice: the same id and bytes each time, the delivery staying delivered', async () => {
    const { received, state, orderId, row } = await exhausted();
    state.down = false;
    const sentBefore = received.length;
    for (const attempts of [3, 4]) {
      expect(
        await run('redeliver_webhook_delivery', { deliveryId: row.id }, staff('admin')),
      ).toMatchObject({ ok: true, value: { status: 'delivered', attempts } });
    }
    const sent = received.slice(sentBefore);
    expect(new Set(sent.map((r) => r.headers.get('x-commerceworker-delivery')))).toEqual(
      new Set([row.id]),
    );
    expect(new Set(sent.map((r) => r.body)).size).toBe(1);
    expect(await rows(orderId)).toHaveLength(1);
    // Each send is audited, naming the delivery.
    const audited = (await listAuditEvents({ audit: auditLog(env) }, { limit: 500 })).filter(
      (e) => e.action === 'webhook.redelivered' && e.target === row.id,
    );
    expect(audited).toHaveLength(2);
    expect(audited[0]).toMatchObject({
      actor: 'admin@example.com',
      detail: expect.objectContaining({ event: 'order.completed', via: 'api' }),
    });
  });

  it('signs with the secret the subscription has now', async () => {
    const { received, state, row } = await exhausted('whsec_before');
    state.down = false;
    // The secret is rotated and its grace period has ended: only the new one signs.
    await webhookOutbox(env).rotateSubscription('hook', 'whsec_after', Date.now() - 1);
    await run('redeliver_webhook_delivery', { deliveryId: row.id }, staff('admin'));
    const last = received.at(-1)!;
    const header = last.headers.get('x-commerceworker-signature');
    expect(await verifyWebhook('whsec_after', last.body, header)).toMatchObject({ ok: true });
    expect(await verifyWebhook('whsec_before', last.body, header)).toMatchObject({ ok: false });
  });

  it('sends a delivery that arrived again too', async () => {
    const rx = receiver();
    rx.state.down = false;
    await subscribe('hook', ['order.completed']);
    const { orderId } = await paidOrder();
    const [row] = await rows(orderId);
    expect(row).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(
      await run('redeliver_webhook_delivery', { deliveryId: row!.id }, staff('admin')),
    ).toMatchObject({ ok: true, value: { status: 'delivered', attempts: 2 } });
    expect(rx.received.filter((r) => r.payload.orderId === orderId)).toHaveLength(2);
  });

  it('refuses what it cannot send: an unknown delivery, one still on its first attempt, a gone subscription, and a lower role', async () => {
    const { received, row } = await exhausted();
    expect(
      await run('redeliver_webhook_delivery', { deliveryId: 'whd_nope' }, staff('admin')),
    ).toEqual({ ok: false, error: 'No webhook delivery whd_nope.' });
    // Recorded but never attempted: still on its way.
    await webhookOutbox(env).record(
      [
        {
          id: 'whd_fresh',
          subscriptionId: 'hook',
          subject: 'ord_fresh',
          event: 'order.completed',
          payload: '{}',
        },
      ],
      Date.now(),
    );
    expect(
      await run('redeliver_webhook_delivery', { deliveryId: 'whd_fresh' }, staff('admin')),
    ).toEqual({
      ok: false,
      error: "Delivery whd_fresh hasn't had its first attempt yet; it is still on its way.",
    });
    const sent = received.length;
    for (const role of ['viewer', 'operator'] as const)
      expect(await run('redeliver_webhook_delivery', { deliveryId: row.id }, staff(role))).toEqual({
        ok: false,
        error: 'This needs the Admin role.',
      });
    expect(await run('redeliver_webhook_delivery', {}, staff('admin'))).toMatchObject({
      ok: false,
      status: 400,
    });
    // The subscription removed: its delivery stays on record, with nowhere to go.
    await db().delete(webhookSubscriptions);
    expect(await run('redeliver_webhook_delivery', { deliveryId: row.id }, staff('admin'))).toEqual(
      {
        ok: false,
        error: 'The subscription hook is gone or off, so there is nowhere to send it.',
      },
    );
    expect(received).toHaveLength(sent);
    await db().delete(webhookDeliveries).where(eq(webhookDeliveries.id, 'whd_fresh'));
  });
});
