import {
  authorizeBlockPatch,
  BLOCK_PATCH_MAX_BYTES,
  BLOCK_PATCH_MAX_OPS,
  type BlockOpInput,
  checkEntryBlocks,
  outlineEntryBlocks,
  patchEntryBlocks,
} from '@commerceworker/application';
import { maskDeniedFields, SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as blockDocs from '../../docs/schemas/blocks';
import { blockPatchBody, blockPatchCheckBody, parseBody } from '../../validation';
import { actingCtx, BASE, entryAccess, scopeOf } from './shared';

export function blocksRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const { authorizeEntryRead } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- key-addressed edits to an entry's blocks fields ------------------------------
  // A dry run of a patch: the same checks, the same errors, nothing written. Gated like the patch
  // it stands in for, so it tells a caller nothing a patch wouldn't.
  app.post(
    `${BASE}/entries/blocks/validate`,
    doc('Entries', 'Check a block patch without saving it', {
      body: blockPatchCheckBody,
      ok: blockDocs.blockPatchCheck,
      description:
        'Runs exactly the checks `PATCH …/entries/:id/blocks` makes, failing with the same ' +
        'errors (409 for a stale `expectedVersion`, 403 for a field your role may not write, 422 ' +
        'naming the op that can’t apply or the field the result breaks), and answers the fields ' +
        'as the save would store them with the patch as it would apply. Nothing is written; the ' +
        'keys minted for new blocks are this answer’s only.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const { entryId, ...patch } = await parseBody(c, blockPatchCheckBody);
      const principal = c.get('principal');
      const access = await authorizeBlockPatch(ctx, scopeOf(c), principal, entryId);
      const checked = await checkEntryBlocks(
        ctx,
        scopeOf(c),
        entryId,
        { expectedVersion: patch.expectedVersion, ops: patch.ops as readonly BlockOpInput[] },
        access,
      );
      // Judged with the stored values of the fields this writer may not write; answered without
      // the ones it may not read.
      return c.json({
        ...checked,
        fields: maskDeniedFields(principal, checked.contentTypeApiId, checked.fields),
      });
    },
  );
  app.get(
    `${BASE}/entries/:id/blocks`,
    doc('Entries', 'Outline an entry’s blocks', {
      ok: blockDocs.blocksOutline,
      description:
        'The current draft’s blocks fields as a compact tree: each block’s _key, _type, type ' +
        'name, a label, its path and the blocks in its slots, none of its other values. Build a ' +
        'block patch from it, passing `version` as `expectedVersion`. A block marked ' +
        '`ambiguous` shares its _key with another block in the field and can’t be patched by it.',
      query: {
        field: 'Only this blocks field',
        locale: 'Only this locale',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const id = c.req.param('id');
      const type = await authorizeEntryRead(c, id);
      const field = c.req.query('field');
      const locale = c.req.query('locale');
      const outline = await outlineEntryBlocks(ctx, scopeOf(c), id, {
        ...(field ? { field } : {}),
        ...(locale ? { locale } : {}),
      });
      return c.json({
        ...outline,
        fields: maskDeniedFields(c.get('principal'), type, outline.fields),
      });
    },
  );
  app.patch(
    `${BASE}/entries/:id/blocks`,
    doc('Entries', 'Patch an entry’s blocks', {
      body: blockPatchBody,
      ok: blockDocs.blockPatchResult,
      description:
        'Inserts, updates, moves, removes and duplicates blocks of the entry’s blocks fields by ' +
        '_key, and saves the result as a new draft version (publish to put it live), judged as ' +
        'any save is. Ops apply in order, each to the result of the ones before; one that can’t ' +
        'apply refuses the whole patch with 422, its issue naming the op (`op`, and ' +
        '`field: ops[i]`). A key two blocks of the field share is refused as ambiguous. 409 ' +
        'when the entry is no longer at `expectedVersion`; 403 for an op on a field your role ' +
        `may not write. At most ${BLOCK_PATCH_MAX_OPS} ops and ${BLOCK_PATCH_MAX_BYTES / 1024} ` +
        'KB of them. The answer maps each `ref` to the _key it was given and carries the ' +
        '`inverse` ops that undo the patch (null when an entry:beforeSave plugin changed the ' +
        'blocks it wrote).',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, blockPatchBody);
      const id = c.req.param('id');
      const principal = c.get('principal');
      const access = await authorizeBlockPatch(ctx, scopeOf(c), principal, id);
      const saved = await patchEntryBlocks(
        actingCtx(ctx, c),
        scopeOf(c),
        id,
        { expectedVersion: body.expectedVersion, ops: body.ops as readonly BlockOpInput[] },
        access,
      );
      // The save wrote the whole entry; the answer shows only the fields the caller may read.
      return c.json({
        ...saved,
        fields: maskDeniedFields(principal, saved.entry.contentTypeApiId, saved.fields),
      });
    },
  );

  return app;
}
