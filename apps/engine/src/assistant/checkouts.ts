/**
 * Hosted checkout through the assistant, REST's and MCP's twin: `create_checkout` makes a session
 * and the one-time link that opens it on the storefront (no confirm: nothing is ordered until the
 * buyer completes it, and the link works once). The session and its credentials are the engine's
 * (../checkout/hosted.ts); the audit trail names the checkout, never the link.
 */
import type { Principal, ToolInput } from '@commerceworker/core';
import { recordAudit } from '../audit';
import { createHostedCheckout } from '../checkout/hosted';
import { Refused } from './data';

export async function openHostedCheckout(
  env: Env,
  p: Principal,
  i: ToolInput<'create_checkout'>,
  trail: Record<string, unknown>,
) {
  const made = await createHostedCheckout(env, i);
  if (!made.ok) throw new Refused(made.error);
  await recordAudit(env, 'checkout.created', {
    actor: p,
    target: made.id,
    detail: {
      lines: i.lines.length,
      ...(i.customerId ? { customerId: i.customerId } : {}),
      ...trail,
    },
  });
  return { id: made.id, url: made.url };
}
