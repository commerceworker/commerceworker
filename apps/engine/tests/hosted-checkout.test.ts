/**
 * The hosted checkout (docs/trust-model.md): an operator makes a session through `create_checkout`,
 * the storefront redeems the one-time start link, and from then on the buyer is the cookie secret's
 * hash plus an actor the storefront signed for that session. The engine owns the credentials, a
 * link opens once, a UCP platform's session is never a hosted buyer's, the setting off refuses
 * everything, and a buyer can set no price.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { listAuditEvents } from '@commerceworker/application/commerce';
import {
  type HostedChange,
  hostedCall,
  hostedGuestId,
  hostedHash,
  hostedOwner,
  hostedStartOwner,
  operationCall,
  type Role,
  type RpcActor,
  type SignedActor,
  STOREFRONT_SETTINGS_KEY,
  type StorefrontSettings,
  storefrontOrderFlow,
} from '@commerceworker/core';
import {
  balanceEntries,
  checkoutSessions as checkoutSessionsTable,
  createDb,
  invoices,
  messages,
  orders,
  workspaceSettings,
} from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineApi } from '../src/api';
import { holdsNothingOnlyInTestMode } from '../src/checkout/hosted';
import { ensureTemplates } from '../src/flows';
import { auditLog, checkoutSessions, flowStore, paymentLedger } from '../src/wire';
import { signedActor, signedGuest, storefrontApi } from './principal';
import { enableUcp, monitorCheckout, platform, ucp } from './ucp-helpers';

const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const staff = (role: Role): RpcActor => ({
  kind: 'staff',
  id: `usr_hosted_${role}`,
  name: `${role}@example.com`,
  role,
});
const run = async (tool: string, input: unknown, actor: RpcActor) =>
  api().runOperation(tool, input, await signedActor(actor, await operationCall(tool, input)));

const sf = storefrontApi();
const db = () => createDb(env.DB);

/** The storefront setting as an admin saved it; null removes it (the default: off). */
async function setting(checkout: Partial<StorefrontSettings['checkout']> | null) {
  if (checkout === null) {
    await db().delete(workspaceSettings).where(eq(workspaceSettings.key, STOREFRONT_SETTINGS_KEY));
    return;
  }
  const value = JSON.stringify({ checkout: { enabled: true, ...checkout } });
  await db()
    .insert(workspaceSettings)
    .values({ key: STOREFRONT_SETTINGS_KEY, value, updatedAt: Date.now(), updatedBy: 'test' })
    .onConflictDoUpdate({ target: workspaceSettings.key, set: { value } });
}

const lines = [{ sku: 'MON-27', qty: 1 }];

/** A checkout made through the API, with the id and token its link carries. */
async function made(input: Record<string, unknown> = { lines }) {
  const r = await run('create_checkout', input, staff('operator'));
  if (!r.ok) throw new Error(JSON.stringify(r));
  const { id, url } = r.value as { id: string; url: string };
  return { id, url, token: url.split('/').pop()! };
}

/** The buyer's side of a session: the cookie's secret (and its hash, the stored owner) and the actor the storefront signs. */
const buyer = async (id: string, secret: string) => ({
  secret,
  hash: await hostedHash(secret),
  actor: await signedGuest({ kind: 'guest', id: hostedGuestId(id), name: 'Buyer' }, hostedCall(id)),
});

/** A session redeemed: what the buyer's cookie and calls hold. */
async function redeemed(input?: Record<string, unknown>) {
  const m = await made(input);
  const r = await sf.redeemCheckoutStart(m.id, m.token);
  if (!r) throw new Error('not redeemed');
  return { ...m, ...r, ...(await buyer(m.id, r.secret)) };
}

const ok = (c: HostedChange | null) => {
  if (!c?.ok) throw new Error(`refused: ${JSON.stringify(c)}`);
  return c.checkout;
};

const startOwner = async (token: string) => hostedStartOwner(await hostedHash(token));

beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
});
beforeEach(() => setting({}));

/** Orders run their flow: with its waits compressed, and the run disposed after each test. */
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});
async function runOrders() {
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
}

describe('making a hosted checkout', () => {
  it('returns its id and a one-time link on the storefront, priced, for an operator', async () => {
    const m = await made({ lines, buyer: { email: 'ada@example.com' } });
    expect(m.url).toBe(`${env.STOREFRONT_ORIGIN}/checkout/start/${m.id}/${m.token}`);
    expect(m.token).toMatch(/^[0-9a-f]{48}$/);
    // Until redeemed it is the start token's, not a cookie's.
    expect(await checkoutSessions(env).ownerOf(m.id)).toBe(await startOwner(m.token));
    const s = (await checkoutSessions(env).load(await startOwner(m.token), m.id))!;
    expect(s).toMatchObject({
      lines: [{ sku: 'MON-27', qty: 1 }],
      buyer: { email: 'ada@example.com' },
    });
    expect(s.quote?.total).toBeGreaterThan(0);
  });

  it('is an operator’s, and refused for a viewer', async () => {
    expect(await run('create_checkout', { lines }, staff('viewer'))).toEqual({
      ok: false,
      error: 'This needs the Operator role.',
    });
  });

  it('audits the checkout and never the link', async () => {
    const m = await made();
    const events = await listAuditEvents({ audit: auditLog(env) }, { limit: 500 });
    const mine = events.find((e) => e.action === 'checkout.created' && e.target === m.id);
    expect(mine?.detail).toMatchObject({ via: 'api', tool: 'create_checkout', lines: 1 });
    expect(JSON.stringify(events)).not.toContain(m.token);
  });

  it('refuses goods that are not sold and a customer that does not exist', async () => {
    const bad = await run(
      'create_checkout',
      { lines: [{ sku: 'NOPE-1', qty: 1 }] },
      staff('operator'),
    );
    expect(bad).toMatchObject({ ok: false });
    expect(JSON.stringify(bad)).toContain('NOPE-1');
    expect(
      await run('create_checkout', { lines, customerId: 'cus_nobody' }, staff('operator')),
    ).toMatchObject({ ok: false, error: expect.stringContaining('cus_nobody') });
  });

  it('refuses a buyer email that is not one', async () => {
    expect(
      await run('create_checkout', { lines, buyer: { email: 'not an email' } }, staff('operator')),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('is for the customer it names, and a buyer never sees that', async () => {
    const m = await made({ lines, customerId: 'cus_northwind' });
    const s = await checkoutSessions(env).load(await startOwner(m.token), m.id);
    expect(s?.customerId).toBe('cus_northwind');
    const r = await sf.redeemCheckoutStart(m.id, m.token);
    const b = await buyer(m.id, r!.secret);
    const seen = await sf.checkout(m.id, b.secret, b.actor);
    expect(seen).not.toHaveProperty('customerId');
    expect(JSON.stringify(seen)).not.toContain('cus_northwind');
  });

  it('refuses while hosted checkout is off or was never set', async () => {
    await setting({ enabled: false });
    expect(await run('create_checkout', { lines }, staff('operator'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('not turned on'),
    });
    await setting(null);
    expect(await run('create_checkout', { lines }, staff('operator'))).toMatchObject({
      ok: false,
    });
  });

  it('is priced by the setting’s own flow, and refused when that flow is not there', async () => {
    await setting({ checkoutFlowId: 'tpl-nope' });
    expect(await run('create_checkout', { lines }, staff('operator'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('no checkout flow'),
    });
    await setting({ checkoutFlowId: 'tpl-storefront-order' });
    await made();
  });
});

describe('redeeming the start link', () => {
  it('opens once: the engine mints the secret, a second redemption is refused', async () => {
    const m = await made();
    const first = await sf.redeemCheckoutStart(m.id, m.token);
    expect(first?.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(first!.expiresAt).toBeGreaterThan(Date.now());
    // The session is the cookie's now; the engine kept only its hash.
    const owner = hostedOwner(await hostedHash(first!.secret));
    expect(await checkoutSessions(env).ownerOf(m.id)).toBe(owner);
    expect(await sf.redeemCheckoutStart(m.id, m.token)).toBeNull();
    expect(await checkoutSessions(env).ownerOf(m.id)).toBe(owner);
  });

  it('is won by exactly one of two redemptions at once', async () => {
    const m = await made();
    const both = await Promise.all([
      sf.redeemCheckoutStart(m.id, m.token),
      sf.redeemCheckoutStart(m.id, m.token),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a wrong token, another checkout’s token, and malformed ones', async () => {
    const a = await made();
    const b = await made();
    expect(await sf.redeemCheckoutStart(a.id, b.token)).toBeNull();
    expect(await sf.redeemCheckoutStart(a.id, 'x'.repeat(48))).toBeNull();
    expect(await sf.redeemCheckoutStart(a.id, '')).toBeNull();
    expect(await sf.redeemCheckoutStart(a.id, 'x'.repeat(500))).toBeNull();
    expect(await sf.redeemCheckoutStart('chk_none', a.token)).toBeNull();
    expect(await sf.redeemCheckoutStart('../etc', a.token)).toBeNull();
    expect(await sf.redeemCheckoutStart(a.id, undefined as never)).toBeNull();
    // None of that spent the real link.
    expect(await sf.redeemCheckoutStart(a.id, a.token)).not.toBeNull();
  });

  it('is not a cookie: the link’s own hash opens no session', async () => {
    const m = await made();
    const asCookie = await buyer(m.id, m.token);
    expect(await sf.checkout(m.id, asCookie.secret, asCookie.actor)).toBeNull();
    const hashed = await buyer(m.id, await hostedHash(m.token));
    expect(await sf.checkout(m.id, hashed.secret, hashed.actor)).toBeNull();
    expect(await sf.redeemCheckoutStart(m.id, m.token)).not.toBeNull();
  });

  it('refuses an expired link and a closed session', async () => {
    const m = await made();
    await db()
      .update(checkoutSessionsTable)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(checkoutSessionsTable.id, m.id));
    expect(await sf.redeemCheckoutStart(m.id, m.token)).toBeNull();
    const c = await made();
    await db()
      .update(checkoutSessionsTable)
      .set({ status: 'canceled' })
      .where(eq(checkoutSessionsTable.id, c.id));
    expect(await sf.redeemCheckoutStart(c.id, c.token)).toBeNull();
  });

  it('refuses while off without spending the link', async () => {
    const m = await made();
    await setting({ enabled: false });
    expect(await sf.redeemCheckoutStart(m.id, m.token)).toBeNull();
    await setting({});
    expect(await sf.redeemCheckoutStart(m.id, m.token)).not.toBeNull();
  });
});

describe('the buyer’s session', () => {
  it('is read by the cookie’s hash and a signed actor, without its owner', async () => {
    const b = await redeemed();
    const s = await sf.checkout(b.id, b.secret, b.actor);
    expect(s).toMatchObject({ id: b.id, status: 'incomplete', lines: [{ sku: 'MON-27' }] });
    expect(s).not.toHaveProperty('ownerId');
    expect(JSON.stringify(s)).not.toContain(b.hash);
    expect(JSON.stringify(s)).not.toContain(b.secret);
  });

  it('is null for a wrong hash, another session, or a malformed one', async () => {
    const b = await redeemed();
    const other = await redeemed();
    expect(await sf.checkout(b.id, other.secret, b.actor)).toBeNull();
    expect(await sf.checkout(b.id, 'a'.repeat(64), b.actor)).toBeNull();
    // The stored owner is a hash of the secret: presented as the secret, it opens nothing.
    expect(await sf.checkout(b.id, b.hash, b.actor)).toBeNull();
    expect(await sf.checkout(b.id, 'not a secret', b.actor)).toBeNull();
    expect(await sf.checkout(b.id, undefined as never, b.actor)).toBeNull();
    expect(await sf.checkout('chk_none', b.secret, b.actor)).toBeNull();
    expect(await sf.checkout(undefined as never, b.secret, b.actor)).toBeNull();
    // The other buyer's own cookie opens theirs only.
    expect(await sf.checkout(other.id, other.secret, other.actor)).not.toBeNull();
    expect(await sf.checkout(other.id, b.secret, other.actor)).toBeNull();
  });

  it('needs the actor too: none, another session’s, a staff one, or a forged one is null', async () => {
    const b = await redeemed();
    const other = await redeemed();
    // The same actor signed under the principal key, which only staff envelopes verify under.
    const underPrincipalKey = await signedActor(
      { kind: 'guest', id: hostedGuestId(b.id), name: 'Buyer' },
      hostedCall(b.id),
    );
    const asStaff = await signedActor(staff('admin'), hostedCall(b.id));
    const wrongId = await signedGuest(
      { kind: 'guest', id: 'guest:someone', name: 'Buyer' },
      hostedCall(b.id),
    );
    for (const actor of [
      '' as SignedActor,
      undefined as never,
      other.actor,
      underPrincipalKey,
      asStaff,
      wrongId,
      'a1.forged',
    ])
      expect(await sf.checkout(b.id, b.secret, actor)).toBeNull();
    expect(await sf.checkout(b.id, other.secret, b.actor)).toBeNull();
  });

  it('is null for a UCP platform’s session, however it is asked for', async () => {
    const alpha = await platform('alpha');
    const { body } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const id = body.id as string;
    const b = await buyer(id, 'whatever');
    expect(await sf.checkout(id, b.secret, b.actor)).toBeNull();
    expect(
      await sf.updateCheckout(id, { buyer: { email: 'x@example.com' } }, b.secret, b.actor),
    ).toBeNull();
    expect(await sf.checkout(id, 'a'.repeat(64), b.actor)).toBeNull();
    expect(await sf.redeemCheckoutStart(id, 'alpha')).toBeNull();
    // And the platform still has it.
    expect((await ucp(alpha, 'GET', `/ucp/v1/checkout-sessions/${id}`)).status).toBe(200);
  });

  it('refuses everything while hosted checkout is off', async () => {
    const b = await redeemed();
    await setting({ enabled: false });
    expect(await sf.checkout(b.id, b.secret, b.actor)).toBeNull();
    expect(
      await sf.updateCheckout(b.id, { buyer: { email: 'a@example.com' } }, b.secret, b.actor),
    ).toBeNull();
    expect(await sf.storefrontSettings()).toEqual({
      checkout: { enabled: false, editLines: false, testPayments: true, publishableKey: null },
    });
    await setting({});
    expect(await sf.checkout(b.id, b.secret, b.actor)).not.toBeNull();
  });

  it('shows an expired session as canceled', async () => {
    const b = await redeemed();
    const s = (await checkoutSessions(env).load(hostedOwner(b.hash), b.id))!;
    await checkoutSessions(env).save(
      { ...s, expiresAt: Date.now() - 1, version: s.version + 1 },
      s.version,
    );
    expect(await sf.checkout(b.id, b.secret, b.actor)).toMatchObject({ status: 'canceled' });
  });
});

describe('what a buyer changes', () => {
  const ship = {
    name: 'Ada Lovelace',
    line1: '500 Congress Ave',
    city: 'Austin',
    region: 'TX',
    postalCode: '78701',
    country: 'US',
  };

  it('completes the session’s details and prices it again', async () => {
    const b = await redeemed();
    const next = ok(
      await sf.updateCheckout(
        b.id,
        { buyer: { email: 'ada@example.com', firstName: 'Ada' }, shipTo: ship },
        b.secret,
        b.actor,
      ),
    );
    expect(next).toMatchObject({
      buyer: { email: 'ada@example.com' },
      shipTo: { city: 'Austin' },
      status: 'ready_for_complete',
      version: 2,
    });
    expect(next.quote?.total).toBeGreaterThan(0);
    // The quote works out each line's total and the subtotal before promotions, so no page adds up.
    const q = next.quote!;
    for (const l of q.lines) {
      expect(l.total).toBeCloseTo(l.unitPrice * l.qty, 2);
      expect(l.listTotal).toBeGreaterThanOrEqual(l.total!);
    }
    expect(q.listSubtotal).toBeCloseTo(
      q.lines.reduce((n, l) => n + l.listTotal!, 0),
      2,
    );
    expect(next).not.toHaveProperty('ownerId');
    expect(await sf.checkout(b.id, b.secret, b.actor)).toMatchObject({ version: 2 });
  });

  it('can set no price, the owner, the status or anything else it is not given', async () => {
    const b = await redeemed();
    const before = await sf.checkout(b.id, b.secret, b.actor);
    for (const patch of [
      { quote: { total: 1 } },
      { total: 1 },
      { status: 'completed' },
      { ownerId: 'hosted:evil' },
      { orderId: 'ord_1' },
      { payment: { intentId: 'pi_1', state: 'paid' } },
      { customerId: 'cus_northwind' },
      { shippingOption: 'x'.repeat(500) },
      { buyer: { email: 'a@example.com', discount: 100 } },
      { buyer: { email: 'not an email' } },
      { shipTo: { line1: 'x', price: 0 } },
      { fulfillment: 'carry_out' },
      { promoCodes: 'FREE' },
    ]) {
      const r = await sf.updateCheckout(b.id, patch, b.secret, b.actor);
      expect(r, JSON.stringify(patch)).toMatchObject({
        ok: false,
        error: expect.stringContaining('not allowed'),
      });
    }
    for (const bad of [null, 'x', 7, [], undefined])
      expect(await sf.updateCheckout(b.id, bad, b.secret, b.actor)).toMatchObject({ ok: false });
    expect(await sf.checkout(b.id, b.secret, b.actor)).toEqual(before);
  });

  it('leaves the lines to the merchant unless the setting lets the buyer change them', async () => {
    const b = await redeemed();
    const r = await sf.updateCheckout(
      b.id,
      { lines: [{ sku: 'MON-27', qty: 2 }] },
      b.secret,
      b.actor,
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('not allowed') });
    expect((await sf.checkout(b.id, b.secret, b.actor))?.lines[0]?.qty).toBe(1);

    await setting({ editLines: true });
    expect(await sf.storefrontSettings()).toEqual({
      checkout: { enabled: true, editLines: true, testPayments: true, publishableKey: null },
    });
    const next = ok(
      await sf.updateCheckout(
        b.id,
        { lines: [{ id: 'li_1', sku: 'MON-27', qty: 2 }] },
        b.secret,
        b.actor,
      ),
    );
    expect(next.lines).toMatchObject([{ id: 'li_1', sku: 'MON-27', qty: 2 }]);
    // Even then a line is a SKU and a quantity: it names no price.
    for (const line of [
      { sku: 'MON-27', qty: 1, unitPrice: 1 },
      { sku: 'MON-27', qty: 0 },
      { sku: 'MON-27', qty: 1.5 },
      { sku: '', qty: 1 },
    ])
      expect(await sf.updateCheckout(b.id, { lines: [line] }, b.secret, b.actor)).toMatchObject({
        ok: false,
      });
    expect(await sf.updateCheckout(b.id, { lines: [] }, b.secret, b.actor)).toMatchObject({
      ok: false,
    });
    // Goods that aren't sold are priced as unavailable, never accepted at a price.
    const unknown = ok(
      await sf.updateCheckout(b.id, { lines: [{ sku: 'NOPE-1', qty: 1 }] }, b.secret, b.actor),
    );
    expect(unknown.issues.map((i) => i.code)).toContain('item_unavailable');
    expect(unknown.quote).toBeNull();
  });

  it('is refused for another buyer, and for a session that is final or being completed', async () => {
    const b = await redeemed();
    const other = await redeemed();
    const email = { buyer: { email: 'a@example.com' } };
    expect(await sf.updateCheckout(b.id, email, other.secret, other.actor)).toBeNull();
    expect(await sf.updateCheckout(b.id, email, b.secret, other.actor)).toBeNull();

    const s = (await checkoutSessions(env).load(hostedOwner(b.hash), b.id))!;
    await checkoutSessions(env).save(
      { ...s, status: 'completed', version: s.version + 1 },
      s.version,
    );
    expect(await sf.updateCheckout(b.id, email, b.secret, b.actor)).toMatchObject({
      ok: false,
      error: 'The checkout is completed.',
    });

    const c = await redeemed();
    const t = (await checkoutSessions(env).load(hostedOwner(c.hash), c.id))!;
    await checkoutSessions(env).save(
      { ...t, status: 'complete_in_progress', version: t.version + 1 },
      t.version,
    );
    expect(await sf.updateCheckout(c.id, email, c.secret, c.actor)).toMatchObject({
      ok: false,
      error: expect.stringContaining('being completed'),
    });
  });

  it('loses cleanly to a write that raced it', async () => {
    const b = await redeemed();
    const results = await Promise.all([
      sf.updateCheckout(b.id, { buyer: { email: 'a@example.com' } }, b.secret, b.actor),
      sf.updateCheckout(b.id, { buyer: { email: 'b@example.com' } }, b.secret, b.actor),
    ]);
    expect(results.filter((r) => r?.ok).length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((r) => r && !r.ok))
      expect(r).toMatchObject({ error: expect.stringContaining('changed') });
    const now = await sf.checkout(b.id, b.secret, b.actor);
    expect(['a@example.com', 'b@example.com']).toContain(now?.buyer.email);
  });
});

describe('a page that changed under the buyer', () => {
  const email = (e: string) => ({ buyer: { email: e } });

  it('refuses a change made from an older version, shows the session as it is, and writes nothing', async () => {
    const b = await redeemed();
    const first = ok(await sf.updateCheckout(b.id, email('a@example.com'), b.secret, b.actor, 1));
    expect(first.version).toBe(2);
    // A page still showing version 1 posts its change: the buyer has not seen version 2.
    const stale = await sf.updateCheckout(b.id, email('b@example.com'), b.secret, b.actor, 1);
    expect(stale).toMatchObject({
      ok: false,
      changed: true,
      error: expect.stringContaining('changed'),
      checkout: { version: 2, buyer: { email: 'a@example.com' } },
    });
    expect(await sf.checkout(b.id, b.secret, b.actor)).toMatchObject({
      version: 2,
      buyer: { email: 'a@example.com' },
    });
    // From the current version it goes through; no version at all is the engine's own check alone.
    expect(
      ok(await sf.updateCheckout(b.id, email('c@example.com'), b.secret, b.actor, 2)),
    ).toMatchObject({
      version: 3,
    });
    expect(
      ok(await sf.updateCheckout(b.id, email('d@example.com'), b.secret, b.actor)),
    ).toMatchObject({
      version: 4,
    });
    // A version that is no number is no version the session has.
    expect(
      await sf.updateCheckout(b.id, email('e@example.com'), b.secret, b.actor, 'x' as never),
    ).toMatchObject({ ok: false, changed: true });
  });

  it('says so, and only so, when a write raced it', async () => {
    const b = await redeemed();
    const results = await Promise.all([
      sf.updateCheckout(b.id, email('a@example.com'), b.secret, b.actor, 1),
      sf.updateCheckout(b.id, email('b@example.com'), b.secret, b.actor, 1),
    ]);
    expect(results.filter((r) => r?.ok)).toHaveLength(1);
    expect(results.find((r) => r && !r.ok)).toMatchObject({ changed: true });
  });

  it('is not set for a refusal about the change itself', async () => {
    const b = await redeemed();
    const r = await sf.updateCheckout(b.id, { total: 1 }, b.secret, b.actor, 1);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('not allowed') });
    expect(r).not.toHaveProperty('changed');
  });
});

describe('placing the order in test mode', () => {
  const ship = {
    name: 'Ada Lovelace',
    line1: '500 Congress Ave',
    city: 'Austin',
    region: 'TX',
    postalCode: '78701',
    country: 'US',
  };
  const ready = async (input?: Record<string, unknown>) => {
    const b = await redeemed(input);
    ok(
      await sf.updateCheckout(
        b.id,
        { buyer: { email: 'ada@example.com', firstName: 'Ada' }, shipTo: ship },
        b.secret,
        b.actor,
      ),
    );
    return b;
  };
  const rows = (id: string) =>
    db()
      .select()
      .from(orders)
      .where(eq(orders.idempotencyKey, `hosted:${id}`))
      .all();

  it('is offered while payments are only recorded, and not otherwise', async () => {
    expect(await sf.storefrontSettings()).toMatchObject({ checkout: { testPayments: true } });
    const mode = (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE;
    try {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = 'stripe';
      expect(await sf.storefrontSettings()).toMatchObject({ checkout: { testPayments: false } });
    } finally {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = mode;
    }
  });

  it('places an order on the web channel, keyed by the checkout, and says it is completed', async () => {
    await runOrders();
    const b = await ready();
    const done = ok(await sf.completeCheckout(b.id, b.secret, b.actor));
    expect(done).toMatchObject({
      id: b.id,
      status: 'completed',
      orderId: expect.stringMatching(/^ord_/),
    });
    const [order, ...more] = await rows(b.id);
    expect(more).toEqual([]);
    expect(order).toMatchObject({
      id: done.orderId,
      channel: 'web',
      externalId: b.id,
      idempotencyKey: `hosted:${b.id}`,
      startedBy: hostedOwner(b.hash),
    });
    // No customer was named, so none is on the order, and the buyer's answer names none either.
    expect(order?.customerId).toBeNull();
    expect(JSON.stringify(done)).not.toMatch(/customerId|ownerId|hosted:/);
    expect(await sf.checkout(b.id, b.secret, b.actor)).toMatchObject({ status: 'completed' });
  });

  it('sends the buyer one confirmation when the order completes, and none for a repeat press', async () => {
    const mail: { to: unknown; subject: string; text?: string }[] = [];
    const e = env as { EMAIL?: unknown; EMAIL_FROM?: string };
    const before = { EMAIL: e.EMAIL, EMAIL_FROM: e.EMAIL_FROM };
    e.EMAIL = {
      send: async (m: (typeof mail)[number]) => {
        mail.push(m);
        return { messageId: `m${mail.length}` };
      },
    };
    e.EMAIL_FROM = 'orders@mail.shop.test';
    try {
      await runOrders();
      const b = await ready();
      const done = ok(await sf.completeCheckout(b.id, b.secret, b.actor));
      ok(await sf.completeCheckout(b.id, b.secret, b.actor));
      const row = async () =>
        (await db().select().from(messages).where(eq(messages.orderId, done.orderId!))).find((m) =>
          m.id.endsWith('_confirmation'),
        );
      for (let i = 0; i < 300 && !(await row())?.sentAt; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(await row()).toMatchObject({ recipient: 'ada@example.com', error: null });
      expect(mail).toHaveLength(1);
      expect(mail[0]).toMatchObject({ to: 'ada@example.com' });
      expect(mail[0]?.text).toContain(`/orders/${done.orderId}?t=`);
    } finally {
      e.EMAIL = before.EMAIL;
      e.EMAIL_FROM = before.EMAIL_FROM;
    }
  });

  it('is answered again as it is, with no second order, when it is pressed twice', async () => {
    await runOrders();
    const b = await ready();
    const first = ok(await sf.completeCheckout(b.id, b.secret, b.actor));
    const second = ok(await sf.completeCheckout(b.id, b.secret, b.actor));
    expect(second.orderId).toBe(first.orderId);
    expect(await rows(b.id)).toHaveLength(1);
  });

  it('places one order when two presses race, and the other is told it changed or is placed', async () => {
    await runOrders();
    const b = await ready();
    const results = await Promise.all([
      sf.completeCheckout(b.id, b.secret, b.actor),
      sf.completeCheckout(b.id, b.secret, b.actor),
    ]);
    expect(results.some((r) => r?.ok)).toBe(true);
    for (const r of results)
      if (r && !r.ok)
        expect(r.changed === true || /being completed|completed/.test(r.error)).toBe(true);
    expect(await rows(b.id)).toHaveLength(1);
  });

  it('keeps the customer off the buyer’s view, and takes nothing from their credit, account invoices or saved cards', async () => {
    await runOrders();
    const b = await ready({ lines, customerId: 'cus_northwind' });
    const view = await sf.checkout(b.id, b.secret, b.actor);
    expect(JSON.stringify(view)).not.toMatch(/cus_northwind|customerId/);
    const done = ok(await sf.completeCheckout(b.id, b.secret, b.actor));
    expect(JSON.stringify(done)).not.toMatch(/cus_northwind|customerId/);
    const [order] = await rows(b.id);
    // Priced for them, as the session was; the order carries them.
    expect(order).toMatchObject({ customerId: 'cus_northwind', channel: 'web' });
    // Let the order's flow reach its payment step, then look at everything that could be charged.
    await vi.waitFor(
      async () =>
        expect((await paymentLedger(env).forOrder(done.orderId!)).length).toBeGreaterThan(0),
      { timeout: 20_000 },
    );
    const paid = await paymentLedger(env).forOrder(done.orderId!);
    // Only the test mode's recorded payment: no processor, no saved card (nothing off session).
    expect(paid.every((p) => p.provider === 'mock')).toBe(true);
    expect(JSON.stringify(paid)).not.toMatch(/off_session|pm_|cus_northwind/);
    // No hold on the customer's credit, and no invoice on account for the order.
    const entries = await db()
      .select()
      .from(balanceEntries)
      .where(eq(balanceEntries.orderId, done.orderId!))
      .all();
    expect(entries).toEqual([]);
    expect(
      await db().select().from(invoices).where(eq(invoices.orderId, done.orderId!)).all(),
    ).toEqual([]);
  });

  it('refuses to complete on a flow version that no longer authorizes a card, placing no order', async () => {
    const card = { ...storefrontOrderFlow(), id: 'tpl-hosted-recheck' } as never;
    await flowStore(env).publish(card);
    await setting({ checkoutFlowId: 'tpl-hosted-recheck' });
    const b = await ready();
    // A later version drops the payment step: the setting was saved before it, and still names the flow.
    await flowStore(env).publish({ ...(card as object), nodes: [], edges: [] } as never);
    expect(await sf.completeCheckout(b.id, b.secret, b.actor)).toMatchObject({
      ok: false,
      error: 'Checkout is not set up for this business.',
    });
    expect(await rows(b.id)).toEqual([]);
    expect((await sf.checkout(b.id, b.secret, b.actor))?.status).not.toBe('completed');
  });

  it('completes only the version and total the buyer saw', async () => {
    await runOrders();
    const b = await ready();
    const seen = (await sf.checkout(b.id, b.secret, b.actor))!;
    const shown = { version: seen.version, total: seen.quote!.total };
    // Something changes between the page and the press.
    ok(await sf.updateCheckout(b.id, { promoCodes: ['NOPE'] }, b.secret, b.actor));
    const stale = await sf.completeCheckout(b.id, b.secret, b.actor, shown);
    expect(stale).toMatchObject({
      ok: false,
      changed: true,
      checkout: { version: seen.version + 1 },
    });
    expect(await rows(b.id)).toEqual([]);
    // A total the buyer was not shown is refused too, with the session priced as it is.
    const now = (await sf.checkout(b.id, b.secret, b.actor))!;
    const wrongTotal = await sf.completeCheckout(b.id, b.secret, b.actor, {
      version: now.version,
      total: now.quote!.total + 1,
    });
    expect(wrongTotal).toMatchObject({ ok: false, changed: true });
    expect(await rows(b.id)).toEqual([]);
    const again = (await sf.checkout(b.id, b.secret, b.actor))!;
    expect(again.status).toBe('ready_for_complete');
    // What they saw, now: it goes through.
    ok(
      await sf.completeCheckout(b.id, b.secret, b.actor, {
        version: again.version,
        total: again.quote!.total,
      }),
    );
    expect(await rows(b.id)).toHaveLength(1);
    // Nonsense is no version or total anyone was shown.
    const c = await ready();
    for (const bad of [
      { version: 'x', total: 1 },
      { version: 1, total: 'x' },
      { version: 1, total: NaN },
    ])
      expect(await sf.completeCheckout(c.id, c.secret, c.actor, bad as never)).toMatchObject({
        ok: false,
        changed: true,
      });
  });

  it('places no payment-less order outside test mode', async () => {
    const guarded = holdsNothingOnlyInTestMode(env, {
      refusal: null,
      authorize: async () => ({ ok: true }),
    });
    const s = {} as never;
    expect(await guarded.authorize(s)).toEqual({ ok: true });
    const mode = (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE;
    try {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = 'stripe';
      await expect(guarded.authorize(s)).rejects.toThrow(/needs the buyer’s own payment/);
      // The buyer's own payment, for the order to adopt, is allowed live.
      const own = holdsNothingOnlyInTestMode(env, {
        refusal: null,
        authorize: async () => ({
          ok: true,
          payment: { provider: 'stripe', intentId: 'pi_buyer' },
        }),
      });
      expect(await own.authorize(s)).toMatchObject({ ok: true });
    } finally {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = mode;
    }
  });

  it('shows what is missing and claims nothing for a checkout that is not ready', async () => {
    const b = await redeemed();
    const r = await sf.completeCheckout(b.id, b.secret, b.actor);
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining('Finish the details'),
      checkout: { status: 'incomplete' },
    });
    expect(await rows(b.id)).toEqual([]);
    // It is still open: the buyer can finish it.
    expect(
      ok(
        await sf.updateCheckout(
          b.id,
          { buyer: { email: 'ada@example.com' }, shipTo: ship },
          b.secret,
          b.actor,
        ),
      ).status,
    ).toBe('ready_for_complete');
  });

  it('is the buyer’s alone: no one else’s cookie or actor, nor a final or closed session, nor while off', async () => {
    const b = await ready();
    const other = await redeemed();
    expect(await sf.completeCheckout(b.id, other.secret, other.actor)).toBeNull();
    expect(await sf.completeCheckout(b.id, b.secret, other.actor)).toBeNull();
    expect(await sf.completeCheckout('chk_nope', b.secret, b.actor)).toBeNull();
    expect(await sf.completeCheckout(b.id, 'not-a-secret', b.actor)).toBeNull();

    const s = (await checkoutSessions(env).load(hostedOwner(b.hash), b.id))!;
    await checkoutSessions(env).save(
      { ...s, status: 'canceled', version: s.version + 1 },
      s.version,
    );
    expect(await sf.completeCheckout(b.id, b.secret, b.actor)).toMatchObject({
      ok: false,
      error: 'The checkout is canceled.',
    });
    expect(await rows(b.id)).toEqual([]);

    const c = await ready();
    await setting({ enabled: false });
    expect(await sf.completeCheckout(c.id, c.secret, c.actor)).toBeNull();
    expect(await rows(c.id)).toEqual([]);
  });

  it('is a UCP platform’s session never: it is not a hosted buyer’s to complete', async () => {
    const alpha = await platform('alpha-complete');
    const { body } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const b = await buyer(body.id, 'ab'.repeat(32));
    expect(await sf.completeCheckout(body.id, b.secret, b.actor)).toBeNull();
  });

  it('refuses when payments are real, without claiming the session or placing an order', async () => {
    const b = await ready();
    const mode = (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE;
    try {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = 'stripe';
      const r = await sf.completeCheckout(b.id, b.secret, b.actor);
      expect(r).toMatchObject({
        ok: false,
        error: 'This checkout is paid by card.',
        checkout: { status: 'ready_for_complete' },
      });
    } finally {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = mode;
    }
    expect(await rows(b.id)).toEqual([]);
    expect(await sf.checkout(b.id, b.secret, b.actor)).toMatchObject({
      status: 'ready_for_complete',
    });
  });
});
