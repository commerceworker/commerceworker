/**
 * A cancel runs the rollbacks of the steps that finished, a plugin's included: the agent stops the
 * Workflow with `terminate({ rollback: true })`, so a stamp the example plugin wrote for the
 * order is removed, and `compensateOrder` covers what the core holds. Both are idempotent, so
 * the two together undo each thing once.
 */
import { applyD1Migrations, introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { OrderState } from '@commerceworker/core';
import { createDb, publishFlow } from '@commerceworker/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../../src/flows';
import { startOrder } from '../../src/orders';
import { edge, node, stampInput } from '../plugin-helpers';

const testEnv = env as Env & { EXAMPLE_DB: D1Database; TEST_EXAMPLE_MIGRATIONS: D1Migration[] };
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;
const stamps = async (orderId: string) =>
  (
    await testEnv.EXAMPLE_DB.prepare('SELECT step_key FROM stamps WHERE order_id = ?')
      .bind(orderId)
      .all()
  ).results;

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

beforeAll(async () => {
  await applyD1Migrations(testEnv.EXAMPLE_DB, testEnv.TEST_EXAMPLE_MIGRATIONS);
  await ensureTemplates(env);
  // start → stamp → wait for "go" → end: the order sits waiting with its stamp written.
  await publishFlow(createDb(env.DB), {
    id: 'test-stamp-wait',
    name: 'Stamp, then wait',
    description: '',
    model: 'b2b',
    channels: [],
    nodes: [
      node('start', 'trigger.manual'),
      node('stamp', 'example.stamp', { note: 'hello' }),
      node('go', 'control.wait_event', { event: 'go' }),
      node('done', 'control.end', { outcome: 'completed', reason: 'Went' }),
    ],
    edges: [edge('start', 'stamp'), edge('stamp', 'go', 'ok'), edge('go', 'done', 'received')],
  });
});

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('cancelling an order that ran a plugin node', () => {
  it('runs the plugin’s rollback, and a second cancel undoes nothing more', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const { orderId } = await startOrder(env, { flowId: 'test-stamp-wait', input: stampInput() });
    await expect.poll(async () => (await state(orderId)).waits.length, { timeout: 30_000 }).toBe(1);
    expect(await stamps(orderId)).toEqual([{ step_key: 'stamp#1' }]);

    expect(await agent(orderId).cancel('Changed our mind')).toEqual({ ok: true });
    expect((await state(orderId)).status).toBe('cancelled');
    // The rollback runs as the Workflow winds down, so it may land just after the cancel returns.
    await expect.poll(() => stamps(orderId), { timeout: 30_000 }).toEqual([]);
    expect(await agent(orderId).cancel('Again')).toEqual({ ok: false });
  });
});
