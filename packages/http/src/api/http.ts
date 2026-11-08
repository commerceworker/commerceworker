import {
  AssetInUseError,
  AssetRightsError,
  ConflictError,
  DomainError,
  HookRejectedError,
  LastAdminError,
  NotConfiguredError,
  NotFoundError,
  PublishGatedError,
  RateLimitedError,
  SecretUnreadableError,
  ValidationError,
} from '@commerceworker/domain';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/** Maps a domain error onto an HTTP status code + JSON body. */
export function toHttpError(err: unknown): { status: number; body: unknown } {
  if (err instanceof NotFoundError) return { status: 404, body: errBody(err) };
  if (err instanceof ValidationError) {
    return {
      status: 422,
      body: { error: { code: err.code, message: err.message, issues: err.issues } },
    };
  }
  // A conflict's details say what it conflicts with (the entries still using a removed field or
  // variant, the run already active), so a client can act on them without parsing the message.
  if (err instanceof ConflictError) {
    return {
      status: 409,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      },
    };
  }
  // Still linked from entries: the links come back, so a client can show or clear them.
  if (err instanceof AssetInUseError) {
    return {
      status: 409,
      body: {
        error: { code: err.code, message: err.message, usage: err.usage, total: err.total },
      },
    };
  }
  // The asset's rights hold it back (an embargo not yet lifted, an expiry passed): a conflict with
  // its state, naming the instant that decides it.
  if (err instanceof AssetRightsError) {
    return {
      status: 409,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details as Record<string, string>),
        },
      },
    };
  }
  // Would leave the space with no administrator: a conflict with the space's state.
  if (err instanceof LastAdminError) return { status: 409, body: errBody(err) };
  // A gated workflow covers the entry: a conflict with the space's workflow configuration. The
  // body names each refused entry and the workflows whose runs may publish it.
  if (err instanceof PublishGatedError) {
    return {
      status: 409,
      body: { error: { code: err.code, message: err.message, entries: err.entries } },
    };
  }
  if (err instanceof DomainError && err.code === 'unauthorized')
    return { status: 401, body: errBody(err) };
  // A refusal's details say what was refused (a read-only field, how many it can't read).
  if (err instanceof DomainError && err.code === 'forbidden') {
    return {
      status: 403,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      },
    };
  }
  // A hook refused it: the request was understood and declined on policy
  // grounds, which is 422 rather than 400 or 409.
  if (err instanceof HookRejectedError) return { status: 422, body: errBody(err) };
  if (err instanceof RateLimitedError) return { status: 429, body: errBody(err) };
  if (err instanceof NotConfiguredError) return { status: 501, body: errBody(err) };
  // A stored secret no configured key opens is a server-side fault (a lost
  // DATA_KEY, or tampering), never the client's. The message names only where
  // the value lives.
  if (err instanceof SecretUnreadableError) return { status: 500, body: errBody(err) };
  if (err instanceof DomainError) return { status: 400, body: errBody(err) };
  if (err instanceof HTTPException) {
    return { status: err.status, body: { error: { code: 'http_error', message: err.message } } };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } };
}

function errBody(err: DomainError) {
  return { error: { code: err.code, message: err.message } };
}

/** Central error handler registered via `app.onError`. */
export function onError(err: unknown, c: Context) {
  const { status, body } = toHttpError(err);
  // biome-ignore lint/suspicious/noExplicitAny: hono status code typing
  return c.json(body as any, status as any);
}
