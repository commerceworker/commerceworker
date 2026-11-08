import { env, waitUntil } from 'cloudflare:workers';
import { createCfEmailSender, type SendEmailBinding } from '@commerceworker/adapters/email-cf';
import { type AuthDb, authSchema } from '@commerceworker/store/auth';
import { drizzle } from 'drizzle-orm/d1';

/**
 * The deployment's password pepper (`PASSWORD_PEPPER`), mixed into every password hash and never
 * stored with them; unset in local development, where hashes are made without one.
 */
export function passwordPepper(): string | undefined {
  return (env as { PASSWORD_PEPPER?: string }).PASSWORD_PEPPER || undefined;
}

/** The `EmailSender` port, as the adapter builds it (the web app takes no dependency on ports). */
export type EmailSender = ReturnType<typeof createCfEmailSender>;

type EmailEnv = { EMAIL?: SendEmailBinding; EMAIL_FROM?: string; EMAIL_FROM_NAME?: string };

/**
 * The deployment's email settings, or null when it sends none: an Email Sending `send_email`
 * binding (EMAIL, added per deployment by scripts/fleet.ts when the registry names a sender) and
 * its sender address. A bound EMAIL without EMAIL_FROM is a configuration error, refused with the
 * engine's words (`makeEmail` in packages/platform/src/wire.ts) rather than read as "no email".
 */
function emailSettings(): (EmailEnv & { EMAIL: SendEmailBinding; EMAIL_FROM: string }) | null {
  const e = env as EmailEnv;
  if (!e.EMAIL) return null;
  if (!e.EMAIL_FROM)
    throw new Error(
      'The EMAIL send_email binding is set but EMAIL_FROM is not; set it to an address on a domain onboarded to Email Sending',
    );
  return e as EmailEnv & { EMAIL: SendEmailBinding; EMAIL_FROM: string };
}

/** Whether this deployment sends email. Throws on EMAIL bound without EMAIL_FROM. */
export const sendsEmail = (): boolean => emailSettings() !== null;

/**
 * The `EmailSender` over the EMAIL binding (`@commerceworker/adapters/email-cf`), or undefined
 * when the deployment sends no email. Throws on EMAIL without EMAIL_FROM, and on a sender address
 * the adapter can't use.
 */
export function emailSender(): EmailSender | undefined {
  const e = emailSettings();
  if (!e) return undefined;
  return createCfEmailSender(e.EMAIL, {
    from: e.EMAIL_FROM,
    ...(e.EMAIL_FROM_NAME ? { fromName: e.EMAIL_FROM_NAME } : {}),
  });
}

/** One drizzle instance per D1 binding, so a request that asks again reuses it. */
const instances = new WeakMap<D1Database, AuthDb>();

export function createDb(d1: D1Database): AuthDb {
  let db = instances.get(d1);
  if (!db) {
    db = drizzle(d1, { schema: authSchema });
    instances.set(d1, db);
  }
  return db;
}

/** The auth tables in the deployment's D1 (the same database the api uses). */
export function db(): AuthDb {
  return createDb(env.DB);
}

/** The api Worker, over the `API` service binding. */
/** The delivery Worker's binding (bearer-key /delivery/* calls go through its cache). */
export function delivery(): Fetcher | undefined {
  return env.DELIVERY;
}

export function api(): Fetcher {
  return env.API;
}

/**
 * Runs bookkeeping (a session's last use) after the response instead of before it. The write
 * still happens: the Worker stays alive until it settles. A failure is logged.
 */
export function afterResponse(work: PromiseLike<unknown>) {
  waitUntil(Promise.resolve(work).catch((err) => console.error('background write failed', err)));
}
