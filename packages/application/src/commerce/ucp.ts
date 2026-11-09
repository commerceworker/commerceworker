/**
 * Agentic checkout's admin side: its settings, the platforms let in (never a key) and revoking one.
 * The REST routes and the MCP tools both call these. Letting a platform in mints a key shown once,
 * so that stays with the web app. Time comes in as `now`.
 */
import {
  checkoutFlowProblem,
  type FlowGraph,
  readUcpSettings,
  UCP_SETTINGS_KEY,
  type UcpSettings,
} from '@commerceworker/core';
import type { FlowStore, UcpStore, WorkspaceStore } from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

/** Platforms listed at most. */
const PLATFORMS_MAX = 500;

/** The settings as stored, off until an admin sets them. Reads the database: never a cached copy. */
export async function readUcpAdminSettings(ports: { workspace: WorkspaceStore }) {
  return readUcpSettings(await ports.workspace.setting(UCP_SETTINGS_KEY));
}

/** The settings and the platforms, as the admin API shows them: never a key. */
export async function getUcpAdmin(ports: { workspace: WorkspaceStore; ucp: UcpStore }) {
  return {
    settings: await readUcpAdminSettings(ports),
    platforms: await ports.ucp.platforms(PLATFORMS_MAX),
  };
}

/** Why `flowId` can't take checkouts (unknown, unpublished, or never holds a card), or null. */
export async function checkoutFlowRefusal(
  ports: { flows: FlowStore },
  flowId: string,
): Promise<string | null> {
  const version = await ports.flows.version(flowId);
  if (!version) return `No published flow ${flowId}`;
  return checkoutFlowProblem(version as unknown as FlowGraph);
}

/**
 * What changing the settings would do, for a preview: the settings now, and why the change can't
 * go ahead (its checkout flow can't take checkouts), or null.
 */
export async function planUcpSettings(
  ports: { workspace: WorkspaceStore; flows: FlowStore },
  next: UcpSettings,
) {
  const flowId = next.checkoutFlowId;
  return {
    from: await readUcpAdminSettings(ports),
    refusal: flowId ? await checkoutFlowRefusal(ports, flowId) : null,
  };
}

/** Sets the settings, once the checkout flow can take checkouts. */
export async function changeUcpSettings(
  ports: { workspace: WorkspaceStore; flows: FlowStore },
  next: UcpSettings,
  by: string,
): Promise<{ ok: true; settings: UcpSettings; audit: AuditDraft } | { ok: false; error: string }> {
  const { from, refusal } = await planUcpSettings(ports, next);
  if (refusal) return { ok: false, error: refusal };
  await ports.workspace.setSetting(UCP_SETTINGS_KEY, JSON.stringify(next), by);
  return {
    ok: true,
    settings: next,
    // No target: the settings have no name, only the flow they switch.
    audit: {
      action: 'ucp.settings',
      detail: { from: from.checkoutFlowId, to: next.checkoutFlowId },
    },
  };
}

/** One platform as the admin API shows it, revoked or not; undefined for an unknown id. */
export async function getUcpPlatform(ports: { ucp: UcpStore }, id: string) {
  return (await ports.ucp.platforms(PLATFORMS_MAX)).find((p) => p.id === id);
}

/** Why a platform can't be revoked: it never existed, or already was. */
export async function revokeUcpPlatformProblem(
  ports: { ucp: UcpStore },
  id: string,
): Promise<string | undefined> {
  const found = await getUcpPlatform(ports, id);
  if (!found) return `No platform ${id}.`;
  return found.revokedAt ? `${found.name} is already revoked.` : undefined;
}

/** Revokes a platform at once. The row stays, so its checkouts and orders still name it. */
export async function revokeUcpPlatform(
  ports: { ucp: UcpStore },
  id: string,
  now: number,
): Promise<{ ok: true; audit: AuditDraft } | { ok: false; error: string }> {
  const platform = await ports.ucp.revokePlatform(id, now);
  if (!platform)
    return { ok: false, error: (await revokeUcpPlatformProblem(ports, id)) ?? 'Not found.' };
  return {
    ok: true,
    audit: { action: 'ucp.platform_revoked', target: platform.name, detail: { id: platform.id } },
  };
}
