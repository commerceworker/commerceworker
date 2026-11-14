import {
  diffVersions,
  getPreviewEntry,
  getVersion,
  listVersions,
  restoreVersion,
  visibleDiff,
} from '@commerceworker/application';
import {
  assertWritableFields,
  authorizeContent,
  maskDeniedFields,
  SCOPES,
  withAuthorIdsFor,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, type ToolContext, toolSchema } from './shared';

const versionRef = z.union([z.number().int().positive(), z.enum(['draft', 'published'])]);

export function registerVersionTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { ctx, principal, guard, authorizeEntryRead } = t;
  // --- entry version history ---------------------------------------------
  server.registerTool(
    'entries_list_versions',
    {
      description: 'List every saved version of an entry, newest first.',
      inputSchema: toolSchema('entries_list_versions', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const type = await authorizeEntryRead(scopeOf(args), args.id);
      const items = (await listVersions(ctx, scopeOf(args), args.id)).map((v) =>
        withAuthorIdsFor(principal, { ...v, fields: maskDeniedFields(principal, type, v.fields) }),
      );
      return ok(items);
    },
  );

  server.registerTool(
    'entries_diff_versions',
    {
      description:
        'Compare two versions of an entry (from → to). Each side is a version number, "draft" ' +
        '(the current draft) or "published". Returns every field with its kind (added, removed, ' +
        'changed, unchanged) per locale, and for a change a typed detail: word-level text ' +
        'segments, link targets by id, list elements matched by key with moves, or rich-text ' +
        'blocks with word changes inside each changed block. Fields you may not read are left out; ' +
        'hiddenChanges counts the ones that changed.',
      inputSchema: toolSchema('entries_diff_versions', () =>
        z.object({
          id: z.string(),
          from: versionRef.describe('The baseline: a version number, "draft" or "published"'),
          to: versionRef.describe('The version compared against it'),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      await authorizeEntryRead(scopeOf(args), args.id);
      const diff = await diffVersions(ctx, scopeOf(args), args.id, args.from, args.to);
      return ok(visibleDiff(principal, diff));
    },
  );

  server.registerTool(
    'entries_restore_version',
    {
      description: 'Restore an older version by copying its fields into a new draft version.',
      inputSchema: toolSchema('entries_restore_version', () =>
        z.object({
          id: z.string(),
          version: z.number(),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("The entry's currentVersion as you read it; refused if it has changed since"),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
      authorizeContent(principal, 'write', entry.contentType);
      const target = await getVersion(ctx, scopeOf(args), args.id, args.version);
      assertWritableFields(principal, entry.contentType, target.fields);
      return ok(
        await restoreVersion(ctx, scopeOf(args), args.id, args.version, {
          expectedVersion: args.expectedVersion,
        }),
      );
    },
  );
}
