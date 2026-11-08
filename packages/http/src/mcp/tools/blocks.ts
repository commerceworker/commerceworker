import {
  authorizeBlockPatch,
  type BlockOpInput,
  checkEntryBlocks,
  getEntry,
  outlineEntryBlocks,
  patchEntryBlocks,
} from '@commerceworker/application';
import { authorizeContent, maskDeniedFields, SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { blockPatchShape } from '../../api/docs/schemas/blocks';
import { ok, READ_ONLY, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerBlockTools(server: McpServer, t: ToolContext): void {
  const { ctx, principal, guard } = t;
  // --- key-addressed edits to an entry's blocks fields ------------------------------
  server.registerTool(
    'entry_blocks_validate',
    {
      description:
        'Check an entry_blocks_patch without saving it: exactly the checks the patch makes, failing ' +
        'with the same errors (a stale expectedVersion, a field your role may not write, the op ' +
        'that can’t apply or the field the result breaks). Writes nothing. Answers the fields as ' +
        'the save would store them and the patch as it would apply (refs, positions and locales ' +
        'resolved); keys minted for new blocks are this answer’s only.',
      inputSchema: toolSchema('entry_blocks_validate', () =>
        z.object({ id: z.string(), ...blockPatchShape, ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const access = await authorizeBlockPatch(ctx, scopeOf(args), principal, args.id);
      const checked = await checkEntryBlocks(
        ctx,
        scopeOf(args),
        args.id,
        { expectedVersion: args.expectedVersion, ops: args.ops as readonly BlockOpInput[] },
        access,
      );
      // As the route does: the answer shows only the fields the caller may read.
      return ok({
        ...checked,
        fields: maskDeniedFields(principal, checked.contentTypeApiId, checked.fields),
      });
    },
  );

  server.registerTool(
    'entry_blocks_outline',
    {
      description:
        "An entry's blocks fields (current draft) as a compact tree: per field and locale, each " +
        'block’s key, _type, type name, label, path (body[2].items[0]) and the blocks in its ' +
        'slots (children, by slot apiId), none of its other values. Read it before ' +
        'entry_blocks_patch, and pass its version as expectedVersion. A block marked ambiguous ' +
        'shares its key with another and can’t be patched by it.',
      inputSchema: toolSchema('entry_blocks_outline', () =>
        z.object({
          id: z.string(),
          field: z.string().optional().describe('Only this blocks field'),
          locale: z.string().optional().describe('Only this locale'),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const { entry } = await getEntry(ctx, scopeOf(args), args.id);
      authorizeContent(principal, 'read', entry.contentTypeApiId);
      const outline = await outlineEntryBlocks(ctx, scopeOf(args), args.id, {
        ...(args.field ? { field: args.field } : {}),
        ...(args.locale ? { locale: args.locale } : {}),
      });
      // As the route does: no outline of a field the caller may not read.
      return ok({
        ...outline,
        fields: maskDeniedFields(principal, entry.contentTypeApiId, outline.fields),
      });
    },
  );

  server.registerTool(
    'entry_blocks_patch',
    {
      description:
        "Edit an entry's blocks by _key and save a new draft version (publish to put it live): " +
        'insert {field, locale?, parent?: {key, slot}, before|after|index, block: {_type, …}, ' +
        'ref?}, update {field, key, set?, unset?} (the block’s own fields; never a field holding ' +
        'blocks), move {field, key, to: {parent?, before|after|index}}, remove {field, key}, ' +
        'duplicate {field, key, ref?}. Ops apply in order, all or none; a later op can address ' +
        'a new block by its ref. Pass the version entry_blocks_outline or entries_get gave as ' +
        'expectedVersion (refused if the entry changed since). Answers the saved entry, keys ' +
        '(ref → _key) and inverse: the ops that undo it (null when a plugin rewrote the blocks).',
      inputSchema: toolSchema('entry_blocks_patch', () =>
        z.object({ id: z.string(), ...blockPatchShape, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const access = await authorizeBlockPatch(ctx, scopeOf(args), principal, args.id);
      const saved = await patchEntryBlocks(
        ctx,
        scopeOf(args),
        args.id,
        { expectedVersion: args.expectedVersion, ops: args.ops as readonly BlockOpInput[] },
        access,
      );
      // As the route does: the answer shows only the fields the caller may read.
      return ok({
        ...saved,
        fields: maskDeniedFields(principal, saved.entry.contentTypeApiId, saved.fields),
      });
    },
  );
}
