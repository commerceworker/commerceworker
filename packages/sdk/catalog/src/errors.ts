/**
 * What a failed request throws, all of it a `CatalogError`: an HTTP refusal is a `CatalogApiError`,
 * a request that never got an answer a `CatalogConnectionError` (or its `CatalogTimeoutError`).
 * Naming follows the Management and commerce clients: `<Surface>Error` for the base, `is…` guards
 * for narrowing. Catch with `isCatalogError(e)`, not `instanceof`: a program that loads both the
 * ESM and the CJS build has two copies of every class.
 *
 * The catalog edge refuses with `{ error }` (a 400 for a request that isn't canonical, a 404 for
 * what isn't published, a 503 while a listing rebuilds); `kind` is the stable thing to branch on.
 */

export type CatalogErrorKind =
  | 'bad_request'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'unknown'
  | 'connection'
  | 'timeout';

const BRAND = Symbol.for('commerceworker.catalog.error');

/** Any failure of this client: an HTTP refusal, a dropped connection or a timeout. */
export class CatalogError extends Error {
  /** The request id Cloudflare sent (`cf-ray`), for support. */
  readonly requestId?: string;
  readonly kind: CatalogErrorKind;
  readonly [BRAND] = true;

  constructor(
    message: string,
    kind: CatalogErrorKind,
    extra: { requestId?: string; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'CatalogError';
    this.kind = kind;
    this.requestId = extra.requestId;
  }
}

/** The request never got an answer (network down, connection reset). The original is `cause`. */
export class CatalogConnectionError extends CatalogError {
  constructor(
    message: string,
    extra: { cause?: unknown },
    kind: 'connection' | 'timeout' = 'connection',
  ) {
    super(message, kind, extra);
    this.name = 'CatalogConnectionError';
  }
}

/** The request outlived `timeoutMs`. A kind of connection error: the retry rules treat it alike. */
export class CatalogTimeoutError extends CatalogConnectionError {
  constructor(message: string, extra: { cause?: unknown }) {
    super(message, extra, 'timeout');
    this.name = 'CatalogTimeoutError';
  }
}

/** True for any failure of this client, from either build of the package. */
export function isCatalogError(err: unknown): err is CatalogError {
  return (
    typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[BRAND] === true
  );
}

/** True for an HTTP refusal (`status`, `body`); pass a `kind` to narrow further. */
export function isCatalogApiError(err: unknown, kind?: CatalogErrorKind): err is CatalogApiError {
  return (
    isCatalogError(err) &&
    typeof (err as { status?: unknown }).status === 'number' &&
    (kind === undefined || err.kind === kind)
  );
}

/** True for a request that got no answer, including a timeout. */
export function isCatalogConnectionError(err: unknown): err is CatalogConnectionError {
  return isCatalogError(err) && (err.kind === 'connection' || err.kind === 'timeout');
}

export interface CatalogErrorInit {
  readonly status: number;
  readonly message: string;
  /** The parsed response body, or its text when it wasn't JSON. */
  readonly body: unknown;
  readonly retryAfterSec?: number;
  readonly requestId?: string;
}

export class CatalogApiError extends CatalogError {
  readonly status: number;
  readonly body: unknown;
  /** On a 429 or a 503 that sent one: seconds to wait before retrying. */
  readonly retryAfterSec?: number;

  constructor(init: CatalogErrorInit, kind: CatalogErrorKind = kindOf(init.status)) {
    super(init.message, kind, { requestId: init.requestId });
    this.name = 'CatalogApiError';
    this.status = init.status;
    this.body = init.body;
    this.retryAfterSec = init.retryAfterSec;
  }
}

/** 400: the edge refused the request (the client checks first, so this is a version skew). */
export class CatalogBadRequestError extends CatalogApiError {
  override readonly name = 'CatalogBadRequestError';
}
/** 404: nothing is published there (a product, SKU, slug or category the channel doesn't hold). */
export class CatalogNotFoundError extends CatalogApiError {
  override readonly name = 'CatalogNotFoundError';
}
/** 429: over a rate limit; wait `retryAfterSec`. */
export class CatalogRateLimitError extends CatalogApiError {
  override readonly name = 'CatalogRateLimitError';
}

function kindOf(status: number): CatalogErrorKind {
  switch (status) {
    case 400:
      return 'bad_request';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'server' : 'unknown';
  }
}

const CLASSES: Partial<Record<CatalogErrorKind, new (init: CatalogErrorInit) => CatalogApiError>> =
  {
    bad_request: CatalogBadRequestError,
    not_found: CatalogNotFoundError,
    rate_limited: CatalogRateLimitError,
  };

/** `Retry-After` as seconds: a number of seconds or an HTTP date. */
export function retryAfterSec(header: string | null, nowMs = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** The error a response maps to. */
export function errorFor(status: number, body: unknown, headers: Headers): CatalogApiError {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const message =
    (typeof b.error === 'string' && b.error) ||
    (typeof body === 'string' && body.trim()) ||
    `Request failed with status ${status}`;
  const Cls = CLASSES[kindOf(status)] ?? CatalogApiError;
  return new Cls({
    status,
    message,
    body,
    retryAfterSec: retryAfterSec(headers.get('retry-after')),
    requestId: headers.get('cf-ray') || undefined,
  });
}
