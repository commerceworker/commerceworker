/**
 * Role presets and the people on a space's team: ordered roles mapped onto commerceworker's
 * scopes. A preset is not a
 * second permission system: each one is seeded into a space as an ordinary {@link Role} carrying
 * the scopes below, so keys, SSO people and the existing `authorize` checks treat it exactly like
 * a custom role. Each preset can do everything the presets before it can.
 */
import { DomainError } from '../errors';
import { type ContentTypeGrant, type PermissionScope, type Role, SCOPES } from './auth';

export const ROLE_PRESETS = ['viewer', 'approver', 'editor', 'manager', 'admin'] as const;
export type RolePreset = (typeof ROLE_PRESETS)[number];

export const isRolePreset = (v: unknown): v is RolePreset => ROLE_PRESETS.includes(v as RolePreset);

export interface RolePresetDefinition {
  readonly preset: RolePreset;
  /** The role's name as it is seeded: plain language. */
  readonly name: string;
  /** One line on what someone with it can do, in a reader's words. */
  readonly description: string;
  readonly scopes: readonly PermissionScope[];
  /**
   * Every content type (`*`), at the level the preset works at. A role-bound principal is denied
   * any type its grants don't name, so a preset without one could touch no content at all.
   */
  readonly contentGrants: readonly ContentTypeGrant[];
}

const READS: readonly ContentTypeGrant[] = [{ contentTypeApiId: '*', actions: ['read'] }];
const WRITES: readonly ContentTypeGrant[] = [
  { contentTypeApiId: '*', actions: ['read', 'write', 'publish'] },
];

const VIEWER: readonly PermissionScope[] = [
  SCOPES.previewRead,
  SCOPES.deliveryRead,
  SCOPES.searchRead,
];
const APPROVER: readonly PermissionScope[] = [...VIEWER, SCOPES.workflowApprove];
const EDITOR: readonly PermissionScope[] = [
  ...APPROVER,
  SCOPES.contentWrite,
  SCOPES.contentPublish,
];
const MANAGER: readonly PermissionScope[] = [...EDITOR, SCOPES.contentManage];
const ADMIN: readonly PermissionScope[] = [...MANAGER, SCOPES.spaceAdmin];

/**
 * The presets, in order. Starting and cancelling workflow runs and delivering workflow events
 * need `content:write`, so they arrive with Editor.
 */
export const ROLE_PRESET_DEFINITIONS: readonly RolePresetDefinition[] = [
  {
    preset: 'viewer',
    name: 'Viewer',
    description: 'Reads drafts, published content, workflows and approvals, and searches.',
    scopes: VIEWER,
    contentGrants: READS,
  },
  {
    preset: 'approver',
    name: 'Approver',
    description: 'Everything a viewer can do, and also approves or rejects workflow approvals.',
    scopes: APPROVER,
    contentGrants: READS,
  },
  {
    preset: 'editor',
    name: 'Editor',
    description:
      'Everything an approver can do, and also writes and publishes content, starts and cancels workflow runs, and delivers workflow events.',
    scopes: EDITOR,
    contentGrants: WRITES,
  },
  {
    preset: 'manager',
    name: 'Manager',
    description:
      'Everything an editor can do, and also changes how content is structured: content types, workflows, taxonomy, functions and AI actions.',
    scopes: MANAGER,
    contentGrants: WRITES,
  },
  {
    preset: 'admin',
    name: 'Administrator',
    description:
      'Everything a manager can do, and also manages the team, API keys, roles, webhooks, environments, plugins and the audit log.',
    scopes: ADMIN,
    contentGrants: WRITES,
  },
];

export function rolePresetDefinition(preset: RolePreset): RolePresetDefinition {
  const def = ROLE_PRESET_DEFINITIONS.find((d) => d.preset === preset);
  if (!def) throw new Error(`Unknown role preset "${preset}"`);
  return def;
}

/** The role a space's preset was seeded as (the first, should a race have seeded two). */
export function presetRole(roles: readonly Role[], preset: RolePreset): Role | undefined {
  return roles.find((r) => r.preset === preset);
}

/** True when a scope set administers its space: what "an admin" means for last-admin rules. */
export const grantsAdmin = (scopes: readonly string[]): boolean =>
  scopes.includes(SCOPES.spaceAdmin);

/**
 * A person on a space's team: who they are (an email and, once they sign in with SSO, the
 * provider's subject) and the role they hold. SSO sign-in resolves a person's role from here
 * before falling back to the group map, and a disabled person's sign-in is refused.
 */
export interface SpaceMember {
  readonly id: string;
  readonly spaceId: string;
  /** Lower-cased; unique within the space. */
  readonly email: string;
  readonly name?: string;
  /** The OIDC subject, linked on their first SSO sign-in. */
  readonly subject?: string;
  readonly roleId: string;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Normalizes an email for storage and comparison. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** A plausible email: one `@`, something on each side, a dot in the domain, no spaces. */
export const isEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * Refused because it would leave the space with no active administrator: the last admin can't
 * be demoted, disabled, removed or revoked, and a role can't lose `space:admin` while it is all
 * that makes anyone an admin. Maps to HTTP 409.
 */
export class LastAdminError extends DomainError {
  constructor(
    message = 'This is the last active administrator of the space. Make someone else an administrator first.',
  ) {
    super('last_admin', message);
  }
}
