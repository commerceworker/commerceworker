import {
  AGENT_WORKFLOWS,
  ASSET_BULK_ACTION_NAMES,
  BULK_JOB_MAX_ITEMS,
  ENTRY_TRASH_MAX_ITEMS,
  MAX_ASSET_BULK_TAGS,
  MAX_ASSET_MOVE,
  MAX_PART_URLS,
  MAX_TRASH_RETENTION_DAYS,
  SCHEDULER_ALERT_MAX_RECIPIENTS,
} from '@commerceworker/application';
import {
  FIELD_GUIDANCE_LIMITS,
  MAX_ASSET_RIGHTS_TEXT,
  MAX_CANONICAL_URL_LENGTH,
  MAX_COLLECTION_CHANGE,
  MAX_COLLECTION_DESCRIPTION,
  MAX_COLLECTION_ITEMS,
  MAX_MENU_DESCRIPTION_LENGTH,
  MAX_MENU_HANDLE_LENGTH,
  MAX_MENU_ITEMS,
  MAX_MENU_NAME_LENGTH,
  MAX_MENUS,
  MAX_REDIRECT_IMPORT,
  MAX_REDIRECT_LENGTH,
  MAX_REDIRECT_NOTE_LENGTH,
  MAX_REDIRECTS,
  MAX_SEO_DESCRIPTION_LENGTH,
  MAX_SEO_TITLE_LENGTH,
  MAX_SHARE_PASSWORD,
  MAX_URL_PATTERN_LENGTH,
  MAX_VIEW_COLUMNS,
  MAX_VIEW_FILTERS,
  MAX_VIEW_NAME_LENGTH,
  MAX_VIEW_ORDER,
  MAX_ZIP_ASSETS,
  PLUGIN_SETTING_MAX_STRING,
  SPACE_ID_PATTERN,
  ValidationError,
} from '@commerceworker/domain';
import { STARTERS } from '@commerceworker/seed';
import type { Context } from 'hono';
import { z } from 'zod';
import { blockPatchShape } from './docs/schemas/blocks';
import {
  contentTypeDetails,
  contentTypeLayout,
  contentTypePreview,
} from './docs/schemas/content-types';

/**
 * Parses a request JSON body against a zod schema, throwing a domain
 * ValidationError (→ 422) on mismatch so every route reports invalid input
 * uniformly instead of leaking a 500. Unknown keys are stripped by zod's default
 * object behaviour, which structurally prevents mass-assignment (a body field
 * can never override a value the handler sets itself).
 */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  // Missing/invalid JSON coerces to {} so optional-body routes validate cleanly;
  // required fields then surface as normal validation issues.
  const raw = await c.req.json().catch(() => ({}));
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({
        field: i.path.length ? i.path.join('.') : '(body)',
        message: i.message,
      })),
    );
  }
  return result.data;
}

// ---- reusable primitives --------------------------------------------------

/** A stable identifier (apiId / id): non-empty, bounded. */
export const zId = z.string().min(1).max(128);
/** A short human string (names, labels). */
export const zShort = z.string().max(256);
/** A locale code. */
export const zLocale = z.string().min(2).max(35);

/**
 * A localized value map (`locale -> value`). Values are opaque here — the domain
 * validators enforce per-field-type semantics; this only bounds the shape.
 */
export const zLocalized = z.record(zLocale, z.unknown());
/** Entry field values: `apiId -> localized value`. */
export const zFieldValues = z.record(zId, zLocalized);
/** A bounded list of ids (bulk operations). */
export const zIdList = z.array(zId).max(1000);
/** A model tier. */
export const zTier = z.enum(['flagship', 'balanced', 'fast']);
/** Free-form prompt/prose text, bounded to keep prompts sane. */
export const zText = z.string().max(100_000);

// ---- request schemas (one per mutating route) -----------------------------
// Deeply nested content (field values, content-type field arrays, workflow
// steps) is bounded here but validated for semantics by the domain layer, so
// these schemas stay at the "shape + bounds + strip unknown keys" altitude.

export const createSpaceBody = z.object({
  spaceId: z
    .string()
    .regex(SPACE_ID_PATTERN, 'letters, digits, ".", "_" or "-", starting with a letter or digit')
    .describe(
      '1–64 letters, digits, ".", "_" or "-", starting with a letter or digit; not versions, imports, plugins or dlq (reserved)',
    ),
  name: zShort,
  defaultLocale: zLocale,
  locales: z.array(zLocale).max(200).optional(),
  fallbacks: z.record(zLocale, zLocale.nullable()).optional(),
  environments: z.array(zId).max(100).optional(),
  starter: z
    .enum(STARTERS)
    .optional()
    .describe(
      '`sample` installs sample content into the first environment: a content model covering ' +
        'every field type, a few dozen entries, taxonomy, sample images and documents, and one ' +
        'open release. `empty` (the default) creates the space with nothing in it. ' +
        '`enterprise`, where the deployment offers it (GET /starters), adds a large demo ' +
        "brand's locales and installs its content in the background (`installing`).",
    ),
});
export const createEnvironmentBody = z.object({ id: zId, name: zShort.optional() });
export const setAliasBody = z.object({ targetEnvironmentId: zId });
export const mergeBody = z.object({
  source: zId,
  target: zId,
  contentTypes: z.array(zId).max(1000).optional(),
  entries: zIdList.optional(),
});
export const promotionBody = z.object({
  source: zId,
  target: zId,
  contentTypes: z.array(zId).max(1000).optional(),
  entries: zIdList.optional(),
});
export const createApiKeyBody = z.object({
  kind: z.enum(['cma', 'cda', 'cpa']),
  name: zShort.optional(),
  scopes: z.array(z.string().max(64)).max(64).optional(),
  roleId: zId.optional(),
});
export const revokeConnectionBody = z.object({
  clientId: zId,
  // An identity string from the IdP, not an id — email-shaped, so sized generously.
  subject: z.string().min(1).max(320),
});
// The snapshot's inner shape is validated by the domain on replay; this only
// guards the envelope so a malformed body fails before any writing starts.
export const snapshotBody = z.object({
  snapshotVersion: z.number().int(),
  exportedAt: z.string().optional(),
  source: z.object({ spaceId: z.string(), environmentId: z.string() }).optional(),
  contentTypes: z.array(z.any()).max(1000),
  entries: z.array(z.any()).max(100_000),
  assets: z.array(z.any()).max(100_000).optional(),
  assetFolders: z.array(z.any()).max(10_000).optional(),
  assetCollections: z.array(z.any()).max(10_000).optional(),
  taxonomy: z
    .object({
      schemes: z.array(z.any()).max(1000),
      concepts: z.array(z.any()).max(10_000),
      tags: z.array(z.any()).max(10_000),
    })
    .optional(),
  workflows: z.array(z.any()).max(1000).optional(),
  redirects: z.array(z.any()).max(MAX_REDIRECTS).optional(),
  menus: z.array(z.any()).max(MAX_MENUS).optional(),
});

// Menu items are checked by the domain (shape, links, depth, attributes), which names each bad
// item by its path; here only that they are a bounded list of objects.
const menuItems = z
  .array(z.object({}).loose())
  .max(MAX_MENU_ITEMS)
  .describe(
    'The item tree: { id?, label?, link: { type: "entry", entryId } | { type: "term", termKind, termId } | { type: "url", url }, target?, attrs?, children? }',
  );
const menuFields = {
  handle: z
    .string()
    .min(1)
    .max(MAX_MENU_HANDLE_LENGTH)
    .describe('Lowercase letters and digits joined by - or _: main, footer-legal'),
  name: z.string().min(1).max(MAX_MENU_NAME_LENGTH),
  description: z.string().max(MAX_MENU_DESCRIPTION_LENGTH).nullable().optional(),
  items: menuItems.optional(),
};
export const menuBody = z.object(menuFields);
export const menuPatchBody = z
  .object(menuFields)
  .partial()
  .extend({
    revision: z
      .int()
      .min(1)
      .optional()
      .describe('The revision this change was made against: a menu saved since is a 409'),
  });
export const menuMoveBody = z.object({
  itemId: z.string().min(1),
  parentId: z.string().min(1).nullable().describe('The new parent, or null for the top level'),
  index: z.int().min(0).describe('Position among the new siblings; past the end appends'),
  revision: z.int().min(1).optional(),
});
// A saved view's query is checked by the domain with the live query's validators (strictly),
// which name each bad part (`query.where.or[1]`); here only its outline.
const savedViewQuery = z
  .object({
    filters: z
      .array(z.object({}).loose())
      .max(MAX_VIEW_FILTERS)
      .optional()
      .describe('Field predicates, ANDed: { field, op, value } as in an entries query'),
    where: z
      .unknown()
      .optional()
      .describe('AND/OR groups of predicates: {"or": [...]} or {"and": [...]}, nestable'),
    order: z
      .array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }))
      .max(MAX_VIEW_ORDER)
      .optional(),
    search: z.string().optional().describe('Full-text search over text fields'),
    extra: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Query keys this version does not apply, kept verbatim (a run reports them)'),
  })
  .loose()
  .describe('The structured query: never a query string');
const savedViewColumns = z
  .array(z.string())
  .max(MAX_VIEW_COLUMNS)
  .nullable()
  .optional()
  .describe(
    'Columns besides the display field, in order: sys.status, sys.updatedAt or field apiIds; null is the default',
  );
const savedViewVisibility = z
  .enum(['personal', 'shared'])
  .describe(
    'personal: yours alone. shared: everyone in the space who can read its type (content:manage)',
  );
export const savedViewBody = z.object({
  name: z.string().min(1).max(MAX_VIEW_NAME_LENGTH),
  contentTypeApiId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('The content type whose entries it lists; absent or null for every type'),
  visibility: savedViewVisibility.optional(),
  query: savedViewQuery.optional(),
  columns: savedViewColumns,
});
export const savedViewPatchBody = z.object({
  name: z.string().min(1).max(MAX_VIEW_NAME_LENGTH).optional(),
  visibility: savedViewVisibility.optional(),
  query: savedViewQuery.optional().describe('Replaces the whole query'),
  columns: savedViewColumns,
  revision: z
    .int()
    .min(1)
    .optional()
    .describe('The revision this change was made against: a view saved since is a 409'),
});
const redirectFields = {
  source: z
    .string()
    .min(1)
    .max(MAX_REDIRECT_LENGTH)
    .describe('A path: /old, /blog/[slug], /docs/[...rest]'),
  destination: z
    .string()
    .min(1)
    .max(MAX_REDIRECT_LENGTH)
    .describe('A path or an https:// URL; [slug] and [...rest] insert the captures'),
  status: z
    .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
    .optional()
    .describe('Default 301'),
  locale: z.string().max(35).nullable().optional().describe('One locale only; null for every'),
  enabled: z.boolean().optional().describe('Default true'),
  note: z.string().max(MAX_REDIRECT_NOTE_LENGTH).nullable().optional(),
};
export const redirectBody = z.object(redirectFields);
export const redirectPatchBody = z.object(redirectFields).partial();
export const redirectImportBody = z.object({
  format: z.enum(['csv', 'json']),
  data: z
    .union([z.string().max(1_000_000), z.array(z.object({}).loose()).max(MAX_REDIRECT_IMPORT)])
    .describe(
      'CSV text with a header row (source, destination, status, locale, enabled, note), or a ' +
        'JSON array of redirects',
    ),
  dryRun: z.boolean().optional().describe('Check and report without writing'),
});
export const cloneBody = z.object({
  targetSpaceId: zId.optional(),
  targetEnvironmentId: zId,
  publish: z.boolean().optional(),
});
// The manifest's inner shape is validated by the domain, which rejects rather
// than repairs — this only guards the envelope and bounds the bundle size.
export const installPluginBody = z.object({
  manifest: z.object({}).loose(),
  bundle: z.string().min(1).max(2_000_000),
  approvedCapabilities: z.array(z.string().max(64)).max(32),
});
export const pluginEnabledBody = z.object({ enabled: z.boolean() });
// Each value's type is checked against the manifest's field by the domain; this
// bounds the envelope. `null` clears a setting; a key left out keeps its value.
export const pluginSettingsBody = z.object({
  values: z
    .record(
      z.string().max(64),
      z.union([z.string().max(PLUGIN_SETTING_MAX_STRING), z.number(), z.boolean(), z.null()]),
    )
    .refine((v) => Object.keys(v).length <= 50, 'At most 50 settings'),
  expectedVersion: z.number().int().min(0).optional(),
});
export const pluginCapabilitiesBody = z.object({
  approvedCapabilities: z.array(z.string().max(64)).max(32),
});
const zSha256 = z.string().regex(/^[a-fA-F0-9]{64}$/, 'must be a hex SHA-256');
export const installPluginFromUrlBody = z.object({
  packageUrl: z.string().url().max(2048),
  expectedChecksum: zSha256.optional(),
  expectedId: z.string().max(128).optional(),
  expectedVersion: z.string().max(64).optional(),
  approvedCapabilities: z.array(z.string().max(64)).max(32),
  minimumReleaseAgeHours: z.number().int().min(0).max(8760).optional(),
});
export const upgradePluginFromUrlBody = installPluginFromUrlBody.partial({
  approvedCapabilities: true,
});
export const inspectPluginBody = installPluginFromUrlBody.omit({ approvedCapabilities: true });
export const importBody = z.object({
  source: z.string().min(1).max(64),
  // Bounded by the app's own body limit long before this; the cap is here so a
  // non-HTTP caller gets the same answer.
  payload: z.string().min(1).max(20_000_000),
  mapping: z.object({
    contentTypeApiId: zId,
    fields: z.record(zId, z.string().max(256)),
    identityField: zId.optional(),
    locale: zLocale.optional(),
  }),
  sourceOptions: z.record(z.string().max(64), z.unknown()).optional(),
  conflicts: z.enum(['skip', 'update', 'fail']).optional(),
});
export const spaceExportImportBody = z.object({
  // The export file's text; bounded by the app's own body limit long before this.
  payload: z.string().min(1).max(20_000_000),
  publish: z.boolean().optional(),
  addLocales: z.boolean().optional(),
});
export const createPatBody = z.object({
  name: zShort,
  scopes: z.array(z.string().max(64)).min(1).max(64),
  // Capped at a year: a token with no expiry at all is opt-in by omission, but
  // an absurd finite lifetime is more likely a typo than an intention.
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
const contentGrant = z.object({
  contentTypeApiId: z.string().max(128),
  actions: z.array(z.enum(['read', 'write', 'publish'])).max(3),
  // `delete` comes with write or publish and `unpublish` with publish; naming one here withholds it.
  deniedActions: z
    .array(z.enum(['delete', 'unpublish']))
    .max(2)
    .optional(),
  deniedFields: z.array(zId).max(500).optional(),
  readOnlyFields: z.array(zId).max(500).optional(),
});
export const roleBody = z.object({
  name: zShort,
  description: zShort.optional(),
  scopes: z.array(z.string().max(64)).max(64),
  contentGrants: z.array(contentGrant).max(500).optional(),
});
// The deep field shape (nested fields, validations, options, messages, guidance and rules) is
// validated by the domain at every depth. The guidance keys are named here so the request
// documents them, without caps or types: a revision may carry a value stored before guidance was
// checked, which the domain lets through unchanged, so refusing it here would lock the type.
const guidanceText = (what: string, max: number) =>
  z.unknown().optional().describe(`${what} (text, at most ${max} characters)`);
const fieldDef = z
  .object({
    help: guidanceText(
      'How to fill the field: shown under the input and given to a model',
      FIELD_GUIDANCE_LIMITS.help,
    ),
    placeholder: guidanceText(
      'An example shown in the empty input; never stored',
      FIELD_GUIDANCE_LIMITS.placeholder,
    ),
    description: guidanceText(
      'What the field means, for agents and API readers',
      FIELD_GUIDANCE_LIMITS.description,
    ),
    rules: z
      .unknown()
      .optional()
      .describe(
        'Hide or disable the field while a sibling matches: ' +
          '[{ action: hide|disable, when: { field, operator: eq|ne|in|empty|notEmpty|gt|lt, value? } }]',
      ),
    format: z
      .unknown()
      .optional()
      .describe('Date: date (YYYY-MM-DD), datetime (YYYY-MM-DDThh:mm) or time (hh:mm)'),
  })
  .loose();
// Left out keeps a value on a revision; null clears it. Checked by the domain, which also lets a
// value stored as it stands through.
const detail = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
export const contentTypeBody = z.object({
  apiId: zId,
  name: zShort,
  displayField: zId,
  group: detail(contentTypeDetails.group),
  description: detail(contentTypeDetails.description),
  icon: detail(contentTypeDetails.icon),
  agentInstructions: detail(contentTypeDetails.agentInstructions),
  layout: detail(contentTypeLayout),
  preview: detail(contentTypePreview),
  fields: z.array(fieldDef).max(500),
  urlPattern: z
    .string()
    .max(MAX_URL_PATTERN_LENGTH)
    .nullable()
    .optional()
    .describe(
      'Where its entries live on the site, e.g. /blog/{slug} ({id}, {locale} or a Slug field). ' +
        'A publish that changes the slug redirects the old path. null clears it.',
    ),
  singleton: z
    .boolean()
    .optional()
    .describe(
      'Holds at most one entry (site settings, a home page), served at GET …/singletons/:apiId. ' +
        'Turning it on is refused while the type has more than one entry. Left out, unchanged.',
    ),
});
/** A content type's copy: its new apiId and name. */
export const cloneContentTypeBody = z.object({ apiId: zId, name: zShort });
export const createEntryBody = z.object({
  contentTypeApiId: zId,
  fields: zFieldValues.optional(),
});
export const draftEntryBody = z.object({
  contentTypeApiId: zId,
  prompt: zText,
  tier: zTier.optional(),
});
export const canvasBody = z.object({
  contentTypeApiId: zId,
  prose: zText,
  tier: zTier.optional(),
});
export const previewLinkBody = z.object({
  ttlHours: z.number().positive().max(8760).optional(),
  previewBaseUrl: z.string().url().max(2048).optional(),
  locale: z
    .string()
    .min(1)
    .max(35)
    .optional()
    .describe('The locale frontendUrl is filled in; the space’s default if absent'),
});
export const updateEntryBody = z.object({ fields: zFieldValues });
/**
 * A dry run of a save: `contentTypeApiId` judges the fields as a new entry, `entryId` as a new
 * version of that entry.
 */
// A move in a type's manual order: right after one entry (null: first), or right before one
// (null: last). Exactly one of the two.
export const moveEntryBody = z.union([
  z.strictObject({ after: zId.nullable() }),
  z.strictObject({ before: zId.nullable() }),
]);
export const validateEntryBody = z
  .object({
    contentTypeApiId: zId.optional().describe('Validate as a new entry of this content type'),
    entryId: zId.optional().describe('Validate as a new version of this entry'),
    fields: zFieldValues.optional(),
  })
  .refine((b) => (b.contentTypeApiId === undefined) !== (b.entryId === undefined), {
    message: 'Give contentTypeApiId (a new entry) or entryId (a new version), not both',
  });
/**
 * A change to one locale of an entry's SEO metadata (its type's Seo field): a part left out keeps
 * its value, null clears it. Shared with the MCP tool, so both take the same change.
 */
export const entrySeoShape = {
  locale: zLocale
    .optional()
    .describe(
      'The locale to change (default: the default locale); only a localized Seo field takes another',
    ),
  title: z.string().max(MAX_SEO_TITLE_LENGTH).nullable().optional().describe('Page title'),
  description: z
    .string()
    .max(MAX_SEO_DESCRIPTION_LENGTH)
    .nullable()
    .optional()
    .describe('Meta description'),
  canonicalUrl: z
    .string()
    .max(MAX_CANONICAL_URL_LENGTH)
    .nullable()
    .optional()
    .describe(
      'Where the canonical copy lives when not here: a site path or an absolute http(s) URL',
    ),
  noindex: z
    .boolean()
    .nullable()
    .optional()
    .describe('Keep the page out of search results and the sitemap'),
  ogImage: z
    .object({ id: z.string().min(1), linkType: z.literal('Asset') })
    .nullable()
    .optional()
    .describe('Social sharing image: { id, linkType: "Asset" }'),
};
export const entrySeoBody = z.object(entrySeoShape);
/** A key-addressed patch of an entry's blocks fields (`patchEntryBlocks`). */
export const blockPatchBody = z.object(blockPatchShape);
/**
 * A dry run of one (`checkEntryBlocks`). The entry is named in the body, as `…/entries/validate`
 * names it, so the audit row of a check that wrote nothing is never read as the entry's activity.
 */
export const blockPatchCheckBody = z.object({ entryId: zId, ...blockPatchShape });
export const translateBody = z.object({
  targetLocale: zLocale,
  sourceLocale: zLocale.optional(),
  apply: z.boolean().optional(),
  tier: zTier.optional(),
});
export const summarizeBody = z.object({
  locale: zLocale.optional(),
  maxWords: z.number().int().positive().max(10_000).optional(),
  targetField: zId.optional(),
  apply: z.boolean().optional(),
  tier: zTier.optional(),
});
export const autofillBody = z.object({
  field: zId,
  locale: zLocale.optional(),
  instructions: zText.optional(),
  apply: z.boolean().optional(),
  tier: zTier.optional(),
});
export const tierOnlyBody = z.object({ apply: z.boolean().optional(), tier: zTier.optional() });
export const applyTagsBody = z.object({
  tagIds: z.array(zId).max(1000).optional(),
  newTags: z.array(zShort).max(100).optional(),
});
export const createFunctionBody = z.object({
  name: zShort,
  eventPattern: z.string().max(256),
  url: z.string().max(2048),
  active: z.boolean().optional(),
});
export const appExtensionBody = z.object({
  name: zShort,
  target: z.enum(['field-editor', 'sidebar']),
  entryUrl: z.string().max(2048),
  fieldTypes: z.array(z.string().max(64)).max(64).optional(),
  active: z.boolean().optional(),
});
export const bulkEntriesBody = z.object({ items: z.array(createEntryBody).max(1000).optional() });
export const idsBody = z.object({ ids: zIdList.optional() });
// Durable bulk jobs accept far larger id sets than the synchronous bulk
// routes (the practical ceiling is the request body limit, then chunked
// server-side); the shared application cap keeps both surfaces in lockstep.
export const bulkJobBody = z.object({
  action: z.enum(['publish', 'unpublish', 'trash', 'restore', 'purge']),
  entryIds: z.array(zId).min(1).max(BULK_JOB_MAX_ITEMS),
});
// A bulk field edit: field apiId → locale → value (null clears that locale), on one type's
// entries. Each value is validated when its entry is saved, as an edit's is.
export const setFieldsJobBody = z.object({
  contentTypeApiId: zId,
  entryIds: z.array(zId).min(1).max(ENTRY_TRASH_MAX_ITEMS),
  fields: z
    .record(zId, z.record(z.string().min(1).max(64), z.unknown()))
    .describe('Field apiId → locale → value; null clears that locale'),
});
export const auditBody = z.object({
  createTasks: z.boolean().optional(),
  taskSeverity: z.enum(['error', 'warning', 'info']).optional(),
  assignee: zShort.optional(),
  tier: zTier.optional(),
});
export const reindexBody = z.object({ contentTypeApiId: zId.optional() });
export const createAssetBody = z.object({
  fileName: z.string().min(1).max(1024),
  contentType: z.string().min(1).max(256),
  title: zLocalized.optional(),
  description: zLocalized.optional(),
  folderId: zId.optional().describe('File it in this folder (absent: the library root)'),
});
export const moveAssetsBody = z.object({
  ids: z.array(zId).min(1).max(MAX_ASSET_MOVE),
  folderId: zId.nullable().describe('The folder to file them in; null takes them to the root'),
});
export const replaceAssetFileBody = z.object({
  fileName: z.string().min(1).max(1024),
  contentType: z.string().min(1).max(256),
});
export const replaceAssetFileUploadBody = replaceAssetFileBody.extend({
  size: z.int().min(1).describe('The new file’s exact length in bytes'),
});
export const commitAssetFileBody = z.object({
  version: z.int().min(2).describe('commit.version from the replace response'),
  fileName: z.string().min(1).max(1024),
  contentType: z.string().min(1).max(256),
  attempt: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('commit.attempt from the replace response: the upload’s own key'),
});
const rightsText = z.string().max(MAX_ASSET_RIGHTS_TEXT).nullable().optional();
const rightsInstant = z
  .string()
  .max(64)
  .nullable()
  .optional()
  .describe('ISO-8601 date and time with a zone; null or absent: none');
export const assetRightsBody = z.object({
  license: rightsText,
  credit: rightsText,
  expiresAt: rightsInstant,
  embargoUntil: rightsInstant,
});
export const assetBulkBody = z.object({
  action: z.enum(ASSET_BULK_ACTION_NAMES as unknown as [string, ...string[]]),
  ids: z.array(zId).min(1).max(BULK_JOB_MAX_ITEMS),
  folderId: zId.nullable().optional().describe('move: the folder (null: the root)'),
  addTags: z.array(zId).max(MAX_ASSET_BULK_TAGS).optional().describe('tag: tag ids to add'),
  removeTags: z.array(zId).max(MAX_ASSET_BULK_TAGS).optional().describe('tag: tag ids to remove'),
});
export const assetReindexBody = z.object({
  all: z
    .boolean()
    .optional()
    .describe(
      'Every asset with a file; by default only those never ingested or whose ingest failed',
    ),
});
export const assetCollectionBody = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(MAX_COLLECTION_DESCRIPTION).optional(),
});
export const assetCollectionPatchBody = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z
    .string()
    .max(MAX_COLLECTION_DESCRIPTION)
    .optional()
    .describe('An empty string clears it'),
});
export const collectionAssetIdsBody = z.object({
  assetIds: z.array(zId).min(1).max(MAX_COLLECTION_CHANGE),
});
export const collectionOrderBody = z.object({
  assetIds: z
    .array(zId)
    .min(1)
    .max(MAX_COLLECTION_ITEMS)
    .describe('Members to put first, in this order (the whole order: up to 1,000)'),
});
export const shareLinkBody = z.object({
  targetType: z.enum(['asset', 'collection']),
  targetId: zId,
  expiresAt: z.iso.datetime({ offset: true }).describe('5 minutes to 90 days from now'),
  allowDownload: z.boolean().optional(),
  password: z
    .string()
    .min(8)
    .max(MAX_SHARE_PASSWORD)
    .optional()
    .describe('Asked for before the page opens; hashed, never stored or returned'),
});
export const multipartUploadBody = z.object({
  fileName: z.string().min(1).max(1024),
  contentType: z.string().min(1).max(256),
  size: z.int().min(1).describe('The file’s exact length in bytes'),
  title: zLocalized.optional(),
  description: zLocalized.optional(),
  folderId: zId.optional().describe('File it in this folder (absent: the library root)'),
});
export const uploadPartsBody = z.object({
  partNumbers: z.array(z.int().min(1).max(10_000)).min(1).max(MAX_PART_URLS),
});
export const completeUploadBody = z.object({
  parts: z
    .array(z.object({ partNumber: z.int().min(1).max(10_000), etag: z.string().min(1).max(256) }))
    .min(1)
    .max(10_000),
});
export const assetZipBody = z
  .object({
    assetIds: z.array(zId).min(1).max(MAX_ZIP_ASSETS).optional(),
    collectionId: zId.optional(),
    name: z.string().max(100).optional().describe('The archive’s name (.zip is added)'),
  })
  .refine((b) => (b.assetIds === undefined) !== (b.collectionId === undefined), {
    message: 'Give assetIds or collectionId, not both',
  });
export const assetFolderBody = z.object({
  name: z.string().min(1).max(128),
  parentId: zId.nullable().optional().describe('The folder to create it in (absent: the root)'),
});
export const assetFolderPatchBody = z.object({
  name: z.string().min(1).max(128).optional(),
  parentId: zId.nullable().optional().describe('Move it here; null moves it to the root'),
});
const renditionSpec = {
  width: z.int().min(1).max(4096).optional(),
  height: z.int().min(1).max(4096).optional(),
  fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
  format: z.enum(['auto', 'jpg', 'png', 'webp', 'avif']).optional(),
  quality: z.int().min(1).max(100).optional(),
};
export const assetRenditionBody = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .describe('Lowercase letters, digits and dashes; its URL segment is r-<name>'),
  ...renditionSpec,
});
export const assetRenditionPatchBody = z.object(renditionSpec);
export const createVideoAssetBody = z.object({
  fileName: z.string().min(1).max(1024),
  contentType: z.string().min(1).max(256),
  title: zLocalized.optional(),
  description: zLocalized.optional(),
  maxDurationSeconds: z.int().positive().optional(),
});
/** A media URL to resolve into an `embed` node's data; the domain decides which URLs are allowed. */
export const resolveEmbedBody = z.object({
  url: z.string().min(1).max(2048).describe('https URL of the media page (a video, post or track)'),
});
/**
 * An asset metadata patch: the keys sent change, the rest are kept. One shape for the REST body
 * and MCP's `asset_set_metadata`, so neither surface takes what the other refuses. Unknown keys
 * are stripped.
 */
export const assetMetadataPatchShape = {
  altText: z.record(zLocale, z.string()).optional().describe('Alt text per locale'),
  tags: z.array(zId).optional().describe('Taxonomy tag ids (the whole set)'),
  focalPoint: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('0..1 on each axis; crops are anchored here'),
  fields: z.record(z.string(), z.unknown()).optional().describe('Free-form custom values'),
};
export const assetMetadataBody = z.object(assetMetadataPatchShape);
export const altTextBody = z.object({
  locale: zLocale.optional(),
  context: zText.optional(),
  apply: z.boolean().optional(),
  tier: zTier.optional(),
});
export const createAiActionBody = z.object({
  name: zShort,
  description: zShort.optional(),
  promptTemplate: zText,
  targetField: zId.optional(),
  tier: zTier.optional(),
});
export const runAiActionBody = z.object({
  variables: z.record(z.string().max(128), z.string().max(10_000)).optional(),
  entryId: zId.optional(),
  locale: zLocale.optional(),
  apply: z.boolean().optional(),
});
export const webhookBody = z.object({
  url: z.string().max(2048),
  topics: z.array(z.string().max(64)).max(64),
  secret: z.string().min(1).max(512),
  active: z.boolean().optional(),
  headers: z.record(z.string().max(128), z.string().max(2048)).optional(),
  allEnvironments: z
    .boolean()
    .optional()
    .describe(
      "true: receive every environment's events. Otherwise only the events of the environment " +
        'in the path; under an alias the hook is space-wide and false is refused. On update, ' +
        "false scopes the hook to the path's environment and omitting it keeps the current scope.",
    ),
});
export const updateWebhookBody = webhookBody.partial();
export const createReleaseBody = z.object({ title: zShort, description: zShort.optional() });
export const releaseItemBody = z.object({
  entityId: zId,
  action: z.enum(['publish', 'unpublish']).optional(),
});
export const scheduleBody = z.object({
  action: z.enum(['publish', 'unpublish']),
  // Capitalized, as the domain, the MCP tool and the admin spell them; lowercase is accepted too.
  entityType: z
    .enum(['Entry', 'Release', 'entry', 'release'])
    .transform((t) => (t === 'entry' || t === 'Entry' ? 'Entry' : 'Release')),
  entityId: zId,
  scheduledFor: z.string().min(1).max(64),
});
export const agentScheduleBody = z.object({
  workflow: z.enum(AGENT_WORKFLOWS),
  // 5-field cron, UTC; the domain validates the expression itself.
  cron: z.string().min(9).max(100),
  contentTypeApiId: zId.optional(),
  enabled: z.boolean().optional(),
  autoApply: z.boolean().optional(),
});
export const agentSchedulePatchBody = z.object({
  cron: z.string().min(9).max(100).optional(),
  enabled: z.boolean().optional(),
  autoApply: z.boolean().optional(),
  // null clears the content-type restriction.
  contentTypeApiId: zId.nullable().optional(),
});
export const commentBody = z.object({
  body: z.string().min(1).max(20_000),
  author: zShort.optional(),
  parentId: zId.optional(),
});
export const createTaskBody = z.object({
  body: z.string().min(1).max(20_000),
  assignee: zShort.optional(),
});
export const updateTaskBody = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  assignee: zShort.nullable().optional(),
});
const workflowStep = z.object({
  id: zId,
  name: zShort,
  requiredScope: z.string().max(64),
});
export const workflowBody = z.object({ name: zShort, steps: z.array(workflowStep).max(100) });
// Graph workflows. The graph itself is shape-checked by the use-case (parseWorkflowGraph plus
// node/edge bounds), so it stays opaque here; the body limit bounds its size.
const workflowDraftFields = {
  description: z.string().max(2000).optional(),
  contentTypes: z.array(zId).max(100).optional(),
  graph: z.unknown().optional(),
  gatesPublish: z.boolean().optional(),
};
export const workflowDraftBody = z.object({ name: zShort.optional(), ...workflowDraftFields });
/** `POST /workflows`: legacy `{name, steps}` (published as v1) or a graph draft. */
export const createWorkflowBody = z.union([
  workflowBody,
  z.object({ name: zShort, ...workflowDraftFields }),
]);
export const validateWorkflowBody = z.object({ graph: z.unknown() });
export const workflowCopilotBody = z.object({
  prompt: z.string().min(1).max(4000),
  graph: z.unknown().optional(),
  contentTypes: z.array(zId).max(20).optional(),
});
const zJsonObject = z.record(z.string().max(128), z.unknown());
export const startWorkflowRunBody = z.object({
  workflowId: zId,
  version: z.number().int().positive().optional(),
  input: zJsonObject.optional(),
  vars: zJsonObject.optional(),
});
export const cancelWorkflowRunBody = z.object({ reason: z.string().max(500).optional() });
export const workflowEventBody = z.object({
  event: z.string().min(1).max(100),
  payload: zJsonObject.optional(),
});
export const decideWorkflowTaskBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
});
export const workflowSettingsBody = z.object({ separateDuties: z.boolean() });
export const trashSettingsBody = z.object({
  retentionDays: z
    .number()
    .int()
    .min(1)
    .max(MAX_TRASH_RETENTION_DAYS)
    .nullable()
    .describe('Days a trashed entry is kept before it is deleted permanently; null is off'),
});
export const transitionBody = z.object({ workflowId: zId, toStepId: zId });
export const schemeBody = z.object({ name: zShort });
/** What a tag or concept carries beside its label (see `TermFieldsInput`). */
const termFields = {
  slug: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('URL slug, normalized (a-z, 0-9, hyphens). Made from the label when omitted'),
  description: z.string().max(2000).nullable().optional().describe('Plain text; null clears it'),
  labels: z
    .record(z.string().min(2).max(35).describe('A locale of the space'), z.string().max(256))
    .refine((r) => Object.keys(r).length <= 100, 'At most 100 locales')
    .optional()
    .describe(
      'Labels by locale (the whole set). The default locale’s sets the term’s own label; an ' +
        'empty value removes that locale’s label',
    ),
};
export const conceptBody = z.object({
  schemeId: zId,
  prefLabel: zShort,
  broaderId: zId.nullable().optional(),
  ...termFields,
});
export const conceptPatchBody = z.object({ prefLabel: zShort.optional(), ...termFields });
export const broaderBody = z.object({ broaderId: zId.nullable().optional() });
export const tagBody = z.object({ name: zShort, ...termFields });
export const tagPatchBody = z.object({ name: zShort.optional(), ...termFields });
export const entryMetadataBody = z.object({
  tags: z.array(zId).max(1000).optional(),
  concepts: z.array(zId).max(1000).optional(),
});

/** PUT /deployment/scheduler/alerts: replaces who is emailed (the addresses are checked there). */
export const schedulerAlertsBody = z.object({
  recipients: z
    .array(z.string().max(320))
    .max(SCHEDULER_ALERT_MAX_RECIPIENTS)
    .describe('Email addresses; an empty list turns the emails off'),
});

/**
 * Per-locale settings to change, by locale; a locale left out keeps its own. Shapes are checked
 * here, and again (with the space's own locales and default) by the use-case.
 */
export const localeSettingsBody = z.object({
  localeSettings: z
    .record(
      z.string().min(2).max(35).describe('One of the space’s locales'),
      z
        .object({
          delivered: z
            .boolean()
            .optional()
            .describe('false: editable and previewable, never delivered (not the default locale)'),
          direction: z
            .enum(['ltr', 'rtl'])
            .optional()
            .describe('Which way its text runs; absent: from the language'),
        })
        .strict(),
    )
    .describe('Settings by locale'),
});
