import { z } from 'zod';

export const localizedValue = z
  .record(z.string().describe('BCP-47 locale tag'), z.unknown())
  .describe('Localized value: locale → value (non-localized fields use the default locale)');

export const entryFields = z
  .record(z.string().describe('Field apiId'), localizedValue)
  .describe('Entry field values by field apiId');

/** Who wrote an entry and when: `sys.createdBy` and the rest, as a list filters and sorts them. */
const authorship = {
  createdAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'When the entry was created (sys.createdAt); null for one from before it was recorded',
    ),
  createdBy: z
    .string()
    .nullable()
    .describe(
      'Who created it (sys.createdBy): a person id, admin-token, a key kind, agent:<name>, ' +
        'workflow:<id>, plugin:<id> or system; null when unknown',
    ),
  updatedBy: z
    .string()
    .nullable()
    .describe(
      'Who made its last change, the one updatedAt records (sys.updatedBy); null when unknown',
    ),
  firstPublishedAt: z.iso
    .datetime()
    .nullable()
    .describe('When it was first published (sys.firstPublishedAt); kept through unpublish'),
  position: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Its own key in its content type’s manual order (order=sys.position); null until it is ' +
        'moved, when it sorts by its id',
    ),
};

export const entry = z.object({
  id: z.uuid().describe('UUIDv7 entry id'),
  contentTypeApiId: z.string(),
  status: z.enum(['draft', 'published', 'changed', 'archived']),
  currentVersion: z.int(),
  publishedVersion: z.int().optional(),
  ...authorship,
  fields: entryFields.optional(),
});

export const createdEntry = z.object({ entry, warnings: z.array(z.string()).optional() });

export const entryValidation = z.object({
  valid: z.literal(true),
  fields: entryFields.describe(
    'The fields as the save would store them: defaults applied, slugs normalized, blocks keyed',
  ),
  skippedHooks: z
    .array(z.string())
    .describe(
      'Plugins on entry:beforeSave that hold capabilities and so did not run; a real save may ' +
        'still rewrite or refuse the fields',
    ),
});

export const publishedEntry = z.object({
  id: z.uuid(),
  contentType: z.string().describe('Content type apiId'),
  fields: entryFields,
  publishedAt: z.iso.datetime(),
  firstPublishedAt: z.iso
    .datetime()
    .optional()
    .describe(
      'When the entry was first published (sort with order=-sys.firstPublishedAt); absent when ' +
        'unknown. Delivery serves no other authorship',
    ),
});

export const publishedEntryList = z.object({
  items: z.array(publishedEntry),
  total: z.int(),
});

export const previewEntry = z.object({
  id: z.uuid(),
  contentType: z.string().describe('Content type apiId'),
  status: z.enum(['draft', 'published', 'changed', 'archived']),
  version: z.int().describe('The current (draft) version'),
  updatedAt: z.iso.datetime().optional().describe('When the entry last changed'),
  ...authorship,
  // Writer ids go to teammates and management keys only: a preview key reads them as absent,
  // and filtering or sorting on them answers 400.
  createdBy: authorship.createdBy
    .optional()
    .describe(
      `${authorship.createdBy.description}. Absent for a preview key (and a filter or sort on ` +
        'sys.createdBy from one is a 400)',
    ),
  updatedBy: authorship.updatedBy
    .optional()
    .describe(`${authorship.updatedBy.description}. Absent for a preview key`),
  fields: entryFields,
});

export const previewEntryPage = z.object({
  items: z.array(previewEntry),
  total: z.int().describe('Entries on this page'),
  nextCursor: z.string().optional().describe('Pass back as cursor for the next page'),
});

export const searchHits = z.object({
  hits: z.array(
    z.object({
      entryId: z.uuid(),
      score: z.number().describe('Relevance (RRF-fused for hybrid mode)'),
      snippet: z.string(),
    }),
  ),
});

export const movedEntry = z.object({
  id: z.string(),
  contentTypeApiId: z.string(),
  position: z.string().describe('Its key now: what order=sys.position sorts by'),
});

/** A minted preview link (`POST …/entries/:id/preview-link`): the token is shown once. */
export const previewLink = z.object({
  url: z.string().describe('The entry on the Preview API, with ?preview_token='),
  frontendUrl: z
    .string()
    .optional()
    .describe(
      'The entry on your frontend: its content type’s preview.urlTemplate, filled. Absent when ' +
        'the type has none, or a field the template names is empty in the locale',
    ),
  token: z
    .string()
    .describe('Reads this one entry, drafts included, until expiresAt; shown only once'),
  expiresAt: z.iso.datetime(),
});
