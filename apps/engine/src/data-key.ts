/**
 * Secrets at rest (see `encryptSecret` in @commerceworker/core): the outbox reads webhook signing
 * secrets, the A2A agent stores push credentials, and the daily sweep (`resealSecrets`) moves every
 * stored secret onto the current `DATA_KEY`, encrypting any stored before encryption.
 */

import { resealSecrets as reseal } from '@commerceworker/application/commerce';
import { decryptSecret, encryptSecret } from '@commerceworker/core';
import { sealedSecrets } from './wire';

/** `DATA_KEY`, then `DATA_KEY_PREVIOUS` while a rotation finishes. */
export const dataKeys = (env: Env) => [env.DATA_KEY, env.DATA_KEY_PREVIOUS] as const;

export const sealSecret = (env: Env, plaintext: string, context: string) =>
  encryptSecret(dataKeys(env), plaintext, context);

export const openSecret = (env: Env, stored: string, context: string) =>
  decryptSecret(dataKeys(env), stored, context);

/**
 * Seals every stored secret under the current `DATA_KEY` (the resealing use-case over the sealed
 * secrets port): values stored before encryption, and values under `DATA_KEY_PREVIOUS` after a
 * rotation. `unreadable` counts values neither key opens (each is logged).
 */
export const resealSecrets = (env: Env) => reseal({ secrets: sealedSecrets(env) }, dataKeys(env));
