import { MAX_PERSONAL_VIEWS, MAX_SHARED_VIEWS, MAX_VIEW_COLUMNS } from '@commerceworker/domain';
import { z } from 'zod';
import { previewEntry } from './entries';

// --- saved views ------------------------------------------------------------

const filter = z.object({
  field: z.string().describe('A field apiId, a component path (seo.title) or a sys.* field'),
  op: z.string().describe('eq, ne, in, nin, gt, gte, lt, lte, between, exists, match, …'),
  value: z.unknown().optional(),
});

export const savedViewQuery = z
  .object({
    filters: z.array(filter).optional().describe('Field predicates, ANDed'),
    where: z
      .object({})
      .loose()
      .optional()
      .describe('AND/OR groups of predicates ({"or": [...]}, {"and": [...]}), ANDed with filters'),
    order: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) })).optional(),
    search: z.string().optional(),
    extra: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Query keys kept verbatim but not applied by this version'),
  })
  .describe('The structured query a live entries query parses into');

export const savedView = z.object({
  id: z.uuid(),
  name: z.string(),
  contentTypeApiId: z.string().nullable().describe('null: the entries of every type'),
  visibility: z
    .enum(['personal', 'shared'])
    .describe(
      `personal: the creator's alone (at most ${MAX_PERSONAL_VIEWS} each). shared: everyone in the space who can read its type (at most ${MAX_SHARED_VIEWS} a space)`,
    ),
  createdBy: z
    .string()
    .optional()
    .describe(
      'The creator as the audit log names them; a personal view’s owner. Left out for a key not served author ids',
    ),
  query: savedViewQuery,
  columns: z
    .array(z.string())
    .max(MAX_VIEW_COLUMNS)
    .optional()
    .describe('Columns besides the display field; absent is sys.status, sys.updatedAt'),
  revision: z.int().describe('Bumped by every save; send it back to refuse a stale save'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const savedViewList = z.object({ items: z.array(savedView), total: z.int() });

export const savedViewRun = z.object({
  view: savedView
    .pick({ id: true, name: true, contentTypeApiId: true, revision: true, columns: true })
    .describe('The view that ran'),
  items: z.array(previewEntry),
  total: z.int().describe('Entries on this page'),
  nextCursor: z.string().optional().describe('Pass back as cursor for the next page'),
  ignored: z
    .array(z.string())
    .optional()
    .describe('Kept query keys (query.extra) this version did not apply'),
  typeMissing: z
    .literal(true)
    .optional()
    .describe('The view’s content type isn’t in this environment: nothing to list'),
});
