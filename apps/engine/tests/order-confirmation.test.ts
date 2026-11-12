/**
 * The order-confirmation email on the engine: the Workflow sends it for a hosted web order that
 * completes, once; a deployment with no Email Sending binding sends nothing and says so; and the
 * receipt link it carries opens the order, for its credential alone, through `StorefrontApi`.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  type BuyerOrderView,
  ORDER_VIEW_TTL_MS,
  type OrderInput,
  type OrderState,
} from '@commerceworker/core';
import { createDb, messages, orderViewTokens } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../src/flows';
import { orderConfirmation } from '../src/order-confirmation';
import { fromOutside, startOrder, startOrderOnce } from '../src/orders';
import { emailSender } from '../src/wire';
import { storefrontApi } from './principal';

const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeAll(async () => {
  await ensureTemplates(env);
});
afterEach(async () => {
  await introspector?.dispose();
});

async function settled(id: string) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const s = (await agent(id).snapshot()) as OrderState;
    if (['completed', 'failed', 'cancelled', 'declined'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for the order to end');
}

/** A counter sale on the web channel: it completes without a wait, so the test can follow it. */
async function sale(meta: Record<string, unknown>, opts: { key?: string; outside?: boolean } = {}) {
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
    meta,
  };
  const req = { flowId: 'tpl-pos-sale', input };
  const { orderId } = opts.key
    ? ((await startOrderOnce(env, { ...req, idempotencyKey: opts.key })) as { orderId: string })
    : await startOrder(env, opts.outside ? fromOutside(req) : req);
  return { orderId, done: await settled(orderId) };
}

const confirmation = async (orderId: string) =>
  (await db().select().from(messages).where(eq(messages.orderId, orderId))).find((m) =>
    m.id.endsWith('_confirmation'),
  );

/** A send_email binding that keeps what it was given. */
function fakeEmail() {
  const sent: { from: unknown; to: unknown; subject: string; text?: string; html?: string }[] = [];
  const binding = {
    send: async (m: (typeof sent)[number]) => {
      sent.push(m);
      return { messageId: `m${sent.length}` };
    },
  };
  return {
    sent,
    env: { ...env, EMAIL: binding, EMAIL_FROM: 'orders@mail.shop.test' } as unknown as Env,
  };
}

describe('the wiring', () => {
  it('sends nothing without both the binding and the sender address', () => {
    expect(
      emailSender({ EMAIL: undefined, EMAIL_FROM: 'a@b.test', EMAIL_FROM_NAME: '' }),
    ).toBeUndefined();
    expect(
      emailSender({ EMAIL: fakeEmail().env.EMAIL, EMAIL_FROM: '', EMAIL_FROM_NAME: '' }),
    ).toBeUndefined();
    expect(emailSender(fakeEmail().env)).toBeDefined();
  });

  it('refuses an unusable sender address, and the send records that it failed instead of throwing', async () => {
    const { env: bad } = fakeEmail();
    const r = await orderConfirmation.send(
      { ...bad, EMAIL_FROM: 'not an address' } as unknown as Env,
      'ord_none',
    );
    expect(r.status).toBe('unknown_order');
    const { orderId } = await sale({});
    const failed = await orderConfirmation.send(
      { ...bad, EMAIL_FROM: 'not an address' } as unknown as Env,
      orderId,
    );
    expect(failed).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('EMAIL_FROM'),
    });
  });
});

describe('a hosted web order that completes', () => {
  it('records its confirmation unsent, and says why, when email sending is not configured', async () => {
    const { orderId, done } = await sale({}, { key: `hosted:${crypto.randomUUID()}` });
    expect(done.status).toBe('completed');
    const m = await confirmation(orderId);
    expect(m).toMatchObject({
      recipient: 'buyer@example.com',
      sentAt: null,
      error: 'Email sending is not configured on this deployment',
    });
    // No credential is minted for a message that isn't mailed.
    expect(
      await db().select().from(orderViewTokens).where(eq(orderViewTokens.orderId, orderId)),
    ).toEqual([]);
    const line = done.timeline.find((t) => t.key?.endsWith(':unsent'));
    expect(line?.message).toMatch(/email sending is not configured/);
  });

  it('is mailed once, with a link only its credential opens', async () => {
    const { orderId } = await sale({}, { key: `hosted:${crypto.randomUUID()}` });
    const mail = fakeEmail();
    const first = await orderConfirmation.send(mail.env, orderId);
    expect(first.status).toBe('sent');
    expect(await orderConfirmation.send(mail.env, orderId)).toMatchObject({
      status: 'already_sent',
    });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ from: 'orders@mail.shop.test', to: 'buyer@example.com' });
    const link = new RegExp(`${env.STOREFRONT_ORIGIN}/orders/${orderId}\\?t=([0-9a-f]{64})`).exec(
      mail.sent[0]!.text!,
    );
    expect(link).not.toBeNull();
    const token = link![1]!;

    const stored = await confirmation(orderId);
    expect(stored?.sentAt).toBeTypeOf('number');
    expect(stored?.body).not.toContain(token);
    const rows = await db()
      .select()
      .from(orderViewTokens)
      .where(eq(orderViewTokens.orderId, orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.expiresAt - rows[0]!.createdAt).toBe(ORDER_VIEW_TTL_MS);

    const view = (await storefrontApi().orderReceipt(orderId, token)) as BuyerOrderView;
    expect(view).toMatchObject({
      id: orderId,
      status: 'completed',
      lines: [{ sku: 'TEE-01', qty: 1 }],
    });
    // Buyer-safe only: nothing of the timeline, the flow, the contact or the meta.
    expect(Object.keys(view).sort()).toEqual(
      [
        'currency',
        'id',
        'lines',
        'placedAt',
        'ref',
        'shipTo',
        'shipments',
        'shipping',
        'status',
        'subtotal',
        'tax',
        'total',
      ].sort(),
    );
    expect(JSON.stringify(view)).not.toMatch(/buyer@example|hosted|timeline|Pat Buyer/);
  });

  it('is not confirmed unless it is hosted and on the web channel', async () => {
    const plain = await sale({});
    expect(await confirmation(plain.orderId)).toBeUndefined();
  });

  it('is not mailed for a caller’s meta.hosted: only the engine’s own hosted: key marks it', async () => {
    // As the REST and binding paths start it, with every mark only the core sets dropped.
    const outside = await sale({ hosted: true }, { outside: true });
    expect(outside.done.status).toBe('completed');
    expect(outside.done.order?.meta).not.toHaveProperty('hosted');
    expect(await confirmation(outside.orderId)).toBeUndefined();
    // Even a meta that got through (an internal start) does nothing without the key.
    const meta = await sale({ hosted: true });
    expect(await confirmation(meta.orderId)).toBeUndefined();
    // A key off the reserved prefix, or on another channel, doesn't either.
    const other = await sale({}, { key: `shop:${crypto.randomUUID()}` });
    expect(await confirmation(other.orderId)).toBeUndefined();
  });

  it('is mailed for an order started under a hosted: key', async () => {
    const { orderId } = await sale({}, { key: `hosted:${crypto.randomUUID()}` });
    expect(await confirmation(orderId)).toMatchObject({ recipient: 'buyer@example.com' });
  });
});

describe('the receipt link', () => {
  async function minted() {
    const { orderId } = await sale({}, { key: `hosted:${crypto.randomUUID()}` });
    const mail = fakeEmail();
    await orderConfirmation.send(mail.env, orderId);
    return { orderId, token: /\?t=([0-9a-f]{64})/.exec(mail.sent[0]!.text!)![1]! };
  }

  it('shows nothing for a wrong credential, another order’s, an unknown order or a malformed one', async () => {
    const a = await minted();
    const b = await minted();
    const api = storefrontApi();
    expect(await api.orderReceipt(a.orderId, 'f'.repeat(64))).toBeNull();
    expect(await api.orderReceipt(a.orderId, b.token)).toBeNull();
    expect(await api.orderReceipt('ord_nope', a.token)).toBeNull();
    expect(await api.orderReceipt(a.orderId, '')).toBeNull();
    expect(await api.orderReceipt(a.orderId, a.token.toUpperCase())).toBeNull();
    expect(await api.orderReceipt(a.orderId, 42 as never)).toBeNull();
  });

  it('shows nothing once it has expired', async () => {
    const { orderId, token } = await minted();
    expect(await storefrontApi().orderReceipt(orderId, token)).not.toBeNull();
    await db()
      .update(orderViewTokens)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(orderViewTokens.orderId, orderId));
    expect(await storefrontApi().orderReceipt(orderId, token)).toBeNull();
  });
});
