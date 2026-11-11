/**
 * The zod schemas for what the catalog Worker answers (`ProductCatalogRpc`, api.ts), which the REST
 * API's OpenAPI document describes. They sit apart from api.ts, a file of types and constants;
 * `tests/response-schemas.test.ts` holds each to the type it describes, so the two can't drift.
 */

import { z } from 'zod';
import { BOARD_COLUMNS, EDIT_SOURCES, FEED_FORMATS, FEED_STATES } from './api';
import { fieldRefSchema, GAP_GROUPS, GAP_KINDS } from './content';
import { productDataSchema, productSchema } from './model';

/** Why a product (or one of its values) was refused: where, and what was wrong. */
export const issueSchema = z.object({ path: z.string(), message: z.string() });

/** What a product write did, per product key. */
export const writeResultSchema = z.object({
  key: z.string(),
  status: z.enum(['created', 'updated', 'unchanged', 'deleted', 'rejected']),
  version: z.number().int().optional(),
  issues: z.array(issueSchema).optional().describe('Why it was `rejected`'),
});

export const feedStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  format: z.enum(FEED_FORMATS),
  state: z.enum(FEED_STATES),
  by: z.string(),
  createdAt: z.number().int(),
  finishedAt: z.number().int().optional(),
  rows: z.number().int().describe('Rows read from the file'),
  parts: z.number().int().describe('Parts the rows were split into'),
  partsDone: z.number().int().describe('Parts applied so far'),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  rejected: z.number().int(),
  errors: z
    .array(z.object({ row: z.number().int(), key: z.string().optional(), message: z.string() }))
    .describe('The first rejected rows, with why'),
  failure: z
    .string()
    .optional()
    .describe('Why the feed failed as a whole, when `state` is `failed`'),
  cancelledBy: z.string().optional().describe('Who cancelled it, when `state` is `cancelled`'),
});

/** A feed row (or API write) the catalog refused for a product key, with why. */
export const rejectionSchema = z.object({
  feed: z.string().optional().describe('The feed it came from; absent for an API write'),
  row: z.number().int().optional().describe('Its row in the feed file'),
  issues: z.array(issueSchema),
  at: z.number().int(),
});

const gapKinds = z.enum(GAP_KINDS);

export const gapSchema = z.object({
  kind: gapKinds,
  field: z.string(),
  locale: z.string(),
  channel: z.string(),
});

/** One product on the editor's board. */
export const boardCardSchema = z.object({
  key: z.string(),
  title: z.string().describe('The product’s title in any locale, the rejected row’s, or the key'),
  column: z.enum(BOARD_COLUMNS),
  kinds: z.partialRecord(gapKinds, z.number().int()).describe('Its gaps by kind'),
  rejection: rejectionSchema.nullable(),
  locales: z.array(z.string()).describe('The locales it lacks text in, sorted'),
  staged: z.number().int().describe('Edits staged for it, in any column'),
  drafts: z.number().int().describe('Assistant drafts waiting for review, in any column'),
  failure: z.string().nullable().describe('Why its staged edits did not publish last time'),
  at: z.number().int().describe('When it joined this column'),
});

/** One page of a board column. */
export const boardPageSchema = z.object({
  items: z.array(boardCardSchema),
  cursor: z.string().nullable().describe('Pass it back for the next page; null on the last'),
});

/** The board's counts and the latest feeds. */
export const boardSummarySchema = z.object({
  columns: z.record(z.enum(BOARD_COLUMNS), z.number().int()).describe('Products in each column'),
  gapGroups: z
    .record(z.enum(GAP_GROUPS), z.number().int())
    .describe('Products in the Gaps column by group; each product counts once'),
  gapsByKind: z
    .partialRecord(gapKinds, z.object({ gaps: z.number().int(), products: z.number().int() }))
    .describe('Gaps of each kind, and how many products have one'),
  lastFeed: feedStatusSchema.nullable().describe('The most recent finished feed'),
  runningFeed: feedStatusSchema.nullable().describe('A feed still running'),
  indexBuilt: z
    .boolean()
    .describe('False until every product stored before the gap index existed has been counted'),
});

const editSource = z.enum(EDIT_SOURCES);
const nullableText = z.string().nullable();

export const stagedEditSchema = z.object({
  ref: fieldRefSchema,
  op: z.enum(['set', 'clear']),
  value: nullableText,
  seen: nullableText.describe('The value the person saw when they staged it'),
  source: editSource,
  by: z.string(),
  at: z.number().int(),
  failure: nullableText.describe('Why it did not publish last time'),
});

export const draftSchema = z.object({
  ref: fieldRefSchema,
  value: z.string(),
  seen: nullableText.describe('The live value it was drafted against'),
  stale: z.boolean().describe('The field’s live value has changed since it was drafted'),
  model: nullableText,
  by: z.string().describe('Who asked for it'),
  at: z.number().int(),
});

export const fieldOverrideSchema = z.object({
  ref: fieldRefSchema,
  value: nullableText,
  base: nullableText.describe('The feed value it was made against'),
  feed: nullableText.describe('The feed’s value now'),
  conflict: z.boolean().describe('The feed changed the value since the override was made'),
  source: editSource,
  by: z.string(),
  at: z.number().int(),
});

export const revisionSchema = z.object({
  ref: fieldRefSchema,
  op: z.enum(['set', 'clear']),
  value: nullableText,
  previous: nullableText,
  source: editSource,
  by: z.string(),
  at: z.number().int(),
});

/** Everything the editor's sheet shows for one product. */
export const productSheetSchema = z.object({
  /** As it is live: the feed's version with the overrides applied. */
  product: productSchema,
  /** As the last feed (or API write) sent it. */
  feed: productDataSchema,
  overrides: z.array(fieldOverrideSchema),
  staged: z.array(stagedEditSchema),
  drafts: z.array(draftSchema),
  gaps: z.array(gapSchema),
  rejection: rejectionSchema.nullable(),
  revisions: z.array(revisionSchema).describe('Newest first'),
});

/** What staging or drafting did with one edit. */
export const editResultSchema = z.discriminatedUnion('ok', [
  z.object({ key: z.string(), ref: fieldRefSchema, ok: z.literal(true) }),
  z.object({
    key: z.string(),
    ref: fieldRefSchema,
    ok: z.literal(false),
    issues: z.array(z.string()),
  }),
]);

/** What publishing did with a product's staged edits. */
export const publishResultSchema = z.object({
  key: z.string(),
  status: z.enum(['published', 'failed', 'unchanged']),
  version: z.number().int().optional(),
  issues: z.array(z.string()).optional().describe('Why it failed; the edits stay staged'),
});

/** What a draft request saved, and what it couldn't, field by field. */
export const productDraftResultSchema = z.object({
  key: z.string(),
  title: z.string().describe('The product’s title, in the first locale it has one'),
  drafted: z.array(z.object({ ref: fieldRefSchema, value: z.string() })),
  refused: z.array(z.object({ ref: fieldRefSchema, issues: z.array(z.string()) })),
  more: z.number().int().describe('Gaps left for another request'),
  model: z
    .string()
    .nullable()
    .describe('The model that wrote them; null for the offline heuristic'),
});

// The envelopes REST wraps those answers in.

export const writeResultsSchema = z.object({ results: z.array(writeResultSchema) });
export const productResponseSchema = z.object({ product: productSchema });
export const aliasResponseSchema = z.object({
  key: z.string().describe('The key of the product that holds the alias'),
});
export const feedResponseSchema = z.object({ feed: feedStatusSchema });
export const feedsResponseSchema = z.object({ feeds: z.array(feedStatusSchema) });
export const boardResponseSchema = z.object({ board: boardSummarySchema });
export const sheetResponseSchema = z.object({ sheet: productSheetSchema });
export const editResultsSchema = z.object({ results: z.array(editResultSchema) });
export const publishResultsSchema = z.object({
  requestId: z.string().describe('Send it again to get this answer without publishing twice'),
  results: z.array(publishResultSchema),
});
export const discardedSchema = z.object({
  discarded: z.number().int().describe('How many were dropped'),
});
export const typeDeletedSchema = z.object({
  ok: z.literal(true),
  code: z.string(),
  versions: z.number().int().describe('How many versions were removed'),
});
export const channelDeletedSchema = z.object({
  ok: z.literal(true),
  code: z.string(),
  unpublished: z.number().int().describe('How many published documents were taken down'),
});
export const categoriesDeletedSchema = z.object({
  ok: z.literal(true),
  deleted: z.array(z.string()).describe('The codes of the categories removed'),
});
export const gapsRebuiltSchema = z.object({
  products: z.number().int().describe('How many products were read'),
});
export const reindexedSchema = z.object({
  queued: z.number().int().describe('How many products were queued for republishing'),
});
