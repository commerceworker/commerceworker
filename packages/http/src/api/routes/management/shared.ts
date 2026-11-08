import type { AppContext } from '@commerceworker/application';
import { actingAs, getEntry, withChanges } from '@commerceworker/application';
import {
  type ApiKey,
  type Asset,
  authorizeContent,
  authorizeTrash,
  type ContentAction,
  effectivePluginGrant,
  ForbiddenError,
  type InstalledPlugin,
  type Scope,
  ValidationError,
  type Webhook,
} from '@commerceworker/domain';
import type { ImportSource } from '@commerceworker/ports';
import type { Context } from 'hono';
import { assetResponse } from '../../asset-response';
import type { AuthDeps, AuthVars } from '../../auth';

// Reads the route's scope, preferring the alias-resolved environment id stamped
// by environmentMiddleware over the raw `:env` param.
export const scopeOf = (c: Context<AuthVars>): Scope => ({
  spaceId: c.req.param('space') as string,
  environmentId: c.get('environmentId') ?? (c.req.param('env') as string),
});

/**
 * The use-cases' context for this request, acting as its principal: what they write (an entry's
 * `createdBy` and `updatedBy`, a version's author, a job's chunks) is recorded as that principal's,
 * and the entries it saves are noted for the request's audit row (`auditMiddleware`).
 */
export const actingCtx = (ctx: AppContext, c: Context<AuthVars>): AppContext =>
  withChanges(actingAs(ctx, c.get('principal')), c.get('changes'));

// Public projections that strip secrets before they leave the server: API keys
// never expose their stored hash, webhooks never expose their signing secret.
export const apiKeySummary = (k: ApiKey) => ({
  id: k.id,
  kind: k.kind,
  name: k.name,
  scopes: k.scopes,
  revoked: k.revoked,
  roleId: k.roleId,
  lastUsedAt: k.lastUsedAt,
});
export const pluginSummary = (p: InstalledPlugin) => ({
  id: p.id,
  name: p.manifest.name,
  version: p.manifest.version,
  description: p.manifest.description,
  requestedCapabilities: p.manifest.capabilities,
  approvedCapabilities: p.approvedCapabilities,
  // What it actually runs with: declared ∩ approved.
  grantedCapabilities: effectivePluginGrant(p.manifest.capabilities, p.approvedCapabilities),
  needsReapproval: p.needsReapproval === true,
  allowedHosts: p.manifest.allowedHosts,
  hooks: p.manifest.hooks,
  checksum: p.checksum,
  enabled: p.enabled,
  installedAt: p.installedAt,
  installedBy: p.installedBy,
});
export const webhookSummary = (h: Webhook) => ({
  id: h.id,
  url: h.url,
  topics: h.topics,
  active: h.active,
  environmentId: h.environmentId,
});

export const BASE = '/spaces/:space/environments/:env';

/**
 * `?expectedVersion=N`: hold a publish, unpublish or restore to the version the caller read (a
 * 409 when the entry has moved on). Absent, the write acts on the entry as it is.
 */
export function expectedVersionOf(c: Context<AuthVars>): { expectedVersion?: number } {
  const raw = c.req.query('expectedVersion');
  if (raw === undefined || raw === '') return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError([
      { field: 'expectedVersion', message: 'expectedVersion must be a positive integer' },
    ]);
  }
  return { expectedVersion: n };
}

/**
 * Resolves a source id, naming what is available when it is unknown.
 *
 * A bare 404 here is unhelpful: the caller almost always mistyped one of two
 * ids, and the list is short enough to just show them.
 */
export function importSourceOr400(
  sources: Readonly<Record<string, ImportSource>> | undefined,
  id: string,
): ImportSource {
  const found = sources?.[id];
  if (found) return found;
  const known = Object.keys(sources ?? {});
  throw new ValidationError([
    {
      field: 'source',
      message: known.length
        ? `Unknown import source "${id}". Available: ${known.join(', ')}`
        : 'No import sources are configured on this deployment',
    },
  ]);
}

/** The entry-level RBAC checks every area that reads or writes an entry runs. */
export function entryAccess(ctx: AppContext) {
  // Granular RBAC: content-level check on top of the coarse scope for
  // role-bound principals (unrestricted principals short-circuit inside the
  // domain helpers). Resolves the entry's content type when needed.
  const guardEntry = async (
    c: Context<AuthVars>,
    id: string,
    action: ContentAction | readonly ContentAction[],
  ) => {
    const principal = c.get('principal');
    if (!principal.contentGrants) return;
    const { entry } = await getEntry(ctx, scopeOf(c), id);
    authorizeContent(principal, action, entry.contentTypeApiId);
  };
  // Trashing asks for more than one action, and for `unpublish` too when the entry is live.
  const guardTrash = async (c: Context<AuthVars>, id: string) => {
    const principal = c.get('principal');
    if (!principal.contentGrants) return;
    const { entry } = await getEntry(ctx, scopeOf(c), id);
    authorizeTrash(principal, entry);
  };
  // Authorizes read on an entry (404 if missing, 403 if the role can't read its
  // content type) and returns the content type id so callers can mask denied
  // fields on version/history/related reads. Use this on every path that returns
  // an entry's field values so granular RBAC can't be bypassed via a side door.
  const authorizeEntryRead = async (c: Context<AuthVars>, id: string): Promise<string> => {
    const { entry } = await getEntry(ctx, scopeOf(c), id);
    authorizeContent(c.get('principal'), 'read', entry.contentTypeApiId);
    return entry.contentTypeApiId;
  };
  return { guardEntry, guardTrash, authorizeEntryRead };
}

/**
 * Every asset goes out through the one serializer (as MCP's do): a short-lived signed URL, never
 * the stored non-expiring one, and none of the server's own fields (r2Key).
 */
export function assetUrls(blob: AuthDeps['blob']) {
  const signedOne = (c: Context<AuthVars>, asset: Asset) => assetResponse(blob, scopeOf(c), asset);
  const signed = (c: Context<AuthVars>, assets: readonly Asset[]) =>
    Promise.all(assets.map((a) => signedOne(c, a)));
  return { signedOne, signed };
}

// A key with content grants reads no assets (as the preview asset reads refuse it): not a
// collection's members, and not a zip of anyone's files.
export function refuseGrantedAssetReads(c: Context<AuthVars>): void {
  if (c.get('principal').contentGrants) {
    throw new ForbiddenError('assets (a key with content grants reads no assets)');
  }
}
