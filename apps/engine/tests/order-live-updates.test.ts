import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  b2bOrderFlow,
  mergeTimeline,
  type Order,
  type OrderInput,
  type OrderState,
  PRINCIPAL_HEADER,
  type ProxiedPrincipal,
  TIMELINE_BROADCAST,
  type TimelineEntry,
} from '@commerceworker/core';
import { createDb, orders, sessions, users } from '@commerceworker/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { startOrder } from '../src/orders';
import { signed } from './principal';

const flow = { ...b2bOrderFlow(), version: 1, publishedAt: 0 };
const order: Order = {
  id: 'ord_live',
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
};
const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;
const TERMINAL = ['completed', 'declined', 'cancelled', 'failed', 'rolled_back'];

async function until<T>(fn: () => Promise<T | undefined | false>, what: string): Promise<T> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const got = await fn();
    if (got) return got as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const waitingOn = (id: string, pred: (s: OrderState) => boolean, what: string) =>
  until(async () => {
    const s = await state(id);
    return pred(s) ? s : false;
  }, what);

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeAll(async () => {
  await ensureTemplates(env);
});
afterEach(async () => {
  await introspector?.dispose();
});

/** A viewer's session, as the web proxy would sign it. */
async function viewer(): Promise<ProxiedPrincipal> {
  const id = 'usr_live_updates';
  const session = `sess_${id}`;
  await db()
    .insert(users)
    .values({ id, email: 'live@example.com', name: 'live', role: 'viewer', createdAt: Date.now() })
    .onConflictDoNothing();
  await db()
    .insert(sessions)
    .values({
      tokenHash: session,
      userId: id,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    })
    .onConflictDoNothing();
  return { kind: 'user', id, name: 'live', email: 'live@example.com', role: 'viewer', session };
}

/** Opens the order page's socket and keeps every state frame it receives. */
async function watch(orderId: string) {
  const headers = new Headers({ Upgrade: 'websocket' });
  headers.set(PRINCIPAL_HEADER, await signed(await viewer(), `/agents/order-agent/${orderId}`));
  const res = await worker.fetch(
    new Request(`http://engine/agents/order-agent/${orderId}`, { headers }),
    env,
  );
  if (!res.webSocket) throw new Error(`socket refused: ${res.status} ${await res.text()}`);
  const ws = res.webSocket;
  ws.accept();
  const frames: { bytes: number; state: OrderState }[] = [];
  ws.addEventListener('message', (e) => {
    const raw = String(e.data);
    const m = JSON.parse(raw);
    if (m.type === 'cf_agent_state')
      frames.push({ bytes: new TextEncoder().encode(raw).length, state: m.state as OrderState });
  });
  return {
    frames,
    /** Every frame after the first, which is the connect's. */
    updates: () => frames.slice(1),
    bytes: () => frames.slice(1).reduce((n, f) => n + f.bytes, 0),
    close: () => ws.close(),
  };
}

const input = (o: Partial<OrderInput> & Pick<OrderInput, 'model'>): OrderInput => ({
  channel: 'api',
  currency: 'USD',
  lines: [],
  meta: {},
  ...o,
});

/** Runs the default B2C order from placing to a returned, completed order. */
async function runStorefrontOrder() {
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const { orderId } = await startOrder(env, {
    flowId: 'tpl-storefront-order',
    input: input({ model: 'b2c', customerId: 'cus_ada', lines: [{ sku: 'MON-27', qty: 2 }] }),
  });
  const ws = await watch(orderId);
  await waitingOn(orderId, (s) => s.waits.some((w) => w.event === 'return.requested'), 'window');
  await agent(orderId).deliver('return.requested', { amount: 100, reason: 'Damaged box' });
  await waitingOn(orderId, (s) => s.waits.some((w) => w.event === 'return.received'), 'received');
  await agent(orderId).deliver('return.received');
  const done = await waitingOn(orderId, (s) => TERMINAL.includes(s.status), 'a terminal status');
  // Let a trailing flush land.
  await new Promise((r) => setTimeout(r, 300));
  return { orderId, ws, done };
}

/** What the default storefront order broadcast before its updates were coalesced. */
const BEFORE = { messages: 87, bytes: 580_190 };

/** The page's timeline after every frame, merged the way the order page merges them. */
const pageTimeline = (frames: { state: OrderState }[]) =>
  frames.reduce<TimelineEntry[]>((held, f) => mergeTimeline(held, f.state.timeline), []);

describe('order live updates', () => {
  it('sends a fraction of what an order broadcast before, with the flow out and the timeline whole', async () => {
    const { ws, done } = await runStorefrontOrder();
    const snapshot = await state(done.orderId!);
    const messages = ws.updates().length;
    const bytes = ws.bytes();
    console.log(
      `order live updates: ${messages} messages, ${bytes} bytes (before: ${BEFORE.messages}, ${BEFORE.bytes})`,
    );
    // The default storefront order: a quarter of the frames and bytes at most.
    expect(messages).toBeLessThanOrEqual(BEFORE.messages / 4);
    expect(bytes).toBeLessThanOrEqual(BEFORE.bytes / 4);

    // The graph never rides a frame; the page has it from its loader.
    expect(ws.frames.every((f) => f.state.flow === null)).toBe(true);
    expect(ws.frames.every((f) => f.state.timeline.length <= TIMELINE_BROADCAST)).toBe(true);
    // The newest frame is the order as it ended, and the frames add up to its whole timeline.
    const last = ws.frames.at(-1)!.state;
    expect(last).toMatchObject({
      status: snapshot.status,
      waits: [],
      nodes: JSON.parse(JSON.stringify(snapshot.nodes)),
    });
    expect(last.updatedAt).toBe(snapshot.updatedAt);
    expect(pageTimeline(ws.frames)).toEqual(snapshot.timeline);
    ws.close();
  });

  it('holds a burst of reports to one frame but never a status change, a wait or a vote', async () => {
    const id = 'ord_live_burst';
    const a = agent(id);
    const o = { ...order, id };
    await a.init(o, flow, `${id}-g1`);
    // The socket opens only for an order the index holds.
    await db().insert(orders).values({
      id,
      model: 'b2b',
      status: 'queued',
      flowId: 'tpl-b2b-order',
      flowVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    await a.report({ generation: 1, seq: 1, status: 'running', order: o });
    const ws = await watch(id);
    await until(async () => ws.frames.length > 0, 'the connect frame');
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await settle(150);
    const before = ws.frames.length;

    for (let i = 0; i < 5; i++)
      await a.report({
        generation: 1,
        log: { at: i, kind: 'node', message: `s${i}`, key: `k${i}` },
      });
    // Inside the window nothing has gone out; after it, one frame carries all five.
    await settle(30);
    expect(ws.frames.length).toBe(before);
    await settle(250);
    expect(ws.frames.length).toBe(before + 1);
    expect(
      ws.frames
        .at(-1)!
        .state.timeline.map((t) => t.message)
        .slice(-5),
    ).toEqual(['s0', 's1', 's2', 's3', 's4']);

    // A status change goes out with the report, not after the window.
    await a.report({ generation: 1, seq: 2, status: 'waiting' });
    await settle(30);
    expect(ws.frames.at(-1)!.state.status).toBe('waiting');
    // So does a wait an approver needs, and a terminal status.
    await a.openWait({
      nodeId: 'extract',
      eventType: 'pay#1',
      kind: 'event',
      event: 'payment.received',
      title: 'Payment',
      since: Date.now(),
    });
    await settle(30);
    expect(ws.frames.at(-1)!.state.waits.map((w) => w.eventType)).toEqual(['pay#1']);
    await a.report({ generation: 1, seq: 3, status: 'completed' });
    await settle(30);
    expect(ws.frames.at(-1)!.state.status).toBe('completed');
    ws.close();
  });

  it('keeps a page whole when a burst outgrows the frame tail', async () => {
    const id = 'ord_live_flood';
    const a = agent(id);
    const o = { ...order, id };
    await a.init(o, flow, `${id}-g1`);
    // The socket opens only for an order the index holds.
    await db().insert(orders).values({
      id,
      model: 'b2b',
      status: 'queued',
      flowId: 'tpl-b2b-order',
      flowVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    await a.report({ generation: 1, seq: 1, status: 'running', order: o });
    const ws = await watch(id);
    for (let i = 0; i < 130; i++)
      await a.report({
        generation: 1,
        log: { at: i, kind: 'node', message: `s${i}`, key: `k${i}` },
      });
    await new Promise((r) => setTimeout(r, 300));
    const snapshot = await state(id);
    expect(ws.frames.length).toBeLessThan(130);
    // Every frame carries a tail that overlaps the last, so the page merges to the whole timeline.
    expect(pageTimeline(ws.frames)).toEqual(snapshot.timeline);
    ws.close();
  });
});
