/**
 * Channel intake on the engine: the consumer reads the raw body the web app kept in DOCS, maps it with
 * the functions the web app checked it with and starts each order once per channel and external id,
 * so a redelivery or a duplicate gives one order; an order that can't start yet is retried, and past
 * the queue's retries the dead letter is kept in the replica and logged at error level.
 */
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  introspectWorkflow,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { IntakeMessage } from '@commerceworker/core';
import { createDb, orders, purchaseOrders } from '@commerceworker/db';
import { eq, like } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import shopify from '../../../packages/core/tests/fixtures/shopify-order.json';
import { backoff } from '../src/docs-replica';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';

const db = () => createDb(env.DB);
const QUEUE = 'commerceworker-intake';
const DLQ = 'commerceworker-intake-dlq';
const today = new Date().toISOString().slice(0, 10);

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeAll(async () => {
  await ensureTemplates(env);
});
beforeEach(async () => {
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await introspector.dispose();
});

/** Delivers messages to the Worker's `queue()` as Queues would, and returns what it did with them. */
let n = 0;
async function deliver(queue: string, bodies: unknown[], attempts = 1) {
  const batch = createMessageBatch(
    queue,
    bodies.map((body) => ({ id: `in-${++n}`, timestamp: new Date(), attempts, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue!(batch, env);
  return getQueueResult(batch, ctx);
}

/** What the web app does before answering 202: keep the raw body, name it in a message. */
async function accepted(key: string, raw: string, rest: Partial<IntakeMessage> & object = {}) {
  await env.DOCS.put(key, raw);
  return {
    channel: 'shopify',
    key,
    receivedAt: Date.now(),
    shop: 'acme.myshopify.com',
    flowId: 'tpl-storefront-order',
    ...rest,
  } as IntakeMessage;
}

const shopifyBody = (id: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({ ...shopify, id, ...over });
const byKey = (key: string) =>
  db().select().from(orders).where(eq(orders.idempotencyKey, key)).all();

describe('Shopify orders from the queue', () => {
  it('retries while the body is not readable and starts the order on redelivery', async () => {
    const key = `intake/shopify/${today}/wh-late`;
    const msg: IntakeMessage = {
      channel: 'shopify',
      key,
      receivedAt: Date.now(),
      shop: 'acme.myshopify.com',
      flowId: 'tpl-storefront-order',
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = await deliver(QUEUE, [msg]);
    expect(down.explicitAcks).toEqual([]);
    expect(down.retryMessages).toHaveLength(1);
    expect(warn.mock.calls.some(([l]) => String(l).includes('"intake_retry"'))).toBe(true);
    expect(await byKey('order:web:9101')).toHaveLength(0);

    await env.DOCS.put(key, shopifyBody(9101));
    const up = await deliver(QUEUE, [msg], 2);
    expect(up.explicitAcks).toHaveLength(1);
    expect(await byKey('order:web:9101')).toHaveLength(1);
    expect([1, 2, 3].map(backoff)).toEqual([30, 60, 120]);
  });

  it('gives one order for a duplicate delivery, and for the same webhook kept twice', async () => {
    const raw = shopifyBody(9102);
    const a = await accepted(`intake/shopify/${today}/wh-a`, raw);
    const b = await accepted(`intake/shopify/${today}/wh-b`, raw);
    const r = await deliver(QUEUE, [a, a, b]);
    expect(r.explicitAcks).toHaveLength(3);
    expect(await byKey('order:web:9102')).toHaveLength(1);
  });

  it('retries an order with a currency it has no rate for, and refuses one that arrives changed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const eur = await accepted(
      `intake/shopify/${today}/wh-eur`,
      shopifyBody(9103, { currency: 'XXX', presentment_currency: 'XXX' }),
    );
    expect((await deliver(QUEUE, [eur])).retryMessages).toHaveLength(1);
    expect(await byKey('order:web:9103')).toHaveLength(0);

    const first = await accepted(`intake/shopify/${today}/wh-m1`, shopifyBody(9104));
    expect((await deliver(QUEUE, [first])).explicitAcks).toHaveLength(1);
    const changed = await accepted(
      `intake/shopify/${today}/wh-m2`,
      shopifyBody(9104, {
        line_items: [{ sku: 'TEE-01', title: 'Tee', quantity: 9, price: '32.00' }],
      }),
    );
    // It can never start, so retrying is no use: it is acknowledged, and logged for a person at
    // error level (the raw body stays in DOCS for a week).
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const again = await deliver(QUEUE, [changed]);
    expect(again.explicitAcks).toHaveLength(1);
    expect(again.retryMessages).toEqual([]);
    expect(errors.mock.calls.some(([l]) => String(l).includes('intake_order_refused'))).toBe(true);
    expect(await byKey('order:web:9104')).toHaveLength(1);
  });

  it('acknowledges a message that is not an intake message, logging it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await deliver(QUEUE, [{ hello: 'world' }]);
    expect(r.explicitAcks).toHaveLength(1);
    expect(errors.mock.calls.some(([l]) => String(l).includes('intake_unreadable'))).toBe(true);
  });
});

const isa = (sender: string) =>
  `ISA*00*          *00*          *ZZ*${sender.padEnd(15)}*ZZ*COMMERCEWORKER *261014*1200*U*00401*000000001*0*P*>~`;
const tx = (control: string, po: string, price = '21.50') =>
  [
    `ST*850*${control}`,
    `BEG*00*SA*${po}**20261014`,
    `PO1*1*120*EA*${price}**VP*WID-100`,
    'CTT*1',
    `SE*5*${control}`,
  ].join('~');
const noPo = ['ST*850*0002', 'PO1*1*1*EA*1**VP*WID-100', 'CTT*1', 'SE*4*0002'].join('~');
const x12 = (sender: string, txs: string[]) =>
  `${isa(sender)}GS*PO*${sender}*COMMERCEWORKER*20261014*1200*1*X*004010~${txs.join('~')}~GE*${txs.length}*1~IEA*1*000000001~`;

describe('EDI 850 from the queue', () => {
  it('starts each purchase order once, records it as a PO, and skips one refused in the 997', async () => {
    const key = `intake/edi/${today}/${'a'.repeat(40)}`;
    await env.DOCS.put(key, x12('NORTHWIND', [tx('0001', 'QNW-1'), noPo, tx('0003', 'QNW-3')]));
    const msg: IntakeMessage = {
      channel: 'edi',
      key,
      receivedAt: Date.now(),
      sender: 'NORTHWIND',
      customerId: 'cus_northwind',
      flows: { '0001': 'tpl-b2b-order', '0003': 'tpl-b2b-order' },
      actor: { kind: 'token', id: 'tok_edi' },
    };
    const r = await deliver(QUEUE, [msg, msg]);
    expect(r.explicitAcks).toHaveLength(2);
    for (const po of ['QNW-1', 'QNW-3']) {
      const rows = await byKey(`order:edi:NORTHWIND:${po}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: 'edi', customerId: 'cus_northwind' });
    }
    const records = await db()
      .select()
      .from(purchaseOrders)
      .where(like(purchaseOrders.poNumber, 'QNW-%'))
      .all();
    expect(records.map((p) => p.poNumber).sort()).toEqual(['QNW-1', 'QNW-3']);
  });

  const edi = (key: string, flows: Record<string, string>): IntakeMessage => ({
    channel: 'edi',
    key,
    receivedAt: Date.now(),
    sender: 'NORTHWIND',
    customerId: 'cus_northwind',
    flows,
    actor: { kind: 'token', id: 'tok_edi' },
  });

  it('retries the interchange when a flow is not published, and starts the rest of it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = `intake/edi/${today}/${'b'.repeat(40)}`;
    await env.DOCS.put(key, x12('NORTHWIND', [tx('0001', 'QNW-4'), tx('0002', 'QNW-5')]));
    const r = await deliver(QUEUE, [edi(key, { '0001': 'no-such-flow', '0002': 'tpl-b2b-order' })]);
    expect(r.retryMessages).toHaveLength(1);
    expect(await byKey('order:edi:NORTHWIND:QNW-4')).toHaveLength(0);
    // The one that could start did, and starts once more on the retry.
    expect(await byKey('order:edi:NORTHWIND:QNW-5')).toHaveLength(1);
    const again = await deliver(
      QUEUE,
      [edi(key, { '0001': 'tpl-b2b-order', '0002': 'tpl-b2b-order' })],
      2,
    );
    expect(again.explicitAcks).toHaveLength(1);
    expect(await byKey('order:edi:NORTHWIND:QNW-4')).toHaveLength(1);
    expect(await byKey('order:edi:NORTHWIND:QNW-5')).toHaveLength(1);
  });

  it('skips a PO that can never start and starts the ones after it', async () => {
    const flows = { '0001': 'tpl-b2b-order', '0002': 'tpl-b2b-order', '0003': 'tpl-b2b-order' };
    const first = `intake/edi/${today}/${'c'.repeat(40)}`;
    await env.DOCS.put(first, x12('NORTHWIND', [tx('0001', 'QNW-A')]));
    expect((await deliver(QUEUE, [edi(first, flows)])).explicitAcks).toHaveLength(1);

    // A resent with A changed, then B and C: A is a replay with different contents.
    const second = `intake/edi/${today}/${'d'.repeat(40)}`;
    await env.DOCS.put(
      second,
      x12('NORTHWIND', [tx('0001', 'QNW-A', '99.00'), tx('0002', 'QNW-B'), tx('0003', 'QNW-C')]),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await deliver(QUEUE, [edi(second, flows)]);
    expect(r.explicitAcks).toHaveLength(1);
    expect(r.retryMessages).toEqual([]);
    expect(await byKey('order:edi:NORTHWIND:QNW-B')).toHaveLength(1);
    expect(await byKey('order:edi:NORTHWIND:QNW-C')).toHaveLength(1);
    expect(await byKey('order:edi:NORTHWIND:QNW-A')).toHaveLength(1);
    const line = errors.mock.calls
      .map(([l]) => String(l))
      .find((l) => l.includes('intake_order_refused'));
    expect(JSON.parse(line!)).toMatchObject({ order: 'QNW-A', key: second });
  });
});

describe('dead letters', () => {
  it('keeps one in the replica, logs it at error level and acknowledges it', async () => {
    const msg = await accepted(`intake/shopify/${today}/wh-dead`, shopifyBody(9105));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await deliver(DLQ, [msg], 7);
    expect(r.explicitAcks).toHaveLength(1);
    expect(
      errors.mock.calls.some(([l]) => typeof l === 'string' && l.includes('"dlq_message"')),
    ).toBe(true);
    const kept = await env.DOCS_REPLICA.list({ prefix: `dlq/${DLQ}/${today}/` });
    expect(kept.objects).toHaveLength(1);
    expect(
      JSON.parse(await (await env.DOCS_REPLICA.get(kept.objects[0]!.key))!.text()),
    ).toMatchObject({ queue: DLQ, body: { key: msg.key } });
    // The raw body is still where the message points.
    expect(await env.DOCS.get(msg.key)).not.toBeNull();
  });
});
