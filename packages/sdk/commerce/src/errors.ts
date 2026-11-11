/**
 * What a failed request throws, all of it a `CommerceError`: an HTTP refusal is a
 * `CommerceApiError`, a request that never got an answer a `CommerceConnectionError` (or its
 * `CommerceTimeoutError`). Naming follows the Management client (`ManagementError`): `<Surface>Error`
 * for the base, `is…` guards for narrowing. Catch with `isCommerceError(e)`, not `instanceof`: a
 * program that loads both the ESM and the CJS build has two copies of every class.
 *
 * What a refusal carries. The REST API refuses with `{ error, issues? }` (a refusal made
 * before a route runs, like the body-size 413, may answer `{ code, message }`); both are read here.
 * `kind` is the stable thing to branch on, and the subclasses narrow it for `instanceof`.
 */

export type CommerceErrorKind =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unprocessable'
  | 'rate_limited'
  | 'server'
  | 'unknown'
  | 'connection'
  | 'timeout';

const BRAND = Symbol.for('commerceworker.commerce.error');

/** Any failure of this client: an HTTP refusal, a dropped connection or a timeout. */
export class CommerceError extends Error {
  /** The request id the server (or Cloudflare) sent, for support: `x-request-id`, else `cf-ray`. */
  readonly requestId?: string;
  readonly kind: CommerceErrorKind;
  readonly operationId?: string;
  readonly [BRAND] = true;

  constructor(
    message: string,
    kind: CommerceErrorKind,
    extra: { requestId?: string; operationId?: string; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'CommerceError';
    this.kind = kind;
    this.requestId = extra.requestId;
    this.operationId = extra.operationId;
  }
}

/** The request never got an answer (network down, connection reset). The original is `cause`. */
export class CommerceConnectionError extends CommerceError {
  constructor(
    message: string,
    extra: { operationId?: string; cause?: unknown },
    kind: 'connection' | 'timeout' = 'connection',
  ) {
    super(message, kind, extra);
    this.name = 'CommerceConnectionError';
  }
}

/** The request outlived `timeoutMs`. A kind of connection error: the retry rules treat it alike. */
export class CommerceTimeoutError extends CommerceConnectionError {
  constructor(message: string, extra: { operationId?: string; cause?: unknown }) {
    super(message, extra, 'timeout');
    this.name = 'CommerceTimeoutError';
  }
}

/** True for any failure of this client, from either build of the package. */
export function isCommerceError(err: unknown): err is CommerceError {
  return (
    typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[BRAND] === true
  );
}

/** True for an HTTP refusal (`status`, `issues`, `retryAfterSec`); pass a `kind` to narrow further. */
export function isCommerceApiError(
  err: unknown,
  kind?: CommerceErrorKind,
): err is CommerceApiError {
  return (
    isCommerceError(err) &&
    typeof (err as { status?: unknown }).status === 'number' &&
    (kind === undefined || err.kind === kind)
  );
}

/** True for a request that got no answer, including a timeout. */
export function isCommerceConnectionError(err: unknown): err is CommerceConnectionError {
  return isCommerceError(err) && (err.kind === 'connection' || err.kind === 'timeout');
}

export interface CommerceErrorInit {
  readonly status: number;
  readonly message: string;
  /** The parsed response body, or its text when it wasn't JSON. */
  readonly body: unknown;
  readonly issues?: readonly unknown[];
  readonly retryAfterSec?: number;
  readonly operationId?: string;
  readonly requestId?: string;
}

export class CommerceApiError extends CommerceError {
  readonly status: number;
  readonly body: unknown;
  /** One entry per invalid field, when the refusal listed them (`path` and `message` each). */
  readonly issues: readonly unknown[];
  /** On a 429 (and a 503 that sent one): seconds to wait before retrying. */
  readonly retryAfterSec?: number;

  constructor(init: CommerceErrorInit, kind: CommerceErrorKind = kindOf(init.status)) {
    super(init.message, kind, { requestId: init.requestId, operationId: init.operationId });
    this.name = 'CommerceApiError';
    this.status = init.status;
    this.body = init.body;
    this.issues = init.issues ?? [];
    this.retryAfterSec = init.retryAfterSec;
  }
}

export class CommerceBadRequestError extends CommerceApiError {
  override readonly name = 'CommerceBadRequestError';
}
/** 401: a missing, wrong, revoked or expired token. */
export class CommerceUnauthorizedError extends CommerceApiError {
  override readonly name = 'CommerceUnauthorizedError';
}
/** 403: the token's role is too low for the operation. */
export class CommerceForbiddenError extends CommerceApiError {
  override readonly name = 'CommerceForbiddenError';
}
export class CommerceNotFoundError extends CommerceApiError {
  override readonly name = 'CommerceNotFoundError';
}
/** 409: the order, flow or record can't do that now. */
export class CommerceConflictError extends CommerceApiError {
  override readonly name = 'CommerceConflictError';
}
/** 422: understood and refused (an idempotency key reused with a different request, say). */
export class CommerceUnprocessableError extends CommerceApiError {
  override readonly name = 'CommerceUnprocessableError';
}
/** 429: over the caller's requests a minute; wait `retryAfterSec`. */
export class CommerceRateLimitError extends CommerceApiError {
  override readonly name = 'CommerceRateLimitError';
}

function kindOf(status: number): CommerceErrorKind {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'unprocessable';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'server' : 'unknown';
  }
}

const CLASSES: Partial<
  Record<CommerceErrorKind, new (init: CommerceErrorInit) => CommerceApiError>
> = {
  bad_request: CommerceBadRequestError,
  unauthorized: CommerceUnauthorizedError,
  forbidden: CommerceForbiddenError,
  not_found: CommerceNotFoundError,
  conflict: CommerceConflictError,
  unprocessable: CommerceUnprocessableError,
  rate_limited: CommerceRateLimitError,
};

/** `Retry-After` as seconds: a number of seconds or an HTTP date. */
export function retryAfterSec(header: string | null, nowMs = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** `x-request-id`, else Cloudflare's `cf-ray`. */
export const requestIdOf = (headers: Headers): string | undefined =>
  headers.get('x-request-id') || headers.get('cf-ray') || undefined;

/** The error a response maps to. */
export function errorFor(
  status: number,
  body: unknown,
  headers: Headers,
  operationId?: string,
): CommerceApiError {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const message =
    (typeof b.error === 'string' && b.error) ||
    (typeof b.message === 'string' && b.message) ||
    (typeof body === 'string' && body.trim()) ||
    `Request failed with status ${status}`;
  const init: CommerceErrorInit = {
    status,
    message,
    body,
    issues: Array.isArray(b.issues) ? b.issues : undefined,
    retryAfterSec: retryAfterSec(headers.get('retry-after')),
    operationId,
    requestId: requestIdOf(headers),
  };
  const Cls = CLASSES[kindOf(status)] ?? CommerceApiError;
  return new Cls(init);
}
