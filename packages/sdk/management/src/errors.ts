/**
 * What a failed Management request throws, and guards that narrow it to the error bodies a client
 * branches on. The api answers `{ error: { code, message, …details } }`; a refusal made before a
 * route runs (the 413, a request-rate 429) answers flat `{ code, message }`. Both are read here.
 */

/** The api's error object: a stable `code`, a human `message`, and per-code details. */
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly [detail: string]: unknown;
}

/**
 * A field a write was refused for (`validation_failed`): a dotted path into the body
 * (`altText.en-US`), `'(body)'` when the body as a whole is wrong, `''` for an entry as a whole.
 */
export interface FieldIssue {
  readonly field: string;
  readonly locale?: string;
  readonly message: string;
}

/** One entry field that links to an asset (`assets.usage`). */
export interface AssetLink {
  readonly fromEntryId: string;
  readonly fromField: string;
  readonly toId: string;
  readonly toType: 'Entry' | 'Asset';
}

/** A link that holds an asset, named the way a person recognises the entry. */
export interface AssetUsage extends AssetLink {
  readonly contentTypeApiId?: string;
  /** Absent when the entry has no title. */
  readonly entryTitle?: string;
}

export class ManagementError extends Error {
  /** The api's error code (`not_found`, `asset_in_use`, …); absent when the body had none. */
  readonly code?: string;
  /** The parsed error object, details included; absent when the body had none. */
  readonly error?: ApiError;

  constructor(
    readonly status: number,
    message: string,
    /** Response body, when the server returned one (JSON-parsed if possible). */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ManagementError';
    const error = apiErrorOf(body);
    if (error) {
      this.error = error;
      this.code = error.code;
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{ error: { code, message } }`, or the flat `{ code, message }` of a pre-route refusal. */
function apiErrorOf(body: unknown): ApiError | undefined {
  if (!isRecord(body)) return undefined;
  const candidate = isRecord(body.error) ? body.error : body;
  if (typeof candidate.code !== 'string') return undefined;
  return {
    ...candidate,
    code: candidate.code,
    message: typeof candidate.message === 'string' ? candidate.message : '',
  };
}

/** A {@link ManagementError} whose error object is `E`. */
export type ManagementErrorWith<E extends ApiError> = ManagementError & {
  readonly code: E['code'];
  readonly error: E;
};

const withCode = (err: unknown, ...codes: string[]): err is ManagementError & { error: ApiError } =>
  err instanceof ManagementError && err.error !== undefined && codes.includes(err.error.code);

export interface AssetInUse extends ApiError {
  readonly code: 'asset_in_use';
  /** The first 50 links. */
  readonly usage: readonly AssetUsage[];
  /** Every link, counted. */
  readonly total: number;
}

/** Deleting an asset entries still link to (409): `error.usage` names them, `error.total` counts. */
export function isAssetInUse(err: unknown): err is ManagementErrorWith<AssetInUse> {
  return (
    withCode(err, 'asset_in_use') &&
    Array.isArray(err.error.usage) &&
    typeof err.error.total === 'number'
  );
}

export type AssetRightsRefusal =
  | (ApiError & { readonly code: 'asset_embargoed'; readonly embargoUntil: string })
  | (ApiError & { readonly code: 'asset_expired'; readonly expiresAt: string });

/**
 * The asset's rights hold it back (409): under embargo until `error.embargoUntil`
 * (`asset_embargoed`), or expired at `error.expiresAt` (`asset_expired`). Publishing refuses with
 * it, and so does setting an embargo on a published asset.
 */
export function isAssetRightsError(err: unknown): err is ManagementErrorWith<AssetRightsRefusal> {
  if (!withCode(err, 'asset_embargoed', 'asset_expired')) return false;
  return err.error.code === 'asset_embargoed'
    ? typeof err.error.embargoUntil === 'string'
    : typeof err.error.expiresAt === 'string';
}

/** No such resource in this space and environment (404). */
export function isNotFound(
  err: unknown,
): err is ManagementErrorWith<ApiError & { code: 'not_found' }> {
  return withCode(err, 'not_found');
}

/**
 * A conflict with the resource's state (409 `conflict`): a value already taken, an
 * `expectedVersion` that moved on, a replace another commit beat. Re-read, then decide.
 */
export function isConflict(
  err: unknown,
): err is ManagementErrorWith<ApiError & { code: 'conflict' }> {
  return withCode(err, 'conflict');
}

export interface ValidationFailed extends ApiError {
  readonly code: 'validation_failed';
  readonly issues: readonly FieldIssue[];
}

/** The request was refused field by field (422): `error.issues` says which and why. */
export function isValidationError(err: unknown): err is ManagementErrorWith<ValidationFailed> {
  return withCode(err, 'validation_failed') && Array.isArray(err.error.issues);
}

export interface RateLimited extends ApiError {
  readonly code: 'rate_limited';
}

/** Too many requests, or an AI budget spent (429); retry later. */
export function isRateLimited(err: unknown): err is ManagementErrorWith<RateLimited> {
  return withCode(err, 'rate_limited');
}
