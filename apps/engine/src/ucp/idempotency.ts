/**
 * `Idempotency-Key` for UCP's state-changing operations, per platform. The first request with a
 * key claims it; a repeat with the same body (SHA-256 of the raw bytes, as UCP asks) gets the
 * stored response, one with a different body gets 409, and one that arrives while the first is
 * still running gets 409 too. A request that throws releases its key, so the platform can retry.
 * Keys are kept 24 hours (the retention sweep removes older ones). If the store can't be read or
 * written the request is refused (503), never run without its key.
 */

import { ucpStore } from '../wire';
import type { UcpResult } from './checkout';

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

async function digest(body: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const conflict = (content: string): UcpResult => ({
  status: 409,
  body: { code: 'idempotency_conflict', content },
});

/** Runs `op` at most once for (`ownerId`, `key`, `scope` + `body`). */
export async function once(
  env: Env,
  ownerId: string,
  key: string,
  scope: string,
  body: string,
  op: () => Promise<UcpResult>,
): Promise<UcpResult> {
  const store = ucpStore(env);
  const hash = await digest(`${scope}\n${body}`);
  let claimed: boolean;
  try {
    // A key older than the TTL is free again.
    const now = Date.now();
    claimed = await store.claimKey(ownerId, key, hash, now, now - IDEMPOTENCY_TTL_MS);
  } catch (err) {
    console.error('ucp idempotency store', err);
    return { status: 503, body: { code: 'unavailable', content: 'Try again shortly.' } };
  }
  if (!claimed) {
    const prior = await store.heldKey(ownerId, key);
    if (!prior || prior.requestHash !== hash)
      return conflict('This Idempotency-Key was used for a different request.');
    if (prior.status === null)
      return conflict(
        'A request with this Idempotency-Key is still running; get the checkout instead.',
      );
    return { status: prior.status, body: JSON.parse(prior.response ?? 'null') };
  }
  let result: UcpResult;
  try {
    result = await op();
  } catch (err) {
    await store.releaseKey(ownerId, key);
    throw err;
  }
  // A refusal that changed nothing (5xx, a lost race) can be tried again under the same key.
  if (result.status >= 500 || result.status === 409) await store.releaseKey(ownerId, key);
  else await store.settleKey(ownerId, key, result.status, JSON.stringify(result.body));
  return result;
}
