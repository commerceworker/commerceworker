import { analyzeImport, executeImport } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { importArgs, ok, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerImportTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, guard, principal } = t;
  // --- importing content from elsewhere -------------------------------------
  const toImport = (args: Record<string, unknown>) => ({
    payload: args.payload as string,
    mapping: {
      contentTypeApiId: args.contentTypeApiId as string,
      fields: args.fields as Record<string, string>,
      ...(args.identityField ? { identityField: args.identityField as string } : {}),
      ...(args.locale ? { locale: args.locale as string } : {}),
    },
    ...(args.sourceOptions ? { sourceOptions: args.sourceOptions as Record<string, unknown> } : {}),
  });
  const importSource = (id: string) => {
    const found = deps.importSources?.[id];
    if (!found) {
      const known = Object.keys(deps.importSources ?? {}).join(', ') || 'none';
      throw new Error(`Unknown import source "${id}". Available: ${known}`);
    }
    return found;
  };

  server.registerTool(
    'import_sources',
    {
      description: 'List the external content formats this deployment can read.',
      inputSchema: toolSchema('import_sources', () => z.object({})),
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok(Object.values(deps.importSources ?? {}).map((s) => ({ id: s.id, name: s.name }))),
  );

  server.registerTool(
    'import_analyze',
    {
      description:
        'Report what importing a payload would create, update and skip — including the ' +
        'source fields nothing maps to and the records that would fail. Writes nothing. ' +
        'Run this before import_execute; it is the same computation without the commit.',
      inputSchema: toolSchema('import_analyze', () => z.object(importArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await analyzeImport(
          ctx,
          principal,
          scopeOf(args),
          importSource(args.source),
          toImport(args),
          {
            ...(args.conflicts ? { conflicts: args.conflicts } : {}),
          },
        ),
      );
    },
  );

  server.registerTool(
    'import_execute',
    {
      description:
        'Import a payload. Entries are created through the same use-cases as any other ' +
        'write, arrive as drafts, and a record that fails validation is skipped and reported ' +
        'rather than aborting the run.',
      inputSchema: toolSchema('import_execute', () => z.object(importArgs)),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await executeImport(
          ctx,
          principal,
          scopeOf(args),
          importSource(args.source),
          toImport(args),
          {
            ...(args.conflicts ? { conflicts: args.conflicts } : {}),
          },
        ),
      );
    },
  );
}
