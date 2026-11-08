import { z } from 'zod';

// The readable entry diff (`diffEntryFields` in the domain): typed parts, never markup.

const diffKind = z.enum(['added', 'removed', 'changed', 'unchanged']);

const textSegment = z.object({
  kind: z.enum(['added', 'removed', 'unchanged']),
  text: z.string(),
});

const linkRef = z.object({ id: z.string(), linkType: z.enum(['Entry', 'Asset']) });

const richTextBlock = z.object({
  kind: diffKind,
  moved: z.literal(true).optional().describe('In both versions, elsewhere among its neighbours'),
  nodeType: z.string().describe('paragraph, heading-2, list-item, table-row, embed, …'),
  beforeNodeType: z.string().optional().describe('Its type before, when the edit changed it'),
  depth: z.int().describe('List nesting: 0 for a top-level block, 1 for a top-level list item'),
  container: z.string().optional().describe('ordered-list, unordered-list or table'),
  text: z.array(textSegment).describe('The block text; a word-level diff when it changed'),
  formattingChanged: z.literal(true).optional().describe('Same text, different marks or links'),
  target: linkRef.optional().describe('What an embedded entry or asset block shows'),
  beforeTarget: linkRef.optional().describe('What it showed before, when swapped'),
});

const nestedFieldDiff = z.object({
  field: z.string(),
  name: z.string().optional(),
  fieldType: z.string().optional(),
  kind: diffKind,
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  get detail() {
    return valueDiff.optional();
  },
});

const listItemDiff = z.object({
  kind: diffKind,
  moved: z.literal(true).optional(),
  beforeIndex: z.int().nullable(),
  afterIndex: z.int().nullable(),
  key: z.string().optional().describe("A block's _key"),
  variant: z.string().optional().describe("A block's _type"),
  link: linkRef.optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  get detail() {
    return valueDiff.optional();
  },
});

const valueDiff: z.ZodType = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('text'), segments: z.array(textSegment) }),
    z.object({ type: z.literal('value'), before: z.unknown(), after: z.unknown() }),
    z.object({ type: z.literal('link'), before: linkRef.nullable(), after: linkRef.nullable() }),
    z.object({ type: z.literal('component'), fields: z.array(nestedFieldDiff) }),
    z.object({ type: z.literal('list'), items: z.array(listItemDiff) }),
    z.object({ type: z.literal('richText'), blocks: z.array(richTextBlock) }),
  ])
  .meta({ id: 'EntryValueDiff' })
  .describe('How one value changed, by field type');

const fieldDiff = z.object({
  field: z.string().describe('Field apiId'),
  name: z.string().optional().describe("The field's name in the content type"),
  fieldType: z.string().optional(),
  kind: diffKind,
  before: z.record(z.string(), z.unknown()).optional().describe('Locale → value, before'),
  after: z.record(z.string(), z.unknown()).optional().describe('Locale → value, after'),
  locales: z.array(
    z.object({
      locale: z.string(),
      kind: diffKind,
      before: z.unknown().optional(),
      after: z.unknown().optional(),
      detail: valueDiff.optional(),
    }),
  ),
});

export const versionDiff = z.object({
  entryId: z.uuid(),
  contentType: z.string().describe('Content type apiId'),
  from: z.int().describe('The baseline version'),
  to: z.int().describe('The version compared against it'),
  changes: z
    .array(fieldDiff)
    .describe("Every field the caller may read, in the content type's order"),
  hiddenChanges: z
    .int()
    .describe('How many fields changed that the caller may not read, without saying which'),
});
