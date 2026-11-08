import { BLOCK_PATCH_MAX_OPS } from '@commerceworker/application';
import { z } from 'zod';
import { entry, entryFields } from './entries';

// --- key-addressed block patches ------------------------------------------------

const zKey = z.string().min(1).max(128);

const target = {
  field: z.string().min(1).max(64).describe('A top-level blocks field of the entry’s type'),
  locale: z
    .string()
    .min(2)
    .max(35)
    .optional()
    .describe('The locale of the field to edit (default: the default locale)'),
};

const parent = z
  .object({
    key: zKey.describe('The parent block’s _key, or a ref an earlier op named'),
    slot: z.string().min(1).max(64).describe('The blocks field of the parent’s type to use'),
  })
  .describe('Into this block’s slot; absent, the field itself');

const place = {
  parent: parent.optional(),
  before: zKey.optional().describe('Right before this sibling (a _key or a ref)'),
  after: zKey.optional().describe('Right after this sibling (a _key or a ref)'),
  index: z.int().min(0).optional().describe('At this index; none of the three: at the end'),
};

const ref = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    'A name for the new block: later ops address it by this, and `keys` maps it to its key',
  );

/**
 * One op of a patch. The same shape describes the request and the `inverse` the answer carries
 * (whose ops always name their locale and carry every key).
 */
export const blockOp = z
  .discriminatedUnion('op', [
    z.object({
      op: z.literal('insert'),
      ...target,
      ...place,
      block: z
        .object({ _type: z.string().min(1).max(64) })
        .loose()
        .describe(
          'The new block: its _type and field values. A _key it carries is kept when no block ' +
            'in the field holds it; missing keys (on it and on blocks inside it) are minted',
        ),
      ref,
    }),
    z.object({
      op: z.literal('update'),
      ...target,
      key: zKey,
      set: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Field apiId → new value; fields not named keep theirs'),
      unset: z.array(z.string()).optional().describe('Field apiIds to clear'),
    }),
    z.object({
      op: z.literal('move'),
      ...target,
      key: zKey,
      to: z.object(place).describe('Where it goes, judged without the block itself'),
    }),
    z.object({ op: z.literal('remove'), ...target, key: zKey }),
    z.object({
      op: z.literal('duplicate'),
      ...target,
      key: zKey,
      ref,
    }),
  ])
  .describe(
    'insert, update (a block’s own fields; never a field holding blocks), move (with its ' +
      'children; never into itself), remove (with its children) or duplicate (right after ' +
      'itself, fresh keys throughout)',
  );

export const blockPatchShape = {
  expectedVersion: z
    .int()
    .min(1)
    .describe('The currentVersion you read: a 409 when the entry has moved on since'),
  ops: z
    .array(blockOp)
    .min(1)
    .max(BLOCK_PATCH_MAX_OPS)
    .describe('Applied in order, each to the result of the ones before; all or none'),
};

export const blockPatchResult = z.object({
  entry,
  fields: entryFields,
  keys: z.record(z.string(), z.string()).describe('ref → the _key its block was given'),
  inverse: z
    .array(blockOp)
    .nullable()
    .describe(
      'The ops that undo this patch: send them with the new currentVersion to undo it. Null when ' +
        'an entry:beforeSave plugin changed the blocks the patch wrote, so no undo is offered',
    ),
});

export const blockPatchCheck = z.object({
  valid: z.literal(true),
  contentTypeApiId: z.string(),
  fields: entryFields.describe('The fields as the save would store them; nothing is written'),
  applied: z
    .array(blockOp)
    .describe('The patch as it would apply: refs, positions and locales resolved, keys present'),
  keys: z
    .record(z.string(), z.string())
    .describe('ref → the _key its block would be given (minted for this answer, never stored)'),
  skippedHooks: z
    .array(z.string())
    .describe('Plugins on entry:beforeSave that hold capabilities and so did not run'),
});

/**
 * Blocks nest (a block's slots hold blocks), so the children are described as open objects
 * rather than repeating this shape: `z.lazy` would emit a `$ref` cycle the reference renderer
 * does not draw well.
 */
export const blockOutline = z.object({
  key: z.string().nullable(),
  type: z.string().describe('Its _type'),
  name: z.string().describe('Its type’s name'),
  label: z.string().optional().describe('Its first non-empty text field, shortened'),
  path: z.string().describe('Where it sits, as validation issues name it: body[2].items[0]'),
  ambiguous: z
    .literal(true)
    .optional()
    .describe('Another block in the field holds the same _key, so ops can’t address it'),
  children: z
    .record(z.string(), z.array(z.object({}).loose()))
    .optional()
    .describe('Its non-empty slots: slot apiId → its blocks (this same shape)'),
});

export const blocksOutline = z.object({
  entryId: z.string(),
  version: z.int().describe('The version outlined: pass it as expectedVersion'),
  fields: z
    .record(z.string(), z.record(z.string(), z.array(blockOutline)))
    .describe('Blocks field apiId → locale → its blocks'),
});
