/**
 * Hosted checkout through the assistant, REST's and MCP's twin: `create_checkout` makes a session
 * and the one-time link that opens it on the storefront (no confirm: nothing is ordered until the
 * buyer completes it, and the link works once). The session and its credentials are the engine's
 * (../checkout/hosted.ts); the audit trail names the checkout, never the link.
 *
 * `set_storefront_settings` turns hosted checkout on and off, a confirmed admin write like agentic
 * checkout's settings (./access.ts), since it opens the public storefront to buyers.
 */
import {
  changeStorefrontSettings,
  planStorefrontSettings,
} from '@commerceworker/application/commerce';
import {
  type ActionPreview,
  boundText,
  type Principal,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { createHostedCheckout } from '../checkout/hosted';
import { flowStore, workspaceStore } from '../wire';
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

const settingsPorts = (env: Env) => ({ workspace: workspaceStore(env), flows: flowStore(env) });

export async function previewStorefrontSettings(
  env: Env,
  i: ToolInput<'set_storefront_settings'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const { from, flowId, refusal } = await planStorefrontSettings(settingsPorts(env), i);
  const flowName = async (id: string) =>
    boundText((await flowStore(env).flow(id))?.name ?? id, 80) ?? id;
  const on = i.checkout.enabled;
  return {
    title: !on
      ? 'Turn hosted checkout off'
      : from.checkout.enabled
        ? 'Change hosted checkout'
        : 'Turn hosted checkout on',
    consequences: [
      on
        ? flowId
          ? `Checkouts are priced by the flow ${await flowName(flowId)}, its latest published version, and place their orders on it`
          : 'No flow prices them yet'
        : 'Every hosted checkout link stops working and every checkout page is refused, until it is turned on again',
      on
        ? i.checkout.editLines
          ? 'Buyers may change the lines on their page'
          : 'Only you may change a checkout’s lines; the buyer changes their details'
        : `Now: ${from.checkout.enabled ? 'on' : 'off'}`,
      'The storefront picks it up within 30 seconds',
    ],
    blocked: roleBlock ?? refusal ?? undefined,
  };
}

export async function runStorefrontSettings(
  env: Env,
  p: Principal,
  i: ToolInput<'set_storefront_settings'>,
  trail: Record<string, unknown>,
) {
  const r = await changeStorefrontSettings(settingsPorts(env), i, p.email ?? p.name);
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, { actor: p, detail: { ...r.audit.detail, ...trail } });
  return {
    done: r.settings.checkout.enabled ? 'Saved hosted checkout' : 'Turned hosted checkout off',
  };
}
