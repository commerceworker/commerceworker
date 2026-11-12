import { type BuyerOrderView, ORDER_VIEW_TTL_MS } from '@commerceworker/core';
import type { EmailMessage, EmailSender } from '@commerceworker/ports';
import type { OrderConfirmations } from '@commerceworker/ports/commerce';
import { InMemoryMessageStore, InMemoryOrderViewTokens } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { NOT_CONFIGURED, orderReceipt, sendOrderConfirmation } from '../src/commerce';

const now = 1_800_000_000_000;
const ORIGIN = 'https://shop.example';

const view = (over: Partial<BuyerOrderView> = {}): BuyerOrderView => ({
  id: 'ord_abc123def456',
  ref: '#def456',
  status: 'completed',
  placedAt: now - 1000,
  currency: 'USD',
  lines: [{ sku: 'MUG', name: 'Blue mug', qty: 2, unitPrice: 12, lineTotal: 24 }],
  subtotal: 24,
  shipping: 5,
  tax: 2.4,
  total: 31.4,
  shipTo: ['Pat Buyer', '1 Main St', 'Springfield, IL 62701', 'US'],
  shipments: [],
  ...over,
});

function setup(opts: { view?: BuyerOrderView; recipient?: string | null; email?: boolean } = {}) {
  const sent: EmailMessage[] = [];
  let fail: string | null = null;
  const sender: EmailSender = {
    async send(m) {
      if (fail) return { delivered: false, error: fail };
      sent.push(m);
      return { delivered: true, id: `m${sent.length}` };
    },
  };
  const v = opts.view ?? view();
  const orders: OrderConfirmations = {
    read: async (id) =>
      id === v.id
        ? { view: v, recipient: opts.recipient === undefined ? 'pat@example.com' : opts.recipient }
        : null,
  };
  const messages = new InMemoryMessageStore();
  const tokens = new InMemoryOrderViewTokens();
  const ports = (email = opts.email !== false) => ({
    orders,
    messages,
    tokens,
    email: email ? sender : undefined,
    storefrontOrigin: ORIGIN,
  });
  return {
    sent,
    messages,
    tokens,
    ports,
    failWith: (e: string | null) => {
      fail = e;
    },
    id: v.id,
  };
}

const credentialOf = (m: EmailMessage) => /\?t=([0-9a-f]{64})/.exec(m.text)?.[1] ?? '';

describe('sendOrderConfirmation', () => {
  it('mails the buyer once per order and sends nothing on a repeat', async () => {
    const t = setup();
    const first = await sendOrderConfirmation(t.ports(), t.id, now);
    expect(first.status).toBe('sent');
    const again = await sendOrderConfirmation(t.ports(), t.id, now + 1000);
    expect(again.status).toBe('already_sent');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      to: ['pat@example.com'],
      subject: 'Your order #def456 is confirmed',
    });
    expect(t.sent[0]?.text).toContain('2 × Blue mug');
    expect(t.sent[0]?.text).toContain('Total: $31.40');
    expect(t.sent[0]?.text).toContain('1 Main St');
    const [m] = await t.messages.messages(t.id);
    expect(m).toMatchObject({ messageId: `msg_${t.id}_confirmation`, sentAt: now, error: null });
  });

  it('keeps the credential in the email alone, and only its hash in the store', async () => {
    const t = setup();
    await sendOrderConfirmation(t.ports(), t.id, now);
    const mail = t.sent[0]!;
    const token = credentialOf(mail);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mail.text).toContain(`${ORIGIN}/orders/${t.id}?t=${token}`);
    expect(mail.html).toContain(`href="${ORIGIN}/orders/${t.id}?t=${token}"`);
    const [stored] = await t.messages.messages(t.id);
    expect(stored?.body).not.toContain(token);
    expect(stored?.body).toContain(`${ORIGIN}/orders/${t.id}`);
    expect(t.tokens.hashes()).toHaveLength(1);
    expect(t.tokens.hashes()).not.toContain(token);
  });

  it('keeps a product title and a buyer’s name as text, escaped in the HTML part', async () => {
    const t = setup({
      view: view({
        lines: [
          {
            sku: 'X',
            name: '<script>alert(1)</script> & "co"',
            qty: 1,
            unitPrice: 1,
            lineTotal: 1,
          },
        ],
        shipTo: ['<img src=x onerror=alert(1)>', 'Main St'],
      }),
    });
    await sendOrderConfirmation(t.ports(), t.id, now);
    const mail = t.sent[0]!;
    expect(mail.text).toContain('<script>alert(1)</script> & "co"');
    expect(mail.html).not.toMatch(/<script|<img/i);
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // The subject holds only the order's reference.
    expect(mail.subject).not.toContain('script');
  });

  it('sends nothing without Email Sending, and records why on the message', async () => {
    const t = setup();
    const r = await sendOrderConfirmation(t.ports(false), t.id, now);
    expect(r.status).toBe('not_configured');
    expect(t.sent).toEqual([]);
    expect(t.tokens.hashes()).toEqual([]);
    expect((await t.messages.find(t.id, 'confirmation'))?.error).toBe(NOT_CONFIGURED);
    // Once the binding is there, the same order's confirmation goes.
    expect((await sendOrderConfirmation(t.ports(true), t.id, now + 1)).status).toBe('sent');
    expect((await t.messages.find(t.id, 'confirmation'))?.error).toBeNull();
  });

  it('records a refusal and tries again on the next call', async () => {
    const t = setup();
    t.failWith('E_SENDER_NOT_VERIFIED: domain is not onboarded');
    const r = await sendOrderConfirmation(t.ports(), t.id, now);
    expect(r).toMatchObject({ status: 'failed', error: expect.stringContaining('onboarded') });
    expect((await t.messages.find(t.id, 'confirmation'))?.sentAt).toBeNull();
    // The credential minted for the attempt that failed reaches no one, so it is gone.
    expect(t.tokens.hashes()).toEqual([]);
    t.failWith(null);
    expect((await sendOrderConfirmation(t.ports(), t.id, now + 1)).status).toBe('sent');
    expect(t.sent).toHaveLength(1);
    expect(t.tokens.hashes()).toHaveLength(1);
  });

  it('leaves at most one live credential per order, whatever failed before', async () => {
    const t = setup();
    await t.tokens.issue(t.id, 'e'.repeat(64), now, now + 1000);
    await sendOrderConfirmation(t.ports(), t.id, now);
    expect(await t.tokens.live(t.id, now)).toHaveLength(1);
    expect(await t.tokens.live(t.id, now)).not.toContain('e'.repeat(64));
  });

  it('treats a sender that throws as a failed send', async () => {
    const t = setup();
    const ports = {
      ...t.ports(),
      email: {
        send: async () => {
          throw new Error('binding down');
        },
      },
    };
    expect(await sendOrderConfirmation(ports, t.id, now)).toMatchObject({
      status: 'failed',
      error: 'binding down',
    });
  });

  it('sends nothing for an order with no address, or no order', async () => {
    const t = setup({ recipient: null });
    expect((await sendOrderConfirmation(t.ports(), t.id, now)).status).toBe('no_recipient');
    expect((await sendOrderConfirmation(t.ports(), 'ord_missing', now)).status).toBe(
      'unknown_order',
    );
    expect(t.sent).toEqual([]);
    expect(await t.messages.messages(t.id)).toEqual([]);
  });
});

describe('orderReceipt', () => {
  async function confirmed() {
    const t = setup();
    await sendOrderConfirmation(t.ports(), t.id, now);
    return { t, token: credentialOf(t.sent[0]!) };
  }

  it('shows the order to the credential its email carried', async () => {
    const { t, token } = await confirmed();
    const r = await orderReceipt(t.ports(), t.id, token, now + 1000);
    expect(r).toMatchObject({ id: t.id, ref: '#def456', total: 31.4 });
  });

  it('shows nothing for a wrong credential, one of another order, or none', async () => {
    const { t, token } = await confirmed();
    expect(await orderReceipt(t.ports(), t.id, 'f'.repeat(64), now)).toBeNull();
    expect(await orderReceipt(t.ports(), t.id, token.slice(1), now)).toBeNull();
    expect(await orderReceipt(t.ports(), t.id, '', now)).toBeNull();
    expect(await orderReceipt(t.ports(), 'ord_other', token, now)).toBeNull();
  });

  it('shows nothing once the credential has expired', async () => {
    const { t, token } = await confirmed();
    expect(await orderReceipt(t.ports(), t.id, token, now + ORDER_VIEW_TTL_MS - 1)).not.toBeNull();
    expect(await orderReceipt(t.ports(), t.id, token, now + ORDER_VIEW_TTL_MS)).toBeNull();
  });

  it('shows nothing once the order’s credentials are revoked (an erasure)', async () => {
    const { t, token } = await confirmed();
    await t.tokens.revoke([t.id]);
    expect(await orderReceipt(t.ports(), t.id, token, now)).toBeNull();
  });

  it('carries only the buyer-safe fields', async () => {
    const { t, token } = await confirmed();
    const r = await orderReceipt(t.ports(), t.id, token, now);
    expect(Object.keys(r ?? {}).sort()).toEqual(
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
  });
});
