/**
 * Domain errors. These are transport-agnostic; adapters (e.g. the HTTP API) map
 * them onto status codes. Each carries a stable `code` for clients.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** A referenced resource does not exist within the scope. */
export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('not_found', `${resource} "${id}" was not found`);
  }
}

/** A uniqueness or identity rule was violated (e.g. duplicate apiId). */
export class ConflictError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, details);
  }
}

/** A field value (or set of values) failed content-model validation. */
export class ValidationError extends DomainError {
  readonly issues: readonly FieldIssue[];
  constructor(issues: readonly FieldIssue[]) {
    super('validation_failed', 'One or more fields are invalid', issues);
    this.issues = issues;
  }
}

/** An operation was attempted that the entry's current status forbids. */
export class InvalidStateError extends DomainError {
  constructor(message: string) {
    super('invalid_state', message);
  }
}

/**
 * A field-level query matched more candidate rows than the store will pull
 * into memory to evaluate exactly (maps to HTTP 400). Reported instead of
 * silently truncating: a delivery client must never receive a partial result
 * that looks complete. Narrow with `content_type` or an additional filter.
 */
export class QueryTooBroadError extends DomainError {
  constructor(scanLimit: number) {
    super(
      'query_too_broad',
      `Query matched more than ${scanLimit} candidate entries to evaluate; narrow it with content_type, a more selective filter, or paginate with a cursor (sorting a large set requires narrowing it first)`,
      { scanLimit },
    );
  }
}

/** A per-space rate/budget ceiling was exceeded (maps to HTTP 429). */
export class RateLimitedError extends DomainError {
  readonly retryAfterSeconds?: number;
  constructor(message: string, retryAfterSeconds?: number) {
    super('rate_limited', message, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A registered hook refused the operation.
 *
 * Distinct from ValidationError: the content is well-formed, and something
 * policy-shaped (moderation, an external system, a governance rule) declined
 * it. The hook is named so an editor can tell "the CMS rejected this" from
 * "your integration rejected this".
 */
export class HookRejectedError extends DomainError {
  readonly hook: string;
  constructor(hook: string, reason: string) {
    super('hook_rejected', reason, { hook });
    this.hook = hook;
  }
}

/**
 * The operation needs an optional platform capability (a video host, an image
 * transformer) that this deployment has not bound. Maps to HTTP 501: the
 * request is well-formed, the server simply cannot serve it as configured.
 */
export class NotConfiguredError extends DomainError {
  readonly capability: string;
  constructor(capability: string, message: string) {
    super('not_configured', message, { capability });
    this.capability = capability;
  }
}

/**
 * A secret stored at rest cannot be opened: it was sealed under a key this
 * deployment no longer holds (neither DATA_KEY nor DATA_KEY_PREVIOUS), or the
 * stored value was altered. Never degraded to "not set" — an operator has to
 * see it. `context` names where the value lives, never the value.
 */
export class SecretUnreadableError extends DomainError {
  readonly context: string;
  constructor(context: string) {
    super(
      'secret_unreadable',
      `The secret at ${context} can't be decrypted with DATA_KEY or DATA_KEY_PREVIOUS`,
      { context },
    );
    this.context = context;
  }
}

export interface FieldIssue {
  /** Field apiId the issue applies to ("" for entry-level issues). */
  readonly field: string;
  /** Locale the issue applies to, if locale-specific. */
  readonly locale?: string;
  readonly message: string;
}
