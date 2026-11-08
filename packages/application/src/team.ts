/**
 * Role presets and the team (people + keys) on commerceworker's roles: presets are ordinary {@link Role}s seeded per space, people are
 * {@link SpaceMember}s whose role SSO sign-in resolves, and keys keep their live role binding.
 *
 * The one rule every change here obeys: a space that has an active administrator keeps one. The
 * last admin can't be demoted, disabled, removed or revoked, and a role can't lose `space:admin`
 * while it is all that makes anyone an admin ({@link LastAdminError}).
 */
import {
  type ApiKey,
  type ApiKeyKind,
  ConflictError,
  DelegatedKeyMintError,
  grantsAdmin,
  isDelegatedBearer,
  isEmail,
  isRolePreset,
  LastAdminError,
  NotFoundError,
  normalizeEmail,
  type Principal,
  presetRole,
  ROLE_PRESET_DEFINITIONS,
  type Role,
  type RolePreset,
  type SpaceMember,
  scopesForKind,
  type TokenIssuance,
  ValidationError,
} from '@commerceworker/domain';
import type { AppContext } from './context';
import { invalidateCachedPrincipals } from './principal-cache';

/**
 * What the deployment's sign-in looks like, as the composition root knows it. People (members)
 * can only sign in through SSO, so they count as administrators only when SSO is configured;
 * without it, an admin person with no key could never act.
 */
export interface AccessPolicy {
  readonly sso: boolean;
}

export const NO_SSO: AccessPolicy = { sso: false };

// ---- per-space access settings ------------------------------------------------------------------

/** A space's sign-in settings (deployment settings key `access:<spaceId>`). */
export interface AccessSettings {
  /**
   * People sign in only through SSO: the setup-issued administrator credential stops working.
   * Redeeming a setup (recovery) code turns it off.
   */
  readonly ssoOnly: boolean;
}

const accessKey = (spaceId: string) => `access:${spaceId}`;

export async function readAccessSettings(
  ctx: AppContext,
  spaceId: string,
): Promise<AccessSettings> {
  const stored = await ctx.store.settings.get(accessKey(spaceId));
  const value = (stored?.value ?? {}) as Partial<AccessSettings>;
  return { ssoOnly: value.ssoOnly === true };
}

/** Writes a space's access settings, retrying the compare-and-set on a concurrent write. */
export async function writeAccessSettings(
  ctx: AppContext,
  spaceId: string,
  next: AccessSettings,
): Promise<AccessSettings> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const stored = await ctx.store.settings.get(accessKey(spaceId));
    if (await ctx.store.settings.put(accessKey(spaceId), next, stored?.version ?? null)) {
      return next;
    }
  }
  throw new ConflictError('Access settings changed concurrently; try again');
}

/**
 * Turns SSO-only sign-in on or off. Turning it on needs SSO configured and an administrator who
 * signs in with it, so it can't lock every admin out (the setup code is still the way back).
 */
export async function setSsoOnly(
  ctx: AppContext,
  spaceId: string,
  ssoOnly: boolean,
  policy: AccessPolicy,
): Promise<AccessSettings> {
  if (ssoOnly) {
    if (!policy.sso) {
      throw new ValidationError([
        { field: 'ssoOnly', message: 'Single sign-on is not configured on this deployment' },
      ]);
    }
    const [members, roles] = await Promise.all([
      ctx.store.members.list(spaceId),
      ctx.store.roles.list(spaceId),
    ]);
    const byId = new Map(roles.map((r) => [r.id, r]));
    const ssoAdmin = members.some(
      (m) => !m.disabled && grantsAdmin(byId.get(m.roleId)?.scopes ?? []),
    );
    if (!ssoAdmin) {
      throw new ValidationError([
        {
          field: 'ssoOnly',
          message: 'Add a person with the Administrator role first, so someone can still sign in',
        },
      ]);
    }
  }
  const written = await writeAccessSettings(ctx, spaceId, {
    ...(await readAccessSettings(ctx, spaceId)),
    ssoOnly,
  });
  await invalidateCachedPrincipals(ctx, spaceId);
  return written;
}

// ---- presets --------------------------------------------------------------------------------------

/**
 * Seeds the built-in preset roles into a space (idempotent) and returns them in preset order.
 * A seed that races another is refused by the store's unique (space, preset) index; the winner's
 * role is read back instead.
 */
export async function ensureRolePresets(ctx: AppContext, spaceId: string): Promise<Role[]> {
  let roles = await ctx.store.roles.list(spaceId);
  for (const def of ROLE_PRESET_DEFINITIONS) {
    if (presetRole(roles, def.preset)) continue;
    const role: Role = {
      id: ctx.ids.newId(),
      spaceId,
      name: def.name,
      description: def.description,
      scopes: [...def.scopes],
      contentGrants: def.contentGrants.map((g) => ({ ...g, actions: [...g.actions] })),
      preset: def.preset,
    };
    try {
      await ctx.store.roles.save(role);
    } catch {
      // Another request seeded it first; fall through to the re-read.
    }
    roles = await ctx.store.roles.list(spaceId);
  }
  return ROLE_PRESET_DEFINITIONS.map((d) => presetRole(roles, d.preset)).filter(
    (r): r is Role => !!r,
  );
}

/** The id of a space's preset role, seeding the presets first when needed. */
export async function presetRoleId(
  ctx: AppContext,
  spaceId: string,
  preset: RolePreset,
): Promise<string> {
  const role = (await ensureRolePresets(ctx, spaceId)).find((r) => r.preset === preset);
  if (!role) throw new NotFoundError('Role preset', preset);
  return role.id;
}

export interface RolePresetSummary {
  readonly preset: RolePreset;
  /** The seeded role, which an admin may have renamed or edited. */
  readonly roleId: string;
  readonly name: string;
  readonly description?: string;
  /** The role's live scopes (an edited preset shows its edits). */
  readonly scopes: readonly string[];
}

/** The space's presets, in order, as their seeded roles read now. */
export async function listRolePresets(
  ctx: AppContext,
  spaceId: string,
): Promise<RolePresetSummary[]> {
  return (await ensureRolePresets(ctx, spaceId)).map((r) => ({
    preset: r.preset as RolePreset,
    roleId: r.id,
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    scopes: r.scopes,
  }));
}

/** Copies a role (preset or custom) into a new custom role that can be changed freely. */
export async function cloneRole(
  ctx: AppContext,
  spaceId: string,
  id: string,
  name?: string,
): Promise<Role> {
  const source = await ctx.store.roles.get(spaceId, id);
  if (!source) throw new NotFoundError('Role', id);
  const role: Role = {
    id: ctx.ids.newId(),
    spaceId,
    name: name?.trim() || `${source.name} (copy)`,
    ...(source.description ? { description: source.description } : {}),
    scopes: [...source.scopes],
    contentGrants: source.contentGrants.map((g) => ({ ...g })),
  };
  await ctx.store.roles.save(role);
  return role;
}

// ---- the last-admin rule ------------------------------------------------------------------------

export interface AdminHolder {
  readonly kind: 'key' | 'member';
  readonly id: string;
}

interface AdminView {
  readonly keys: readonly ApiKey[];
  readonly members: readonly SpaceMember[];
  readonly roles: readonly Role[];
}

/**
 * Who administers the space, as a pure read of its keys, people and roles. A key counts when it
 * is active, never expires (an SSO session's or OAuth client's short-lived token is not a seat),
 * and its effective scopes include `space:admin`. A setup credential counts unless the space
 * requires SSO. A person counts when SSO is configured, they are enabled, and their role
 * administers the space.
 */
export function adminHoldersOf(
  view: AdminView,
  policy: AccessPolicy,
  settings: AccessSettings = { ssoOnly: false },
): AdminHolder[] {
  const roles = new Map(view.roles.map((r) => [r.id, r]));
  const holders: AdminHolder[] = [];
  for (const k of view.keys) {
    if (k.revoked || k.expiresAt || k.issuance === 'oauth') continue;
    if (k.issuance === 'setup' && settings.ssoOnly) continue;
    let scopes: readonly string[] = k.scopes;
    if (k.roleId) {
      const role = roles.get(k.roleId);
      if (!role) continue; // a dangling role fails closed at authentication
      scopes =
        k.issuance === 'pat' || k.issuance === 'setup'
          ? role.scopes.filter((s) => k.scopes.includes(s))
          : role.scopes;
    }
    if (grantsAdmin(scopes)) holders.push({ kind: 'key', id: k.id });
  }
  if (policy.sso) {
    for (const m of view.members) {
      if (!m.disabled && grantsAdmin(roles.get(m.roleId)?.scopes ?? [])) {
        holders.push({ kind: 'member', id: m.id });
      }
    }
  }
  return holders;
}

/** The space's administrators now. */
export async function adminHolders(
  ctx: AppContext,
  spaceId: string,
  policy: AccessPolicy,
): Promise<AdminHolder[]> {
  const [keys, members, roles, settings] = await Promise.all([
    ctx.store.auth.list(spaceId),
    ctx.store.members.list(spaceId),
    ctx.store.roles.list(spaceId),
    readAccessSettings(ctx, spaceId),
  ]);
  return adminHoldersOf({ keys, members, roles }, policy, settings);
}

/**
 * Refuses a change that would take a space with an administrator down to none. `after` replaces
 * the parts of the space the change touches; the rest is read as it stands. A space with no
 * administrator already (only the deployment's ADMIN_TOKEN) is not blocked.
 */
export async function assertKeepsAnAdmin(
  ctx: AppContext,
  spaceId: string,
  policy: AccessPolicy,
  after: Partial<AdminView>,
): Promise<void> {
  const [keys, members, roles, settings] = await Promise.all([
    ctx.store.auth.list(spaceId),
    ctx.store.members.list(spaceId),
    ctx.store.roles.list(spaceId),
    readAccessSettings(ctx, spaceId),
  ]);
  const before = adminHoldersOf({ keys, members, roles }, policy, settings);
  if (before.length === 0) return;
  const next = adminHoldersOf(
    { keys: after.keys ?? keys, members: after.members ?? members, roles: after.roles ?? roles },
    policy,
    settings,
  );
  if (next.length === 0) throw new LastAdminError();
}

// ---- people -------------------------------------------------------------------------------------

export interface AddMemberInput {
  readonly email: string;
  readonly name?: string;
  /** A role id, or a preset name (`viewer` … `admin`). */
  readonly role: string;
}

/** A role by id, or the space's preset by name (seeding the presets first when needed). */
export async function resolveRoleRef(ctx: AppContext, spaceId: string, ref: string): Promise<Role> {
  if (isRolePreset(ref)) {
    const id = await presetRoleId(ctx, spaceId, ref);
    const role = await ctx.store.roles.get(spaceId, id);
    if (role) return role;
  }
  const role = await ctx.store.roles.get(spaceId, ref);
  if (!role) throw new NotFoundError('Role', ref);
  return role;
}

/** Adds a person to the team with a role. They sign in with SSO; their email links them. */
export async function addMember(
  ctx: AppContext,
  spaceId: string,
  input: AddMemberInput,
): Promise<SpaceMember> {
  const email = normalizeEmail(input.email ?? '');
  if (!isEmail(email)) {
    throw new ValidationError([{ field: 'email', message: 'A valid email address is required' }]);
  }
  if (await ctx.store.members.getByEmail(spaceId, email)) {
    throw new ConflictError(`${email} is already on the team`);
  }
  const role = await resolveRoleRef(ctx, spaceId, input.role);
  const now = ctx.clock.now().toISOString();
  const member: SpaceMember = {
    id: ctx.ids.newId(),
    spaceId,
    email,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    roleId: role.id,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.store.members.save(member);
  return member;
}

export interface UpdateMemberInput {
  /** A role id or preset name. */
  readonly role?: string;
  readonly disabled?: boolean;
  readonly name?: string;
}

/** Changes a person's role, name or whether they may sign in. Keeps the last admin. */
export async function updateMember(
  ctx: AppContext,
  spaceId: string,
  id: string,
  input: UpdateMemberInput,
  policy: AccessPolicy,
): Promise<SpaceMember> {
  const existing = await ctx.store.members.get(spaceId, id);
  if (!existing) throw new NotFoundError('Member', id);
  const roleId =
    input.role !== undefined
      ? (await resolveRoleRef(ctx, spaceId, input.role)).id
      : existing.roleId;
  const next: SpaceMember = {
    ...existing,
    roleId,
    disabled: input.disabled ?? existing.disabled,
    ...(input.name !== undefined ? { name: input.name.trim() || undefined } : {}),
    updatedAt: ctx.clock.now().toISOString(),
  };
  const members = await ctx.store.members.list(spaceId);
  await assertKeepsAnAdmin(ctx, spaceId, policy, {
    members: members.map((m) => (m.id === id ? next : m)),
  });
  await ctx.store.members.save(next);
  return next;
}

/** Removes a person from the team. Keeps the last admin. */
export async function removeMember(
  ctx: AppContext,
  spaceId: string,
  id: string,
  policy: AccessPolicy,
): Promise<void> {
  const existing = await ctx.store.members.get(spaceId, id);
  if (!existing) throw new NotFoundError('Member', id);
  const members = await ctx.store.members.list(spaceId);
  await assertKeepsAnAdmin(ctx, spaceId, policy, { members: members.filter((m) => m.id !== id) });
  await ctx.store.members.delete(spaceId, id);
}

/** The enabled person SSO sign-in should resolve to: by linked subject, else by email. */
export async function findMemberForSignIn(
  ctx: AppContext,
  spaceId: string,
  subject: string,
  email?: string,
): Promise<SpaceMember | null> {
  const members = await ctx.store.members.list(spaceId);
  const bySubject = subject ? members.find((m) => m.subject === subject) : undefined;
  // An email match only counts for a row not yet linked to anyone: a row linked to another
  // subject belongs to that person, even if this one now has (or once had) the same address.
  const byEmail = email
    ? members.find(
        (m) => m.email === normalizeEmail(email) && (!m.subject || m.subject === subject),
      )
    : undefined;
  const member = bySubject ?? byEmail ?? null;
  if (member && !member.subject && subject) {
    // First SSO sign-in links the provider's subject to the person.
    const linked = { ...member, subject, updatedAt: ctx.clock.now().toISOString() };
    await ctx.store.members.save(linked);
    return linked;
  }
  return member;
}

// ---- keys -----------------------------------------------------------------------------------------

/**
 * Binds a key to a role (or none). Keeps the last admin. A delegated bearer (`issuer`) may only
 * narrow a key: to scopes it already has, never off a role (which may restrict its content) and
 * never onto another role's grants.
 */
export async function assignApiKeyRole(
  ctx: AppContext,
  spaceId: string,
  keyId: string,
  roleRef: string | null,
  policy: AccessPolicy,
  issuer: Principal | 'system',
): Promise<ApiKey> {
  const keys = await ctx.store.auth.list(spaceId);
  const key = keys.find((k) => k.id === keyId);
  if (!key) throw new NotFoundError('ApiKey', keyId);
  if (key.revoked) throw new ValidationError([{ field: 'id', message: 'The key is revoked' }]);
  if (key.issuance === 'oauth') {
    throw new ValidationError([
      {
        field: 'id',
        message: 'A connected app’s token takes its role from the person who approved it',
      },
    ]);
  }
  const role = roleRef ? await resolveRoleRef(ctx, spaceId, roleRef) : undefined;
  // Unbinding falls back to the kind's defaults, as an unbound key always has.
  const scopes = role ? role.scopes : scopesForKind(key.kind);
  if (issuer !== 'system' && isDelegatedBearer(issuer)) {
    const current = key.roleId ? await ctx.store.roles.get(spaceId, key.roleId) : null;
    const held = current ? current.scopes : key.scopes;
    const widens =
      scopes.some((s) => !held.includes(s)) ||
      (key.roleId !== undefined &&
        (!role ||
          (role.id !== key.roleId &&
            JSON.stringify(role.contentGrants) !== JSON.stringify(current?.contentGrants))));
    // As `assertMayMintKeys` (auth.ts) refuses a delegated bearer minting a key.
    if (widens) throw new DelegatedKeyMintError();
  }
  const { roleId: _previous, ...unbound } = key;
  const next: ApiKey = role ? { ...key, roleId: role.id, scopes } : { ...unbound, scopes };
  await assertKeepsAnAdmin(ctx, spaceId, policy, {
    keys: keys.map((k) => (k.id === keyId ? next : k)),
  });
  await ctx.store.auth.setRole(keyId, role?.id, scopes);
  await invalidateCachedPrincipals(ctx, spaceId);
  return next;
}

export type PresetTarget = { readonly keyId: string } | { readonly memberId: string };

/** Gives a key or a person one of the space's preset roles. */
export async function assignRolePreset(
  ctx: AppContext,
  spaceId: string,
  target: PresetTarget,
  preset: RolePreset,
  policy: AccessPolicy,
  issuer: Principal | 'system',
): Promise<ApiKey | SpaceMember> {
  if (!isRolePreset(preset)) {
    throw new ValidationError([{ field: 'preset', message: `Unknown role preset "${preset}"` }]);
  }
  return 'keyId' in target
    ? assignApiKeyRole(ctx, spaceId, target.keyId, preset, policy, issuer)
    : updateMember(ctx, spaceId, target.memberId, { role: preset }, policy);
}

// ---- the team, as one read ------------------------------------------------------------------------

export interface TeamRole {
  readonly id: string;
  readonly name: string;
  readonly preset?: RolePreset;
}

export interface TeamPerson {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  readonly linked: boolean;
  readonly disabled: boolean;
  readonly role: TeamRole | null;
  readonly admin: boolean;
  readonly createdAt: string;
}

export interface TeamKey {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly issuance: TokenIssuance;
  readonly subject?: string;
  readonly role: TeamRole | null;
  readonly admin: boolean;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
}

export interface Team {
  readonly people: TeamPerson[];
  readonly keys: TeamKey[];
  /** How many administrators the space has; the UI warns before touching the last one. */
  readonly adminCount: number;
  readonly settings: AccessSettings;
}

/**
 * The space's people and its long-lived keys with their roles. Revoked keys, OAuth tokens and SSO
 * session keys (short-lived, minted per sign-in and named `oidc:<subject>`) are left out: they
 * are listed under API keys and Connected apps.
 */
export async function listTeam(
  ctx: AppContext,
  spaceId: string,
  policy: AccessPolicy,
): Promise<Team> {
  await ensureRolePresets(ctx, spaceId);
  const [keys, members, roles, settings] = await Promise.all([
    ctx.store.auth.list(spaceId),
    ctx.store.members.list(spaceId),
    ctx.store.roles.list(spaceId),
    readAccessSettings(ctx, spaceId),
  ]);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const roleOf = (id?: string): TeamRole | null => {
    const r = id ? byId.get(id) : undefined;
    return r ? { id: r.id, name: r.name, ...(r.preset ? { preset: r.preset } : {}) } : null;
  };
  const holders = adminHoldersOf({ keys, members, roles }, policy, settings);
  const isAdmin = (kind: AdminHolder['kind'], id: string) =>
    holders.some((h) => h.kind === kind && h.id === id);
  return {
    people: members.map((m) => ({
      id: m.id,
      email: m.email,
      ...(m.name ? { name: m.name } : {}),
      linked: !!m.subject,
      disabled: m.disabled,
      role: roleOf(m.roleId),
      admin: grantsAdmin(byId.get(m.roleId)?.scopes ?? []),
      createdAt: m.createdAt,
    })),
    keys: keys
      .filter((k) => !k.revoked && k.issuance !== 'oauth' && !k.name?.startsWith('oidc:'))
      .map((k) => ({
        id: k.id,
        kind: k.kind,
        ...(k.name ? { name: k.name } : {}),
        issuance: k.issuance ?? 'key',
        ...(k.subject ? { subject: k.subject } : {}),
        role: roleOf(k.roleId),
        admin: isAdmin('key', k.id),
        ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt } : {}),
        ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}),
      })),
    adminCount: holders.length,
    settings,
  };
}
