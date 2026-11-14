import { env, waitUntil } from 'cloudflare:workers';

/**
 * The deployment's password pepper (`PASSWORD_PEPPER`), mixed into every password hash and never
 * stored with them; unset in local development, where hashes are made without one.
 */
export function passwordPepper(): string | undefined {
  return (env as { PASSWORD_PEPPER?: string }).PASSWORD_PEPPER || undefined;
}

export type { EmailSender } from '@commerceworker/ports';
export { emailSender, sendsEmail } from './wire.server';

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
