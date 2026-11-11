import {
  CommerceConnectionError,
  CommerceTimeoutError,
  errorFor,
  isCommerceApiError,
  isCommerceConnectionError,
} from './errors.js';
import {
  OPERATIONS,
  type OperationId,
  type OperationSpec,
  type OperationTypes,
  PAGINATION,
} from './generated/operations.js';

export interface CommerceClientOptions {
  /** The workspace's host, e.g. `https://app.your-workspace.commerceworker.com` (no `/api/v1`). */
  readonly baseUrl: string;
  /** An API token (`cmw_live_…`). Keep it on a server. */
  readonly token: string;
  /** Inject a fetch (a Worker's service binding, a test); defaults to the global one. */
  readonly fetch?: typeof fetch;
  /** Give up on a request after this long (each attempt), with a `CommerceTimeoutError`. Default: never. */
  readonly timeoutMs?: number;
  /**
   * How often to resend a request that failed with a 429, a 5xx or a connection error. Default 2;
   * 0 turns retries off. Only a GET, a DELETE or a write sent with an `idempotencyKey` is resent:
   * anything else may already have happened. Waits grow exponentially with jitter, and a
   * `Retry-After` is honored (one over a minute is not waited for: the error is thrown).
   */
  readonly maxRetries?: number;
}

export interface CallOptions {
  /**
   * Makes the write happen once however often it is sent: a repeat with the same key and request
   * returns the first answer. Only operations that document an `Idempotency-Key` take one
   * (`startOrder`); the others throw rather than pretend.
   */
  readonly idempotencyKey?: string;
  /** Extra request headers, e.g. `If-Match` for `submitCart`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Aborts the request; the abort error is thrown as it is and never retried. */
  readonly signal?: AbortSignal;
  /** Overrides the client's `timeoutMs` for this call. */
  readonly timeoutMs?: number;
  /** Overrides the client's `maxRetries` for this call. */
  readonly maxRetries?: number;
}

export type OperationInput<K extends OperationId> = OperationTypes[K]['input'];
export type OperationResult<K extends OperationId> = OperationTypes[K]['result'];
export type PagedOperationId = keyof typeof PAGINATION;

/** An input with no required field may be left out. */
type Args<K extends OperationId> =
  Partial<OperationInput<K>> extends OperationInput<K>
    ? [input?: OperationInput<K>, options?: CallOptions]
    : [input: OperationInput<K>, options?: CallOptions];

/** What one page of a paging operation holds. */
export type PageItem<K extends PagedOperationId> =
  OperationResult<K> extends Record<(typeof PAGINATION)[K]['items'], readonly (infer I)[]>
    ? I
    : unknown;

type CamelCase<S extends string> = S extends `${infer A}_${infer B}`
  ? `${A}${Capitalize<CamelCase<B>>}`
  : S;

/** One method per operation (`list_orders` is `listOrders`), plus the generic entry points. */
export type CommerceClient = {
  [K in OperationId as CamelCase<K>]: (...args: Args<K>) => Promise<OperationResult<K>>;
} & {
  /** Any operation by its `operationId`; the typed methods are this with the name filled in. */
  call<K extends OperationId>(operationId: K, ...args: Args<K>): Promise<OperationResult<K>>;
  /** Every page of a cursor-paged list operation, one result per request. */
  pages<K extends PagedOperationId>(
    operationId: K,
    input?: OperationInput<K>,
    options?: CallOptions,
  ): AsyncGenerator<OperationResult<K>, void, undefined>;
  /** Every item of a cursor-paged list operation, requesting the next page as you go. */
  paginate<K extends PagedOperationId>(
    operationId: K,
    input?: OperationInput<K>,
    options?: CallOptions,
  ): AsyncGenerator<PageItem<K>, void, undefined>;
};

const camel = (id: string) => id.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function appendQuery(params: URLSearchParams, name: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) for (const v of value) appendQuery(params, name, v);
  else params.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Full jitter: anywhere up to the exponential step, so retrying clients spread out. */
const backoffMs = (attempt: number) =>
  Math.random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);

export function createCommerceClient(options: CommerceClientOptions): CommerceClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call(
    operationId: OperationId,
    input: Record<string, unknown> = {},
    opts: CallOptions = {},
  ): Promise<unknown> {
    const spec: OperationSpec | undefined = OPERATIONS[operationId];
    if (!spec) throw new TypeError(`Unknown operation "${operationId}"`);
    if (opts.idempotencyKey !== undefined && !('idempotent' in spec))
      throw new TypeError(`${operationId} does not take an idempotency key`);

    const rest: Record<string, unknown> = { ...input };
    let path = spec.path;
    for (const name of spec.pathParams) {
      const value = rest[name];
      if (value === undefined || value === null || value === '')
        throw new TypeError(`${operationId} needs "${name}"`);
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
      delete rest[name];
    }

    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${options.token}`,
    });
    let body: string | undefined;
    if (spec.input === 'body') {
      body = JSON.stringify(rest);
      headers.set('content-type', 'application/json');
    } else if (spec.input === 'raw') {
      body = String(rest.body ?? '');
      headers.set('content-type', String(rest.contentType ?? spec.contentTypes?.[0]));
      delete rest.body;
      delete rest.contentType;
    }
    const query = new URLSearchParams();
    if (spec.input === 'query' || spec.input === 'raw')
      for (const [k, v] of Object.entries(rest)) appendQuery(query, k, v);
    if (opts.idempotencyKey !== undefined) headers.set('idempotency-key', opts.idempotencyKey);
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);

    const qs = query.toString();
    const url = `${base}${path}${qs ? `?${qs}` : ''}`;
    const timeoutMs = opts.timeoutMs ?? options.timeoutMs;
    const maxRetries = opts.maxRetries ?? options.maxRetries ?? 2;
    // A write that may already have happened is only resent when its key makes that safe.
    const resendable =
      spec.method === 'GET' || spec.method === 'DELETE' || opts.idempotencyKey !== undefined;

    for (let attempt = 0; ; attempt++) {
      let failure: unknown;
      let waitMs: number | undefined;
      try {
        return await attemptOnce(
          operationId,
          url,
          { method: spec.method, headers, body },
          opts.signal,
          timeoutMs,
        );
      } catch (err) {
        failure = err;
        if (isCommerceApiError(err)) {
          if (err.status !== 429 && err.status < 500) throw err;
          if (err.retryAfterSec !== undefined) {
            if (err.retryAfterSec * 1000 > MAX_RETRY_AFTER_MS) throw err;
            waitMs = err.retryAfterSec * 1000;
          }
        } else if (!isCommerceConnectionError(err)) throw err;
      }
      if (!resendable || attempt >= maxRetries) throw failure;
      await sleep(waitMs ?? backoffMs(attempt));
    }
  }

  /** One request, its failures as `CommerceError`s. A caller's abort is rethrown untouched. */
  async function attemptOnce(
    operationId: string,
    url: string,
    init: { method: string; headers: Headers; body: string | undefined },
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      const parsed = await readBody(res);
      if (!res.ok) throw errorFor(res.status, parsed, res.headers, operationId);
      return parsed;
    } catch (err) {
      if (isCommerceApiError(err)) throw err;
      if (timedOut)
        throw new CommerceTimeoutError(`${operationId} timed out after ${timeoutMs}ms`, {
          operationId,
          cause: err,
        });
      if (signal?.aborted) throw err;
      throw new CommerceConnectionError(
        `${operationId} failed: ${err instanceof Error ? err.message : String(err)}`,
        { operationId, cause: err },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function* pages(
    operationId: PagedOperationId,
    input: Record<string, unknown> = {},
    opts?: CallOptions,
  ): AsyncGenerator<unknown, void, undefined> {
    const paging = PAGINATION[operationId];
    let cursor = input[paging.param];
    do {
      const page = (await call(operationId, { ...input, [paging.param]: cursor }, opts)) as
        | Record<string, unknown>
        | undefined;
      yield page;
      const next = page?.[paging.next];
      cursor = typeof next === 'string' && next && next !== cursor ? next : undefined;
    } while (cursor !== undefined);
  }

  async function* paginate(
    operationId: PagedOperationId,
    input?: Record<string, unknown>,
    opts?: CallOptions,
  ): AsyncGenerator<unknown, void, undefined> {
    const items = PAGINATION[operationId].items;
    for await (const page of pages(operationId, input, opts)) {
      const list = (page as Record<string, unknown> | undefined)?.[items];
      if (Array.isArray(list)) yield* list;
    }
  }

  const client: Record<string, unknown> = { call, pages, paginate };
  for (const id of Object.keys(OPERATIONS) as OperationId[])
    client[camel(id)] = (input?: Record<string, unknown>, opts?: CallOptions) =>
      call(id, input, opts);
  return client as CommerceClient;
}
