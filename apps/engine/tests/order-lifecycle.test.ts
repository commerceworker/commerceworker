/**
 * What keeps an order's records consistent when a store or the Workflow fails under the OrderAgent:
 * the D1 index row behind a failed write (retried from an alarm), a failed order's rollback
 * outcome (polled until the instance settles, however long it takes), and a cancel whose
 * `terminate` fails (nothing is undone until the run is stopped). The agent is driven directly,
 * the way `agent.test.ts` does, with the Workflow binding and the index store faked at the seam.
 */
import { introspectWorkflow, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { b2bOrderFlow, type Order, type OrderState } from '@commerceworker/core';
import { createDb, orders, promotionRedemptions, publishFlow } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTemplates } from '../src/flows';
import { startOrder } from '../src/orders';
import { orderRecords } from '../src/wire';
import { edge, node } from './plugin-helpers';

const flow = { ...b2bOrderFlow(), version: 1, publishedAt: 0 };
const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;

const orderOf = (id: string): Order => ({
  id,
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  lines: [],
  meta: {},
  createdAt: 0,
  subtotal: 0,
  shipping: 0,
  tax: 0,
  total: 0,
});

/** Starts an agent for an order, with its D1 row unless `row` is false. */
async function begin(id: string, row = true) {
  if (row)
    await db().insert(orders).values({
      id,
      model: 'b2b',
      status: 'queued',
      flowId: 'f',
      flowVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    });
  await agent(id).init(orderOf(id), flow, `${id}-g1`);
}

const d1Status = async (id: string) =>
  (await db().select().from(orders).where(eq(orders.id, id)).get())?.status;

type Queued = { id: string; callback: string; time: number; payload: unknown };
/** The agent's alarm schedule, from inside it (the stub's RPC typing doesn't carry it). */
const schedules = (inst: { getSchedules(): unknown }, callback: string) =>
  (inst.getSchedules() as Queued[]).filter((s) => s.callback === callback);

type Inner = {
  records(): unknown;
  env: { ORDER_WORKFLOW: { get(id: string): Promise<unknown> } };
  getSchedules(): unknown;
  cancelSchedule(id: string): Promise<boolean>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

beforeAll(async () => {
  await ensureTemplates(env);
});

describe('the D1 index row', () => {
  it('lands from an alarm when the write fails on a terminal report, and the failed order is still watched', async () => {
    const id = 'ord_lc_index';
    await begin(id);
    await runInDurableObject(agent(id), async (inst) => {
      const o = inst as unknown as Inner & {
        report(r: unknown): Promise<void>;
        retryIndex(p: { attempt: number }): Promise<void>;
      };
      const real = orderRecords(env);
      let calls = 0;
      vi.spyOn(o, 'records').mockReturnValue({
        ...real,
        index: async (...a: Parameters<typeof real.index>) => {
          if (calls++ === 0) throw new Error('D1 is down');
          return real.index(...a);
        },
      });
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});

      // The report is saved, the index write fails, and the report still answers (it must not
      // throw: the Workflow would swallow it and never send it again).
      await o.report({ generation: 1, status: 'failed', reason: 'boom' });
      expect((inst as unknown as { state: OrderState }).state.status).toBe('failed');
      expect(await d1Status(id)).toBe('queued');
      expect(err.mock.calls.some(([m]) => String(m).includes('order_index_failed'))).toBe(true);
      expect(schedules(o, 'retryIndex')).toHaveLength(1);
      // The rollback watch is scheduled from the same report.
      expect(schedules(o, 'checkInstance')).toHaveLength(1);

      // The Workflow sends the report again: the status has not changed, but the index is behind,
      // and the watch (dropped here to stand for one that never ran) is scheduled again.
      for (const s of schedules(o, 'checkInstance')) await o.cancelSchedule(s.id);
      await o.report({ generation: 1, status: 'failed', reason: 'boom' });
      expect(await d1Status(id)).toBe('failed');
      expect(schedules(o, 'checkInstance')).toHaveLength(1);
    });
  });

  it('retries from the alarm with a growing wait, and shouts once it is stuck', async () => {
    const id = 'ord_lc_stuck';
    await begin(id);
    await runInDurableObject(agent(id), async (inst) => {
      const o = inst as unknown as Inner & {
        report(r: unknown): Promise<void>;
        retryIndex(p: { attempt: number }): Promise<void>;
      };
      const real = orderRecords(env);
      let down = true;
      vi.spyOn(o, 'records').mockReturnValue({
        ...real,
        index: async (...a: Parameters<typeof real.index>) => {
          if (down) throw new Error('D1 is down');
          return real.index(...a);
        },
      });
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await o.report({ generation: 1, status: 'completed', reason: 'done' });
      const stuck = () => err.mock.calls.filter(([m]) => String(m).includes('order_index_stuck'));

      const waits: number[] = [];
      for (let attempt = 1; attempt <= 6; attempt++) {
        for (const s of schedules(o, 'retryIndex')) await o.cancelSchedule(s.id);
        await o.retryIndex({ attempt });
        const [next] = schedules(o, 'retryIndex');
        waits.push(next!.time - Math.floor(Date.now() / 1000));
      }
      // Quiet for the first few tries, then an error each time.
      expect(stuck().length).toBeGreaterThanOrEqual(1);
      expect(stuck().length).toBeLessThan(6);
      expect(waits[5]!).toBeGreaterThan(waits[0]!);
      expect(await d1Status(id)).toBe('queued');

      down = false;
      await o.retryIndex({ attempt: 7 });
      expect(await d1Status(id)).toBe('completed');
    });
  });

  it('says so, at error level, when the order has no D1 row, and carries on', async () => {
    const id = 'ord_lc_norow';
    await begin(id, false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await agent(id).report({ generation: 1, status: 'completed', reason: 'done' });
    expect((await state(id)).status).toBe('completed');
    expect(
      err.mock.calls.some(
        ([m]) => String(m).includes('order_index_missing') && String(m).includes(id),
      ),
    ).toBe(true);
  });
});

describe('a failed order’s rollback', () => {
  it('is recorded however long it outlasts the poll, and a failed one is logged at error level', async () => {
    const id = 'ord_lc_rollback';
    await begin(id);
    await agent(id).report({ generation: 1, status: 'failed', reason: 'boom' });
    await runInDurableObject(agent(id), async (inst) => {
      const o = inst as unknown as Inner & { checkInstance(p: { attempt: number }): Promise<void> };
      // The instance is rolling back for 40 simulated minutes, then settles with the rollback failed.
      let clockMs = 0;
      const SETTLES_AT = 40 * 60_000;
      vi.spyOn(o.env.ORDER_WORKFLOW, 'get').mockImplementation(async () => ({
        status: async () =>
          clockMs < SETTLES_AT
            ? { status: 'running' }
            : {
                status: 'errored',
                rollback: { outcome: 'failed', error: { message: 'plugin down' } },
              },
      }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});

      let polls = 0;
      let longest = 0;
      for (; polls < 500; polls++) {
        const [next] = schedules(o, 'checkInstance');
        if (!next) break;
        // The wait the schedule asks for is the simulated time that passes before the poll.
        const wait = Math.max(0, next.time - Math.floor(Date.now() / 1000)) * 1000;
        clockMs += wait;
        longest = Math.max(longest, wait);
        await o.cancelSchedule(next.id);
        await o.checkInstance(next.payload as { attempt: number });
      }
      expect(clockMs).toBeGreaterThanOrEqual(SETTLES_AT);
      // Backs off to minutes rather than polling every 10 seconds for the whole wait.
      expect(longest).toBeGreaterThanOrEqual(120_000);
      expect(polls).toBeLessThan(60);
      expect(schedules(o, 'checkInstance')).toEqual([]);
      expect(err.mock.calls.some(([m]) => String(m).includes('rollback_failed'))).toBe(true);
    });
    const s = await state(id);
    expect(s.rollback).toEqual({ outcome: 'failed', error: 'plugin down' });
    expect(s.timeline.some((t) => t.message === 'Rollback failed: plugin down')).toBe(true);
    expect(await d1Status(id)).toBe('failed');
  });
});

describe('cancelling when the run cannot be stopped', () => {
  const redeem = (orderId: string) =>
    db()
      .insert(promotionRedemptions)
      .values({ promotionId: 'promo_lc', orderId, amount: 5, stepKey: 'promo#1', createdAt: 0 });
  const redemptions = (orderId: string) =>
    db().select().from(promotionRedemptions).where(eq(promotionRedemptions.orderId, orderId)).all();

  it('compensates nothing and marks nothing cancelled until terminate succeeds, then does both', async () => {
    const id = 'ord_lc_cancel';
    await begin(id);
    await redeem(id);
    await runInDurableObject(agent(id), async (inst) => {
      const o = inst as unknown as Inner & {
        cancel(reason: string): Promise<{ ok: boolean; error?: string }>;
        retryCancel(p: { reason: string; actor: null; attempt: number }): Promise<void>;
      };
      let stopped = false;
      const terminate = vi.fn(async () => {
        if (!stopped) throw new Error('Workflows is unavailable');
      });
      vi.spyOn(o.env.ORDER_WORKFLOW, 'get').mockImplementation(async () => ({
        terminate,
        status: async () => ({ status: stopped ? 'terminated' : 'running' }),
      }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});

      const first = await o.cancel('Changed our mind');
      expect(first).toEqual({ ok: false, error: 'Workflows is unavailable' });
      // The rollbacks of what already ran are asked for with the terminate.
      expect(terminate).toHaveBeenCalledWith({ rollback: true });
      const s = (inst as unknown as { state: OrderState }).state;
      expect(s.status).toBe('queued');
      expect(await redemptions(id)).toHaveLength(1);
      expect(await d1Status(id)).toBe('queued');
      expect(s.timeline.some((t) => t.message.startsWith('Cancel pending'))).toBe(true);
      expect(err.mock.calls.some(([m]) => String(m).includes('cancel_terminate_failed'))).toBe(
        true,
      );
      expect(schedules(o, 'retryCancel')).toHaveLength(1);

      // A second cancel while one waits queues no second retry.
      await o.cancel('Again');
      expect(schedules(o, 'retryCancel')).toHaveLength(1);

      stopped = true;
      const [retry] = schedules(o, 'retryCancel');
      await o.retryCancel(retry!.payload as never);
      expect((inst as unknown as { state: OrderState }).state.status).toBe('cancelled');
      expect(await redemptions(id)).toEqual([]);
      expect(await d1Status(id)).toBe('cancelled');
    });
  });

  it('goes ahead when terminate throws because the run had already finished', async () => {
    const id = 'ord_lc_cancel_done';
    await begin(id);
    await redeem(id);
    await runInDurableObject(agent(id), async (inst) => {
      const o = inst as unknown as Inner & { cancel(reason: string): Promise<{ ok: boolean }> };
      vi.spyOn(o.env.ORDER_WORKFLOW, 'get').mockImplementation(async () => ({
        terminate: async () => {
          throw new Error('instance.not_running');
        },
        status: async () => ({ status: 'errored' }),
      }));
      expect(await o.cancel('Over')).toEqual({ ok: true });
    });
    expect((await state(id)).status).toBe('cancelled');
    expect(await redemptions(id)).toEqual([]);
  });
});

describe('an order that ends declined', () => {
  it('gives its promotion redemptions back, once', async () => {
    const introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    try {
      await publishFlow(db(), {
        id: 'test-decline-promo',
        name: 'Decline after promotion',
        description: '',
        model: 'b2c',
        channels: [],
        nodes: [
          node('start', 'trigger.manual'),
          node('promo', 'commerce.discount'),
          node('no', 'control.end', { outcome: 'declined', reason: 'Not today' }),
        ],
        edges: [edge('start', 'promo'), edge('promo', 'no')],
      });
      const { promotions } = await import('@commerceworker/db');
      await db()
        .insert(promotions)
        .values({
          id: 'promo_lc_decl',
          code: 'LCDECL',
          kind: 'pct',
          value: 10,
          createdAt: 0,
          updatedAt: 0,
        })
        .onConflictDoNothing();
      const { orderId } = await startOrder(env, {
        flowId: 'test-decline-promo',
        input: {
          model: 'b2c',
          channel: 'web',
          currency: 'USD',
          customerId: 'cus_northwind',
          lines: [{ sku: 'WID-100', qty: 2, unitPrice: 50 }],
          meta: { promoCodes: ['lcdecl'] },
        },
      });
      const done = await vi.waitFor(
        async () => {
          const s = await state(orderId);
          if (s.status !== 'declined') throw new Error(s.status);
          return s;
        },
        { timeout: 30_000, interval: 100 },
      );
      await vi.waitFor(async () => {
        const left = await db()
          .select()
          .from(promotionRedemptions)
          .where(eq(promotionRedemptions.orderId, orderId))
          .all();
        expect(left).toEqual([]);
      });
      expect(done.timeline.some((t) => /Gave back 1 promotion redemption/.test(t.message))).toBe(
        true,
      );
    } finally {
      await introspector.dispose();
    }
  });
});
