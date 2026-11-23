/**
 * Integrations: the external systems that sign webhooks (./webhooks.ts). Each has its own secret
 * and a scope, so a payment provider's key can deliver `payment.received` and nothing else, and a
 * storefront's can start orders on its own channel only. Pure; the web app stores them.
 */

import type { OrderChannel } from './types';

export type IntegrationScope = {
  /** Events it may deliver to `POST /api/v1/webhooks/events`; `"*"` is any. Empty is none. */
  events: string[];
  /** Whether it may start orders at `POST /api/v1/webhooks/orders`. */
  startOrders: boolean;
  /** Flows an order body may name with `flowId`; `"*"` is any. Without `flowId`, routing picks. */
  flows: string[];
  /** Only orders on this channel: the ones it starts, and the ones it sends events to. */
  channel: OrderChannel | null;
};

export type ScopeCheck = { ok: true } | { ok: false; reason: string };

const OK: ScopeCheck = { ok: true };
const allows = (list: string[], value: string) => list.includes('*') || list.includes(value);

/** Whether the integration may deliver `event` to an order on `orderChannel`. */
export function allowsEvent(
  scope: IntegrationScope,
  event: string,
  orderChannel: string,
): ScopeCheck {
  if (!allows(scope.events, event))
    return { ok: false, reason: `This integration may not deliver ${event}` };
  if (scope.channel && orderChannel !== scope.channel)
    return { ok: false, reason: `This integration may only reach ${scope.channel} orders` };
  return OK;
}

/**
 * Whether the integration may start an order on `channel`. `flowId` is the flow the body names;
 * `routed` is the flow routing would pick when it names none. The key's `flows` say which flows
 * its orders may run on: `"*"` any, named or routed; a list only those, named or routed; none at
 * all only the flow routing picks (a named one is refused).
 */
export function allowsOrder(
  scope: IntegrationScope,
  order: { channel: string; flowId?: string; routed?: string },
): ScopeCheck {
  if (!scope.startOrders) return { ok: false, reason: 'This integration may not start orders' };
  if (scope.channel && order.channel !== scope.channel)
    return { ok: false, reason: `This integration may only start ${scope.channel} orders` };
  if (order.flowId && !allows(scope.flows, order.flowId))
    return { ok: false, reason: `This integration may not choose flow ${order.flowId}` };
  if (!order.flowId && scope.flows.length && !allows(scope.flows, order.routed ?? ''))
    return {
      ok: false,
      reason: `This integration may only start orders on its own flows; name one with flowId (routing picks ${order.routed ?? 'none'})`,
    };
  return OK;
}

/** How long a rotated-out secret keeps working, so a sender can switch without downtime. */
export const ROTATION_GRACE_MS = 24 * 3_600_000;

/** The secrets a signature may match now: the current one, and the previous one until it expires. */
export function verificationSecrets(
  key: { secret: string; previousSecret: string | null; previousExpiresAt: number | null },
  now = Date.now(),
): string[] {
  return key.previousSecret && (key.previousExpiresAt ?? 0) > now
    ? [key.secret, key.previousSecret]
    : [key.secret];
}

/** A new signing secret: `whsec_` and 48 hex digits. */
export function newWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
