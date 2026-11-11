import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CommerceApiError,
  type CommerceClientOptions,
  CommerceConflictError,
  CommerceConnectionError,
  CommerceError,
  CommerceForbiddenError,
  CommerceNotFoundError,
  CommerceRateLimitError,
  CommerceTimeoutError,
  CommerceUnauthorizedError,
  CommerceUnprocessableError,
  createCommerceClient,
  isCommerceApiError,
  isCommerceConnectionError,
  isCommerceError,
  type ListQuotesResult,
  OPERATIONS,
} from '../src/index.js';

type Call = { url: URL; init: RequestInit; headers: Headers };

/** A fetch that records each request and answers from `reply` (a body, or a Response). */
function fake(reply: (call: Call, n: number) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: new URL(String(input)),
      init: init ?? {},
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const out = reply(call, calls.length - 1);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// No retries unless a test asks: a refusal should surface at once.
const client = (f: typeof fetch, extra: Partial<CommerceClientOptions> = {}) =>
  createCommerceClient({
    baseUrl: 'https://app.test/',
    token: 'cmw_live_x',
    fetch: f,
    maxRetries: 0,
    ...extra,
  });

const refusal = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('request mapping', () => {
  it('sends a GET with a path param as a path, and the rest of the input as the query', async () => {
    const { fetchImpl, calls } = fake(() => ({ cart: { id: 'c 1' } }));
    await client(fetchImpl).getCart({ id: 'c 1' });
    const [c] = calls;
    expect(c?.init.method).toBe('GET');
    expect(c?.url.pathname).toBe('/api/v1/carts/c%201');
    expect(c?.url.search).toBe('');
    expect(c?.init.body).toBeUndefined();
    expect(c?.headers.get('authorization')).toBe('Bearer cmw_live_x');
  });

  it('puts a list GET input in the query: scalars, skipped undefined, repeated arrays', async () => {
    const { fetchImpl, calls } = fake(() => ({ orders: [], nextCursor: null }));
    await client(fetchImpl).listOrders({ status: 'running', limit: 5, q: undefined });
    expect(calls[0]?.url.pathname).toBe('/api/v1/orders');
    expect(calls[0]?.url.searchParams.toString()).toBe('status=running&limit=5');
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('sends a POST as JSON, with the path params taken out of the body', async () => {
    const { fetchImpl, calls } = fake(() => ({ cart: {} }));
    await client(fetchImpl).submitCart({ id: 'c1', cartVersion: 3 });
    const c = calls[0];
    expect(c?.init.method).toBe('POST');
    expect(c?.url.pathname).toBe('/api/v1/carts/c1/submit');
    expect(c?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(c?.init.body))).toEqual({ cartVersion: 3 });
  });

  it('makes a hosted checkout with a POST of its lines and returns its id and one-time link', async () => {
    const link = { id: 'chk_1', url: 'https://shop.test/checkout/start/chk_1/tok' };
    const { fetchImpl, calls } = fake(() => link);
    const made = await client(fetchImpl).createCheckout({
      lines: [{ sku: 'MON-27', qty: 1 }],
      buyer: { email: 'ada@example.com' },
      customerId: 'cus_1',
    });
    expect(made).toEqual(link);
    const [c] = calls;
    expect(c?.init.method).toBe('POST');
    expect(c?.url.pathname).toBe('/api/v1/checkouts');
    expect(JSON.parse(String(c?.init.body))).toEqual({
      lines: [{ sku: 'MON-27', qty: 1 }],
      buyer: { email: 'ada@example.com' },
      customerId: 'cus_1',
    });
  });

  it('sends nothing for a POST that takes no body', async () => {
    const { fetchImpl, calls } = fake(() => ({}));
    await client(fetchImpl).cancelCart({ id: 'c1' });
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[0]?.headers.get('content-type')).toBeNull();
  });

  it('sends a DELETE with its path param', async () => {
    const { fetchImpl, calls } = fake(() => ({}));
    await client(fetchImpl).revokeIntegration({ id: 'i1' });
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe('/api/v1/integrations/i1');
  });

  it('sends a file as the body as it is, with its media type and the rest as the query', async () => {
    const { fetchImpl, calls } = fake(() => ({ id: 'f1' }));
    await client(fetchImpl).importCatalogFeed({
      body: 'sku,title\nA,B\n',
      format: 'csv',
      name: 'spring',
    });
    expect(calls[0]?.init.body).toBe('sku,title\nA,B\n');
    expect(calls[0]?.headers.get('content-type')).toBe('text/csv');
    expect(calls[0]?.url.search).toBe('?format=csv&name=spring');
  });

  it('call(operationId) is the typed method with the name filled in', async () => {
    const { fetchImpl, calls } = fake(() => ({ cart: {} }));
    await client(fetchImpl).call('get_cart', { id: 'c1' });
    expect(calls[0]?.url.pathname).toBe('/api/v1/carts/c1');
  });

  it('refuses a missing path param and an unknown operation before sending anything', async () => {
    const { fetchImpl, calls } = fake(() => ({}));
    const c = client(fetchImpl);
    // @ts-expect-error `id` is required
    await expect(c.getCart({})).rejects.toThrow('get_cart needs "id"');
    // @ts-expect-error not an operation
    await expect(c.call('nope')).rejects.toThrow('Unknown operation');
    expect(calls).toHaveLength(0);
  });

  it('has a method for every operation in the table', () => {
    const c = client(fake(() => ({})).fetchImpl) as unknown as Record<string, unknown>;
    for (const id of Object.keys(OPERATIONS)) {
      const name = id.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
      expect(typeof c[name], name).toBe('function');
    }
  });

  it('leaves out signed receivers: a provider calls those, not a token', () => {
    expect(OPERATIONS).not.toHaveProperty('receive_stripe_webhook');
    expect(OPERATIONS).not.toHaveProperty('receive_order_event');
  });
});

describe('idempotency', () => {
  it('sends the key as Idempotency-Key on an operation that honors one', async () => {
    const { fetchImpl, calls } = fake(() => ({ orderId: 'o1' }));
    await client(fetchImpl).startOrder(
      { flowId: 'f', input: { model: 'b2c' } },
      { idempotencyKey: 'order-42' },
    );
    expect(calls[0]?.headers.get('idempotency-key')).toBe('order-42');
  });

  it('throws on an operation that would ignore it', async () => {
    const { fetchImpl, calls } = fake(() => ({}));
    await expect(
      client(fetchImpl).cancelCart({ id: 'c1' }, { idempotencyKey: 'k' }),
    ).rejects.toThrow('cancel_cart does not take an idempotency key');
    expect(calls).toHaveLength(0);
  });

  it('sends extra headers, such as If-Match', async () => {
    const { fetchImpl, calls } = fake(() => ({ cart: {} }));
    await client(fetchImpl).submitCart({ id: 'c1' }, { headers: { 'If-Match': '"3"' } });
    expect(calls[0]?.headers.get('if-match')).toBe('"3"');
  });
});

describe('errors', () => {
  const cases: [number, string, new (...a: never[]) => CommerceApiError][] = [
    [401, 'unauthorized', CommerceUnauthorizedError],
    [403, 'forbidden', CommerceForbiddenError],
    [404, 'not_found', CommerceNotFoundError],
    [409, 'conflict', CommerceConflictError],
    [422, 'unprocessable', CommerceUnprocessableError],
    [429, 'rate_limited', CommerceRateLimitError],
  ];
  for (const [status, kind, Cls] of cases) {
    it(`maps ${status} to ${kind}`, async () => {
      const { fetchImpl } = fake(() => refusal(status, { error: `nope ${status}` }));
      const err = await client(fetchImpl)
        .getCart({ id: 'c1' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Cls);
      expect(err).toBeInstanceOf(CommerceApiError);
      expect(err).toMatchObject({
        status,
        kind,
        message: `nope ${status}`,
        operationId: 'get_cart',
      });
    });
  }

  it('carries the issues of a 400 and the body it answered', async () => {
    const issues = [{ path: ['qty'], message: 'Expected number' }];
    const { fetchImpl } = fake(() => refusal(400, { error: 'Invalid cart', issues }));
    const err = (await client(fetchImpl)
      .createCart({ flowId: 'f', title: 'x' })
      .catch((e: unknown) => e)) as CommerceApiError;
    expect(err.kind).toBe('bad_request');
    expect(err.issues).toEqual(issues);
    expect(err.body).toEqual({ error: 'Invalid cart', issues });
  });

  it('reads Retry-After as seconds, from a number or a date', async () => {
    const seconds = fake(() => refusal(429, { error: 'Too many' }, { 'retry-after': '60' }));
    const a = (await client(seconds.fetchImpl)
      .listOrders()
      .catch((e: unknown) => e)) as CommerceRateLimitError;
    expect(a.retryAfterSec).toBe(60);

    const date = new Date(Date.now() + 30_000).toUTCString();
    const dated = fake(() => refusal(429, { error: 'Too many' }, { 'retry-after': date }));
    const b = (await client(dated.fetchImpl)
      .listOrders()
      .catch((e: unknown) => e)) as CommerceRateLimitError;
    expect(b.retryAfterSec).toBeGreaterThan(25);
    expect(b.retryAfterSec).toBeLessThanOrEqual(30);
  });

  it('reads a flat { code, message } refusal and a non-JSON failure', async () => {
    const flat = fake(() => refusal(413, { code: 'too_large', message: 'Body too large' }));
    await expect(client(flat.fetchImpl).listOrders()).rejects.toMatchObject({
      status: 413,
      kind: 'unknown',
      message: 'Body too large',
    });
    const text = fake(() => new Response('upstream down', { status: 502 }));
    await expect(client(text.fetchImpl).listOrders()).rejects.toMatchObject({
      status: 502,
      kind: 'server',
      message: 'upstream down',
    });
  });
});

describe('pagination', () => {
  const page = (rows: string[], cursor: string | null) => ({
    quotes: rows.map((id) => ({ id })),
    cursor,
  });

  it('follows the cursor to the last page and yields every item', async () => {
    const pages = [page(['q1', 'q2'], 'c2'), page(['q3'], 'c3'), page(['q4'], null)];
    const { fetchImpl, calls } = fake((_c, n) => pages[n]);
    const ids: string[] = [];
    for await (const q of client(fetchImpl).paginate('list_quotes', { status: 'sent' }))
      ids.push((q as { id: string }).id);
    expect(ids).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(calls.map((c) => c.url.searchParams.get('cursor'))).toEqual([null, 'c2', 'c3']);
    // The filter rides along on every page.
    expect(calls.every((c) => c.url.searchParams.get('status') === 'sent')).toBe(true);
  });

  it('starts from a cursor the caller gives, and pages() yields whole results', async () => {
    const { fetchImpl, calls } = fake((_c, n) =>
      n === 0 ? page(['q1'], 'c9') : page(['q2'], null),
    );
    const results = [];
    for await (const r of client(fetchImpl).pages('list_quotes', { cursor: 'c1' })) results.push(r);
    expect(results).toHaveLength(2);
    expect(calls[0]?.url.searchParams.get('cursor')).toBe('c1');
  });

  it('reads list_orders by its nextCursor', async () => {
    const { fetchImpl, calls } = fake((_c, n) =>
      n === 0
        ? { orders: [{ id: 'a' }], nextCursor: 'n1' }
        : { orders: [{ id: 'b' }], nextCursor: null },
    );
    const ids: unknown[] = [];
    for await (const o of client(fetchImpl).paginate('list_orders')) ids.push(o);
    expect(ids).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(calls[1]?.url.searchParams.get('cursor')).toBe('n1');
  });

  it('stops when a page repeats its own cursor rather than looping', async () => {
    const { fetchImpl, calls } = fake(() => page(['q1'], 'same'));
    const out = [];
    for await (const q of client(fetchImpl).paginate('list_quotes', { cursor: 'same' }))
      out.push(q);
    expect(calls).toHaveLength(1);
    expect(out).toHaveLength(1);
  });

  it('surfaces an error from a later page', async () => {
    const { fetchImpl } = fake((_c, n) =>
      n === 0 ? page(['q1'], 'c2') : refusal(403, { error: 'no' }),
    );
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const q of client(fetchImpl).paginate('list_quotes')) seen.push(q);
      })(),
    ).rejects.toBeInstanceOf(CommerceForbiddenError);
    expect(seen).toHaveLength(1);
  });
});

describe('types', () => {
  it('types inputs and results from the OpenAPI document', () => {
    const c = client(fake(() => ({})).fetchImpl);
    expectTypeOf(c.listQuotes).returns.resolves.toEqualTypeOf<ListQuotesResult>();
    // A required path param is required; an all-optional input may be left out.
    expectTypeOf(c.getCart).parameter(0).toHaveProperty('id');
    expectTypeOf(c.listOrders).parameters.toMatchTypeOf<[input?: object, options?: object]>();
    expectTypeOf(c.paginate<'list_quotes'>).returns.toMatchTypeOf<
      AsyncGenerator<ListQuotesResult['quotes'][number], void, undefined>
    >();
  });
});

describe('method names', () => {
  // Renaming an operationId renames a published method: this list changes only on purpose.
  it('are the flat camelCase of every operationId', () => {
    const c = client(fake(() => ({})).fetchImpl) as unknown as Record<string, unknown>;
    const names = Object.keys(c)
      .filter((k) => !['call', 'pages', 'paginate'].includes(k))
      .sort();
    expect(names).toMatchSnapshot();
  });
});

describe('request ids', () => {
  it('reads x-request-id, then cf-ray, on an API error', async () => {
    const a = fake(() =>
      refusal(404, { error: 'x' }, { 'x-request-id': 'req_1', 'cf-ray': 'ray' }),
    );
    await expect(client(a.fetchImpl).getCart({ id: 'c' })).rejects.toMatchObject({
      requestId: 'req_1',
    });
    const b = fake(() => refusal(500, { error: 'x' }, { 'cf-ray': 'ray-9' }));
    await expect(client(b.fetchImpl).getCart({ id: 'c' })).rejects.toMatchObject({
      requestId: 'ray-9',
    });
    const c = fake(() => refusal(500, { error: 'x' }));
    await expect(client(c.fetchImpl).getCart({ id: 'c' })).rejects.toMatchObject({
      requestId: undefined,
    });
  });
});

describe('connection failures', () => {
  it('wraps a network failure, keeping the original as cause', async () => {
    const boom = new TypeError('fetch failed');
    const f = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;
    const err = await client(f)
      .getCart({ id: 'c' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommerceConnectionError);
    expect(err).toBeInstanceOf(CommerceError);
    expect(err).toMatchObject({ kind: 'connection', cause: boom, operationId: 'get_cart' });
    expect(isCommerceConnectionError(err)).toBe(true);
    expect(isCommerceApiError(err)).toBe(false);
  });

  it('times out with a CommerceTimeoutError, from the client or the call', async () => {
    const hang = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init?.signal?.addEventListener('abort', () =>
            rej(new DOMException('aborted', 'AbortError')),
          ),
        ),
    ) as unknown as typeof fetch;
    const err = await client(hang, { timeoutMs: 10 })
      .getCart({ id: 'c' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommerceTimeoutError);
    expect(err).toBeInstanceOf(CommerceConnectionError);
    expect(err).toMatchObject({ kind: 'timeout' });
    expect((err as CommerceError).cause).toBeInstanceOf(DOMException);
    const perCall = await client(hang)
      .getCart({ id: 'c' }, { timeoutMs: 10 })
      .catch((e: unknown) => e);
    expect(perCall).toBeInstanceOf(CommerceTimeoutError);
  });

  it('rethrows the caller’s own abort untouched and does not retry it', async () => {
    const ctl = new AbortController();
    const f = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init?.signal?.addEventListener('abort', () => rej(init.signal?.reason)),
        ),
    ) as unknown as typeof fetch;
    const p = client(f, { maxRetries: 3 }).getCart({ id: 'c' }, { signal: ctl.signal });
    ctl.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('retries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const run = async <T>(p: Promise<T>) => {
    // Settle the promise's rejection into the result so fake timers can drive the waits.
    const settled = p.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await vi.runAllTimersAsync();
    return settled;
  };

  it('retries a GET on 5xx, 429 and a dropped connection, then returns the answer', async () => {
    vi.useFakeTimers();
    const steps = [
      refusal(503, { error: 'down' }),
      refusal(429, { error: 'slow' }),
      { cart: { id: 'c' } },
    ];
    const { fetchImpl, calls } = fake((_c, n) => steps[n]);
    const out = await run(client(fetchImpl, { maxRetries: 2 }).getCart({ id: 'c' }));
    expect(out).toEqual({ ok: true, v: { cart: { id: 'c' } } });
    expect(calls).toHaveLength(3);

    let n = 0;
    const flaky = vi.fn(async () => {
      if (n++ === 0) throw new TypeError('reset');
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect((await run(client(flaky, { maxRetries: 1 }).getCart({ id: 'c' }))).ok).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and throws the last error; 0 disables retries', async () => {
    vi.useFakeTimers();
    const a = fake(() => refusal(500, { error: 'down' }));
    const out = await run(client(a.fetchImpl, { maxRetries: 2 }).getCart({ id: 'c' }));
    expect(out).toMatchObject({ ok: false, e: { status: 500 } });
    expect(a.calls).toHaveLength(3);
    const b = fake(() => refusal(500, { error: 'down' }));
    await run(client(b.fetchImpl, { maxRetries: 0 }).getCart({ id: 'c' }));
    expect(b.calls).toHaveLength(1);
    const c = fake(() => refusal(500, { error: 'down' }));
    await run(client(c.fetchImpl, { maxRetries: 0 }).getCart({ id: 'c' }, { maxRetries: 1 }));
    expect(c.calls).toHaveLength(2);
  });

  it('defaults to 2 retries', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fake(() => refusal(502, { error: 'bad gateway' }));
    await run(
      createCommerceClient({ baseUrl: 'https://app.test', token: 't', fetch: fetchImpl }).getCart({
        id: 'c',
      }),
    );
    expect(calls).toHaveLength(3);
  });

  it('never retries a 4xx other than 429', async () => {
    vi.useFakeTimers();
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const { fetchImpl, calls } = fake(() => refusal(status, { error: 'no' }));
      await run(client(fetchImpl, { maxRetries: 3 }).getCart({ id: 'c' }));
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('does not resend a write without an idempotency key, but does with one', async () => {
    vi.useFakeTimers();
    const plain = fake(() => refusal(503, { error: 'down' }));
    await run(client(plain.fetchImpl, { maxRetries: 2 }).submitCart({ id: 'c' }));
    expect(plain.calls).toHaveLength(1);

    const dropped = vi.fn(async () => {
      throw new TypeError('reset');
    }) as unknown as typeof fetch;
    await run(client(dropped, { maxRetries: 2 }).createCart({ flowId: 'f', title: 't' }));
    expect(dropped).toHaveBeenCalledTimes(1);

    const keyed = fake((_c, n) => (n === 0 ? refusal(503, { error: 'down' }) : { orderId: 'o1' }));
    const out = await run(
      client(keyed.fetchImpl, { maxRetries: 2 }).startOrder(
        { flowId: 'f', input: { model: 'b2c' } },
        { idempotencyKey: 'k1' },
      ),
    );
    expect(out).toEqual({ ok: true, v: { orderId: 'o1' } });
    expect(keyed.calls.map((c) => c.headers.get('idempotency-key'))).toEqual(['k1', 'k1']);
  });

  it('retries a DELETE', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fake((_c, n) => (n === 0 ? refusal(500, { error: 'x' }) : {}));
    await run(client(fetchImpl, { maxRetries: 1 }).revokeIntegration({ id: 'i' }));
    expect(calls).toHaveLength(2);
  });

  it('backs off exponentially with jitter, and waits at least Retry-After', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1); // the longest jitter, so the step is exact
    const waits: number[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const { fetchImpl } = fake(() => refusal(503, { error: 'down' }));
    await run(client(fetchImpl, { maxRetries: 3 }).getCart({ id: 'c' }));
    for (const c of spy.mock.calls) waits.push(Number(c[1]));
    expect(waits).toEqual([500, 1000, 2000]);

    vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter wait at all
    spy.mockClear();
    const ra = fake((_c, n) =>
      n === 0 ? refusal(429, { error: 'slow' }, { 'retry-after': '7' }) : { cart: {} },
    );
    await run(client(ra.fetchImpl, { maxRetries: 1 }).getCart({ id: 'c' }));
    expect(spy.mock.calls.map((c) => Number(c[1]))).toEqual([7000]);
  });

  it('does not wait out a Retry-After over a minute: it throws', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fake(() =>
      refusal(429, { error: 'slow' }, { 'retry-after': '3600' }),
    );
    const out = await run(client(fetchImpl, { maxRetries: 2 }).getCart({ id: 'c' }));
    expect(out).toMatchObject({ ok: false, e: { kind: 'rate_limited', retryAfterSec: 3600 } });
    expect(calls).toHaveLength(1);
  });
});

describe('isCommerceError and isCommerceApiError', () => {
  it('recognise every failure by brand and kind, not by class', async () => {
    const { fetchImpl } = fake(() => refusal(404, { error: 'x' }));
    const api = await client(fetchImpl)
      .getCart({ id: 'c' })
      .catch((e: unknown) => e);
    expect(isCommerceError(api)).toBe(true);
    expect(isCommerceApiError(api)).toBe(true);
    expect(isCommerceApiError(api, 'not_found')).toBe(true);
    expect(isCommerceApiError(api, 'conflict')).toBe(false);

    // The other build of the package has its own classes, so `instanceof` fails across them; the
    // brand is a global symbol, so it doesn't.
    const foreign = Object.assign(Object.create(null), {
      [Symbol.for('commerceworker.commerce.error')]: true,
      kind: 'conflict',
      status: 409,
    });
    expect(foreign instanceof CommerceError).toBe(false);
    expect(isCommerceError(foreign)).toBe(true);
    expect(isCommerceApiError(foreign, 'conflict')).toBe(true);

    for (const other of [
      new Error('x'),
      null,
      undefined,
      'x',
      { kind: 'not_found', status: 404 },
    ]) {
      expect(isCommerceError(other)).toBe(false);
      expect(isCommerceApiError(other)).toBe(false);
    }
  });
});
