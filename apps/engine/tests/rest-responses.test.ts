/**
 * What the engine answers the REST API with, from real orders on real Workflows, validated against
 * the schemas the OpenAPI document describes those responses by (`apps/web/tests/rest-responses.test.ts`
 * holds the handlers to the same schemas, with the engine's answers typed). A response must carry
 * nothing its schema doesn't name: parsing strips an unknown field, so the parsed value is held
 * equal to the one the engine returned.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  cancelResultSchema,
  decisionResultSchema,
  erasureResultSchema,
  type FlowNode,
  type OrderInput,
  type OrderState,
  orderStateSchema,
  pluginUsageSchema,
  sendEventResultSchema,
  startOrderResultSchema,
  subjectExportSchema,
} from '@commerceworker/core';
import { createDb, publishFlow } from '@commerceworker/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { EngineApi } from '../src/api';
import { ensureTemplates } from '../src/flows';
import { signedActor } from './principal';

const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const suffix = () => crypto.randomUUID().slice(0, 8);

/** The value as JSON, which is how REST sends it, and parsed by `schema` without losing a field. */
function expectValid(schema: z.ZodType, value: unknown) {
  const sent = JSON.parse(JSON.stringify(value));
  const parsed = schema.safeParse(sent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 1)).toBe(true);
  expect(parsed.data).toEqual(sent);
  return sent;
}

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r as T;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const state = async (id: string) => (await api().snapshot(id)) as OrderState;
const waitingApproval = (id: string) =>
  until(async () => {
    const s = await state(id);
    return s.waits.some((w) => w.kind === 'approval') && s;
  }, 'the approval');

const node = (id: string, type: string, config: Record<string, unknown> = {}): FlowNode => ({
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

/** A flow that waits at one approval, then ends the order completed or declined. */
async function approvalFlow(id: string) {
  await publishFlow(db(), {
    id,
    name: id,
    description: 'A flow with one approval',
    model: 'b2b',
    channels: ['api'],
    nodes: [
      node('start', 'trigger.manual'),
      node('appr', 'control.approval', { title: 'Approve it', assignee: 'ops' }),
      node('ok', 'control.end', { outcome: 'completed', reason: 'Approved' }),
      node('no', 'control.end', { outcome: 'declined', reason: 'Rejected' }),
    ],
    edges: [edge('start', 'appr'), edge('appr', 'ok', 'approved'), edge('appr', 'no', 'rejected')],
  });
}

const input = (over: Partial<OrderInput> = {}): OrderInput => ({
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  title: 'REST responses',
  lines: [{ sku: 'WID-100', name: 'Widget', qty: 2, unitPrice: 10 }],
  contact: { email: `buyer-${suffix()}@example.test`, name: 'Buyer' },
  meta: {},
  ...over,
});

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeAll(async () => {
  await ensureTemplates(env);
});
afterEach(async () => {
  await introspector?.dispose();
});

describe('the engine’s answers to the REST API', () => {
  it('an order’s state while it waits and once it is done, and each step on the way', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const flowId = `rest-${suffix()}`;
    await approvalFlow(flowId);
    const started = await api().startOrderOnce({
      flowId,
      input: input(),
      startedBy: 'tok_1',
      idempotencyKey: `rest:${suffix()}`,
    });
    expectValid(startOrderResultSchema, started);
    const replay = await api().startOrderOnce({
      flowId,
      input: input(),
      startedBy: 'tok_1',
      idempotencyKey: `rest:${suffix()}`,
    });
    expectValid(startOrderResultSchema, replay);
    const orderId = (started as { orderId: string }).orderId;

    const waiting = await waitingApproval(orderId);
    expectValid(orderStateSchema, waiting);
    expect(waiting.waits[0]).toMatchObject({ kind: 'approval', nodeId: 'appr' });
    expect(waiting.flow?.id).toBe(flowId);

    // Nothing in this flow waits for a payment: the order says where the event went.
    expectValid(sendEventResultSchema, await api().sendEvent(orderId, 'payment.received', {}));

    const decided = await api().decide(
      orderId,
      'appr',
      'approved',
      await signedActor(
        { kind: 'staff', id: 'u_ann', name: 'ann@example.com', role: 'approver' },
        `decide:${orderId}`,
      ),
    );
    expect(decided).toMatchObject({ ok: true, outcome: 'approved' });
    expectValid(decisionResultSchema, decided);

    const done = await until(async () => {
      const s = await state(orderId);
      return s.status === 'completed' && s;
    }, 'the order to complete');
    expectValid(orderStateSchema, done);
  });

  it('cancelling an order', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const flowId = `rest-${suffix()}`;
    await approvalFlow(flowId);
    const { orderId } = await api().startOrder({ flowId, input: input() });
    await waitingApproval(orderId);
    const cancelled = await api().cancel(orderId, 'Cancelled via API');
    expect(cancelled).toEqual({ ok: true });
    expectValid(cancelResultSchema, cancelled);
    const s = await until(async () => {
      const s = await state(orderId);
      return s.status === 'cancelled' && s;
    }, 'the order to cancel');
    // A cancelled order has a reason, and says so in its state.
    expectValid(orderStateSchema, s);
    expect(s.reason).toBe('Cancelled via API');
  });

  it('exporting and erasing a data subject', async () => {
    const email = `ada-${suffix()}@example.test`;
    expectValid(subjectExportSchema, await api().exportDataSubject(email));
    const erased = await api().eraseDataSubject(email);
    expect(erased).toMatchObject({ ok: true, done: true });
    expectValid(erasureResultSchema, erased);
  });

  it('what uses a plugin', async () => {
    expectValid(pluginUsageSchema, await api().pluginUsage('nothing'));
  });
});
