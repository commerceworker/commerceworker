import { createAIAction, listAIActions, runAIAction } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerAiActionTools(server: McpServer, t: ToolContext): void {
  const { ctx, ai, guard } = t;
  // --- AI Actions (templated, governed operations) -----------------------
  server.registerTool(
    'ai_actions_list',
    {
      description: 'List the reusable AI Actions defined in a space/environment.',
      inputSchema: toolSchema('ai_actions_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listAIActions(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'ai_action_create',
    {
      description:
        'Create a reusable AI Action: a prompt template with {{variables}} and an ' +
        'optional targetField the run writes into. Variables are derived from the template.',
      inputSchema: toolSchema('ai_action_create', () =>
        z.object({
          name: z.string(),
          promptTemplate: z.string(),
          description: z.string().optional(),
          targetField: z.string().optional(),
          tier: z.enum(['flagship', 'balanced', 'fast']).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createAIAction(ctx, scopeOf(args), {
          name: args.name,
          promptTemplate: args.promptTemplate,
          description: args.description,
          targetField: args.targetField,
          tier: args.tier,
        }),
      );
    },
  );

  server.registerTool(
    'ai_action_run',
    {
      description:
        'Run a stored AI Action. Pass variables, and/or an entryId whose fields ' +
        'become {{field.<apiId>}}; apply=true writes the output into the targetField.',
      inputSchema: toolSchema('ai_action_run', () =>
        z.object({
          id: z.string(),
          entryId: z.string().optional(),
          variables: z.record(z.string(), z.string()).optional(),
          locale: z.string().optional(),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await runAIAction(ctx, ai, scopeOf(args), args.id, {
          entryId: args.entryId,
          variables: args.variables,
          locale: args.locale,
          apply: args.apply,
        }),
      );
    },
  );
}
