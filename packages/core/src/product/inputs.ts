/**
 * What the catalog's admin writes take, as REST's request bodies and MCP's tool inputs both read
 * them: one set of zod objects, so the two transports hold the same bounds. Shapes only: the
 * catalog checks products against their types, and each edit against the product, and answers per
 * item.
 */

import { z } from 'zod';
import { EDIT_SOURCES, FEED_FORMATS } from './api';
import {
  fieldRefSchema,
  MAX_DRAFT_FIELDS,
  PRODUCT_DRAFT_INSTRUCTION_MAX,
  TEXT_MAX,
} from './content';
import { categorySchema, channelSchema, productInputSchema, productTypeSchema } from './model';

/** Items a bulk write takes a call (the catalog's own `MAX_WRITE`). */
export const CATALOG_BATCH_MAX = 500;

const productKey = z.string().min(1).max(128);
const codeList = z.array(z.string().min(1).max(128)).min(1).max(CATALOG_BATCH_MAX);

export const catalogProductsInput = z.object({
  products: z.array(productInputSchema).min(1).max(CATALOG_BATCH_MAX),
  /** Purge cached copies now (rationed) instead of within the minute; for takedowns and fixes. */
  urgent: z.boolean().optional(),
});

export const catalogDeleteInput = z.object({
  keys: z.array(productKey).min(1).max(CATALOG_BATCH_MAX),
  urgent: z.boolean().optional(),
});

export const catalogCategoriesDeleteInput = z.object({ codes: codeList });

export const catalogCategoriesInput = z.object({
  categories: z.array(categorySchema).min(1).max(CATALOG_BATCH_MAX),
});

export { channelSchema as catalogChannelInput, productTypeSchema as catalogTypeInput };

const editTarget = {
  key: productKey,
  ref: fieldRefSchema,
  /** `assistant` when a person accepts an assistant draft. */
  source: z.enum(EDIT_SOURCES).optional(),
};

export const catalogEditsInput = z.object({
  edits: z
    .array(
      z.discriminatedUnion('op', [
        z.object({
          ...editTarget,
          op: z.literal('set'),
          value: z.string().max(TEXT_MAX).nullable(),
        }),
        z.object({ ...editTarget, op: z.literal('clear') }),
      ]),
    )
    .min(1)
    .max(CATALOG_BATCH_MAX),
});

/** Staged edits or drafts to drop: one field's, or without `ref` all of a product's. */
export const catalogDiscardInput = z.object({
  items: z
    .array(z.object({ key: productKey, ref: fieldRefSchema.optional() }))
    .min(1)
    .max(CATALOG_BATCH_MAX),
});

export const catalogPublishInput = z.object({
  keys: z.array(productKey).min(1).max(CATALOG_BATCH_MAX),
  /** Sending it again answers the first result and publishes nothing twice. */
  requestId: z.string().min(1).max(128).optional(),
  urgent: z.boolean().optional(),
});

export const catalogDraftsInput = z.object({
  drafts: z
    .array(
      z.object({
        key: productKey,
        ref: fieldRefSchema,
        value: z.string().min(1).max(TEXT_MAX),
        model: z.string().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(CATALOG_BATCH_MAX),
});

/** POST /api/v1/catalog/products/:key/draft: what the assistant drafts (its gaps when no fields). */
export const catalogDraftContentInput = z.object({
  fields: z.array(fieldRefSchema).min(1).max(MAX_DRAFT_FIELDS).optional(),
  instruction: z.string().max(PRODUCT_DRAFT_INSTRUCTION_MAX).optional(),
});

/** Characters of feed file a tool call carries: a larger file streams over REST, never through a model. */
export const FEED_TEXT_MAX = 256 * 1024;

/** A feed's file as text, for a transport that can't stream a body (REST streams it as the body). */
export const catalogFeedInput = z.object({
  format: z.enum(FEED_FORMATS).describe('csv (one row per variant) or ndjson (one product a line)'),
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Shown in the feed list; default feed.<format>'),
  content: z.string().min(1).max(FEED_TEXT_MAX).describe('The whole file'),
});
