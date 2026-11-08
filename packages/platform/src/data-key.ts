import {
  createSecretSealer,
  DEV_DATA_KEY,
  MIN_DATA_KEY_LENGTH,
  type SecretSealerKeys,
} from '@commerceworker/application';
import type { SecretSealer } from '@commerceworker/ports';
import type { EdgeEnv } from './env';

/**
 * The keys sealing secrets at rest (`DATA_KEY`, plus `DATA_KEY_PREVIOUS` while
 * a rotation finishes). Same fail-closed policy as `MEDIA_SIGNING_SECRET` and
 * `assertNoFakeAdapters`:
 *
 * - persistent (D1-backed) and REQUIRE_SECURE_SECRETS is not
 *   `false`: DATA_KEY is required, at least 32 characters, and not the dev key.
 *   Missing → the Worker refuses every request, cron tick and queue batch.
 * - persistent with REQUIRE_SECURE_SECRETS=false (the `local`/`dev` envs): an
 *   unset DATA_KEY falls back to the fixed `DEV_DATA_KEY`, so values sealed
 *   against a local D1 database still open after a restart.
 * - in-memory (no database): an unset DATA_KEY gets a key generated once per
 *   isolate — nothing outlives the isolate, so nothing needs a stable key.
 */
export function dataKeysFromEnv(env: EdgeEnv, persistent: boolean): SecretSealerKeys {
  const secure = persistent && env.REQUIRE_SECURE_SECRETS !== 'false';
  const previous = env.DATA_KEY_PREVIOUS || undefined;
  const current = env.DATA_KEY;
  if (current) {
    if (secure) {
      if (current === DEV_DATA_KEY || current.length < MIN_DATA_KEY_LENGTH) {
        throw new Error(
          `DATA_KEY must be at least ${MIN_DATA_KEY_LENGTH} characters and not the dev key (openssl rand -base64 32)`,
        );
      }
      if (previous && previous === current) {
        throw new Error(
          'DATA_KEY_PREVIOUS must differ from DATA_KEY (unset it once a rotation finishes)',
        );
      }
    }
    return { current, ...(previous ? { previous } : {}) };
  }
  if (secure) {
    throw new Error(
      'Refusing to start: the store is persistent but DATA_KEY is unset, so secrets at rest cannot be sealed (wrangler secret put DATA_KEY; value from `openssl rand -base64 32`)',
    );
  }
  if (persistent) return { current: DEV_DATA_KEY, ...(previous ? { previous } : {}) };
  return { current: isolateDevKey() };
}

let generated: string | undefined;

/**
 * Generated lazily — workerd forbids random generation at module scope — and
 * kept for the isolate, matching the module-scope in-memory store it seals.
 */
function isolateDevKey(): string {
  if (!generated) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    generated = btoa(String.fromCharCode(...bytes));
  }
  return generated;
}

/** The deployment's `SecretSealer` (see `dataKeysFromEnv` for the key policy). */
export function sealerFromEnv(env: EdgeEnv, persistent: boolean): SecretSealer {
  return createSecretSealer(dataKeysFromEnv(env, persistent));
}

/** The daily reseal sweep runs on the 03:30 UTC tick of the every-minute cron. */
export function isResealTick(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return at.getUTCHours() === 3 && at.getUTCMinutes() === 30;
}
