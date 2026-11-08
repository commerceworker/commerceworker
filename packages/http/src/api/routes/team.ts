/**
 * The team (people + keys with their roles), the built-in role presets, and a space's sign-in
 * settings. Mounted after `managementRoutes`, whose `/spaces/*` principal and audit middleware
 * cover these routes too. The same use-cases back the MCP tools (`role_presets_list`,
 * `team_list`, `role_preset_assign`).
 */
import {
  addMember,
  assignApiKeyRole,
  cloneRole,
  listRolePresets,
  listTeam,
  removeMember,
  setSsoOnly,
  updateMember,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthDeps, type AuthVars, requireScope } from '../auth';
import { doc } from '../docs/openapi';
import { parseBody, zId, zShort } from '../validation';

/** A role id, or a preset name (`viewer`, `approver`, `editor`, `manager`, `admin`). */
const zRoleRef = zId;

export const addMemberBody = z.object({
  email: z.string().min(3).max(320),
  name: zShort.optional(),
  role: zRoleRef,
});
export const updateMemberBody = z.object({
  role: zRoleRef.optional(),
  disabled: z.boolean().optional(),
  name: zShort.optional(),
});
export const keyRoleBody = z.object({ role: zRoleRef.nullable() });
export const cloneRoleBody = z.object({ name: zShort.optional() });
export const accessSettingsBody = z.object({ ssoOnly: z.boolean() });

export function teamRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const policy = deps.accessPolicy ?? { sso: false };
  const app = new Hono<AuthVars>();
  const admin = requireScope(SCOPES.spaceAdmin);

  app.get(
    '/spaces/:space/team',
    doc('Auth', 'List the team: people and long-lived keys with their roles', {
      description:
        'People (who sign in with SSO) and API keys with their role and whether each counts as ' +
        'an administrator. `adminCount` is how many administrators the space has: the last one ' +
        'cannot be demoted, disabled, removed or revoked.',
    }),
    admin,
    async (c) =>
      c.json({ ...(await listTeam(ctx, c.req.param('space'), policy)), sso: policy.sso }),
  );

  app.get(
    '/spaces/:space/role-presets',
    doc('Auth', 'List the built-in role presets', {
      description:
        'Viewer, Approver, Editor, Manager and Administrator, each seeded into the space as an ' +
        'editable role. Each includes everything the one before it can do.',
    }),
    admin,
    async (c) => c.json({ items: await listRolePresets(ctx, c.req.param('space')) }),
  );

  app.post(
    '/spaces/:space/roles/:id/clone',
    doc('Auth', 'Clone a role into a new custom role', { body: cloneRoleBody, status: 201 }),
    admin,
    async (c) => {
      const body = await parseBody(c, cloneRoleBody);
      return c.json(await cloneRole(ctx, c.req.param('space'), c.req.param('id'), body.name), 201);
    },
  );

  app.post(
    '/spaces/:space/members',
    doc('Auth', 'Add a person to the team', {
      body: addMemberBody,
      status: 201,
      description: 'They sign in with SSO; their email links them on first sign-in.',
    }),
    admin,
    async (c) =>
      c.json(await addMember(ctx, c.req.param('space'), await parseBody(c, addMemberBody)), 201),
  );

  app.patch(
    '/spaces/:space/members/:id',
    doc('Auth', 'Change a person’s role, name or access', {
      body: updateMemberBody,
      description:
        'Refused with 409 `last_admin` when it would leave the space with no administrator.',
    }),
    admin,
    async (c) =>
      c.json(
        await updateMember(
          ctx,
          c.req.param('space'),
          c.req.param('id'),
          await parseBody(c, updateMemberBody),
          policy,
        ),
      ),
  );

  app.delete(
    '/spaces/:space/members/:id',
    doc('Auth', 'Remove a person from the team', { status: 204 }),
    admin,
    async (c) => {
      await removeMember(ctx, c.req.param('space'), c.req.param('id'), policy);
      return c.body(null, 204);
    },
  );

  app.put(
    '/spaces/:space/api-keys/:id/role',
    doc('Auth', 'Change an API key’s role', {
      body: keyRoleBody,
      description:
        'A role id or preset name; `null` unbinds the key (its kind’s default scopes). Refused ' +
        'with 409 `last_admin` when it would leave the space with no administrator, and with 403 ' +
        'to a personal access token or an OAuth token when it would widen the key.',
    }),
    admin,
    async (c) => {
      const body = await parseBody(c, keyRoleBody);
      const key = await assignApiKeyRole(
        ctx,
        c.req.param('space'),
        c.req.param('id'),
        body.role,
        policy,
        c.get('principal'),
      );
      return c.json({ id: key.id, roleId: key.roleId ?? null, scopes: key.scopes });
    },
  );

  app.put(
    '/spaces/:space/access-settings',
    doc('Auth', 'Change how people sign in to the space', {
      body: accessSettingsBody,
      description:
        '`ssoOnly`: people sign in only through SSO, and the administrator credential setup ' +
        'created stops working. Needs SSO configured and an administrator on the team.',
    }),
    admin,
    async (c) => {
      const body = await parseBody(c, accessSettingsBody);
      return c.json(await setSsoOnly(ctx, c.req.param('space'), body.ssoOnly, policy));
    },
  );

  return app;
}
