import { env, waitUntil } from 'cloudflare:workers';
import type { EngineRpc } from '@commerceworker/core';

/** The engine Worker, typed by the shared RPC contract. */
export function engine(): EngineRpc & Pick<Fetcher, 'fetch'> {
  return env.ENGINE as unknown as EngineRpc & Pick<Fetcher, 'fetch'>;
}

/** The documents bucket, where a cart's files are stored. */
export function docs() {
  return env.DOCS;
}

/**
 * Runs bookkeeping (a platform's last use) after the response instead of before it. The write
 * still happens: the Worker stays alive until it settles. A failure is logged.
 */
export function afterResponse(work: PromiseLike<unknown>) {
  waitUntil(Promise.resolve(work).catch((err) => console.error('background write failed', err)));
}
