/**
 * What the public storefront Worker (`apps/storefront`, at `shop.<domain>`) may ask of the engine,
 * and nothing more: it binds this entrypoint (`StorefrontRpc`) where the admin binds `EngineApi`.
 * The storefront is reachable by anyone on the internet, so it holds only `storefrontKey`, a key
 * derived from `PRINCIPAL_KEY`, and no database or bucket: a compromised one can speak as a cart's
 * buyer or a UCP platform, never as staff, and can't start, cancel or pay an order, touch a plugin
 * or read a data subject, because none of those is a method here.
 *
 * A hosted checkout's buyer is named twice: by the SHA-256 of the cookie secret the engine minted
 * when the start link was redeemed (the session's owner, `hosted:<hash>`) and by an actor the
 * storefront signed for `checkout:<id>` (`hostedCall`), so the storefront's key alone mints no
 * buyer and a cookie alone reaches no session; a UCP platform's session is never one of these.
 *
 * Each cart call names its buyer as an actor the storefront signed for `cart:<cartId>`
 * (`signGuestActor`); `buyer` admits it only to an external cart that buyer was admitted to, so one
 * cart's signature opens no other cart, and no staff cart at all.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  attachmentProblem,
  type CartState,
  cartAttachmentKey,
  type GuestActor,
  guestCartOpen,
  type HostedPayInput,
  runHealthChecks,
  type SignedActor,
  type StorefrontRpc,
  UCP_PATH,
  type UcpPlatformRef,
} from '@commerceworker/core';
import { routeAgents } from './agent-routes';
import { cartSnapshot, keepCartOpen, redeemCartStart } from './cart/carts';
import { searchCartProducts } from './cart/search';
import {
  applePayDomainAssociation,
  completeHosted,
  confirmHostedPayment,
  payHosted,
  publicSettings,
  readHosted,
  redeemHostedStart,
  updateHosted,
} from './checkout/hosted';
import { cartAgent } from './namespaces';
import { orderConfirmation } from './order-confirmation';
import { guestActor } from './principal';
import { ucpProfile, ucpSettings } from './ucp/config';
import { handleUcp } from './ucp/rest';
import { d1Reachable, pricingStore, ucpStore } from './wire';

/** How often a platform's last use is written back. */
const TOUCH_MS = 5 * 60_000;

/** A file id as the storefront mints it (`newId('att')`): no path separators, bounded. */
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const CART_PREFIX = '/agents/cart-agent/';

/**
 * The cart and its buyer, when `signed` is that buyer's, for this cart: the actor must be signed
 * under the storefront key for `cart:<cartId>` and be the buyer the cart was opened for, and the
 * cart external. Anyone else is null, whether or not the cart exists. (A function of its own, not
 * a method: every method of a `WorkerEntrypoint` is callable over RPC.)
 */
async function buyerOf(
  env: Env,
  cartId: string,
  signed: SignedActor,
): Promise<{ actor: GuestActor; state: CartState } | null> {
  const actor = await guestActor(env, signed, `cart:${cartId}`);
  if (!actor) return null;
  const state = await cartSnapshot(env, cartId);
  const external = state?.cart?.external;
  if (!state || !external || actor.id !== `guest:${external.buyer.id}`) return null;
  return { actor, state };
}

export class StorefrontApi extends WorkerEntrypoint<Env> implements StorefrontRpc {
  /**
   * Only a cart's socket (`/agents/cart-agent/<id>`, gated by `cartGate`) and UCP (`/ucp/*`). The
   * path is read as the URL parser leaves it (dot segments resolved), and the SDK routes on the
   * same path, so nothing under another prefix, an order's socket included, is reachable.
   */
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(CART_PREFIX) && pathname.length > CART_PREFIX.length)
      return routeAgents(request, this.env);
    if (pathname === UCP_PATH || pathname.startsWith(`${UCP_PATH}/`))
      return handleUcp(request, this.env);
    return new Response('Not found', { status: 404 });
  }

  health() {
    return runHealthChecks('commerceworker-engine', {
      db: () => d1Reachable(this.env),
      docs: () => this.env.DOCS.head('health'),
    });
  }

  ucpProfile(origin: string) {
    return ucpProfile(this.env, typeof origin === 'string' ? origin : '');
  }

  async ucpCheckoutOn() {
    return !!(await ucpSettings(this.env)).checkoutFlowId;
  }

  async ucpPlatform(keyHash: string): Promise<UcpPlatformRef | null> {
    if (typeof keyHash !== 'string' || !/^[0-9a-f]{64}$/.test(keyHash)) return null;
    const store = ucpStore(this.env);
    const row = await store.livePlatform(keyHash);
    if (!row) return null;
    const now = Date.now();
    if (!row.lastUsedAt || now - row.lastUsedAt > TOUCH_MS)
      this.ctx.waitUntil(
        store
          .touchPlatform(row.id, now)
          .catch((err) => console.error('platform touch failed', err)),
      );
    return { id: row.id, name: row.name, profileUrl: row.profileUrl };
  }

  storefrontSettings() {
    return publicSettings(this.env);
  }

  async redeemCheckoutStart(checkoutId: string, token: string) {
    return redeemHostedStart(this.env, checkoutId, token);
  }

  checkout(checkoutId: string, secret: string, actor: SignedActor) {
    return readHosted(this.env, checkoutId, secret, actor);
  }

  updateCheckout(
    checkoutId: string,
    patch: unknown,
    secret: string,
    actor: SignedActor,
    version?: number,
  ) {
    return updateHosted(this.env, checkoutId, patch, secret, actor, version);
  }

  completeCheckout(
    checkoutId: string,
    secret: string,
    actor: SignedActor,
    shown?: { version: number; total: number },
  ) {
    return completeHosted(this.env, checkoutId, secret, actor, shown);
  }

  payCheckout(checkoutId: string, secret: string, actor: SignedActor, pay: HostedPayInput) {
    return payHosted(this.env, checkoutId, secret, actor, pay);
  }

  confirmCheckoutPayment(checkoutId: string, secret: string, actor: SignedActor) {
    return confirmHostedPayment(this.env, checkoutId, secret, actor);
  }

  async applePayDomainAssociation() {
    return applePayDomainAssociation(this.env);
  }

  redeemCartStart(cartId: string, token: string) {
    return redeemCartStart(this.env, cartId, token);
  }

  async cartSnapshot(cartId: string, signed: SignedActor) {
    return (await buyerOf(this.env, cartId, signed))?.state ?? null;
  }

  async cartCustomerName(cartId: string, signed: SignedActor) {
    const customerId = (await buyerOf(this.env, cartId, signed))?.state.cart?.customerId;
    if (!customerId) return null;
    return (await pricingStore(this.env).customers([customerId]))[0]?.name ?? null;
  }

  async addCartFile(
    cartId: string,
    file: { id: string; name: string; type: string; body: ArrayBuffer },
    signed: SignedActor,
  ) {
    const found = await buyerOf(this.env, cartId, signed);
    if (!found) return { ok: false as const, error: 'This isn’t your cart.' };
    const { actor, state } = found;
    const cart = state.cart!;
    if (!guestCartOpen({ status: cart.status, expiresAt: cart.external!.expiresAt }, Date.now()))
      return { ok: false as const, error: 'This cart has closed.' };
    if (
      typeof file?.id !== 'string' ||
      !FILE_ID.test(file.id) ||
      !(file.body instanceof ArrayBuffer)
    )
      return { ok: false as const, error: 'That is not a file.' };
    const problem = attachmentProblem(
      { type: String(file.type), size: file.body.byteLength },
      state.attachments?.length ?? 0,
    );
    if (problem) return { ok: false as const, error: problem };
    const key = cartAttachmentKey(cartId, file.id);
    await this.env.DOCS.put(key, file.body, {
      httpMetadata: { contentType: file.type },
      customMetadata: { cartId, name: String(file.name) },
    });
    const added = await cartAgent(this.env, cartId).attachAs(actor, {
      id: file.id,
      name: String(file.name),
      type: file.type,
      size: file.body.byteLength,
      key,
    });
    if (!added.ok) await this.env.DOCS.delete(key);
    return added;
  }

  async readCartFile(cartId: string, attachmentId: string, signed: SignedActor) {
    const found = await buyerOf(this.env, cartId, signed);
    const cart = found?.state.cart;
    if (!found || !cart?.external) return null;
    // As the cart's socket does (cartGate): while the cart is open, or returned until its time.
    if (!guestCartOpen({ status: cart.status, expiresAt: cart.external.expiresAt }, Date.now()))
      return null;
    const a = found.state.attachments?.find((f) => f.id === attachmentId);
    if (!a || a.key !== cartAttachmentKey(cartId, attachmentId)) return null;
    const obj = await this.env.DOCS.get(a.key);
    return obj ? { body: obj.body } : null;
  }

  async keepCartOpen(cartId: string, signed: SignedActor) {
    const found = await buyerOf(this.env, cartId, signed);
    if (found) await keepCartOpen(this.env, cartId, found.actor);
  }

  orderReceipt(orderId: string, credential: string) {
    if (typeof orderId !== 'string' || typeof credential !== 'string') return Promise.resolve(null);
    return orderConfirmation.receipt(this.env, orderId, credential);
  }

  async searchCartProducts(cartId: string, q: string, signed: SignedActor) {
    const found = await buyerOf(this.env, cartId, signed);
    if (!found) return { ok: false as const, error: 'This isn’t your cart.' };
    const page = await searchCartProducts(
      this.env,
      cartId,
      found.actor,
      typeof q === 'string' ? q : '',
    );
    if (page.ok) await cartAgent(this.env, cartId).keepOpenFor(found.actor);
    return page;
  }
}
