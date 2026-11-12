/**
 * The public storefront's settings: the store's name on buyer pages, whether hosted checkout is on, the flow that prices it and
 * whether the buyer may change the lines. The REST route and the MCP tools both call these, as
 * they do agentic checkout's (./ucp.ts), whose flow rule they share: a flow that can't take a card
 * can't take checkouts. The engine reads the same row on every hosted call, so a change here is
 * the next call's.
 */
import {
  readStorefrontSettings,
  readUcpSettings,
  STOREFRONT_SETTINGS_KEY,
  type StorefrontSettings,
  type StorefrontSettingsInput,
  UCP_SETTINGS_KEY,
} from '@commerceworker/core';
import type { FlowStore, WorkspaceStore } from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';
import { checkoutFlowRefusal } from './ucp';

/** The settings as stored, hosted checkout off until an admin turns it on. Never a cached copy. */
export async function readStorefrontAdminSettings(ports: { workspace: WorkspaceStore }) {
  return readStorefrontSettings(await ports.workspace.setting(STOREFRONT_SETTINGS_KEY));
}

/**
 * What changing the settings would do, for a preview: the settings now, the flow a checkout would
 * be priced by, and why the change can't go ahead, or null. Only turning it on is held to the
 * flow: a saved choice while it is off is checked when it is turned on. With no flow chosen, the
 * flow is agentic checkout's, and that must exist and take a card too.
 */
export async function planStorefrontSettings(
  ports: { workspace: WorkspaceStore; flows: FlowStore },
  input: StorefrontSettingsInput,
) {
  const from = await readStorefrontAdminSettings(ports);
  // A call that leaves the name out keeps it; null clears it.
  const next: StorefrontSettings = {
    ...input,
    storeName: input.storeName ?? (input.storeName === null ? null : from.storeName),
  };
  const flowId =
    next.checkout.checkoutFlowId ??
    readUcpSettings(await ports.workspace.setting(UCP_SETTINGS_KEY)).checkoutFlowId;
  let refusal: string | null = null;
  if (next.checkout.enabled)
    refusal = flowId
      ? await checkoutFlowRefusal(ports, flowId)
      : 'Choose a checkout flow, or set one for agentic checkout, to price hosted checkouts.';
  return { from, next, flowId, refusal };
}

/** Sets the settings (the store name only when the call names it), once a checkout flow that takes cards would price them (when turning it on). */
export async function changeStorefrontSettings(
  ports: { workspace: WorkspaceStore; flows: FlowStore },
  input: StorefrontSettingsInput,
  by: string,
): Promise<
  { ok: true; settings: StorefrontSettings; audit: AuditDraft } | { ok: false; error: string }
> {
  const { from, next, refusal } = await planStorefrontSettings(ports, input);
  if (refusal) return { ok: false, error: refusal };
  await ports.workspace.setSetting(STOREFRONT_SETTINGS_KEY, JSON.stringify(next), by);
  return {
    ok: true,
    settings: next,
    // No target: the settings have no name, only what they switch.
    audit: {
      action: 'checkout.settings',
      detail: {
        enabled: next.checkout.enabled,
        flow: next.checkout.checkoutFlowId,
        fromFlow: from.checkout.checkoutFlowId,
        editLines: next.checkout.editLines,
        wasEnabled: from.checkout.enabled,
        storeName: next.storeName,
        fromStoreName: from.storeName,
      },
    },
  };
}
