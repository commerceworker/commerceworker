import { createFunction, deleteFunction, listFunctions } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerFunctionTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;
  // --- functions (event-triggered, HTTP-invoked) -------------------------
  server.registerTool(
    'functions_list',
    {
      description: 'List the user-defined functions registered in a space/environment.',
      inputSchema: toolSchema('functions_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listFunctions(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'function_create',
    {
      description:
        'Register a function: an HTTP endpoint invoked on events matching ' +
        'eventPattern (a glob on the event type, e.g. "entry.*" or "*").',
      inputSchema: toolSchema('function_create', () =>
        z.object({
          name: z.string(),
          eventPattern: z.string(),
          url: z.string(),
          active: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createFunction(ctx, scopeOf(args), {
          name: args.name,
          eventPattern: args.eventPattern,
          url: args.url,
          active: args.active,
        }),
      );
    },
  );

  server.registerTool(
    'function_delete',
    {
      description: 'Delete a registered function by id.',
      inputSchema: toolSchema('function_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      await deleteFunction(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );
}
