/**
 * Keeps credentials out of log streams.
 *
 * Returning a generic error body to the caller is only half the job: the
 * message still reaches `console.error`, and logs get shipped to an aggregator
 * that must never hold a live password. Provider errors are the usual culprit —
 * database and HTTP clients routinely quote the whole connection URL back.
 *
 * **Zero dependencies and no platform APIs on purpose.** The natural home would
 * be `@commerceworker/telemetry`, but keeping this dependency-free lets any
 * package use it, and it runs unchanged on Node and in workerd.
 *
 * This is defence in depth, not a licence to log secrets deliberately. Redact
 * at the point of logging; never construct a log line from a credential and
 * rely on this to clean it up.
 */

/** Replacement for any redacted span. */
const MASK = '***';

/**
 * `scheme://user:password@host` → `scheme://user:***@host`.
 *
 * The user and host survive because they are what make a log line diagnosable —
 * knowing *which* database refused the connection is the whole point of logging
 * it.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/gi,
    (_match, scheme: string, user: string) => `${scheme}${user}:${MASK}@`,
  );
}

/**
 * `Authorization: Bearer <token>` and bare `Bearer <token>`.
 *
 * Fetch failures and proxy errors echo request headers surprisingly often.
 */
export function redactBearerTokens(text: string): string {
  return text.replace(
    /\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    (_m, prefix: string) => `${prefix}${MASK}`,
  );
}

/**
 * CommerceWorker API tokens (`cwk_<kind>_<secret>`).
 *
 * The kind survives — knowing a *delivery* key was rejected rather than a
 * management one is diagnostic; the secret is not.
 */
export function redactApiTokens(text: string): string {
  return text.replace(
    /\bcwk_([a-z]+)_[A-Za-z0-9._~+/=-]{6,}/gi,
    (_m, kind: string) => `cwk_${kind}_${MASK}`,
  );
}

/**
 * Applies every rule. This is what call sites should reach for; the individual
 * functions are exported for targeted use and for testing.
 *
 * Accepts `unknown` so callers can pass an error straight in without
 * stringifying it first — the common case at a `catch` boundary.
 */
export function redactCredentials(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return redactApiTokens(redactBearerTokens(redactUrlCredentials(text)));
}
