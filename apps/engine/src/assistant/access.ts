/**
 * Who and what may reach the workspace from outside, REST's twins (apps/web's webhooks, integrations
 * and ucp admin routes): removing a webhook subscription, revoking an integration or an AI shopping
 * platform, and changing agentic checkout's settings. Each goes live or takes access away, so each
 * stops for a confirm with a preview of what goes, and is refused up front when there is nothing
 * to remove or revoke. The use-cases are `@commerceworker/application`'s, the ones REST runs.
 * Creating or rotating a credential stays REST's alone: its secret is shown once.
 *
 * Nothing here reads a secret: the stores' admin views carry none, and a webhook's URL shows
 * without its query, where a receiver may keep a token.
 */

import {
  changeUcpSettings,
  findRedeliverable,
  getIntegration,
  getUcpPlatform,
  getWebhookSubscription,
  planUcpSettings,
  removeWebhookSubscription,
  revokeIntegration,
  revokeUcpPlatform,
} from '@commerceworker/application/commerce';
import {
  type ActionPreview,
  boundText,
  type Principal,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { PLUGIN_SUBSCRIPTION, redeliver } from '../outbox';
import { flowStore, integrationStore, ucpStore, webhookOutbox, workspaceStore } from '../wire';
import { Refused } from './data';

type Trail = Record<string, unknown>;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lastUsed = (at: number | null) => (at ? `Last used ${day(at)}` : 'Never used');
/** A URL as a card shows it: where it points, never its query or fragment. */
const where = (url: string) => {
  try {
    const u = new URL(url);
    return boundText(`${u.origin}${u.pathname}`, 120) ?? u.origin;
  } catch {
    return '(not a URL)';
  }
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where a delivery goes: a subscription's URL, or the plugin it is for. */
async function receiver(env: Env, subscriptionId: string) {
  if (subscriptionId.startsWith(PLUGIN_SUBSCRIPTION))
    return { name: `the plugin ${subscriptionId.slice(PLUGIN_SUBSCRIPTION.length)}`, gone: false };
  const sub = (await webhookOutbox(env).subscriptions()).find((s) => s.id === subscriptionId);
  return sub ? { name: where(sub.url), gone: false } : { name: subscriptionId, gone: true };
}

export async function previewRedeliverWebhook(
  env: Env,
  i: ToolInput<'redeliver_webhook_delivery'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const found = await findRedeliverable({ outbox: webhookOutbox(env) }, i.deliveryId);
  if (!found.ok)
    return {
      title: 'Send a webhook delivery again',
      consequences: [],
      blocked: roleBlock ?? found.error,
    };
  const d = found.delivery;
  const to = await receiver(env, d.subscriptionId);
  return {
    title: `Send ${d.event} to ${to.name} again`,
    consequences: [
      `The same delivery id (${d.id}) and the same payload, signed with the subscription’s current secret`,
      `${d.status === 'delivered' ? 'Delivered' : 'Failed'} after ${plural(d.attempts, 'attempt')}${d.lastError && d.status === 'failed' ? `: ${boundText(d.lastError, 120)}` : ''}`,
      'A receiver that dedupes by delivery id handles it once, however many times it is sent',
    ],
    blocked:
      roleBlock ??
      (to.gone
        ? `The subscription ${d.subscriptionId} is gone or off, so there is nowhere to send it.`
        : undefined),
  };
}

export async function runRedeliverWebhook(
  env: Env,
  p: Principal,
  i: ToolInput<'redeliver_webhook_delivery'>,
  trail: Trail,
) {
  const found = await findRedeliverable({ outbox: webhookOutbox(env) }, i.deliveryId);
  if (!found.ok) throw new Refused(found.error);
  const sent = await redeliver(env, i.deliveryId);
  if (!sent.ok) throw new Refused(sent.error);
  await recordAudit(env, found.audit.action, {
    actor: p,
    target: found.audit.target,
    detail: { ...found.audit.detail, ...trail },
  });
  const d = sent.delivery;
  return {
    done:
      d.status === 'delivered'
        ? 'Sent again, and the receiver took it'
        : `Sent again, but it failed: ${d.lastError ?? 'no answer'}`,
    id: d.id,
    status: d.status === 'delivered' ? ('delivered' as const) : ('failed' as const),
    attempts: d.attempts,
    responseStatus: d.responseStatus,
    lastError: d.lastError,
  };
}

export async function previewDeleteWebhook(
  env: Env,
  i: ToolInput<'delete_webhook_subscription'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const outbox = webhookOutbox(env);
  const sub = await getWebhookSubscription({ outbox }, i.subscriptionId, Date.now());
  if (!sub)
    return {
      title: 'Remove a webhook subscription',
      consequences: [],
      blocked: roleBlock ?? `No webhook subscription ${i.subscriptionId}.`,
    };
  const [last] = await outbox.deliveries(sub.id, 1);
  return {
    title: `Remove the webhook to ${where(sub.url)}`,
    consequences: [
      `Takes ${sub.events.includes('*') ? 'every event' : (boundText(sub.events.join(', '), 160) ?? 'no events')}`,
      last
        ? `Last delivery ${day(last.createdAt)}, ${last.status}`
        : 'Nothing was ever delivered to it',
      'The URL stops receiving events, and its record of deliveries goes with it',
      'It cannot be brought back: a new subscription has a new signing secret',
    ],
    blocked: roleBlock,
  };
}

export async function runDeleteWebhook(
  env: Env,
  p: Principal,
  i: ToolInput<'delete_webhook_subscription'>,
  trail: Trail,
) {
  const r = await removeWebhookSubscription({ outbox: webhookOutbox(env) }, i.subscriptionId);
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return { done: 'Removed the webhook subscription', id: i.subscriptionId };
}

export async function previewRevokeIntegration(
  env: Env,
  i: ToolInput<'revoke_integration'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const found = await getIntegration(
    { integrations: integrationStore(env) },
    i.integrationId,
    Date.now(),
  );
  if (!found)
    return {
      title: 'Revoke an integration',
      consequences: [],
      blocked: roleBlock ?? `No integration ${i.integrationId}.`,
    };
  return {
    title: `Revoke the integration ${boundText(found.name, 80) ?? found.id}`,
    consequences: [
      lastUsed(found.lastUsedAt),
      found.startOrders
        ? 'It may start orders: they stop at once'
        : 'It sends events only, not orders',
      `Takes ${found.events.includes('*') ? 'every event' : plural(found.events.length, 'event')}`,
      'Its signed requests are refused from now on, even with the secret it was rotating from',
      'It cannot be undone: the sender needs a new integration',
    ],
    blocked: roleBlock ?? (found.revokedAt ? `${found.name} is already revoked.` : undefined),
  };
}

export async function runRevokeIntegration(
  env: Env,
  p: Principal,
  i: ToolInput<'revoke_integration'>,
  trail: Trail,
) {
  const r = await revokeIntegration(
    { integrations: integrationStore(env) },
    i.integrationId,
    Date.now(),
  );
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return { done: `Revoked the integration ${r.integration.name}`, id: r.integration.id };
}

export async function previewRevokePlatform(
  env: Env,
  i: ToolInput<'revoke_ucp_platform'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const found = await getUcpPlatform({ ucp: ucpStore(env) }, i.platformId);
  if (!found)
    return {
      title: 'Revoke an AI shopping platform',
      consequences: [],
      blocked: roleBlock ?? `No platform ${i.platformId}.`,
    };
  return {
    title: `Revoke the platform ${boundText(found.name, 80) ?? found.id}`,
    consequences: [
      lastUsed(found.lastUsedAt),
      `Its key stops working at once; it is registered for ${where(found.profileUrl)}`,
      'Its checkouts and orders stay and still name it',
      'It cannot be undone: the platform needs a new key',
    ],
    blocked: roleBlock ?? (found.revokedAt ? `${found.name} is already revoked.` : undefined),
  };
}

export async function runRevokePlatform(
  env: Env,
  p: Principal,
  i: ToolInput<'revoke_ucp_platform'>,
  trail: Trail,
) {
  const r = await revokeUcpPlatform({ ucp: ucpStore(env) }, i.platformId, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return { done: `Revoked the platform ${r.audit.target}`, id: i.platformId };
}

const ucpPorts = (env: Env) => ({ workspace: workspaceStore(env), flows: flowStore(env) });

export async function previewUcpSettings(
  env: Env,
  i: ToolInput<'set_ucp_settings'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const { from, refusal } = await planUcpSettings(ucpPorts(env), i);
  const flowName = async (id: string) =>
    boundText((await flowStore(env).flow(id))?.name ?? id, 80) ?? id;
  const to = i.checkoutFlowId;
  return {
    title: !to
      ? 'Turn agentic checkout off'
      : from.checkoutFlowId
        ? 'Change agentic checkout'
        : 'Turn agentic checkout on',
    consequences: [
      to
        ? `Checkouts start the flow ${await flowName(to)}, its latest published version`
        : 'Discovery answers 404 and every /ucp call is refused, whatever the platform',
      from.checkoutFlowId
        ? `Now: ${await flowName(from.checkoutFlowId)}`
        : 'Now: off, no platform can check out',
      `${plural(i.links.length, 'legal link')} on every checkout`,
      i.orderUrl
        ? `Buyers see their order at ${where(i.orderUrl)}`
        : 'Buyers see their order in the app',
      i.productUrl
        ? `Catalog results link a product to ${where(i.productUrl)}`
        : 'Catalog results carry no product link',
      'The web app picks it up within 30 seconds',
    ],
    blocked: roleBlock ?? refusal ?? undefined,
  };
}

export async function runUcpSettings(
  env: Env,
  p: Principal,
  i: ToolInput<'set_ucp_settings'>,
  trail: Trail,
) {
  const r = await changeUcpSettings(ucpPorts(env), i, p.email ?? p.name);
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    detail: { ...r.audit.detail, ...trail },
  });
  return {
    done: r.settings.checkoutFlowId ? 'Saved agentic checkout' : 'Turned agentic checkout off',
  };
}
