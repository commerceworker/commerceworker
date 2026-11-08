import {
  deleteEnvironment,
  deleteEnvironmentAlias,
  listEnvironmentAliases,
  setEnvironmentAlias,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DEFAULT_ENV, DEFAULT_SPACE, ok, type ToolContext, toolSchema } from './shared';

export function registerEnvironmentAliasTools(server: McpServer, t: ToolContext): void {
  const { ctx, principal, guard } = t;
  // --- environment aliases (blue/green) ----------------------------------
  server.registerTool(
    'environment_aliases_list',
    {
      description: 'List a space’s environment aliases (repointable pointers to environments).',
      inputSchema: toolSchema('environment_aliases_list', () =>
        z.object({ space: z.string().optional() }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.previewRead, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await listEnvironmentAliases(ctx, spaceId));
    },
  );

  server.registerTool(
    'environment_alias_set',
    {
      description: 'Create or atomically repoint an environment alias at a target environment.',
      inputSchema: toolSchema('environment_alias_set', () =>
        z.object({
          alias: z.string(),
          targetEnvironmentId: z.string(),
          space: z.string().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await setEnvironmentAlias(ctx, spaceId, args.alias, args.targetEnvironmentId));
    },
  );

  server.registerTool(
    'environment_alias_delete',
    {
      description: 'Delete an environment alias (the target environment is untouched).',
      inputSchema: toolSchema('environment_alias_delete', () =>
        z.object({ alias: z.string(), space: z.string().optional() }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      await deleteEnvironmentAlias(ctx, spaceId, args.alias);
      return ok({ deleted: args.alias });
    },
  );

  server.registerTool(
    'environment_delete',
    {
      description:
        'Delete an environment and everything in it (content model, entries, versions, assets, ' +
        'releases, workflows; its audit history stays). IRREVERSIBLE. Refuses `main` and any ' +
        'environment an alias points at. `confirm` must repeat the environment id.',
      inputSchema: toolSchema('environment_delete', () =>
        z.object({
          environment: z.string(),
          confirm: z.string().describe('the environment id again, to confirm'),
          space: z.string().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: args.environment });
      return ok(
        await deleteEnvironment(ctx, spaceId, args.environment, {
          confirm: args.confirm,
          principal,
        }),
      );
    },
  );
}
