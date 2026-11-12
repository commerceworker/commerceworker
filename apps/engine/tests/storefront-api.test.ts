/**
 * `StorefrontApi`, the entrypoint the public storefront is bound to instead of `EngineApi`: it has
 * only the storefront's methods and serves only a cart's socket and `/ucp/*`; and the engine takes
 * the storefront's envelopes under the storefront key alone, and staff envelopes under
 * `PRINCIPAL_KEY` alone, so a storefront that is compromised can't mint a staff one.
 */
import { env } from 'cloudflare:workers';
import {
  type CartGuest,
  type CartState,
  type ExternalCart,
  PRINCIPAL_HEADER,
  type Principal,
  signCartGuest,
  signGuestActor,
  signPlatform,
  signPrincipal,
  signRpcActor,
  storefrontKey,
} from '@commerceworker/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { createCart } from '../src/cart/carts';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { StorefrontApi } from '../src/storefront-api';
import { signedActor, signedGuest, storefrontApi, storefrontSecret } from './principal';

const principalKey = () => (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!;
const engineApi = () =>
  new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);

const ada = { kind: 'staff' as const, id: 'usr_ada', name: 'Ada', role: 'admin' as const };
const admin: Principal = { kind: 'user', id: 'usr_ada', name: 'Ada', role: 'admin' };

const external = (buyerId = 'ann@example.com'): ExternalCart => ({
  pluginId: 'example',
  sessionRef: `s-${crypto.randomUUID()}`,
  expiresAt: Date.now() + 3_600_000,
  idleMs: null,
  returnUrl: 'https://buyer.example/return',
  frameOrigins: [],
  buyer: { id: buyerId, name: 'Ann Buyer' },
});

async function open(ext: ExternalCart | null) {
  const made = await createCart(
    env,
    {
      title: 'Storefront',
      flowId: 'tpl-b2b-order',
      customerId: 'cus_northwind',
      createdBy: 'usr_ada',
    },
    ext,
  );
  if (!made.ok) throw new Error(made.error);
  return made.id;
}

const buyerOf = (id = 'ann@example.com') => ({
  kind: 'guest' as const,
  id: `guest:${id}`,
  name: 'Ann Buyer',
});
const forCart = (cartId: string) => `cart:${cartId}`;

beforeAll(async () => {
  await ensureTemplates(env);
});

describe('the storefront entrypoint', () => {
  it('has the storefront’s methods and no others', () => {
    const methods = Object.getOwnPropertyNames(StorefrontApi.prototype)
      .filter((m) => m !== 'constructor')
      .sort();
    expect(methods).toEqual(
      [
        'addCartFile',
        'cartCustomerName',
        'cartSnapshot',
        'checkout',
        'completeCheckout',
        'fetch',
        'health',
        'keepCartOpen',
        'readCartFile',
        'redeemCartStart',
        'redeemCheckoutStart',
        'searchCartProducts',
        'storefrontSettings',
        'ucpCheckoutOn',
        'ucpPlatform',
        'ucpProfile',
        'updateCheckout',
      ].sort(),
    );
    const api = storefrontApi() as unknown as Record<string, unknown>;
    for (const m of [
      'paymentEvent',
      'uploadPlugin',
      'approvePlugin',
      'setPluginSecret',
      'startOrder',
      'startOrderOnce',
      'sendEvent',
      'cancel',
      'decide',
      'eraseDataSubject',
      'exportDataSubject',
      'createCart',
      'changeCart',
      'submitCart',
      'runOperation',
      'writeHealth',
      'attachToCart',
    ])
      expect(api[m], m).toBeUndefined();
  });

  it('serves only a cart’s socket and /ucp/*', async () => {
    const api = storefrontApi();
    const get = (path: string) => api.fetch(new Request(`https://engine${path}`));
    for (const path of [
      '/health',
      '/mcp',
      '/a2a',
      '/agents/order-agent/ord_1',
      '/agents/assistant-agent/usr_ada',
      '/agents/a2a-agent/x',
      '/agents/cart-agent/',
      '/agents/cart-agent',
      '/agents/cart-agentx/c',
      '//agents/cart-agent/c',
      '/agents/cart-agent/../order-agent/ord_1',
      '/agents/cart-agent/%2e%2e/order-agent/ord_1',
      '/ucpx',
      '/plugins/example/page',
    ])
      expect((await get(path)).status, path).toBe(404);
    // Its two prefixes do reach their handlers: a cart's socket asks who the buyer is, /ucp a platform.
    expect((await get('/agents/cart-agent/cart_1')).status).toBe(401);
    expect((await get('/ucp/v1/checkout-sessions/x')).status).toBe(401);
  });
});

describe('who may read a cart through it', () => {
  it('serves the cart’s own buyer, signed for that cart', async () => {
    const id = await open(external());
    const state = (await storefrontApi().cartSnapshot(
      id,
      await signedGuest(buyerOf(), forCart(id)),
    )) as CartState;
    expect(state.cart?.id).toBe(id);
    expect(
      await storefrontApi().cartCustomerName(id, await signedGuest(buyerOf(), forCart(id))),
    ).toBe('Northwind Traders');
  });

  it('refuses a signature for another cart, another buyer, a staff cart and a forgery', async () => {
    const mine = await open(external());
    const theirs = await open(external('bea@example.com'));
    const staffCart = await open(null);
    const api = storefrontApi();
    // Signed for my cart, used on theirs.
    expect(await api.cartSnapshot(theirs, await signedGuest(buyerOf(), forCart(mine)))).toBeNull();
    // Signed for theirs, but not as their buyer.
    expect(
      await api.cartSnapshot(theirs, await signedGuest(buyerOf(), forCart(theirs))),
    ).toBeNull();
    // A staff cart is nobody's buyer's.
    expect(
      await api.cartSnapshot(staffCart, await signedGuest(buyerOf(), forCart(staffCart))),
    ).toBeNull();
    expect(
      await api.cartCustomerName(theirs, await signedGuest(buyerOf(), forCart(mine))),
    ).toBeNull();
    expect(await api.cartSnapshot(mine, 'forged')).toBeNull();
    expect(await api.cartSnapshot(mine, undefined as never)).toBeNull();
    // Nothing leaks for a cart that doesn't exist.
    expect(
      await api.cartSnapshot('cart_nope', await signedGuest(buyerOf(), 'cart:cart_nope')),
    ).toBeNull();
    expect(
      await api.searchCartProducts(theirs, 'widget', await signedGuest(buyerOf(), forCart(mine))),
    ).toMatchObject({ ok: false });
  });
});

describe('one key for each envelope', () => {
  it('refuses a guest actor signed with PRINCIPAL_KEY, and a staff actor signed with the storefront key', async () => {
    const id = await open(external());
    const api = storefrontApi();
    const guest = buyerOf();
    const underPrincipal = await signRpcActor(principalKey(), guest as never, forCart(id));
    expect(await api.cartSnapshot(id, underPrincipal)).toBeNull();
    expect(await api.searchCartProducts(id, 'widget', underPrincipal)).toMatchObject({ ok: false });
    // The same actor under the storefront key is taken.
    expect(
      await api.cartSnapshot(
        id,
        await signGuestActor(await storefrontSecret(), guest, forCart(id)),
      ),
    ).not.toBeNull();

    // A staff actor signed with the storefront key is no staff actor for EngineApi, nor for
    // the storefront (it takes a buyer).
    const staffCart = await open(null);
    const forged = await signRpcActor(await storefrontSecret(), ada, forCart(staffCart));
    expect(
      await engineApi().changeCart(staffCart, { op: 'add', sku: 'WID-100', qty: 1 }, forged),
    ).toMatchObject({
      ok: false,
    });
    expect(await engineApi().cancelCart(staffCart, forged)).toMatchObject({ ok: false });
    expect(
      await engineApi().changeCart(
        staffCart,
        { op: 'add', sku: 'WID-100', qty: 1 },
        await signedActor(ada, forCart(staffCart)),
      ),
    ).toMatchObject({ ok: true });
    expect(await api.cartSnapshot(staffCart, forged)).toBeNull();
    // A guest-kind actor signed with the principal key is no staff actor either.
    expect(
      await engineApi().changeCart(
        staffCart,
        { op: 'add', sku: 'WID-100', qty: 1 },
        await signRpcActor(principalKey(), guest as never, forCart(staffCart)),
      ),
    ).toMatchObject({ ok: false });
  });

  it('refuses a v1 principal signed with the storefront key on every staff route', async () => {
    const key = await storefrontSecret();
    for (const path of ['/mcp', '/a2a']) {
      const res = await worker.fetch(
        new Request(`https://engine${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'a2a-version': '1.0',
            [PRINCIPAL_HEADER]: await signPrincipal(key, admin, path),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        }),
        env,
      );
      expect(res.status, path).toBe(401);
    }
    const sock = `/agents/order-agent/ord_1`;
    const res = await worker.fetch(
      new Request(`https://engine${sock}`, {
        headers: {
          Upgrade: 'websocket',
          [PRINCIPAL_HEADER]: await signPrincipal(key, admin, sock),
        },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('takes a cart’s socket and a platform’s header under the storefront key only', async () => {
    const id = await open(external());
    const guest: CartGuest = { cartId: id, id: 'guest:ann@example.com', name: 'Ann Buyer' };
    const path = `/agents/cart-agent/${id}`;
    const socket = async (key: string) =>
      (
        await storefrontApi().fetch(
          new Request(`https://engine${path}`, {
            headers: {
              Upgrade: 'websocket',
              [PRINCIPAL_HEADER]: await signCartGuest(key, guest, path),
            },
          }),
        )
      ).status;
    expect(await socket(principalKey())).toBe(401);
    expect(await socket('another-key')).toBe(401);
    // Past the signature, the gate asks the plugin that opened the cart (not installed here).
    expect(await socket(await storefrontSecret())).toBe(410);

    const platform = {
      id: 'ucp_x',
      name: 'X',
      profileUrl: 'https://p.example/ucp',
      origin: 'https://shop.example',
    };
    const ucp = async (key: string) =>
      (
        await storefrontApi().fetch(
          new Request('https://engine/ucp/v1/checkout-sessions/none', {
            headers: {
              [PRINCIPAL_HEADER]: await signPlatform(
                key,
                platform,
                '/ucp/v1/checkout-sessions/none',
              ),
            },
          }),
        )
      ).status;
    expect(await ucp(principalKey())).toBe(401);
    expect(await ucp(await storefrontSecret())).not.toBe(401);
    expect(await storefrontKey(principalKey())).not.toBe(principalKey());
  });

  it('answers the platform lookups for the storefront', async () => {
    const api = storefrontApi();
    expect(await api.ucpPlatform('not-a-hash')).toBeNull();
    expect(await api.ucpPlatform('0'.repeat(64))).toBeNull();
    expect(await api.ucpCheckoutOn()).toBe(false);
    expect((await api.health()).ok).toBe(true);
  });
});
