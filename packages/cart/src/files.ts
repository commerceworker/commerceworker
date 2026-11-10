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
  type CartAnswer,
  type CartProductPage,
  type CartState,
  canReadCart,
  cartAttachmentKey,
  guestCartOpen,
  newId,
} from '@commerceworker/core';

/**
 * What the serving Worker hands over: how it reaches the cart's agent and the documents bucket for
 * `actor`, whom it has already admitted. The admin stores the file itself and signs a staff actor
 * for each engine call; the storefront holds no bucket and asks the engine's `StorefrontApi`, with
 * the buyer signed under its own key.
 */
export type CartFilesDeps = {
  /** The cart as its agent holds it, or null. */
  snapshot(cartId: string, actor: CartActor): Promise<CartState | null>;
  /**
   * Stores a file at `cartAttachmentKey` and adds it to the cart as `actor`; a file the cart refuses
   * is not kept.
   */
  add(
    cartId: string,
    file: { id: string; name: string; type: string; body: ArrayBuffer },
    actor: CartActor,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The stored bytes of one of the cart's files, or null. */
  read(
    cartId: string,
    attachmentId: string,
    actor: CartActor,
  ): Promise<{ body: ReadableStream } | null>;
  /** Counts a request from the cart's buyer as activity on it (`extendedCartExpiry`). */
  keepOpen(cartId: string, actor: CartActor): Promise<void>;
  /** The engine's product search for the cart (`searchCartProducts`). */
  search(cartId: string, q: string, actor: CartActor): Promise<CartAnswer<CartProductPage>>;
};

export type Failure = { ok: false; error: string; status: number };

/**
 * Stores an uploaded file and adds it to the cart, or says why not. The agent decides whether the
 * caller may change the cart; a file it refuses is not kept.
 */
export async function uploadAttachment(
  deps: CartFilesDeps,
  cartId: string,
  actor: CartActor,
  form: FormData,
): Promise<{ ok: true } | Failure> {
  const file = form.get('file');
  if (!(file instanceof File)) return { ok: false, error: 'Choose a file.', status: 400 };
  const snapshot = await deps.snapshot(cartId, actor);
  if (!snapshot?.cart) return { ok: false, error: 'No such cart.', status: 404 };
  if (!canReadCart(snapshot.cart, actor) || (actor.kind === 'guest' && !snapshot.cart.external))
    return { ok: false, error: 'Forbidden', status: 403 };
  const problem = attachmentProblem(file, snapshot.attachments?.length ?? 0);
  if (problem) return { ok: false, error: problem, status: 400 };
  const added = await deps.add(
    cartId,
    {
      id: newId('att'),
      name: attachmentName(file.name),
      type: file.type,
      body: await file.arrayBuffer(),
    },
    actor,
  );
  if (!added.ok) return { ok: false, error: added.error, status: 400 };
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
  const snapshot = await deps.snapshot(cartId, actor);
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
  const obj = await deps.read(cartId, id, actor);
  if (!obj) return null;
  // Fetching a file is the buyer working on the cart, as much as editing it.
  if (actor.kind === 'guest') await deps.keepOpen(cartId, actor);
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
  const r = await deps.search(cartId, (q ?? '').slice(0, MAX_Q), actor);
  if (!r.ok) return { ok: false, error: r.error, status: r.notFound ? 404 : 403 };
  const { ok: _ok, ...page } = r;
  return { ok: true, page };
}
