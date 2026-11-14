import {
  duplicateEntry,
  getTrashSettings,
  listPreviewEntries,
  MAX_TRASH_RETENTION_DAYS,
  purgeEntry,
  restoreEntry,
  setTrashRetention,
  trashEntry,
} from '@commerceworker/application';
import {
  canAccessContentType,
  ENTRY_OPERATION_ACTIONS,
  maskDeniedFields,
  SCOPES,
  withAuthorIdsFor,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerTrashTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { deps, ctx, principal, guard, guardEntry, guardTrash } = t;
  // --- trash lifecycle ----------------------------------------------------
  server.registerTool(
    'entries_trash',
    {
      description:
        'Move an entry to the trash. Unpublishes it first when it is live, so ' +
        'delivery stops serving it. Recoverable with entries_restore. A role needs write and ' +
        'delete on the type (and unpublish, when its grant withholds it and the entry is live).',
      inputSchema: toolSchema('entries_trash', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardTrash(scopeOf(args), args.id);
      return ok(await trashEntry(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'entries_list_trashed',
    {
      description: 'List the entries currently in the trash.',
      inputSchema: toolSchema('entries_list_trashed', () =>
        z.object({
          contentType: z.string().optional(),
          limit: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const items = await listPreviewEntries(ctx, scopeOf(args), {
        contentTypeApiId: args.contentType,
        limit: args.limit,
        archived: true,
      });
      // The same projection as entries_query: denied fields masked, author ids for those who see them.
      return ok(
        items
          .filter((e) => canAccessContentType(principal, 'read', e.contentType))
          .map((e) =>
            withAuthorIdsFor(principal, {
              ...e,
              fields: maskDeniedFields(principal, e.contentType, e.fields),
            }),
          ),
      );
    },
  );

  server.registerTool(
    'entries_restore',
    {
      description:
        'Bring an entry back from the trash as a draft. Publishing it again is a ' +
        'separate action.',
      inputSchema: toolSchema('entries_restore', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'write');
      return ok(await restoreEntry(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'entries_purge',
    {
      description:
        'Permanently delete a trashed entry and every version of it. IRREVERSIBLE. ' +
        'Refuses while published entries still link to it unless force is true. A role ' +
        'needs publish and delete on the type.',
      inputSchema: toolSchema('entries_purge', () =>
        z.object({ id: z.string(), force: z.boolean().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      // Gated on content:publish, not content:write: this is the only entry
      // action that cannot be undone.
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, ENTRY_OPERATION_ACTIONS.purge);
      await purgeEntry(ctx, scopeOf(args), args.id, {
        force: args.force,
        ...(deps.blob ? { blob: deps.blob } : {}),
      });
      return ok({ purged: args.id });
    },
  );

  server.registerTool(
    'trash_settings_get',
    {
      description:
        'Read the space’s trash retention: retentionDays, or null when off (the default: trashed ' +
        'entries are kept until someone deletes them).',
      inputSchema: toolSchema('trash_settings_get', () => z.object({ ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getTrashSettings(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'trash_settings_set',
    {
      description:
        'Set the space’s trash retention. Entries in the trash longer than retentionDays are ' +
        'deleted PERMANENTLY by an hourly sweep, in every environment, including what is already ' +
        'in the trash; entries published entries link to are kept. null turns it off. Needs ' +
        'space:admin.',
      inputSchema: toolSchema('trash_settings_set', () =>
        z.object({
          retentionDays: z.number().int().min(1).max(MAX_TRASH_RETENTION_DAYS).nullable(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.spaceAdmin, s);
      return ok(await setTrashRetention(ctx, principal, s, args.retentionDays));
    },
  );

  server.registerTool(
    'entries_duplicate',
    {
      description:
        'Copy an entry, with its taxonomy metadata, into a new draft. A role needs read and ' +
        'write on the type; the copy holds every field, and answers without the ones the role ' +
        'may not read.',
      inputSchema: toolSchema('entries_duplicate', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      // Writing a copy is a write of that content type, not just a read: refused before it exists.
      await guardEntry(scopeOf(args), args.id, ['read', 'write']);
      const created = await duplicateEntry(ctx, scopeOf(args), args.id);
      return ok({
        ...created,
        entry: withAuthorIdsFor(principal, created.entry),
        fields: maskDeniedFields(principal, created.entry.contentTypeApiId, created.fields),
      });
    },
  );
}
