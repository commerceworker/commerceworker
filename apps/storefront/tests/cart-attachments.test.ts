import {
  type Cart,
  type CartAttachment,
  type CartGuest,
  type CartState,
  signCartGuestSession,
  verifyRpcActor,
} from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { PRINCIPAL_KEY: 'storefront-test-key' };
const cartSnapshot = vi.fn();
const attachToCart = vi.fn();
const keepCartOpen = vi.fn();
const objects = new Map<string, { body: ArrayBuffer; type?: string }>();

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ cartSnapshot, attachToCart, keepCartOpen }),
  docs: () => ({
    put: async (key: string, body: ArrayBuffer, o: { httpMetadata?: { contentType?: string } }) => {
      objects.set(key, { body, type: o.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const o = objects.get(key);
      return o ? { body: new Blob([o.body]).stream() } : null;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  }),
}));
const upload = await import('../app/routes/cart-attachments');
const download = await import('../app/routes/cart-attachment');

const cart = (c: Partial<Cart> = {}) => ({ id: 'cart_1', external: null, status: 'open', ...c });
const state = (c: Partial<Cart> = {}, attachments: CartAttachment[] = []) =>
  ({ cart: cart(c), members: [], chat: [], attachments }) as unknown as CartState;
const guest: CartGuest = { cartId: 'cart_1', id: 'guest:b1', name: 'Pat Buyer' };
const guestCookie = async (g = guest) =>
  `ol_${g.cartId}=${await signCartGuestSession(env.PRINCIPAL_KEY, g, Date.now() + 60_000)}`;

const post = (file: File | null, headers: Record<string, string> = {}, cartId = 'cart_1') => {
  const body = new FormData();
  if (file) body.set('file', file);
  return upload
    .action({
      request: new Request(`https://shop.test/carts/${cartId}/attachments`, {
        method: 'POST',
        body,
        headers,
      }),
      params: { cartId },
    } as never)
    .catch((e: { init?: { status: number }; data?: unknown }) => ({
      status: e.init?.status,
      data: e.data,
    }));
};
const get = (id: string, headers: Record<string, string> = {}, cartId = 'cart_1') =>
  download.loader({
    request: new Request(`https://shop.test/carts/${cartId}/attachments/${id}`, { headers }),
    params: { cartId, attachmentId: id },
  } as never) as Promise<Response>;

const pdf = () =>
  new File(['%PDF-1.7 spec'], 'C:\\specs\\widget "spec".pdf', { type: 'application/pdf' });

beforeEach(() => {
  objects.clear();
  cartSnapshot.mockReset();
  attachToCart.mockReset();
  keepCartOpen.mockReset();
});

describe('adding a file to a cart', () => {
  const external = () => state({ external: {} as Cart['external'] });

  it('stores it under the cart and hands it to the cart’s agent as the buyer', async () => {
    cartSnapshot.mockResolvedValue(external());
    attachToCart.mockResolvedValue({ ok: true });
    expect(await post(pdf(), { cookie: await guestCookie() })).toEqual({ ok: true });
    const [cartId, a, actor] = attachToCart.mock.calls[0]!;
    expect(cartId).toBe('cart_1');
    expect(a).toMatchObject({ name: 'widget spec.pdf', type: 'application/pdf', size: 13 });
    expect(a.key).toBe(`carts/cart_1/${a.id}`);
    // Signed for this cart: the engine believes nothing else.
    expect(await verifyRpcActor([env.PRINCIPAL_KEY], actor, 'cart:cart_1')).toEqual({
      kind: 'guest',
      id: 'guest:b1',
      name: 'Pat Buyer',
    });
    expect([...objects.keys()]).toEqual([a.key]);
  });

  it('deletes the file again when the agent refuses it', async () => {
    cartSnapshot.mockResolvedValue(external());
    attachToCart.mockResolvedValue({ ok: false, error: "You can't change this cart." });
    expect(await post(pdf(), { cookie: await guestCookie() })).toMatchObject({ status: 400 });
    expect(objects.size).toBe(0);
  });

  it('refuses a stranger, a wrong type, and a buyer’s cookie for another cart', async () => {
    expect(await post(pdf())).toMatchObject({ status: 401 });
    // No sign-in is an alternative here: staff add files on the admin.
    expect(await post(pdf(), { authorization: 'Bearer cmw_live_x' })).toMatchObject({
      status: 401,
    });
    cartSnapshot.mockResolvedValue(external());
    const html = new File(['<script>'], 'x.html', { type: 'text/html' });
    expect(await post(html, { cookie: await guestCookie() })).toMatchObject({ status: 400 });
    // A buyer's cookie for cart_1 says nothing about cart_2.
    expect(await post(pdf(), { cookie: await guestCookie() }, 'cart_2')).toMatchObject({
      status: 401,
    });
    expect(objects.size).toBe(0);
  });

  it('refuses a buyer a staff cart, even with their own cookie', async () => {
    cartSnapshot.mockResolvedValue(state());
    expect(await post(pdf(), { cookie: await guestCookie() })).toMatchObject({ status: 403 });
    expect(attachToCart).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
  });
});

describe('downloading a cart’s file', () => {
  const file: CartAttachment = {
    id: 'att_1',
    name: 'spec sheet.pdf',
    type: 'application/pdf',
    size: 4,
    key: 'carts/cart_1/att_1',
    by: { id: 'usr_1', name: 'Ada' },
    at: 0,
  };
  const external = (expiresAt: number) => ({ expiresAt }) as Cart['external'];

  it('serves it as a download that runs nothing, to the buyer', async () => {
    objects.set(file.key, { body: new TextEncoder().encode('%PDF').buffer as ArrayBuffer });
    cartSnapshot.mockResolvedValue(state({ external: external(Date.now() + 60_000) }, [file]));
    const res = await get('att_1', { cookie: await guestCookie() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''spec%20sheet.pdf",
    );
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(await res.text()).toBe('%PDF');
  });

  it('is not found for a file another cart lists, and unauthorized for a stranger', async () => {
    cartSnapshot.mockResolvedValue(
      state({ external: external(Date.now() + 60_000) }, [{ ...file, key: 'carts/cart_9/att_1' }]),
    );
    expect((await get('att_1', { cookie: await guestCookie() })).status).toBe(404);
    expect((await get('att_1')).status).toBe(401);
  });

  it('lets the buyer download while the cart is open or returned until its time, not once it closed', async () => {
    objects.set(file.key, { body: new TextEncoder().encode('%PDF').buffer as ArrayBuffer });
    const as = async (c: Partial<Cart>) => {
      cartSnapshot.mockResolvedValue(state(c, [file]));
      return (await get('att_1', { cookie: await guestCookie() })).status;
    };
    const later = Date.now() + 60_000;
    expect(await as({ external: external(later) })).toBe(200);
    expect(await as({ external: external(later), status: 'returned' })).toBe(200);
    // A returned cart past its time is closed to the buyer, though their cookie lasts longer.
    expect(await as({ external: external(0), status: 'returned' })).toBe(404);
    expect(await as({ external: external(later), status: 'canceled' })).toBe(404);
    expect(await as({ external: external(later), status: 'submitted' })).toBe(404);
    expect(await as({ external: external(0) })).toBe(404);
    // Each download the buyer got counts as working on the cart, signed as them for it alone.
    expect(keepCartOpen).toHaveBeenCalledTimes(2);
    const [cartId, actor] = keepCartOpen.mock.calls[0]!;
    expect(cartId).toBe('cart_1');
    expect(await verifyRpcActor([env.PRINCIPAL_KEY], actor, 'cart:cart_1')).toMatchObject({
      kind: 'guest',
      id: guest.id,
    });
  });

  it('keeps a staff cart’s files from a buyer’s cookie', async () => {
    cartSnapshot.mockResolvedValue(state({}, [file]));
    expect((await get('att_1', { cookie: await guestCookie() })).status).toBe(404);
  });
});
