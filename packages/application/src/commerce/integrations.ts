/**
 * Integrations as the admin API shows them (never a secret) and revoking one. The REST route and
 * the MCP tools both call these. Creating and rotating mint a secret shown once, so those stay
 * with the web app, which holds the data key that seals it. Time comes in as `now`.
 */
import type { IntegrationScope, OrderChannel } from '@commerceworker/core';
import type { IntegrationStore, IntegrationView } from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

/** Integrations listed at most. */
const INTEGRATIONS_MAX = 500;

/** What an integration may do, parsed from its row. */
export const integrationScope = (r: IntegrationView): IntegrationScope => ({
  events: JSON.parse(r.events) as string[],
  startOrders: r.startOrders,
  flows: JSON.parse(r.flows) as string[],
  channel: (r.channel as OrderChannel | null) ?? null,
});

/** What the API shows: never a secret. */
export const integrationView = (r: IntegrationView, now: number) => ({
  id: r.id,
  name: r.name,
  ...integrationScope(r),
  createdAt: r.createdAt,
  createdBy: r.createdBy,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
  /** When the previous secret stops working, while a rotation is under way. */
  previousExpiresAt: r.previousExpiresAt && r.previousExpiresAt > now ? r.previousExpiresAt : null,
});

export async function listIntegrations(ports: { integrations: IntegrationStore }, now: number) {
  return (await ports.integrations.list(INTEGRATIONS_MAX)).map((r) => integrationView(r, now));
}

/** One integration as the admin API shows it, revoked or not; undefined for an unknown id. */
export async function getIntegration(
  ports: { integrations: IntegrationStore },
  id: string,
  now: number,
) {
  return (await listIntegrations(ports, now)).find((i) => i.id === id);
}

/** Why a live integration can't be revoked: it never existed, or already was. */
export async function revokeIntegrationProblem(
  ports: { integrations: IntegrationStore },
  id: string,
  now: number,
): Promise<string | undefined> {
  const found = await getIntegration(ports, id, now);
  if (!found) return `No integration ${id}.`;
  return found.revokedAt ? `${found.name} is already revoked.` : undefined;
}

/**
 * Revokes an integration at once, both secrets. The row stays for the audit log. The audit event
 * names it by name, as the app's pages and the REST API do.
 */
export async function revokeIntegration(
  ports: { integrations: IntegrationStore },
  id: string,
  now: number,
): Promise<
  | { ok: true; integration: ReturnType<typeof integrationView>; audit: AuditDraft }
  | {
      ok: false;
      error: string;
    }
> {
  const row = await ports.integrations.revoke(id, now);
  if (!row)
    return { ok: false, error: (await revokeIntegrationProblem(ports, id, now)) ?? 'Not found.' };
  return {
    ok: true,
    integration: integrationView(row, now),
    audit: { action: 'integration.revoked', target: row.name, detail: { id } },
  };
}
