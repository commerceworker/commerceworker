import {
  createAppExtension,
  deleteAppExtension,
  listAppExtensions,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerAppExtensionTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { ctx, guard } = t;
  // --- app extensions (admin UI extensions) ------------------------------
  server.registerTool(
    'app_extensions_list',
    {
      description:
        'List the admin UI extensions (custom field editors / sidebar widgets) registered in a space/environment.',
      inputSchema: toolSchema('app_extensions_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listAppExtensions(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'app_extension_create',
    {
      description:
        'Register an admin UI extension rendered in a sandboxed iframe. target is ' +
        '"field-editor" (custom editor for the given fieldTypes) or "sidebar" (entry widget).',
      inputSchema: toolSchema('app_extension_create', () =>
        z.object({
          name: z.string(),
          target: z.enum(['field-editor', 'sidebar']),
          entryUrl: z.string(),
          fieldTypes: z.array(z.string()).optional(),
          active: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createAppExtension(ctx, scopeOf(args), {
          name: args.name,
          target: args.target,
          entryUrl: args.entryUrl,
          fieldTypes: args.fieldTypes,
          active: args.active,
        }),
      );
    },
  );

  server.registerTool(
    'app_extension_delete',
    {
      description: 'Delete a registered admin UI extension by id.',
      inputSchema: toolSchema('app_extension_delete', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      await deleteAppExtension(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );
}
