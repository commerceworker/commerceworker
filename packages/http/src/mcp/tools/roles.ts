import {
  assignRolePreset,
  createRole,
  deleteRole,
  listRolePresets,
  listRoles,
  listTeam,
  updateRole,
} from '@commerceworker/application';
import { ROLE_PRESETS, SCOPES, ValidationError } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { grantShape, ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerRoleTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, guard } = t;
  // --- roles (granular RBAC, admin) ----------------------------------------

  server.registerTool(
    'roles_list',
    {
      description: 'List the custom roles (granular RBAC) defined in a space.',
      inputSchema: toolSchema('roles_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listRoles(ctx, scopeOf(args).spaceId));
    },
  );

  server.registerTool(
    'role_create',
    {
      description:
        'Create a custom role: a scope set plus per-content-type grants with ' +
        'optional per-field deny/read-only rules. Assign it via api_key roleId.',
      inputSchema: toolSchema('role_create', () =>
        z.object({
          name: z.string(),
          description: z.string().optional(),
          scopes: z.array(z.string()).describe('permission scopes, e.g. content:write'),
          contentGrants: z.array(grantShape).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await createRole(ctx, scopeOf(args).spaceId, {
          name: args.name,
          description: args.description,
          scopes: args.scopes,
          contentGrants: args.contentGrants,
        }),
      );
    },
  );

  server.registerTool(
    'role_update',
    {
      description: 'Replace a role definition; keys bound to it pick the change up live.',
      inputSchema: toolSchema('role_update', () =>
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          scopes: z.array(z.string()),
          contentGrants: z.array(grantShape).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await updateRole(
          ctx,
          scopeOf(args).spaceId,
          args.id,
          {
            name: args.name,
            description: args.description,
            scopes: args.scopes,
            contentGrants: args.contentGrants,
          },
          deps.accessPolicy,
          t.principal,
        ),
      );
    },
  );

  server.registerTool(
    'role_delete',
    {
      description: 'Delete a role (refused while any active API key still references it).',
      inputSchema: toolSchema('role_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      await deleteRole(ctx, scopeOf(args).spaceId, args.id);
      return ok({ deleted: args.id });
    },
  );

  // --- role presets + team (admin; same use-cases as /spaces/:space/{role-presets,team}) ------
  // First-run setup is deliberately not a tool: it is a person with a setup code, over HTTP.
  const accessPolicy = deps.accessPolicy ?? { sso: false };

  server.registerTool(
    'role_presets_list',
    {
      description:
        'List the built-in role presets (Viewer, Approver, Editor, Manager, Administrator) with ' +
        'the role id each is seeded as in the space and its live scopes. Each preset includes ' +
        'everything the one before it can do.',
      inputSchema: toolSchema('role_presets_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listRolePresets(ctx, scopeOf(args).spaceId));
    },
  );

  server.registerTool(
    'team_list',
    {
      description:
        'List the team: people (SSO sign-in) and long-lived API keys with their roles, which of ' +
        'them are administrators, and the admin count (the last admin cannot be demoted).',
      inputSchema: toolSchema('team_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listTeam(ctx, scopeOf(args).spaceId, accessPolicy));
    },
  );

  server.registerTool(
    'role_preset_assign',
    {
      description:
        'Give an API key (keyId) or a person (memberId) one of the role presets. Refused when it ' +
        'would leave the space with no administrator.',
      inputSchema: toolSchema('role_preset_assign', () =>
        z.object({
          preset: z.enum(ROLE_PRESETS),
          keyId: z.string().optional(),
          memberId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      if (!args.keyId === !args.memberId) {
        throw new ValidationError([
          { field: 'keyId', message: 'Give exactly one of keyId or memberId' },
        ]);
      }
      const target = args.keyId ? { keyId: args.keyId } : { memberId: args.memberId as string };
      return ok(
        await assignRolePreset(
          ctx,
          scopeOf(args).spaceId,
          target,
          args.preset,
          accessPolicy,
          t.principal,
        ),
      );
    },
  );
}
