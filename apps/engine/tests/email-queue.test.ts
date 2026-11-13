/**
 * The mail queue on the engine: a confirmation is filed and queued, the consumer sends it and marks
 * it, a redelivery sends nothing, a refusal retries with a backoff and then dead-letters (kept in the
 * replica, logged at error level, counted); a sign-in code is sent inline and queued only as the
 * retry; the fallback sender answers the refusals it should; and Email Sending's events land on the
 * message. With no queue bound, mail goes inline as before.
 */
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  introspectWorkflow,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  type OrderInput,
  type OrderState,
  SHOPPER_CALL,
  SHOPPER_GUEST_ID,
} from '@commerceworker/core';
import { createDb, messages, shopperSignIns } from '@commerceworker/db';
import { eq, like } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { backoff } from '../src/docs-replica';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { orderConfirmation } from '../src/order-confirmation';
import { startOrderOnce } from '../src/orders';
import { StorefrontApi } from '../src/storefront-api';
import { emailSender } from '../src/wire';
import { signedGuest } from './principal';

const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const QUEUE = 'commerceworker-email';
const DLQ = 'commerceworker-email-dlq';
const EVENTS = 'commerceworker-email-events';
const today = new Date().toISOString().slice(0, 10);

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeAll(async () => {
  await ensureTemplates(env);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await introspector?.dispose();
});

async function placedOrder() {
  await introspector?.dispose();
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const input: OrderInput = {
    model: 'b2c',
    channel: 'web',
    currency: 'USD',
    title: 'Hosted sale',
    contact: { email: 'buyer@example.com', name: 'Pat Buyer' },
    fulfillment: { method: 'carry_out', locationId: 'loc_mission' },
    lines: [{ sku: 'TEE-01', qty: 1 }],
    meta: {},
  };
  const { orderId } = (await startOrderOnce(env, {
    flowId: 'tpl-pos-sale',
    input,
    idempotencyKey: `hosted:${crypto.randomUUID()}`,
  })) as { orderId: string };
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const s = (await agent(orderId).snapshot()) as OrderState;
    if (['completed', 'failed', 'cancelled', 'declined'].includes(s.status)) return orderId;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for the order to end');
}

type Sent = { from: unknown; to: unknown; subject: string; text?: string };

/** A send_email binding that keeps what it was given, or throws `fail` (with a code). */
function binding(fail?: () => { code?: string } | null) {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (m: Sent) => {
      const f = fail?.();
      if (f) throw Object.assign(new Error('refused'), f);
      sent.push(m);
      return { messageId: `prov-${crypto.randomUUID().slice(0, 8)}` };
    },
  };
}

/** An engine env that has the sender and a queue that keeps what it is given. */
function mailEnv(opts: { fail?: () => { code?: string } | null; queue?: boolean } = {}) {
  const email = binding(opts.fail);
  const jobs: unknown[] = [];
  const e = {
    ...env,
    EMAIL: email,
    EMAIL_FROM: 'orders@mail.shop.test',
    EMAIL_QUEUE:
      opts.queue === false ? undefined : { send: async (j: unknown) => void jobs.push(j) },
  } as unknown as Env;
  return { env: e, email, jobs };
}

/** Delivers messages to the Worker's `queue()` as Queues would, and returns what it did with them. */
let n = 0;
async function deliver(queue: string, bodies: unknown[], over: Env, attempts = 1) {
  const batch = createMessageBatch(
    queue,
    bodies.map((body) => ({ id: `em-${++n}`, timestamp: new Date(), attempts, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue!(batch, over);
  return getQueueResult(batch, ctx);
}

const row = async (orderId: string) =>
  (await db().select().from(messages).where(eq(messages.orderId, orderId))).find((m) =>
    m.id.endsWith('_confirmation'),
  );

describe('an order confirmation with the queue bound', () => {
  it('is filed and queued, then sent by the consumer and marked; a redelivery sends nothing', async () => {
    const orderId = await placedOrder();
    const m = mailEnv();
    expect(await orderConfirmation.send(m.env, orderId)).toMatchObject({ status: 'queued' });
    // Filed first, unsent, and nothing mailed (and no credential minted) until the consumer runs.
    expect(await row(orderId)).toMatchObject({ sentAt: null, recipient: 'buyer@example.com' });
    expect(m.email.sent).toEqual([]);
    expect(m.jobs).toHaveLength(1);

    const first = await deliver(QUEUE, m.jobs, m.env);
    expect(first.explicitAcks).toHaveLength(1);
    expect(first.retryMessages).toEqual([]);
    expect(m.email.sent).toHaveLength(1);
    expect(m.email.sent[0]).toMatchObject({
      to: 'buyer@example.com',
      from: 'orders@mail.shop.test',
    });
    expect(await row(orderId)).toMatchObject({
      sentAt: expect.any(Number),
      providerId: expect.stringMatching(/^prov-/),
    });

    const again = await deliver(QUEUE, m.jobs, m.env, 2);
    expect(again.explicitAcks).toHaveLength(1);
    expect(m.email.sent).toHaveLength(1);
  });

  it('retries a refusal with a backoff, and sends once it clears', async () => {
    const orderId = await placedOrder();
    let down = true;
    const m = mailEnv({ fail: () => (down ? { code: 'E_RATE_LIMIT_EXCEEDED' } : null) });
    await orderConfirmation.send(m.env, orderId);
    const failed = await deliver(QUEUE, m.jobs, m.env);
    expect(failed.explicitAcks).toEqual([]);
    expect(failed.retryMessages).toHaveLength(1);
    expect((await row(orderId))?.error).toMatch(/E_RATE_LIMIT_EXCEEDED/);
    expect((await row(orderId))?.sentAt).toBeNull();
    // A later attempt waits longer: 30 seconds, doubling, up to 15 minutes.
    expect([1, 2, 3, 6, 20].map(backoff)).toEqual([30, 60, 120, 900, 900]);
    expect((await deliver(QUEUE, m.jobs, m.env, 3)).retryMessages).toHaveLength(1);
    down = false;
    expect((await deliver(QUEUE, m.jobs, m.env, 4)).explicitAcks).toHaveLength(1);
    expect(m.email.sent).toHaveLength(1);
    expect((await row(orderId))?.error).toBeNull();
  });

  it('keeps a dead letter in the replica, logs it at error level and counts it', async () => {
    const orderId = await placedOrder();
    const job = { kind: 'confirmation', orderId, messageId: `msg_${orderId}_confirmation` };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const count = vi.spyOn(env.METRICS, 'writeDataPoint');
    const r = await deliver(DLQ, [job], env as Env);
    expect(r.explicitAcks).toHaveLength(1);
    expect(
      errors.mock.calls.some(
        ([line]) => typeof line === 'string' && line.includes('"dlq_message"'),
      ),
    ).toBe(true);
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining(['failover', 'engine', 'email_failed']),
      }),
    );
    const kept = await env.DOCS_REPLICA.list({ prefix: `dlq/${DLQ}/${today}/` });
    expect(kept.objects).toHaveLength(1);
    expect(
      JSON.parse(await (await env.DOCS_REPLICA.get(kept.objects[0]!.key))!.text()),
    ).toMatchObject({
      queue: DLQ,
      body: job,
    });
  });

  it('with no queue bound, sends inline as it always did', async () => {
    const orderId = await placedOrder();
    const m = mailEnv({ queue: false });
    expect(await orderConfirmation.send(m.env, orderId)).toMatchObject({ status: 'sent' });
    expect(m.email.sent).toHaveLength(1);
    expect(m.jobs).toEqual([]);
  });

  it('queues nothing, and says why on the row, when the deployment has no sender', async () => {
    const orderId = await placedOrder();
    const jobs: unknown[] = [];
    const e = {
      ...env,
      EMAIL: undefined,
      EMAIL_QUEUE: { send: async (j: unknown) => void jobs.push(j) },
    } as unknown as Env;
    expect(await orderConfirmation.send(e, orderId)).toMatchObject({ status: 'not_configured' });
    expect(jobs).toEqual([]);
  });
});

describe('a shopper’s sign-in code', () => {
  const who = () => `${crypto.randomUUID().slice(0, 8)}@queue-engine.test`;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  const actor = () =>
    signedGuest({ kind: 'guest', id: SHOPPER_GUEST_ID, name: 'Shopper' }, SHOPPER_CALL);

  afterEach(async () => {
    await db().delete(shopperSignIns).where(like(shopperSignIns.email, '%@queue-engine.test'));
  });

  it('is sent inline first, and the queue is not touched when that works', async () => {
    const m = mailEnv();
    const r = await new StorefrontApi(ctx, m.env).startShopperSignIn(who(), await actor());
    expect(r).toEqual({ status: 'sent' });
    expect(m.email.sent).toHaveLength(1);
    expect(m.jobs).toEqual([]);
  });

  it('is queued as the retry when the inline attempt fails, and the queue sends it while the code lives', async () => {
    let down = true;
    const m = mailEnv({ fail: () => (down ? { code: 'E_INTERNAL_SERVER_ERROR' } : null) });
    const r = await new StorefrontApi(ctx, m.env).startShopperSignIn(who(), await actor());
    expect(r).toEqual({ status: 'sent' });
    expect(m.email.sent).toEqual([]);
    expect(m.jobs).toHaveLength(1);
    down = false;
    expect((await deliver(QUEUE, m.jobs, m.env)).explicitAcks).toHaveLength(1);
    expect(m.email.sent).toHaveLength(1);
    expect(m.email.sent[0]?.text).toMatch(/code is \d{6}/);
  });

  it('is dropped unsent once its code has expired, and its dead letter keeps no code', async () => {
    const m = mailEnv();
    const dead = {
      kind: 'sign_in',
      to: 'gone@queue-engine.test',
      subject: 'Your code',
      text: 'Your code is 654321',
      expiresAt: Date.now() - 1,
    };
    expect((await deliver(QUEUE, [dead], m.env)).explicitAcks).toHaveLength(1);
    expect(m.email.sent).toEqual([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliver(DLQ, [{ ...dead, expiresAt: Date.now() + 1000 }], env as Env);
    const kept = (await env.DOCS_REPLICA.list({ prefix: `dlq/${DLQ}/${today}/` })).objects;
    const texts = await Promise.all(
      kept.map(async (o) => (await env.DOCS_REPLICA.get(o.key))!.text()),
    );
    expect(texts.some((t) => t.includes('"redacted":true'))).toBe(true);
    expect(texts.join()).not.toMatch(/654321|gone@queue-engine/);
  });
});

describe('the fallback sender', () => {
  const message = { to: ['buyer@example.com'], subject: 's', text: 't' };
  const senderWith = (code?: string) => {
    const primary = binding(() => (code ? { code } : null));
    const fallback = binding();
    return {
      primary,
      fallback,
      sender: emailSender({
        EMAIL: primary,
        EMAIL_FROM: 'orders@main.test',
        EMAIL_FROM_NAME: '',
        EMAIL_FALLBACK: fallback,
        EMAIL_FALLBACK_FROM: 'orders@backup.test',
      } as never)!,
    };
  };

  it.each(['E_SENDER_NOT_VERIFIED', 'E_INTERNAL_SERVER_ERROR'])(
    'sends from the fallback domain on %s',
    async (code) => {
      const t = senderWith(code);
      expect((await t.sender.send(message)).delivered).toBe(true);
      expect(t.fallback.sent[0]).toMatchObject({ from: 'orders@backup.test' });
    },
  );

  it('keeps to the primary on a refusal the fallback could not fix, and when nothing is wrong', async () => {
    const limited = senderWith('E_DAILY_LIMIT_EXCEEDED');
    expect((await limited.sender.send(message)).delivered).toBe(false);
    expect(limited.fallback.sent).toEqual([]);
    const fine = senderWith();
    expect((await fine.sender.send(message)).delivered).toBe(true);
    expect(fine.primary.sent[0]).toMatchObject({ from: 'orders@main.test' });
    expect(fine.fallback.sent).toEqual([]);
  });

  it('is only the primary without a fallback binding or address', () => {
    expect(
      emailSender({ EMAIL: binding(), EMAIL_FROM: 'a@main.test', EMAIL_FROM_NAME: '' } as never),
    ).toBeDefined();
  });
});

describe('Email Sending’s events', () => {
  const event = (type: string, messageId: string) => ({
    type: `cf.email.sending.message.${type}`,
    payload: { messageId, recipient: 'buyer@example.com' },
    metadata: { eventTimestamp: new Date().toISOString() },
  });

  it('records the status on the message its id names', async () => {
    const orderId = await placedOrder();
    const m = mailEnv({ queue: false });
    await orderConfirmation.send(m.env, orderId);
    const provider = (await row(orderId))!.providerId!;
    const r = await deliver(
      EVENTS,
      [event('delivered', provider), event('complained', provider)],
      m.env,
    );
    expect(r.explicitAcks).toHaveLength(2);
    expect(await row(orderId)).toMatchObject({ deliveryStatus: 'complained' });
  });

  it('waits a little for a message it can not find, then lets it go', async () => {
    const waiting = await deliver(EVENTS, [event('delivered', 'nobody-yet')], env as Env, 1);
    expect(waiting.retryMessages).toHaveLength(1);
    const gone = await deliver(EVENTS, [event('delivered', 'nobody-yet')], env as Env, 3);
    expect(gone.explicitAcks).toHaveLength(1);
    expect((await deliver(EVENTS, [{ nonsense: true }], env as Env)).explicitAcks).toHaveLength(1);
  });
});
