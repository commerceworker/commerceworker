/**
 * A cart's files and its product search, for whoever the Worker serving the request has already
 * admitted: staff on the admin (`apps/web`, by their session) or an external cart's buyer on the
 * storefront (`apps/storefront`, by the cookie their start link set for that cart alone). Each
 * Worker authenticates its own kind of caller and hands the rest to this module, so the rules
 * after "who is asking" (what a cart may hold, when a buyer's access has lapsed, what a download
 * runs under) are written once.
 *
 * Files are stored in the documents bucket at `cartAttachmentKey` and listed by the cart's agent.
 */

import {
  attachmentName,
  attachmentProblem,
  type CartActor,
  type CartProductPage,
  canReadCart,
  cartAttachmentKey,
  type EngineRpc,
  guestCartOpen,
  newId,
  type RpcActor,
  type SignedActor,
} from '@commerceworker/core';

/** The slice of the documents bucket (`DOCS`) a cart's files use. */
type Bucket = {
  put(
    key: string,
    body: ArrayBuffer,
    options: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(key: string): Promise<unknown>;
};

/** What the serving Worker hands over: its engine binding, the bucket, and how it signs an actor. */
export type CartFilesDeps = {
  engine: Pick<EngineRpc, 'cartSnapshot' | 'attachToCart' | 'keepCartOpen' | 'searchCartProducts'>;
  docs: Bucket;
  /** Who acts, signed for one call (`cart:<cartId>`): the engine takes it from nothing else. */
  signedActor: (actor: RpcActor, call: string) => Promise<SignedActor>;
};

const forCart = (cartId: string) => `cart:${cartId}`;

export type Failure = { ok: false; error: string; status: number };

/**
 * Stores an uploaded file and adds it to the cart, or says why not. The agent decides whether the
 * caller may change the cart; a file it refuses is deleted again.
 */
export async function uploadAttachment(
  deps: CartFilesDeps,
  cartId: string,
  actor: CartActor,
  form: FormData,
): Promise<{ ok: true } | Failure> {
  const file = form.get('file');
  if (!(file instanceof File)) return { ok: false, error: 'Choose a file.', status: 400 };
  const snapshot = await deps.engine.cartSnapshot(cartId);
  if (!snapshot?.cart) return { ok: false, error: 'No such cart.', status: 404 };
  if (!canReadCart(snapshot.cart, actor) || (actor.kind === 'guest' && !snapshot.cart.external))
    return { ok: false, error: 'Forbidden', status: 403 };
  const problem = attachmentProblem(file, snapshot.attachments?.length ?? 0);
  if (problem) return { ok: false, error: problem, status: 400 };
  const id = newId('att');
  const key = cartAttachmentKey(cartId, id);
  const name = attachmentName(file.name);
  await deps.docs.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { cartId, name },
  });
  const added = await deps.engine.attachToCart(
    cartId,
    { id, name, type: file.type, size: file.size, key },
    await deps.signedActor(actor, forCart(cartId)),
  );
  if (!added.ok) {
    await deps.docs.delete(key);
    return { ok: false, error: added.error, status: 400 };
  }
  return { ok: true };
}

/**
 * One of a cart's files, downloaded, for someone who may read the cart, or null. Served as an
 * attachment under a CSP that runs nothing, so a file can't act on the serving origin.
 */
export async function downloadAttachment(
  deps: CartFilesDeps,
  cartId: string,
  id: string,
  actor: CartActor,
): Promise<Response | null> {
  const snapshot = await deps.engine.cartSnapshot(cartId);
  const cart = snapshot?.cart;
  if (!cart || !canReadCart(cart, actor)) return null;
  // A guest's cookie is for this cart only; the Worker already scoped it to `cartId`. It works
  // while the cart is open, or returned to their system until its time, as the cart's socket does
  // (cartGate).
  if (
    actor.kind === 'guest' &&
    (!cart.external ||
      !guestCartOpen({ status: cart.status, expiresAt: cart.external.expiresAt }, Date.now()))
  )
    return null;
  const a = snapshot.attachments?.find((f) => f.id === id);
  if (!a || a.key !== cartAttachmentKey(cartId, id)) return null;
  const obj = await deps.docs.get(a.key);
  if (!obj) return null;
  // Fetching a file is the buyer working on the cart, as much as editing it.
  if (actor.kind === 'guest')
    await deps.engine.keepCartOpen(cartId, await deps.signedActor(actor, forCart(cartId)));
  return new Response(obj.body, {
    headers: {
      'content-type': a.type,
      'content-length': String(a.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}

/** Characters of a search passed on: no SKU or product name is longer. */
const MAX_Q = 200;

/**
 * A person's own search budget, apart from their API one (the binding counts per key): a buyer's
 * is on their cart, since a cart's buyers share an id only with themselves.
 */
export const productSearchBudgetKey = (cartId: string, actor: CartActor) =>
  actor.kind === 'guest' ? `cart-search:${cartId}:${actor.id}` : `cart-search:${actor.id}`;

/**
 * Products to add to a cart, for its search field. The engine searches what the cart's quote
 * prices and decides who may (`searchCartProducts`); this only passes on who asks.
 */
export async function searchProducts(
  deps: CartFilesDeps,
  cartId: string,
  actor: CartActor,
  q: string | null,
): Promise<{ ok: true; page: CartProductPage } | Failure> {
  const r = await deps.engine.searchCartProducts(
    cartId,
    (q ?? '').slice(0, MAX_Q),
    await deps.signedActor(actor, forCart(cartId)),
  );
  if (!r.ok) return { ok: false, error: r.error, status: r.notFound ? 404 : 403 };
  const { ok: _ok, ...page } = r;
  return { ok: true, page };
}
