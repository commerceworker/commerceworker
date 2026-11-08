import {
  type ContentTypeGrant,
  DelegatedKeyMintError,
  grantsAdmin,
  IMPLIED_CONTENT_ACTIONS,
  isDelegatedBearer,
  LISTED_CONTENT_ACTIONS,
  NotFoundError,
  type Principal,
  type Role,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import type { AppContext } from './context';
import { invalidateCachedPrincipals } from './principal-cache';
import { type AccessPolicy, assertKeepsAnAdmin, NO_SSO } from './team';

export interface RoleInput {
  readonly name: string;
  readonly description?: string;
  readonly scopes: readonly string[];
  readonly contentGrants?: readonly ContentTypeGrant[];
}

const KNOWN_SCOPES = new Set<string>(Object.values(SCOPES));
const LISTED = new Set<string>(LISTED_CONTENT_ACTIONS);
const IMPLIED = new Set<string>(IMPLIED_CONTENT_ACTIONS);

function validateRoleInput(input: RoleInput): void {
  const issues: { field: string; message: string }[] = [];
  if (!input.name?.trim()) issues.push({ field: 'name', message: 'Role name is required' });
  for (const scope of input.scopes ?? []) {
    if (!KNOWN_SCOPES.has(scope)) {
      issues.push({ field: 'scopes', message: `Unknown scope "${scope}"` });
    }
  }
  for (const grant of input.contentGrants ?? []) {
    if (!grant.contentTypeApiId?.trim()) {
      issues.push({ field: 'contentGrants', message: 'contentTypeApiId is required' });
    }
    // Read as strings: the input crossed a wire, and its type is what this proves.
    for (const action of (grant.actions ?? []) as readonly string[]) {
      if (IMPLIED.has(action)) {
        // One way to say it: `delete` and `unpublish` come with `write` and `publish`, so a grant
        // only ever names them to withhold them.
        issues.push({
          field: 'contentGrants',
          message: `"${action}" comes with ${action === 'delete' ? 'write or publish' : 'publish'}; list that, and withhold "${action}" with deniedActions`,
        });
      } else if (!LISTED.has(action)) {
        issues.push({ field: 'contentGrants', message: `Unknown action "${action}"` });
      }
    }
    for (const action of (grant.deniedActions ?? []) as readonly string[]) {
      if (!IMPLIED.has(action)) {
        issues.push({
          field: 'contentGrants',
          message: `deniedActions can withhold "delete" or "unpublish", not "${action}"`,
        });
      }
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

/** Creates a custom role (granular RBAC) in a space. */
export async function createRole(
  ctx: AppContext,
  spaceId: string,
  input: RoleInput,
): Promise<Role> {
  validateRoleInput(input);
  const role: Role = {
    id: ctx.ids.newId(),
    spaceId,
    name: input.name,
    description: input.description,
    scopes: [...input.scopes],
    contentGrants: [...(input.contentGrants ?? [])],
  };
  await ctx.store.roles.save(role);
  await invalidateCachedPrincipals(ctx, spaceId);
  return role;
}

/**
 * A delegated bearer (an OAuth or personal access token) can't widen an active API key by editing
 * the role it is bound to, as it can't by re-roling the key (`assignApiKeyRole`): new scopes, or
 * changed content grants, are refused while any such key holds the role. Narrowing scopes is not.
 */
async function refuseWideningKeys(ctx: AppContext, existing: Role, input: RoleInput) {
  const widens =
    input.scopes.some((s) => !existing.scopes.includes(s)) ||
    JSON.stringify(input.contentGrants ?? []) !== JSON.stringify(existing.contentGrants ?? []);
  if (!widens) return;
  const keys = await ctx.store.auth.list(existing.spaceId);
  if (keys.some((k) => k.roleId === existing.id && !k.revoked)) throw new DelegatedKeyMintError();
}

/**
 * Replaces a role's definition. Keys and people holding it pick the change up live. A preset
 * role stays that preset. Refused with `LastAdminError` when dropping `space:admin` would leave
 * the space with no administrator.
 */
export async function updateRole(
  ctx: AppContext,
  spaceId: string,
  id: string,
  input: RoleInput,
  policy: AccessPolicy = NO_SSO,
  editor?: Principal,
): Promise<Role> {
  validateRoleInput(input);
  const existing = await ctx.store.roles.get(spaceId, id);
  if (!existing) throw new NotFoundError('Role', id);
  if (editor && isDelegatedBearer(editor)) await refuseWideningKeys(ctx, existing, input);
  const role: Role = {
    id,
    spaceId,
    name: input.name,
    description: input.description,
    scopes: [...input.scopes],
    contentGrants: [...(input.contentGrants ?? [])],
    ...(existing.preset ? { preset: existing.preset } : {}),
  };
  if (grantsAdmin(existing.scopes) && !grantsAdmin(role.scopes)) {
    const roles = await ctx.store.roles.list(spaceId);
    await assertKeepsAnAdmin(ctx, spaceId, policy, {
      roles: roles.map((r) => (r.id === id ? role : r)),
    });
  }
  await ctx.store.roles.save(role);
  // Keys and people pick the change up on their next request, not when a cached principal expires.
  await invalidateCachedPrincipals(ctx, spaceId);
  return role;
}

export async function getRole(ctx: AppContext, spaceId: string, id: string): Promise<Role> {
  const role = await ctx.store.roles.get(spaceId, id);
  if (!role) throw new NotFoundError('Role', id);
  return role;
}

export async function listRoles(ctx: AppContext, spaceId: string): Promise<Role[]> {
  return ctx.store.roles.list(spaceId);
}

/**
 * Deletes a role. Refused for a built-in preset (edit or clone it instead), and while any active
 * API key or person still holds it.
 */
export async function deleteRole(ctx: AppContext, spaceId: string, id: string): Promise<void> {
  const role = await ctx.store.roles.get(spaceId, id);
  if (!role) throw new NotFoundError('Role', id);
  if (role.preset) {
    throw new ValidationError([
      { field: 'id', message: `“${role.name}” is a built-in role; edit or clone it instead` },
    ]);
  }
  const keys = await ctx.store.auth.list(spaceId);
  const holders = keys.filter((k) => k.roleId === id && !k.revoked);
  if (holders.length > 0) {
    throw new ValidationError([
      {
        field: 'id',
        message: `Role is assigned to ${holders.length} active API key(s); revoke them first`,
      },
    ]);
  }
  const people = (await ctx.store.members.list(spaceId)).filter((m) => m.roleId === id);
  if (people.length > 0) {
    throw new ValidationError([
      {
        field: 'id',
        message: `Role is held by ${people.length} person(s) on the team; change their role first`,
      },
    ]);
  }
  await ctx.store.roles.delete(spaceId, id);
  await invalidateCachedPrincipals(ctx, spaceId);
}
