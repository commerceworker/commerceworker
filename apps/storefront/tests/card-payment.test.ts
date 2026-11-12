import { hostedCall, verifyGuestActor } from '@commerceworker/core';
import {
  pageHeaders,
  STRIPE_HEADER,
  TURNSTILE_HEADER,
  withSecurityHeaders,
} from '@commerceworker/security/csp';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Taking a card on the hosted checkout page, engine mocked: the page offers it only when payments
 * are live and a publishable key is set, its policy lets Stripe in on that page alone, and Pay posts
 * only a confirmation token with the version and total the page showed, after the budgets and
 * Turnstile. The Payment Element itself runs in a browser (docs/testing.md names what CI can't cover).
 */

const env: Record<string, unknown> = { STOREFRONT_KEY: 'storefront-test-key' };
const checkout = vi.fn();
const updateCheckout = vi.fn();
const completeCheckout = vi.fn();
const payCheckout = vi.fn();
const confirmCheckoutPayment = vi.fn();
const storefrontSettings = vi.fn();
const applePayDomainAssociation = vi.fn();
const live = (over: Record<string, unknown> = {}) => ({
  checkout: {
    enabled: true,
    editLines: false,
    testPayments: false,
    publishableKey: 'pk_test_page',
    ...over,
  },
});

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({
    fetch: async () => new Response('ok'),
    checkout,
    updateCheckout,
    completeCheckout,
    payCheckout,
    confirmCheckoutPayment,
    storefrontSettings,
    applePayDomainAssociation,
  }),
}));

const { default: worker } = await import('../workers/app');
const page = await import('../app/routes/checkout');
const lib = await import('../app/lib/hosted-checkout.server');
const applePay = await import('../app/lib/apple-pay.server');
const { CheckoutForm } = await import('../app/components/checkout-form');

const SECRET = 'a1'.repeat(32);
const COOKIE = `__Host-cw_chk_chk_1=${SECRET}`;
const URL_ = 'https://shop.test/checkout/chk_1';
const TOKEN = 'ctoken_1QabcDEF23';

const view = (over: Record<string, unknown> = {}) => ({
  id: 'chk_1',
  status: 'ready_for_complete',
  currency: 'USD',
  lines: [{ id: 'li_1', sku: 'MON-27', qty: 2, title: 'Monitor', unitPrice: 100 }],
  buyer: { email: 'ada@example.com' },
  fulfillment: 'ship',
  shipTo: null,
  shippingOption: null,
  pickupLocationId: null,
  pickupStores: [],
  promoCodes: [],
  quote: {
    currency: 'USD',
    lines: [],
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

const get = () => new Request(URL_, { headers: { cookie: COOKIE } });
const postForm = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: 'POST',
    headers: {
      origin: 'https://shop.test',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: COOKIE,
      ...headers,
    },
    body: new URLSearchParams(fields),
  });

/** What a loader or action sent: a `data()` (body and status) or a Response (a redirect, a 429). */
async function answer(run: () => Promise<unknown>) {
  const out = await run().catch((e: unknown) => e);
  if (out instanceof Response)
    return { status: out.status, location: out.headers.get('location'), data: null as unknown };
  const d = out as { data: unknown; init?: ResponseInit };
  return {
    status: d.init?.status ?? 200,
    location: null,
    data: d.data as Record<string, unknown> | null,
    headers: new Headers(d.init?.headers),
  };
}
const act = (request: Request) =>
  answer(() => page.action({ params: { id: 'chk_1' }, request } as never) as Promise<unknown>);
const load = () =>
  answer(
    () => page.loader({ params: { id: 'chk_1' }, request: get() } as never) as Promise<unknown>,
  );

const pay = {
  intent: 'pay',
  version: '3',
  total: '200',
  confirmationToken: TOKEN,
  email: 'ada@example.com',
};

/** A Siteverify that answers `body`, and what it was asked. */
function siteverify(body: Record<string, unknown>) {
  const asked: URLSearchParams[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      asked.push(init?.body as URLSearchParams);
      return new Response(JSON.stringify(body));
    }),
  );
  return asked;
}

beforeEach(() => {
  vi.clearAllMocks();
  lib.forgetStorefrontSettings();
  applePay.forgetApplePayFile();
  storefrontSettings.mockResolvedValue(live());
  checkout.mockResolvedValue(view());
  updateCheckout.mockResolvedValue({ ok: true, checkout: view({ version: 4 }) });
  for (const k of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'PAY_LIMIT', 'API_LIMIT'])
    delete env[k];
});
afterEach(() => vi.unstubAllGlobals());

describe('which pages may load Stripe', () => {
  it('draws the card form’s data only while payments are live with a key, and notes it for the policy', async () => {
    const r = await load();
    expect(r.data).toMatchObject({ publishableKey: 'pk_test_page', turnstileKey: null });
    expect(r.headers?.get(STRIPE_HEADER)).toBe('1');
    expect(r.headers?.has(TURNSTILE_HEADER)).toBe(false);
    // The route's `headers` carries the note, whichever answer is drawn.
    const out = page.headers({
      loaderHeaders: r.headers,
      actionHeaders: new Headers(),
      errorHeaders: undefined,
      parentHeaders: new Headers(),
    } as never) as Headers;
    expect(out.get(STRIPE_HEADER)).toBe('1');
    expect(out.get('cache-control')).toBe('no-store');
  });

  it('notes Turnstile too when the deployment has a widget', async () => {
    env.TURNSTILE_SITE_KEY = '0x4AAAAAAAtest';
    const r = await load();
    expect(r.data).toMatchObject({ turnstileKey: '0x4AAAAAAAtest' });
    expect(r.headers?.get(TURNSTILE_HEADER)).toBe('1');
  });

  it('offers no card, and loads nothing of Stripe, in test mode or with no key', async () => {
    for (const settings of [live({ testPayments: true }), live({ publishableKey: null })]) {
      lib.forgetStorefrontSettings();
      storefrontSettings.mockResolvedValue(settings);
      const r = await load();
      expect(r.data).toMatchObject({ publishableKey: null, turnstileKey: null });
      expect(r.headers?.has(STRIPE_HEADER)).toBe(false);
    }
  });

  it('lets only that page frame Stripe, call its API and use the payment request', async () => {
    const r = await load();
    const card = pageHeaders(
      page.headers({ loaderHeaders: r.headers, errorHeaders: undefined } as never) as Headers,
      'n',
    );
    const sent = withSecurityHeaders(new Response('x', { headers: card }), new URL(URL_));
    const csp = sent.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(
      "script-src 'self' 'nonce-n' https://js.stripe.com https://*.js.stripe.com",
    );
    expect(csp).toContain(
      'frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com',
    );
    expect(csp).toContain("connect-src 'self' https://api.stripe.com");
    expect(sent.headers.get('permissions-policy')).toContain(
      'payment=(self "https://js.stripe.com")',
    );
    // The note is for the entry, never sent.
    expect(sent.headers.has(STRIPE_HEADER)).toBe(false);

    // The same page in test mode, and any other page, get none of it.
    lib.forgetStorefrontSettings();
    storefrontSettings.mockResolvedValue(live({ testPayments: true }));
    const test = await load();
    for (const headers of [
      page.headers({ loaderHeaders: test.headers, errorHeaders: undefined } as never) as Headers,
      new Headers(),
    ]) {
      const plain = withSecurityHeaders(
        new Response('x', { headers: pageHeaders(headers, 'n') }),
        new URL(URL_),
      );
      const policy = plain.headers.get('content-security-policy') ?? '';
      expect(policy).not.toContain('stripe.com');
      expect(plain.headers.get('permissions-policy')).toContain('payment=()');
    }
  });
});

describe('Pay', () => {
  it('posts the engine only the token, and the version and total the page showed', async () => {
    payCheckout.mockResolvedValue({
      ok: true,
      checkout: view({ status: 'completed', orderId: 'ord_1' }),
    });
    const r = await act(postForm({ ...pay, cardNumber: '4242424242424242', amount: '1' }));
    expect(r.status).toBe(303);
    expect(r.location).toBe('/checkout/chk_1/placed');
    expect(updateCheckout).toHaveBeenCalledBefore(payCheckout);
    const [id, secret, actor, body] = payCheckout.mock.calls[0]!;
    expect([id, secret]).toEqual(['chk_1', SECRET]);
    // The update's version and the page's total; the token; nothing else the form carried.
    expect(body).toEqual({ version: 4, total: 200, confirmationToken: TOKEN });
    expect(
      await verifyGuestActor([env.STOREFRONT_KEY as string], actor, hostedCall('chk_1')),
    ).not.toBeNull();
  });

  it('says what is missing and pays nothing when the checkout is not ready', async () => {
    updateCheckout.mockResolvedValue({ ok: true, checkout: view({ status: 'incomplete' }) });
    const r = await act(postForm(pay));
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ error: expect.stringMatching(/then pay/) });
    expect(payCheckout).not.toHaveBeenCalled();
  });

  it('refuses a press with no confirmation token (no script) or one that is not a token, asking nothing', async () => {
    for (const confirmationToken of ['', 'pm_card_visa', 'ctoken_', `ctoken_${'a'.repeat(300)}`]) {
      const r = await act(postForm({ ...pay, confirmationToken }));
      expect(r.status).toBe(422);
      expect(r.data).toMatchObject({ error: expect.stringMatching(/needs JavaScript/) });
    }
    const { confirmationToken: _t, ...none } = pay;
    expect((await act(postForm(none))).status).toBe(422);
    expect(updateCheckout).not.toHaveBeenCalled();
    expect(payCheckout).not.toHaveBeenCalled();
  });

  it('is refused while payments are only recorded, or with no key', async () => {
    for (const settings of [live({ testPayments: true }), live({ publishableKey: null })]) {
      lib.forgetStorefrontSettings();
      storefrontSettings.mockResolvedValue(settings);
      const r = await act(postForm(pay));
      expect(r.status).toBe(422);
    }
    expect(payCheckout).not.toHaveBeenCalled();
  });

  it('shows a declined card or a changed price as the engine says it, with the session as it is', async () => {
    payCheckout.mockResolvedValueOnce({
      ok: false,
      error: 'Your card was declined. Try another card or payment method.',
      checkout: view(),
    });
    const declined = await act(postForm(pay));
    expect(declined.status).toBe(422);
    expect(declined.data).toMatchObject({
      error: expect.stringMatching(/declined/),
      changed: false,
    });
    payCheckout.mockResolvedValueOnce({
      ok: false,
      error: 'changed',
      changed: true,
      checkout: view(),
    });
    expect((await act(postForm(pay))).status).toBe(409);
    payCheckout.mockRejectedValueOnce(new Error('boom'));
    const failed = await act(postForm(pay));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.data)).not.toMatch(/boom/);
    expect(failed.data).toMatchObject({ error: expect.stringMatching(/Nothing was charged/) });
  });

  it('hands the browser the client secret when the bank must confirm, then confirms and goes to the order', async () => {
    payCheckout.mockResolvedValue({
      ok: true,
      checkout: view({ status: 'complete_in_progress' }),
      authenticate: { clientSecret: 'pi_1_secret_2' },
    });
    const r = await act(postForm(pay));
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ authenticate: 'pi_1_secret_2', error: '' });
    // The browser's next step posts nothing but the intent: the engine reads the payment itself.
    confirmCheckoutPayment.mockResolvedValue({
      ok: true,
      checkout: view({ status: 'completed', orderId: 'ord_1' }),
    });
    const done = await act(postForm({ intent: 'confirm', total: '1', confirmationToken: 'x' }));
    expect(done.status).toBe(303);
    expect(done.location).toBe('/checkout/chk_1/placed');
    expect(confirmCheckoutPayment).toHaveBeenCalledWith('chk_1', SECRET, expect.anything());
    expect(updateCheckout).toHaveBeenCalledTimes(1);
    // A bank that refused is shown, with the session reopened.
    confirmCheckoutPayment.mockResolvedValue({
      ok: false,
      error: 'That payment was not completed. Try again.',
      checkout: view(),
    });
    expect((await act(postForm({ intent: 'confirm' }))).status).toBe(422);
    confirmCheckoutPayment.mockRejectedValue(new Error('x'));
    expect((await act(postForm({ intent: 'confirm' }))).status).toBe(503);
  });

  it('is held to a budget per cookie and per address, before anything is written', async () => {
    const used = new Map<string, number>();
    env.PAY_LIMIT = {
      limit: vi.fn(async ({ key }: { key: string }) => {
        used.set(key, (used.get(key) ?? 0) + 1);
        return { success: (used.get(key) ?? 0) <= 2 };
      }),
    };
    payCheckout.mockResolvedValue({ ok: false, error: 'no', checkout: view() });
    const from = (ip: string) => ({ 'cf-connecting-ip': ip });
    expect((await act(postForm(pay, from('203.0.113.1')))).status).toBe(422);
    expect((await act(postForm(pay, from('203.0.113.1')))).status).toBe(422);
    const third = await act(postForm(pay, from('203.0.113.1')));
    expect(third.status).toBe(429);
    expect(payCheckout).toHaveBeenCalledTimes(2);
    const keys = [...used.keys()];
    expect(keys.some((k) => k.startsWith('pay:checkout:chk_1:'))).toBe(true);
    expect(keys).toContain('pay:ip:203.0.113.1');
    // A different address is no help once the cookie's own budget is spent.
    expect((await act(postForm(pay, from('198.51.100.9')))).status).toBe(429);
  });
});

describe('Turnstile on Pay', () => {
  beforeEach(() => {
    env.TURNSTILE_SITE_KEY = '0x4AAAAAAAtest';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
  });

  it('asks Siteverify about the checkout_pay action on this host before anything else', async () => {
    const asked = siteverify({ success: true, hostname: 'shop.test', action: 'checkout_pay' });
    payCheckout.mockResolvedValue({
      ok: true,
      checkout: view({ status: 'completed', orderId: 'ord_1' }),
    });
    const r = await act(
      postForm({ ...pay, 'cf-turnstile-response': 'tok-1' }, { 'cf-connecting-ip': '203.0.113.7' }),
    );
    expect(r.status).toBe(303);
    expect(Object.fromEntries(asked[0]!)).toEqual({
      secret: 'turnstile-secret',
      response: 'tok-1',
      remoteip: '203.0.113.7',
    });
    expect(payCheckout).toHaveBeenCalledOnce();
  });

  it('refuses a missing token, another form’s token, another host’s and a failed one, writing nothing', async () => {
    siteverify({ success: true, hostname: 'shop.test', action: 'checkout_pay' });
    expect((await act(postForm(pay))).status).toBe(400);
    siteverify({ success: true, hostname: 'shop.test', action: 'login' });
    expect((await act(postForm({ ...pay, 'cf-turnstile-response': 't' }))).status).toBe(403);
    siteverify({ success: true, hostname: 'app.example', action: 'checkout_pay' });
    expect((await act(postForm({ ...pay, 'cf-turnstile-response': 't' }))).status).toBe(403);
    siteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect((await act(postForm({ ...pay, 'cf-turnstile-response': 't' }))).status).toBe(403);
    expect(updateCheckout).not.toHaveBeenCalled();
    expect(payCheckout).not.toHaveBeenCalled();
  });

  it('refuses everything when a site key has no secret, and says so without Turnstile’s words', async () => {
    delete env.TURNSTILE_SECRET_KEY;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await act(postForm({ ...pay, 'cf-turnstile-response': 't' }));
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.data)).not.toMatch(/Turnstile/i);
    expect(payCheckout).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('is not asked of an update, or of the bank’s confirmation', async () => {
    confirmCheckoutPayment.mockResolvedValue({
      ok: true,
      checkout: view({ status: 'completed', orderId: 'ord_1' }),
    });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await act(postForm({ intent: 'update', version: '3' }))).status).toBe(303);
    expect((await act(postForm({ intent: 'confirm' }))).status).toBe(303);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('the form', () => {
  const draw = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(
        createRoutesStub([
          {
            path: '/checkout/:id',
            Component: () =>
              createElement(CheckoutForm, {
                checkout: view() as never,
                testPayments: false,
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

  it('says "Card payment needs JavaScript" and has no way to pay without a script', () => {
    const html = draw({
      card: { publishableKey: 'pk_test_page', turnstileKey: null, answer: undefined },
    });
    expect(html).toContain('Card payment needs JavaScript');
    expect(html).not.toMatch(/>Pay \$/);
    expect(html).not.toContain('Place order');
    // The page's own version and total still travel with the form.
    expect(html).toMatch(/name="total"[^>]*value="200"|value="200"[^>]*name="total"/);
  });

  it('keeps the test-mode button where payments are only recorded, and the notice where no card can be taken', () => {
    expect(draw({ testPayments: true })).toContain('Place order (test mode)');
    expect(draw({ card: null })).toContain('Card payment isn’t set up here');
  });
});

describe('the Apple Pay domain file', () => {
  const ask = (method = 'GET') =>
    worker.fetch!(
      new Request('https://shop.test/.well-known/apple-developer-merchantid-domain-association', {
        method,
      }) as never,
    );

  it('serves the text the owner set, as plain text and briefly cached, and 404s when there is none', async () => {
    applePayDomainAssociation.mockResolvedValue('7B227073');
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('7B227073');
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    applePay.forgetApplePayFile();
    applePayDomainAssociation.mockResolvedValue(null);
    expect((await ask()).status).toBe(404);
  });

  it('asks the engine at most once in a few minutes', async () => {
    applePayDomainAssociation.mockResolvedValue('7B227073');
    await ask();
    await ask();
    expect(applePayDomainAssociation).toHaveBeenCalledTimes(1);
  });
});
