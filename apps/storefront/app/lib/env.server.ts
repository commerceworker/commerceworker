import { env } from 'cloudflare:workers';
import type { StorefrontRpc } from '@commerceworker/core';

/**
 * The engine Worker's `StorefrontApi` entrypoint, typed by the narrow contract: all this public
 * Worker may ask of the engine. It has no database or bucket binding of its own.
 */
export function engine(): StorefrontRpc {
  return env.ENGINE as unknown as StorefrontRpc;
}
