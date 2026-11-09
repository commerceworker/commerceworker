import { analyzeSpaceExport, startSpaceExportImport } from '@commerceworker/application';
import {
  authorizeEveryContentType,
  SCOPES,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { spaceExportImportBody } from '../../api/validation';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerSpaceExportTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, guard, principal } = t;
  // --- importing a whole space from the JSON space export format --------------
  const spaceExportArgs = {
    payload: spaceExportImportBody.shape.payload.describe('The export file, as JSON text'),
    publish: z
      .boolean()
      .optional()
      .describe('publish what the export marks published (default true)'),
    addLocales: z
      .boolean()
      .optional()
      .describe("add the export's locales the space lacks (needs space:admin)"),
    ...scopeArgs,
  };
  /** The reader, and the input with `addLocales` only for a caller who may change the space. */
  const spaceExport = (
    args: { payload: string; publish?: boolean; addLocales?: boolean } & Scope,
  ) => {
    if (args.addLocales) guard(SCOPES.spaceAdmin, args);
    // As the route: it writes (and publishes) entries of every type the export defines.
    authorizeEveryContentType(principal, args.publish !== false ? ['write', 'publish'] : ['write']);
    return {
      reader: deps.spaceExportReader,
      input: {
        payload: args.payload,
        ...(args.publish !== undefined ? { publish: args.publish } : {}),
        ...(args.addLocales ? { addLocales: true } : {}),
      },
    };
  };

  server.registerTool(
    'space_export_analyze',
    {
      description:
        'Report what importing a JSON space export (contentTypes, entries, assets, locales, ' +
        'tags) into this environment would do: counts, fields and validations with no ' +
        'equivalent, links whose target is not imported, entries that would fail validation, ' +
        'and the problems that stop it (executable: false). Writes nothing. Run this before ' +
        'space_export_import.',
      inputSchema: toolSchema('space_export_analyze', () => z.object(spaceExportArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const target = scopeOf(args);
      guard(SCOPES.contentManage, target);
      const { reader, input } = spaceExport({ ...args, ...target });
      return ok(await analyzeSpaceExport(ctx, target, reader, input));
    },
  );

  server.registerTool(
    'space_export_import',
    {
      description:
        'Import a JSON space export into this environment, which must have no content types. ' +
        'Checks what space_export_analyze checks, then writes the content model and tags and ' +
        'starts a job that copies each asset file from its URL and creates the assets and ' +
        'entries with new ids (every link remapped). Result: `{ report, job, publishJobId }`; ' +
        'follow `job` with bulk_job_status, then `publishJobId`, which publishes what the ' +
        'export marks published once `job` completes with no failures.',
      inputSchema: toolSchema('space_export_import', () => z.object(spaceExportArgs)),
    },
    async (args) => {
      const target = scopeOf(args);
      guard(SCOPES.contentManage, target);
      const { reader, input } = spaceExport({ ...args, ...target });
      if (!deps.blob) {
        throw new ValidationError([
          {
            field: 'payload',
            message: 'This deployment has no object storage to stage an import in',
          },
        ]);
      }
      return ok(await startSpaceExportImport(ctx, deps.blob, target, reader, input));
    },
  );
}
