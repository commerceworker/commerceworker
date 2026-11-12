/**
 * A signed-in shopper's account through `StorefrontApi`: their orders (a keyset-paged list and one
 * order's buyer-safe view) and the places they ship to, all scoped by the session's email and
 * nothing the storefront sends. What a forged id, another address's order, a stored hash or an
 * unsigned call gets, an erased order, and the address book's consumer-only entries.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  type GuestActor,
  hashShopperSecret,
  type OrderInput,
  type OrderState,
  SHOPPER_CALL,
  SHOPPER_GUEST_ID,
  SHOPPER_ORDERS_PAGE,
  type ShopperOrderPage,
  signGuestActor,
} from '@commerceworker/core';
import {
  createDb,
  customerAddresses,
  customers,
  orders,
  shopperSessions,
  shopperSignIns,
} from '@commerceworker/db';
import { eq, like } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../src/flows';
import { startOrder } from '../src/orders';
import { StorefrontApi } from '../src/storefront-api';
import { eraseDataSubject } from '../src/subjects';
import { signedGuest } from './principal';

const db = () => createDb(env.DB);
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const shopperActor: GuestActor = { kind: 'guest', id: SHOPPER_GUEST_ID, name: 'Shopper' };
const actor = () => signedGuest(shopperActor, SHOPPER_CALL);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);

const DOMAIN = '@shopper-account.test';
const email = () => `${crypto.randomUUID().slice(0, 8)}${DOMAIN}`;

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeAll(async () => {
  await ensureTemplates(env);
});
afterEach(async () => {
  await introspector?.dispose();
});
beforeEach(async () => {
  await db()
    .delete(shopperSignIns)
    .where(like(shopperSignIns.email, `%${DOMAIN}`));
  await db()
    .delete(shopperSessions)
    .where(like(shopperSessions.email, `%${DOMAIN}`));
});

/** A shopper signed in by the emailed code, as the storefront does it. */
async function signedIn(who = email()) {
  const sent: { text?: string }[] = [];
  const e = {
    ...env,
    EMAIL: {
      send: async (m: (typeof sent)[number]) => {
        sent.push(m);
        return { messageId: `m${sent.length}` };
      },
    },
    EMAIL_FROM: 'shop@mail.shop.test',
  } as unknown as Env;
  const api = new StorefrontApi(ctx, e);
  await api.startShopperSignIn(who, await actor());
  const code = /code is (\d{6})/.exec(sent[0]!.text!)![1]!;
  const out = (await api.redeemShopperCode(who, code, await actor()))!;
  return { api, who, secret: out.secret };
}

const shipTo = (line1: string) => ({
  name: 'Pat Buyer',
  line1,
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'US',
});

/** A counter sale placed under `contact`, brought to its end. */
async function sale(contact: string, line1?: string) {
  const input: OrderInput = {
    model: 'b2c',
    channel: 'web',
    currency: 'USD',
    title: 'Account sale',
    contact: { email: contact, name: 'Pat Buyer' },
    fulfillment: { method: 'carry_out', locationId: 'loc_mission' },
    lines: [{ sku: 'TEE-01', qty: 1 }],
    meta: line1 ? { shipTo: shipTo(line1) } : {},
  };
  const { orderId } = await startOrder(env, { flowId: 'tpl-pos-sale', input });
  const end = Date.now() + 30_000;
  for (;;) {
    const s = (await agent(orderId).snapshot()) as OrderState;
    if (['completed', 'failed', 'cancelled', 'declined'].includes(s.status)) return orderId;
    if (Date.now() > end) throw new Error('Timed out waiting for the order to end');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function quickly() {
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
}

describe('a shopper’s orders', () => {
  it('lists only the orders placed under the session’s address, newest first', async () => {
    await quickly();
    const { api, who, secret } = await signedIn();
    const first = await sale(who.toUpperCase());
    const second = await sale(who);
    const stranger = await sale(email());

    const page = (await api.shopperOrders(secret, await actor()))!;
    expect(page.email).toBe(who);
    expect(page.next).toBeNull();
    expect(page.orders.map((o) => o.id)).toEqual([second, first]);
    expect(page.orders[0]).toMatchObject({
      ref: `#${second.slice(-6)}`,
      status: 'completed',
      currency: 'USD',
    });
    expect(JSON.stringify(page)).not.toContain(stranger);
    // Nothing of the order beyond what a list shows.
    expect(Object.keys(page.orders[0]!).sort()).toEqual(
      ['currency', 'id', 'placedAt', 'ref', 'status', 'total'].sort(),
    );
  });

  it('pages by keyset, newest first, without a repeat or a gap', async () => {
    const { api, who, secret } = await signedIn();
    const n = SHOPPER_ORDERS_PAGE + 3;
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `ord_page_${who.slice(0, 8)}_${String(i).padStart(3, '0')}`,
      model: 'b2c',
      channel: 'web',
      contactEmail: who,
      status: 'completed',
      flowId: 'tpl-pos-sale',
      flowVersion: 1,
      // Several share a moment, so the id has to break the tie.
      createdAt: 1_700_000_000_000 + Math.floor(i / 3) * 1000,
      updatedAt: 1_700_000_000_000,
    }));
    // D1 binds at most 100 parameters a statement.
    for (let i = 0; i < rows.length; i += 5)
      await db()
        .insert(orders)
        .values(rows.slice(i, i + 5));
    const one = (await api.shopperOrders(secret, await actor()))!;
    expect(one.orders).toHaveLength(SHOPPER_ORDERS_PAGE);
    expect(one.next).toEqual(expect.any(String));
    const two = (await api.shopperOrders(secret, await actor(), one.next!))!;
    expect(two.orders).toHaveLength(3);
    expect(two.next).toBeNull();
    const ids = [...one.orders, ...two.orders].map((o) => o.id);
    expect(new Set(ids).size).toBe(n);
    const times = [...one.orders, ...two.orders].map((o) => o.placedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // A cursor the engine didn't make starts from the top, and widens nothing.
    const forged = (await api.shopperOrders(secret, await actor(), "0:x' or 1=1"))!;
    expect(forged.orders.map((o) => o.id)).toEqual(one.orders.map((o) => o.id));
  });

  it('shows one order’s buyer-safe view, and another address’s order exactly as an unknown one', async () => {
    await quickly();
    const { api, who, secret } = await signedIn();
    const mine = await sale(who);
    const theirs = await sale(email());

    const view = (await api.shopperOrder(secret, await actor(), mine))!;
    expect(view).toMatchObject({ id: mine, ref: `#${mine.slice(-6)}`, status: 'completed' });
    expect(view.lines.length).toBeGreaterThan(0);
    // The buyer's view: no timeline, notes, flow or payment.
    for (const key of ['timeline', 'audit', 'notes', 'meta', 'vars', 'flow', 'payment'])
      expect(view).not.toHaveProperty(key);

    const refused = await api.shopperOrder(secret, await actor(), theirs);
    const unknown = await api.shopperOrder(secret, await actor(), 'ord_does_not_exist');
    expect(refused).toBeNull();
    expect(unknown).toBeNull();
    // A forged or malformed id is no wider.
    for (const id of ['', ' ', '%', "x' or '1'='1", `${mine}/../${theirs}`, 'x'.repeat(200)])
      expect(await api.shopperOrder(secret, await actor(), id)).toBeNull();
  });

  it('refuses every call without the storefront’s actor, with a stored hash, or with no session', async () => {
    await quickly();
    const { api, who, secret } = await signedIn();
    const mine = await sale(who);
    const hash = await hashShopperSecret(secret);
    const other = await signedGuest(shopperActor, 'checkout:chk_1');
    const wrongKey = await signGuestActor(
      (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!,
      shopperActor,
      SHOPPER_CALL,
    );
    for (const bad of ['forged', other, wrongKey]) {
      expect(await api.shopperOrders(secret, bad)).toBeNull();
      expect(await api.shopperOrder(secret, bad, mine)).toBeNull();
      expect(await api.shopperAddresses(secret, bad)).toBeNull();
      expect(await api.forgetAddress(secret, bad, 'book:x')).toBe(false);
    }
    for (const notSecret of [hash, 'x', secret.toUpperCase(), '0'.repeat(64)]) {
      expect(await api.shopperOrders(notSecret, await actor())).toBeNull();
      expect(await api.shopperOrder(notSecret, await actor(), mine)).toBeNull();
      expect(await api.shopperAddresses(notSecret, await actor())).toBeNull();
    }
    // Signing out ends them all, for the shopper's own order too.
    await api.shopperSignOut(secret, await actor());
    expect(await api.shopperOrders(secret, await actor())).toBeNull();
    expect(await api.shopperOrder(secret, await actor(), mine)).toBeNull();
  });

  it('never lists, nor shows, an order an erasure took the buyer off', async () => {
    await quickly();
    const first = await signedIn();
    const mine = await sale(first.who);
    expect(
      ((await first.api.shopperOrders(first.secret, await actor())) as ShopperOrderPage).orders,
    ).toHaveLength(1);

    expect(await eraseDataSubject(env, first.who)).toMatchObject({ ok: true, orders: 1 });
    // The erasure ended the session too; the same address signs in again and finds nothing.
    expect(await first.api.shopperOrders(first.secret, await actor())).toBeNull();
    const again = await signedIn(first.who);
    expect((await again.api.shopperOrders(again.secret, await actor()))!.orders).toEqual([]);
    expect(await again.api.shopperOrder(again.secret, await actor(), mine)).toBeNull();
    expect((await again.api.shopperAddresses(again.secret, await actor()))!.addresses).toEqual([]);
  });
});

describe('a shopper’s addresses', () => {
  it('lists the places of their own orders once, and none of another address’s', async () => {
    await quickly();
    const { api, who, secret } = await signedIn();
    await sale(who, '1 Main St');
    await sale(who, '1 MAIN ST');
    await sale(who, '9 Oak Ave');
    await sale(who);
    await sale(email(), '77 Stranger Rd');

    const out = (await api.shopperAddresses(secret, await actor()))!;
    expect(out.email).toBe(who);
    // The two spellings of one place are one place.
    expect(out.addresses.map((a) => [a.line1.toLowerCase(), a.source]).sort()).toEqual([
      ['1 main st', 'order'],
      ['9 oak ave', 'order'],
    ]);
    expect(JSON.stringify(out)).not.toContain('Stranger');
  });

  it('adds a consumer customer’s book, never a business customer’s, and forgets only those entries', async () => {
    const { api, who, secret } = await signedIn();
    const tag = who.slice(0, 8);
    const [consumer, business, other] = [`cus_c_${tag}`, `cus_b_${tag}`, `cus_o_${tag}`];
    await db()
      .insert(customers)
      .values([
        { id: consumer, name: 'Pat', email: who.toUpperCase(), kind: 'consumer' },
        { id: business, name: 'Pat Ltd', email: who, kind: 'business' },
        { id: other, name: 'Else', email: email(), kind: 'consumer' },
      ]);
    const place = (customerId: string, line1: string) => ({
      id: `adr_${customerId}`,
      customerId,
      key: line1.toLowerCase(),
      line1,
      city: 'Springfield',
      postalCode: '62701',
      country: 'US',
      firstUsedAt: 1,
      lastUsedAt: 1,
      lastOrderId: 'ord_x',
    });
    await db()
      .insert(customerAddresses)
      .values([
        place(consumer, '5 Pine Rd'),
        place(business, '6 Biz Rd'),
        place(other, '7 Else Rd'),
      ]);

    const out = (await api.shopperAddresses(secret, await actor()))!;
    expect(out.addresses.map((a) => [a.line1, a.source, a.id])).toEqual([
      ['5 Pine Rd', 'book', `book:adr_${consumer}`],
    ]);

    // A business's, another shopper's, an order's place and a made-up id forget nothing.
    for (const id of [`book:adr_${business}`, `book:adr_${other}`, 'order:x', 'book:nope', 'x'])
      expect(await api.forgetAddress(secret, await actor(), id)).toBe(false);
    expect(
      await db().select().from(customerAddresses).where(eq(customerAddresses.customerId, business)),
    ).toHaveLength(1);
    expect(
      await db().select().from(customerAddresses).where(eq(customerAddresses.customerId, other)),
    ).toHaveLength(1);

    expect(await api.forgetAddress(secret, await actor(), `book:adr_${consumer}`)).toBe(true);
    // Idempotent: the repeat finds nothing to forget.
    expect(await api.forgetAddress(secret, await actor(), `book:adr_${consumer}`)).toBe(false);
    expect((await api.shopperAddresses(secret, await actor()))!.addresses).toEqual([]);
  });
});
