/**
 * Request budgets on the storefront's two programmatic surfaces: a cart's buyer on product search
 * (`API_LIMIT`) and each UCP platform (`AGENT_LIMIT`). The budgets are Workers rate-limit bindings
 * (`apps/storefront/wrangler.jsonc`, overridden per deployment by the registry's `limits`, as the
 * web Worker's are), counted per Cloudflare location, so they stop a runaway client rather than
 * meter it exactly.
 */

import { env } from 'cloudflare:workers';

export type Budget = 'API_LIMIT' | 'AGENT_LIMIT';

/** Every budget's window, in seconds: what a refused caller is told to wait. */
export const RATE_WINDOW_S = 60;

/**
 * The 429 for a caller over its budget, or null to go ahead. Without the binding (unit tests)
 * nothing is limited.
 */
export async function overBudget(budget: Budget, key: string): Promise<Response | null> {
  const limiter = (env as Partial<Record<Budget, RateLimit>>)[budget];
  if (!limiter || (await limiter.limit({ key })).success) return null;
  return Response.json(
    { error: `Too many requests; try again in ${RATE_WINDOW_S} seconds.` },
    { status: 429, headers: { 'retry-after': String(RATE_WINDOW_S) } },
  );
}
