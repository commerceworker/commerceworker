import { hostedCall, hostedGuestId, verifyGuestActor } from '@commerceworker/core';
import { EMBED_HEADER, pageHeaders, withSecurityHeaders } from '@commerceworker/security/csp';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoutesStub } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = { STOREFRONT_KEY: 'storefront-test-key' };
const engineFetch = vi.fn(async (_r: Request) => new Response('ok'));
const checkout = vi.fn();
const updateCheckout = vi.fn();
const completeCheckout = vi.fn();
const storefrontSettings = vi.fn();
const settings = (over: Record<string, unknown> = {}) => ({
  checkout: { enabled: true, editLines: false, testPayments: true, ...over },
});

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({
    fetch: engineFetch,
    checkout,
    updateCheckout,
    completeCheckout,
    storefrontSettings,
  }),
}));

const { default: worker } = await import('../workers/app');
const page = await import('../app/routes/checkout');
const placed = await import('../app/routes/checkout-placed');
const lib = await import('../app/lib/hosted-checkout.server');
const { CheckoutForm } = await import('../app/components/checkout-form');

const SECRET = 'a1'.repeat(32);
const COOKIE = `__Host-cw_chk_chk_1=${SECRET}`;
const URL_ = 'https://shop.test/checkout/chk_1';

const view = (over: Record<string, unknown> = {}) => ({
  id: 'chk_1',
  status: 'incomplete',
  currency: 'USD',
  lines: [{ id: 'li_1', sku: 'MON-27', qty: 2, title: 'Monitor', unitPrice: 100 }],
  buyer: {},
  fulfillment: 'ship',
  shipTo: null,
  shippingOption: null,
  pickupLocationId: null,
  pickupStores: [],
  promoCodes: [],
  quote: {
    currency: 'USD',
    lines: [
      {
        id: 'li_1',
        sku: 'MON-27',
        title: 'Monitor',
        qty: 2,
        unitPrice: 100,
        ships: true,
        total: 200,
        listTotal: 200,
      },
    ],
    listSubtotal: 200,
    subtotal: 200,
    shipping: 0,
    tax: 0,
    total: 200,
    shippingOptions: [],
    shippingOption: null,
    ships: true,
  },
  issues: [],
  orderId: null,
  expiresAt: 4_102_444_800_000,
  version: 3,
  ...over,
});

const get = (cookie: string | null = COOKIE, url = URL_) =>
  new Request(url, { headers: cookie ? { cookie } : {} });
const postForm = (fields: Record<string, string | string[]>, cookie: string | null = COOKIE) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
  return new Request(URL_, {
    method: 'POST',
    headers: {
      origin: 'https://shop.test',
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
};

/** What a loader or action sent: a `data()` (body and status) or a Response (a redirect, a 429). */
async function answer(run: () => Promise<unknown>) {
  const out = await run().catch((e: unknown) => e);
  if (out instanceof Response)
    return {
      status: out.status,
      location: out.headers.get('location'),
      headers: out.headers,
      data: null,
    };
  const d = out as { data: unknown; init?: ResponseInit; type?: string };
  const init = d.init ?? {};
  return {
    status: init.status ?? 200,
    location: null,
    headers: new Headers(init.headers),
    data: d.data,
  };
}
const act = (request: Request) =>
  answer(() => page.action({ params: { id: 'chk_1' }, request } as never) as Promise<unknown>);
const load = (request = get()) =>
  answer(() => page.loader({ params: { id: 'chk_1' }, request } as never) as Promise<unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  lib.forgetStorefrontSettings();
  storefrontSettings.mockResolvedValue(settings());
  checkout.mockResolvedValue(view());
  delete env.API_LIMIT;
});

describe('the checkout page’s loader', () => {
  it('draws the buyer view with what the settings allow, never cached, nothing in a Referer', async () => {
    storefrontSettings.mockResolvedValue(settings({ editLines: true }));
    const r = await load();
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ checkout: view(), testPayments: true, editLines: true });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    // React Router hands `headers` all three sets, the unused ones empty (not undefined): what the
    // page sends is private whichever answered, and a refusal's own headers stay.
    for (const route of [page, placed]) {
      const sent = route.headers({
        loaderHeaders: r.headers,
        actionHeaders: new Headers(),
        errorHeaders: undefined,
      } as never);
      expect(sent.get('cache-control')).toBe('no-store');
      expect(sent.get('referrer-policy')).toBe('no-referrer');
      const limited = route.headers({
        loaderHeaders: new Headers(),
        actionHeaders: new Headers(),
        errorHeaders: new Headers({ 'retry-after': '30' }),
      } as never);
      expect(limited.get('retry-after')).toBe('30');
      expect(limited.get('cache-control')).toBe('no-store');
    }
  });

  it('is refused with the cookie missing, malformed, another checkout’s or while off', async () => {
    for (const cookie of [null, `__Host-cw_chk_chk_1=nope`, `__Host-cw_chk_chk_2=${SECRET}`]) {
      const r = await load(get(cookie));
      expect(r.status, String(cookie)).toBe(401);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    storefrontSettings.mockResolvedValue(settings({ enabled: false }));
    lib.forgetStorefrontSettings();
    expect((await load()).status).toBe(404);
    expect(checkout).not.toHaveBeenCalled();
  });

  it('goes to the order once the checkout is completed', async () => {
    checkout.mockResolvedValue(view({ status: 'completed', orderId: 'ord_1' }));
    const r = await load();
    expect(r.status).toBe(303);
    expect(r.location).toBe('/checkout/chk_1/placed');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});

describe('an update posted from the page', () => {
  const details = {
    version: '3',
    intent: 'update',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: '',
    phone: '',
    'shipTo.line1': '500 Congress Ave',
    'shipTo.city': 'Austin',
    'shipTo.postalCode': '78701',
    'shipTo.country': 'US',
  };

  it('sends the engine the patch, the version it was drawn from and the buyer’s credentials, then redirects to the page', async () => {
    updateCheckout.mockResolvedValue({ ok: true, checkout: view({ version: 4 }) });
    const r = await act(postForm(details));
    expect(r.status).toBe(303);
    expect(r.location).toBe('/checkout/chk_1');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');

    const [id, patch, secret, actor, version] = updateCheckout.mock.calls[0]!;
    expect(id).toBe('chk_1');
    expect(version).toBe(3);
    expect(secret).toBe(SECRET);
    expect(patch).toMatchObject({
      buyer: { email: 'ada@example.com', firstName: 'Ada' },
      shipTo: { line1: '500 Congress Ave', city: 'Austin' },
    });
    // The patch names no price, and the actor is signed for this checkout alone.
    expect(JSON.stringify(patch)).not.toMatch(/price|total|owner|status/i);
    expect(
      await verifyGuestActor([env.STOREFRONT_KEY as string], actor, hostedCall('chk_1')),
    ).toEqual({
      kind: 'guest',
      id: hostedGuestId('chk_1'),
      name: 'Buyer',
    });
    expect(completeCheckout).not.toHaveBeenCalled();
  });

  it('shows "this checkout changed" with the session as it is, and nothing the buyer typed', async () => {
    const fresh = view({ version: 5, buyer: { email: 'someone@else.example' } });
    updateCheckout.mockResolvedValue({
      ok: false,
      changed: true,
      error: 'This checkout changed. Review it as it is now.',
      checkout: fresh,
    });
    const r = await act(postForm({ ...details, version: '3' }));
    expect(r.status).toBe(409);
    expect(r.data).toEqual({
      intent: 'update',
      error: expect.stringContaining('changed'),
      changed: true,
      checkout: fresh,
    });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('shows a refusal about the change with what was typed, and the session as it is', async () => {
    updateCheckout.mockResolvedValue({
      ok: false,
      error: 'That change is not allowed: Unrecognized key',
      checkout: view(),
    });
    const r = await act(postForm(details));
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({
      changed: false,
      error: expect.stringContaining('not allowed'),
      values: { email: 'ada@example.com', 'shipTo.city': 'Austin' },
    });
    expect((r.data as { values: object }).values).not.toHaveProperty('version');
  });

  it('maps what it can tell wrong to its field, keeps what was typed, and does not ask the engine', async () => {
    const r = await act(postForm({ ...details, email: 'not an email', phone: '1'.repeat(41) }));
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({
      changed: false,
      errors: {
        email: expect.stringContaining('email'),
        phone: expect.stringContaining('too long'),
      },
      values: { email: 'not an email', firstName: 'Ada' },
      checkout: view(),
    });
    expect(updateCheckout).not.toHaveBeenCalled();
  });

  it('applies the code typed in the promo field with the rest of the form', async () => {
    updateCheckout.mockResolvedValue({ ok: true, checkout: view({ version: 4 }) });
    await act(postForm({ version: '3', promo: 'SAVE10' }));
    expect(updateCheckout.mock.calls[0]![1]).toEqual({ promoCodes: ['SAVE10'] });
    await act(postForm({ version: '3', remove: 'SAVE10' }));
  });

  it('refuses a missing checkout, a missing cookie and a spent budget before anything is written', async () => {
    checkout.mockResolvedValueOnce(null);
    expect((await act(postForm(details))).status).toBe(404);
    expect((await act(postForm(details, null))).status).toBe(401);
    env.API_LIMIT = { limit: vi.fn(async () => ({ success: false })) };
    expect((await act(postForm(details))).status).toBe(429);
    expect(updateCheckout).not.toHaveBeenCalled();
  });

  it('never writes while hosted checkout is off', async () => {
    storefrontSettings.mockResolvedValue(settings({ enabled: false }));
    expect((await act(postForm(details))).status).toBe(404);
    expect(updateCheckout).not.toHaveBeenCalled();
  });
});

describe('placing the order from the page', () => {
  const ready = view({ status: 'ready_for_complete', version: 4 });
  const place = { version: '3', total: '200', intent: 'place', email: 'ada@example.com' };

  it('updates first, completes the ready checkout, and goes to the order page', async () => {
    updateCheckout.mockResolvedValue({ ok: true, checkout: ready });
    completeCheckout.mockResolvedValue({
      ok: true,
      checkout: view({ status: 'completed', orderId: 'ord_1' }),
    });
    const r = await act(postForm(place));
    expect(r.status).toBe(303);
    expect(r.location).toBe('/checkout/chk_1/placed');
    expect(updateCheckout).toHaveBeenCalledBefore(completeCheckout);
    const [id, secret, actor, shown] = completeCheckout.mock.calls[0]!;
    expect([id, secret]).toEqual(['chk_1', SECRET]);
    // The version the update just made and the total the page showed: nothing else is placed.
    expect(shown).toEqual({ version: 4, total: 200 });
    expect(
      await verifyGuestActor([env.STOREFRONT_KEY as string], actor, hostedCall('chk_1')),
    ).not.toBeNull();
  });

  it('completes nothing when the update leaves the checkout unfinished, and shows what is missing', async () => {
    updateCheckout.mockResolvedValue({
      ok: true,
      checkout: view({ status: 'incomplete', version: 4 }),
    });
    const r = await act(postForm(place));
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ error: expect.stringContaining('Finish the details') });
    expect(completeCheckout).not.toHaveBeenCalled();
  });

  it('completes nothing when the page was out of date', async () => {
    updateCheckout.mockResolvedValue({
      ok: false,
      changed: true,
      error: 'changed',
      checkout: ready,
    });
    const r = await act(postForm(place));
    expect(r.status).toBe(409);
    expect(completeCheckout).not.toHaveBeenCalled();
  });

  it('shows the engine’s refusal, or that it changed, or that it failed with nothing charged', async () => {
    updateCheckout.mockResolvedValue({ ok: true, checkout: ready });
    completeCheckout.mockResolvedValueOnce({
      ok: false,
      error: 'Card payment is not available on this page yet.',
      checkout: ready,
    });
    expect(await act(postForm(place))).toMatchObject({
      status: 422,
      data: { error: expect.stringContaining('Card payment') },
    });
    completeCheckout.mockResolvedValueOnce({
      ok: false,
      changed: true,
      error: 'changed',
      checkout: ready,
    });
    expect((await act(postForm(place))).status).toBe(409);
    completeCheckout.mockRejectedValueOnce(new Error('order failed'));
    const failed = await act(postForm(place));
    expect(failed.status).toBe(503);
    expect(failed.data).toMatchObject({ error: expect.stringContaining('Nothing was charged') });
    // Never a stack or the engine's words to the buyer.
    expect(JSON.stringify(failed.data)).not.toContain('order failed');
  });

  it('answers a second press on a completed checkout with the order page', async () => {
    checkout.mockResolvedValue(view({ status: 'completed', orderId: 'ord_1' }));
    const r = await act(postForm(place));
    expect(r.location).toBe('/checkout/chk_1/placed');
    expect(updateCheckout).not.toHaveBeenCalled();
    expect(completeCheckout).not.toHaveBeenCalled();
  });
});

describe('the order-placed page', () => {
  const loadPlaced = (request = get(COOKIE, `${URL_}/placed`)) =>
    answer(() => placed.loader({ params: { id: 'chk_1' }, request } as never) as Promise<unknown>);

  it('shows the reference to the buyer whose checkout is complete, and nothing personal in its address', async () => {
    checkout.mockResolvedValue(
      view({ status: 'completed', orderId: 'ord_1', buyer: { email: 'ada@example.com' } }),
    );
    const r = await loadPlaced();
    expect(r.data).toEqual({ orderId: 'ord_1', testPayments: true });
    expect(r.headers.get('cache-control')).toBe('no-store');
    // Nothing personal is in the address it came by: the checkout's id alone.
    expect(new URL(URL_ + '/placed').search).toBe('');
  });

  it('sends a checkout that is not complete back to its page, and refuses a stranger', async () => {
    const r = await loadPlaced();
    expect(r.status).toBe(303);
    expect(r.location).toBe('/checkout/chk_1');
    expect((await loadPlaced(get(null, `${URL_}/placed`))).status).toBe(401);
  });
});

describe('the page on the Worker', () => {
  it('refuses a cross-site POST to the page and to the order page, with the buyer’s cookie', async () => {
    for (const path of ['/checkout/chk_1', '/checkout/chk_1/placed'])
      for (const origin of ['https://evil.example', 'null']) {
        const res = await worker.fetch(
          new Request(`https://shop.test${path}`, {
            method: 'POST',
            headers: {
              cookie: COOKIE,
              origin,
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: 'intent=place&version=3',
          }) as never,
        );
        expect(res.status, `${path} ${origin}`).toBe(403);
      }
    expect(checkout).not.toHaveBeenCalled();
    expect(updateCheckout).not.toHaveBeenCalled();
    expect(completeCheckout).not.toHaveBeenCalled();
  });

  it('is framed by no one: the policy a page without an embed note gets is frame-ancestors none', () => {
    // The checkout routes name no embed policy (a hosted checkout is the buyer's own top-level
    // page), so entry.server gives them the default and the Worker adds the deny header.
    const headers = pageHeaders(new Headers({ 'cache-control': 'no-store' }), 'nonce123');
    expect(headers.has(EMBED_HEADER)).toBe(false);
    const res = withSecurityHeaders(
      new Response('x', { headers }),
      new URL('https://shop.test/checkout/chk_1'),
    );
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

/** The opening tags of `tag` in `html`, and whether one carries every attribute given (their order is React's). */
const tagsOf = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
const has = (html: string, tag: string, ...attrs: string[]) =>
  tagsOf(html, tag).some((t) => attrs.every((a) => t.includes(a)));

/** The page's form drawn on its own, inside a router (its `Form` needs one). */
const draw = (props: Partial<Parameters<typeof CheckoutForm>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(
      createRoutesStub([
        {
          path: '/checkout/:id',
          Component: () =>
            createElement(CheckoutForm, {
              checkout: view() as never,
              testPayments: true,
              editLines: false,
              attempted: false,
              busy: false,
              ...props,
            }),
        },
      ]),
      { initialEntries: ['/checkout/chk_1'] },
    ),
  );

describe('the page’s form', () => {
  it('is one plain form that posts to the page with the version it was drawn from', () => {
    const html = draw();
    expect(html.match(/<form /g)).toHaveLength(1);
    expect(html).toMatch(/<form[^>]*method="post"/);
    // Posted to its own path, so it also works with no script.
    expect(html).toMatch(/<form[^>]*action="\/checkout\/chk_1"/);
    expect(has(html, 'input', 'type="hidden"', 'name="version"', 'value="3"')).toBe(true);
    expect(html).toContain('Place order (test mode)');
    // Enter in a field updates: the first submit button, never a Remove.
    expect(has(html, 'button', 'name="intent"', 'value="update"', 'aria-hidden="true"')).toBe(true);
    expect(tagsOf(html, 'button')[0]).toContain('name="intent"');
  });

  it('fills fields by the tokens a browser knows, at the sizes a thumb and iOS need', () => {
    const html = draw();
    for (const token of [
      'autoComplete="email"',
      'autoComplete="given-name"',
      'autoComplete="family-name"',
      'autoComplete="tel"',
      'autoComplete="shipping name"',
      'autoComplete="shipping address-line1"',
      'autoComplete="shipping address-line2"',
      'autoComplete="shipping address-level2"',
      'autoComplete="shipping address-level1"',
      'autoComplete="shipping postal-code"',
      'autoComplete="shipping country-name"',
    ])
      expect(has(html, 'input', token), token).toBe(true);
    expect(has(html, 'input', 'type="email"')).toBe(true);
    expect(has(html, 'input', 'type="tel"')).toBe(true);
    // Every text field is 44px tall and 16px, on a screen with a mouse too.
    const inputs = tagsOf(html, 'input').filter((i) => /type="(text|email|tel)"/.test(i));
    expect(inputs.length).toBeGreaterThanOrEqual(10);
    for (const i of inputs) {
      expect(i).toContain('h-11');
      expect(i).toContain('text-base');
      expect(i).toContain('md:text-base');
    }
  });

  it('puts an error beside the field it is about, tied to it for a screen reader', () => {
    const html = draw({ errors: { email: 'Enter an email address like name@example.com.' } });
    expect(
      has(html, 'input', 'id="f-email"', 'aria-invalid="true"', 'aria-describedby="f-email-error"'),
    ).toBe(true);
    expect(html).toMatch(/id="f-email-error"[^>]*>Enter an email address/);
    expect(html).not.toContain('f-firstName-error');
  });

  it('maps a session’s issues to their sections, holding back what is still to fill in until tried', () => {
    const issues = [
      {
        kind: 'error',
        code: 'missing',
        path: '$.buyer.email',
        content: "The buyer's email is required.",
      },
      {
        kind: 'error',
        code: 'item_unavailable',
        path: '$.line_items',
        content: 'MON-27 is sold out.',
      },
      { kind: 'warning', code: 'promotion', path: '$.promoCodes', content: 'No such code.' },
    ];
    const first = draw({ checkout: view({ issues }) as never });
    expect(first).not.toContain('The buyer&#x27;s email is required.');
    expect(first).toContain('MON-27 is sold out.');
    expect(first).toContain('No such code.');
    const tried = draw({ checkout: view({ issues }) as never, attempted: true });
    expect(tried).toContain('buyer&#x27;s email is required.');
  });

  it('lists the shipping options from the quote and chooses the one the quote did', () => {
    const q = view().quote;
    const html = draw({
      checkout: view({
        quote: {
          ...q,
          shipping: 10,
          shippingOption: 'ground',
          shippingOptions: [
            { id: 'ground', title: 'Ground', carrier: 'UPS', amount: 10, minDays: 3, maxDays: 5 },
            { id: 'air', title: 'Air', carrier: 'UPS', amount: 0, minDays: 1, maxDays: 1 },
          ],
        },
      }) as never,
    });
    expect(has(html, 'input', 'name="shippingOption"', 'value="ground"', 'checked=""')).toBe(true);
    expect(has(html, 'input', 'name="shippingOption"', 'value="air"')).toBe(true);
    expect(has(html, 'input', 'value="air"', 'checked=""')).toBe(false);
    expect(html).toContain('3 to 5 days');
    expect(html).toContain('1 day');
    expect(html).toContain('Free');
    // Every choice is a row 44px tall, the whole label a target.
    expect(html.match(/<label class="flex min-h-11/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('offers pickup only where the flow found stores, and says so when none holds everything', () => {
    expect(draw()).not.toContain('Pick it up in a store');
    const stores = [{ id: 'loc_1', name: 'Austin Central', postalCode: '78701' }];
    const html = draw({ checkout: view({ pickupStores: stores }) as never });
    expect(html).toContain('Pick it up in a store');
    expect(html).toContain('Austin Central');
    expect(has(html, 'input', 'name="pickupLocationId"', 'value="loc_1"')).toBe(true);
    // Already chosen, with the stores gone: still shown, with why.
    const gone = draw({
      checkout: view({ fulfillment: 'pickup', pickupLocationId: 'loc_1' }) as never,
    });
    expect(gone).toContain('No store has everything in this checkout.');
  });

  it('shows the codes applied and refused, and the total as the quote has it', () => {
    const q = view().quote;
    const html = draw({
      checkout: view({
        promoCodes: ['SAVE10', 'BOGUS'],
        quote: {
          ...q,
          lines: [{ ...q.lines[0], unitPrice: 90, listPrice: 100, total: 180, listTotal: 200 }],
          subtotal: 180,
          shipping: 5,
          tax: 14.8,
          total: 199.8,
          discounts: {
            applied: [{ code: 'SAVE10', title: '10% off', kind: 'pct', amount: 20 }],
            refused: [{ code: 'BOGUS', reason: 'That code does not exist.' }],
          },
        },
      }) as never,
    });
    expect(html).toContain('Applied: 10% off');
    expect(html).toContain('Not applied: That code does not exist.');
    const rows: [string, string][] = [
      ['Subtotal', '$200.00'],
      ['10% off<span class="ml-1.5 font-mono text-xs">SAVE10</span>', '-$20.00'],
      ['Shipping', '$5.00'],
      ['Tax', '$14.80'],
      ['Total', '$199.80'],
    ];
    for (const [label, amount] of rows)
      expect(html, label).toContain(`${label}</dt><dd class="tabular-nums">${amount}`);
  });

  it('takes no card yet in real mode: it says so and has no way to place the order', () => {
    const html = draw({ testPayments: false });
    expect(html).toContain('Card payment is coming');
    expect(html).not.toContain('Place order');
    expect(has(html, 'button', 'value="place"')).toBe(false);
    expect(draw()).not.toContain('Card payment is coming');
  });

  it('shows quantities as text unless the merchant lets the buyer change them', () => {
    expect(has(draw(), 'input', 'name="qty:li_1"')).toBe(false);
    const html = draw({ editLines: true });
    expect(has(html, 'input', 'name="qty:li_1"', 'value="2"')).toBe(true);
    expect(has(html, 'button', 'name="removeLine"', 'value="li_1"')).toBe(true);
  });

  it('is read-only, with nothing to press, once a checkout is over, being placed or with the business', () => {
    for (const status of ['canceled', 'complete_in_progress', 'requires_escalation', 'completed']) {
      const html = draw({ checkout: view({ status }) as never, editLines: true });
      expect(html, status).toContain('<fieldset disabled=""');
      expect(html, status).not.toContain('Place order');
      expect(html, status).not.toContain('Card payment is coming');
      // The one fieldset that is disabled holds every control: none is outside it.
      const outside = html.slice(html.indexOf('</fieldset>', html.lastIndexOf('</aside>')));
      expect(tagsOf(outside, 'input').filter((t) => !t.includes('type="hidden"'))).toEqual([]);
      expect(tagsOf(outside, 'button')).toEqual([]);
      expect(has(html, 'input', 'name="qty:li_1"')).toBe(false);
    }
    // An open one is not disabled.
    expect(draw()).not.toContain('<fieldset disabled=""');
  });

  it('names what each control removes, and cannot be pressed twice', () => {
    const html = draw({
      editLines: true,
      busy: true,
      checkout: view({ promoCodes: ['SAVE10'] }) as never,
    });
    expect(
      has(html, 'button', 'name="removeLine"', 'aria-label="Remove Monitor"', 'disabled=""'),
    ).toBe(true);
    expect(has(html, 'button', 'name="remove"', 'aria-label="Remove code SAVE10"')).toBe(true);
    expect(draw({ editLines: true })).not.toMatch(/name="removeLine"[^>]*disabled/);
  });

  it('labels a quantity for its line and ties its error to it', () => {
    const html = draw({
      editLines: true,
      errors: { 'qty:li_1': 'Enter a quantity from 1 to 10000.' },
    });
    expect(html).toContain('Quantity<span class="sr-only"> of Monitor</span>');
    expect(
      has(
        html,
        'input',
        'id="qty-li_1"',
        'aria-invalid="true"',
        'aria-describedby="qty-li_1-error"',
      ),
    ).toBe(true);
    expect(html).toMatch(/id="qty-li_1-error"[^>]*>Enter a quantity/);
  });

  it('marks what is optional, and what is required is not', () => {
    const html = draw();
    for (const label of [
      'First name',
      'Last name',
      'Phone',
      'Full name',
      'Apartment, suite, etc.',
      'State or region',
    ])
      expect(html, label).toContain(
        `${label}<span class="font-normal text-muted-foreground"> (optional)</span>`,
      );
    for (const label of ['Email', 'Address', 'City', 'Postal code', 'Country'])
      expect(html, label).not.toContain(
        `${label}<span class="font-normal text-muted-foreground"> (optional)</span>`,
      );
  });

  it('puts an issue the engine names on its input, once, and not in a section', () => {
    const html = draw({
      attempted: true,
      checkout: view({
        issues: [
          {
            kind: 'error',
            code: 'invalid',
            path: '$.fulfillment.address.postal_code',
            content: 'That postcode is not deliverable.',
          },
          {
            kind: 'error',
            code: 'invalid',
            path: '$.buyer.phone',
            content: 'That phone number is not valid.',
          },
        ],
      }) as never,
    });
    expect(
      has(
        html,
        'input',
        'id="f-shipTo-postalCode"',
        'aria-invalid="true"',
        'aria-describedby="f-shipTo-postalCode-error"',
      ),
    ).toBe(true);
    expect(html.split('That postcode is not deliverable.').length - 1).toBe(1);
    expect(has(html, 'input', 'id="f-phone"', 'aria-invalid="true"')).toBe(true);
  });

  it('has no alert on a field: the page’s one alert says it, and the field is tied to its message', () => {
    const html = draw({ errors: { email: 'Enter an email address like name@example.com.' } });
    expect(html).not.toContain('role="alert"');
  });

  it('says only what is being placed on the button that placed it', () => {
    expect(draw({ busy: true, placing: true })).toContain('Placing…');
    expect(draw({ busy: true, placing: false })).not.toContain('Placing…');
    expect(draw({ busy: true })).toContain('Place order (test mode)');
  });

  it('shows prices as the quote has them, with Was and Now for a screen reader, and no warning in the wait colour', () => {
    const q = view().quote;
    const html = draw({
      checkout: view({
        issues: [
          { kind: 'warning', code: 'promotion', path: '$.promoCodes', content: 'No such code.' },
        ],
        quote: {
          ...q,
          lines: [{ ...q.lines[0], total: 180, listTotal: 200 }],
        },
      }) as never,
    });
    expect(html).toContain('<span class="sr-only">Was </span>$200.00');
    expect(html).toContain('<span class="sr-only">Now </span>$180.00');
    // A line the quote gives no total for shows no price, never one worked out here.
    const bare = draw({
      checkout: view({
        quote: {
          ...q,
          lines: [
            { id: 'li_1', sku: 'MON-27', title: 'Monitor', qty: 2, unitPrice: 100, ships: true },
          ],
        },
      }) as never,
    });
    expect(bare).not.toContain('$200.00</span></li>');
    expect(html).not.toContain('text-wait');
    expect(html).toMatch(
      /<li class="text-foreground"><span class="font-medium">Note: <\/span>No such code\./,
    );
  });

  it('uses the rounded-lg of a bordered row, not xl', () => {
    const html = draw({ checkout: view({ promoCodes: ['X'] }) as never });
    expect(html).not.toMatch(/min-h-11[^"]*rounded-xl/);
    expect(html).toMatch(/min-h-11[^"]*rounded-lg border/);
  });

  it('keeps the promo row in line: its error is under the row, tied to the input', () => {
    const html = draw({ errors: { promo: 'That code is too long.' } });
    const row = html.slice(html.indexOf('id="f-promo"') - 400, html.indexOf('Apply'));
    expect(row).not.toContain('That code is too long.');
    expect(html.indexOf('That code is too long.')).toBeGreaterThan(html.indexOf('Apply'));
    expect(
      has(html, 'input', 'id="f-promo"', 'aria-invalid="true"', 'aria-describedby="f-promo-error"'),
    ).toBe(true);
  });

  it('says why a card can’t be paid yet, and what to do', () => {
    const html = draw({ testPayments: false });
    expect(html).toContain('Contact the business to pay for this order.');
    expect(html).toContain('data-slot="alert"');
  });

  it('keeps the version and the total it showed in the form', () => {
    const html = draw();
    expect(has(html, 'input', 'type="hidden"', 'name="total"', 'value="200"')).toBe(true);
  });

  it('starts its fields again only when the checkout changed under the buyer', () => {
    // The key is not in the markup; what shows is that a refreshed page keeps its typed values.
    const html = draw({ values: { email: 'typed@example.com' } });
    expect(has(html, 'input', 'name="email"', 'value="typed@example.com"')).toBe(true);
  });
});

describe('what the action is told by the form, and how often', () => {
  const base = { intent: 'update', email: 'ada@example.com' };
  beforeEach(() => updateCheckout.mockResolvedValue({ ok: true, checkout: view({ version: 4 }) }));

  it('asks for no conflict check when the form has no version, and is a conflict for one that is no number', async () => {
    await act(postForm({ ...base }));
    expect(updateCheckout.mock.calls[0]![4]).toBeUndefined();
    await act(postForm({ ...base, version: '' }));
    expect(updateCheckout.mock.calls[1]![4]).toBe(0);
    await act(postForm({ ...base, version: 'abc' }));
    expect(updateCheckout.mock.calls[2]![4]).toBeNaN();
    await act(postForm({ ...base, version: '3' }));
    expect(updateCheckout.mock.calls[3]![4]).toBe(3);
  });

  it('sends a placement the version it made and a total that was not shown as no total', async () => {
    updateCheckout.mockResolvedValue({
      ok: true,
      checkout: view({ status: 'ready_for_complete', version: 4 }),
    });
    completeCheckout.mockResolvedValue({
      ok: false,
      changed: true,
      error: 'changed',
      checkout: view(),
    });
    await act(postForm({ intent: 'place', version: '3' }));
    expect(completeCheckout.mock.calls[0]![3]).toMatchObject({ version: 4 });
    expect(completeCheckout.mock.calls[0]![3].total).toBeNaN();
  });

  it('holds changes to promo codes to a budget of their own, per cookie, and others to none', async () => {
    const used = new Map<string, number>();
    const limit = (name: string, cap: number) => ({
      limit: vi.fn(async ({ key }: { key: string }) => {
        used.set(`${name}:${key}`, (used.get(`${name}:${key}`) ?? 0) + 1);
        return { success: (used.get(`${name}:${key}`) ?? 0) <= cap };
      }),
    });
    env.API_LIMIT = limit('api', 1000);
    env.PROMO_LIMIT = limit('promo', 2);
    const code = { intent: 'update', version: '3', promo: 'SAVE10' };
    expect((await act(postForm(code))).status).toBe(303);
    expect((await act(postForm(code))).status).toBe(303);
    const third = await act(postForm(code));
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('60');
    expect(updateCheckout).toHaveBeenCalledTimes(2);
    // Changing anything but codes spends none of it.
    expect((await act(postForm({ intent: 'update', version: '3', email: 'a@b.co' }))).status).toBe(
      303,
    );
    delete env.PROMO_LIMIT;
  });
});
