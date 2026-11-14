import { compareEnvironments, comparisonFor, mergeEnvironments } from '@commerceworker/application';
import { authorizeEveryContentType, SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, type ToolContext, toolSchema } from './shared';

export function registerEnvironmentMergeTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard, principal } = t;
  // --- branch compare/merge ----------------------------------------------
  server.registerTool(
    'environments_compare',
    {
      description: 'Diff two environments in a space (content types + entries that differ).',
      inputSchema: toolSchema('environments_compare', () =>
        z.object({
          source: z.string(),
          target: z.string(),
          space: z.string().optional(),
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? t.defaultScope.spaceId;
      guard(SCOPES.previewRead, { spaceId, environmentId: args.source });
      return ok(
        comparisonFor(principal, await compareEnvironments(ctx, spaceId, args.source, args.target)),
      );
    },
  );

  server.registerTool(
    'environments_merge',
    {
      description:
        'Apply selected content types/entries from a source environment into a target (additive).',
      inputSchema: toolSchema('environments_merge', () =>
        z.object({
          source: z.string(),
          target: z.string(),
          contentTypes: z.array(z.string()).optional(),
          entries: z.array(z.string()).optional(),
          space: z.string().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? t.defaultScope.spaceId;
      guard(SCOPES.contentManage, { spaceId, environmentId: args.target });
      // As the route: entries are copied whole, of any type, every field.
      if (args.entries?.length) authorizeEveryContentType(principal, ['read', 'write']);
      return ok(
        await mergeEnvironments(ctx, spaceId, args.source, args.target, {
          contentTypes: args.contentTypes,
          entries: args.entries,
        }),
      );
    },
  );
}
