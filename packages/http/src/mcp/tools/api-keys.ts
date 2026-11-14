import {
  assignApiKeyRole,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { apiKeySummary } from '../../api/routes/management/shared';
import { keyRoleBody } from '../../api/routes/team';
import { createApiKeyBody } from '../../api/validation';
import { ok, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerApiKeyTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { deps, ctx, guard, principal, auditTarget } = t;
  const policy = deps.accessPolicy ?? { sso: false };
  // --- API keys (admin) ----------------------------------------------------
  // The `/spaces/:space/api-keys` routes' twins (and `…/api-keys/:id/role`'s): the same
  // use-cases, the same space-admin check, the same body schemas and projections (never the stored
  // hash). The key belongs to the `space` argument, the one the guard authorized. Minting and
  // widening refuse a delegated bearer (an OAuth or personal access token) in the use-case, on both
  // surfaces: a token a person handed to a program never turns itself into one that outlives it.

  server.registerTool(
    'api_keys_list',
    {
      description:
        "List a space's API keys (operator keys, and the OAuth and personal access tokens people " +
        'hold) with kind, scopes, role, revoked and last use. Never the token or its hash.',
      inputSchema: toolSchema('api_keys_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok({ items: (await listApiKeys(ctx, scopeOf(args).spaceId)).map(apiKeySummary) });
    },
  );

  server.registerTool(
    'api_key_create',
    {
      description:
        'Mint an API key for a space: kind cma (management), cda (delivery) or cpa (preview), an ' +
        "optional name, and the kind's default scopes unless scopes or a roleId is given. The " +
        'secret token is shown ONCE, in this result, and never again (only its hash is stored): ' +
        'hand it to whoever needs it now, or revoke the key. It does not expire. Refused to an ' +
        'OAuth or personal access token.',
      inputSchema: toolSchema('api_key_create', () => createApiKeyBody.extend(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      const created = await createApiKey(ctx, deps.hasher, {
        spaceId: scopeOf(args).spaceId,
        kind: args.kind,
        name: args.name,
        scopes: args.scopes,
        roleId: args.roleId,
        issuer: principal,
      });
      auditTarget.set(args, created.apiKey.id);
      return ok({ id: created.apiKey.id, kind: created.apiKey.kind, token: created.token });
    },
  );

  server.registerTool(
    'api_key_update',
    {
      description:
        "Change an API key's role: a role id or preset name (viewer, approver, editor, manager, " +
        "admin), or null to unbind it to its kind's default scopes. Refused for a revoked key, " +
        'an OAuth token, when it would leave the space with no administrator, and to an OAuth or ' +
        'personal access token when it would widen the key.',
      inputSchema: toolSchema('api_key_update', () =>
        keyRoleBody.extend({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      const key = await assignApiKeyRole(
        ctx,
        scopeOf(args).spaceId,
        args.id,
        args.role,
        policy,
        principal,
      );
      return ok({ id: key.id, roleId: key.roleId ?? null, scopes: key.scopes });
    },
  );

  server.registerTool(
    'api_key_revoke',
    {
      description:
        'Revoke an API key by id: it stops authenticating at once. Refused when it is the ' +
        "space's last administrator.",
      inputSchema: toolSchema('api_key_revoke', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: { destructiveHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      await revokeApiKey(ctx, scopeOf(args).spaceId, args.id, deps.accessPolicy);
      return ok({ revoked: args.id });
    },
  );
}
