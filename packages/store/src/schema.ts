import type {
  AssetAiSuggestions,
  AssetFile,
  AssetIngestStatus,
  AssetKind,
  AssetMetadata,
  AssetRights,
  AssetShareTargetType,
  AssetZipSource,
  AssetZipStatus,
  AuditDetail,
  ContentTypeGrant,
  ContentTypeLayout,
  DomainEvent,
  EntryFields,
  FieldDefinition,
  InviteGrant,
  InviteRole,
  LocalizedValue,
  MenuItem,
  PluginManifest,
  PluginSettingValue,
  PromotedContentType,
  PromotedEntry,
  PromotionResult,
  PromotionRisk,
  PromotionStatus,
  PublishedContentTypeDefinition,
  RedirectOrigin,
  RedirectStatus,
  RenditionFit,
  RenditionFormat,
  RolePreset,
  SavedViewQuery,
  SavedViewVisibility,
  StoredInviteStatus,
  WorkflowGraph,
  WorkflowGraphDefinition,
  WorkflowRun,
} from '@commerceworker/domain';
import type { BulkJobAction } from '@commerceworker/ports';
import { sql } from 'drizzle-orm';

/** Epoch milliseconds, the storage form of every timestamp column (drizzle maps it to `Date`). */
const NOW_MS = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema — the only file aware of the physical data model. The domain
 * never imports these types. Content types and entries are environment-scoped
 * (a space holds many environments / branches).
 *
 * For P1, a content type's field definitions are stored as a JSONB column
 * (their natural cohesive, versioned unit). A normalized `fields` table is a
 * later optimization that does not change this adapter's port behavior.
 */

export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  defaultLocale: text('default_locale').notNull(),
  locales: text('locales', { mode: 'json' }).$type<string[]>().notNull(),
  fallbacks: text('fallbacks', { mode: 'json' }).$type<Record<string, string | null>>(),
  /** Per-locale settings, `{ delivered?, direction? }` by locale; null: the defaults for every
   *  locale (0025_locale_settings). */
  localeSettings: text('locale_settings', { mode: 'json' }).$type<
    Record<string, { delivered?: boolean; direction?: 'ltr' | 'rtl' }>
  >(),
  /** Default separation of duties for workflow approvals that leave it unset. */
  workflowSeparateDuties: integer('workflow_separate_duties', { mode: 'boolean' })
    .notNull()
    .default(false),
  /** Days a trashed entry is kept before the engine's sweep purges it; null is off (keep). */
  trashRetentionDays: integer('trash_retention_days'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
});

export const environments = sqliteTable(
  'environments',
  {
    id: text('id').notNull(),
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    /** Where the trash retention sweep resumes here; null is from the oldest. */
    trashSweepCursor: text('trash_sweep_cursor', { mode: 'json' }).$type<{
      trashedAt: string;
      id: string;
    }>(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.id] })],
);

/** Repointable pointers to a target environment (blue/green serving). */
export const environmentAliases = sqliteTable(
  'environment_aliases',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    targetEnvironmentId: text('target_environment_id').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.alias] })],
);

/**
 * Deleted environments whose rows are still being removed, in bounded steps by the engine
 * (0003_environment_purges). While a row is here the name can't be reused.
 */
export const environmentPurges = sqliteTable(
  'environment_purges',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).notNull(),
    nudgedAt: integer('nudged_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId] })],
);

/**
 * Content promoted from one environment to another, with its risk check and approval
 * (0006_environment_promotions). Space-level: it keeps its history when an environment goes.
 */
export const environmentPromotions = sqliteTable(
  'environment_promotions',
  {
    spaceId: text('space_id').notNull(),
    id: text('id').notNull(),
    sourceEnvironmentId: text('source_environment_id').notNull(),
    targetEnvironmentId: text('target_environment_id').notNull(),
    contentTypes: text('content_types', { mode: 'json' }).$type<PromotedContentType[]>().notNull(),
    entries: text('entries', { mode: 'json' }).$type<PromotedEntry[]>().notNull(),
    status: text('status').$type<PromotionStatus>().notNull(),
    risk: text('risk', { mode: 'json' }).$type<PromotionRisk>().notNull(),
    requestedBy: text('requested_by').notNull(),
    decidedBy: text('decided_by'),
    result: text('result', { mode: 'json' }).$type<PromotionResult>(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.id] }),
    index('environment_promotions_by_created').on(t.spaceId, t.createdAt),
  ],
);

/** `content_types.published_definition` as its trigger writes it (a null pattern, no flag). */
export type StoredPublishedDefinition = Omit<
  PublishedContentTypeDefinition,
  'urlPattern' | 'singleton'
> & { readonly urlPattern: string | null };

export const contentTypes = sqliteTable(
  'content_types',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    apiId: text('api_id').notNull(),
    name: text('name').notNull(),
    displayField: text('display_field').notNull(),
    fields: text('fields', { mode: 'json' }).$type<FieldDefinition[]>().notNull(),
    version: integer('version').notNull(),
    status: text('status').$type<'draft' | 'published'>().notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    /** Where the type's entries live on the site (0017_redirects). */
    urlPattern: text('url_pattern'),
    /** Holds at most one entry (0027_singleton_types). */
    singleton: integer('singleton', { mode: 'boolean' }).notNull().default(false),
    /** `singleton` as last published: what Delivery serves by (0028_published_singleton). */
    publishedSingleton: integer('published_singleton', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * The definition last published, while a draft revision holds this row: what Delivery serves.
     * Null otherwise. Written only by 0030_published_definition's triggers, on `status`, so code
     * of any version keeps it right; never set it here.
     */
    publishedDefinition: text('published_definition', {
      mode: 'json',
    }).$type<StoredPublishedDefinition>(),
    /** The admin's sidebar group, description and icon (0026_content_type_details). */
    group: text('group_name'),
    description: text('description'),
    icon: text('icon'),
    /** How an agent should write this type's entries; never delivered (0032). */
    agentInstructions: text('agent_instructions'),
    /** The entry form's tabs and field groups; editor-only, never delivered (0026). */
    layout: text('layout', { mode: 'json' }).$type<ContentTypeLayout>(),
    /** The frontend URL the admin previews entries at; editor-only, never delivered (0035). */
    previewUrlTemplate: text('preview_url_template'),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.apiId] })],
);

export const entries = sqliteTable(
  'entries',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    contentTypeApiId: text('content_type_api_id').notNull(),
    status: text('status').$type<'draft' | 'changed' | 'published' | 'archived'>().notNull(),
    currentVersion: integer('current_version').notNull(),
    publishedVersion: integer('published_version'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    /** Authorship (0024_entry_authorship): null when unknown (written before it). An actor is the
     *  principal's audit identity, `agent:<name>`, `workflow:<id>`, `plugin:<id>` or `system`. */
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    createdBy: text('created_by'),
    /** Who made the change `updatedAt` records. */
    modifiedBy: text('modified_by'),
    /** Set by the first publish and never moved again (the store writes it with COALESCE). */
    firstPublishedAt: integer('first_published_at', { mode: 'timestamp_ms' }),
    /** The entry's place in its type's manual order (0034_entry_position), written only by a move;
     *  null sorts by `id`. Read as `COALESCE(position, id)`. */
    position: text('position'),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('entries_by_position').on(
      t.spaceId,
      t.environmentId,
      t.contentTypeApiId,
      sql`coalesce(${t.position}, ${t.id})`,
      t.id,
    ),
    index('entries_by_creator').on(t.spaceId, t.environmentId, t.createdBy),
    // The trash retention sweep: an archived entry's `updated_at` is when it was trashed.
    index('entries_trashed')
      .on(t.spaceId, t.environmentId, t.updatedAt, t.id)
      .where(sql`${t.status} = 'archived'`),
  ],
);

// The uniqueness registry behind `unique` fields. A row per (entry, field,
// locale) claim, with a unique index doing the actual enforcing — a
// read-then-write check in the application would let two concurrent creates
// both pass, which is exactly the case `unique` exists to prevent.
export const entryUniqueValues = sqliteTable(
  'entry_unique_values',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    contentTypeApiId: text('content_type_api_id').notNull(),
    fieldApiId: text('field_api_id').notNull(),
    locale: text('locale').notNull(),
    value: text('value').notNull(),
    entryId: text('entry_id').notNull(),
  },
  (t) => [
    uniqueIndex('entry_unique_values_claim').on(
      t.spaceId,
      t.environmentId,
      t.contentTypeApiId,
      t.fieldApiId,
      t.locale,
      t.value,
    ),
    // Releasing an entry's claims (trash, purge, re-save) deletes by entry.
    index('entry_unique_values_by_entry').on(t.spaceId, t.environmentId, t.entryId),
  ],
);

export const entryVersions = sqliteTable(
  'entry_versions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    version: integer('version').notNull(),
    fields: text('fields', { mode: 'json' }).$type<EntryFields>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    /** Set once the body has moved to object storage under this key; `fields` is then `{}`
     *  (0004_version_bodies). */
    bodyKey: text('body_key'),
    /** Who saved this version; null when unknown (0024_entry_authorship). */
    createdBy: text('created_by'),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId, t.version] })],
);

/**
 * Superseded versions waiting for their body to move to object storage (0004_version_bodies).
 * Queued when a newer version is saved, due a day later; the archive sweep drains due rows.
 */
export const versionArchiveQueue = sqliteTable(
  'version_archive_queue',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    version: integer('version').notNull(),
    dueAt: integer('due_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId, t.version] }),
    index('version_archive_queue_due').on(t.dueAt),
  ],
);

export const entryPublished = sqliteTable(
  'entry_published',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    contentTypeApiId: text('content_type_api_id').notNull(),
    version: integer('version').notNull(),
    fields: text('fields', { mode: 'json' }).$type<EntryFields>().notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<{ tags: string[]; concepts: string[] }>(),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }).notNull(),
    /** The entry's first publish, copied from `entries` (0024_entry_authorship); null when unknown. */
    firstPublishedAt: integer('first_published_at', { mode: 'timestamp_ms' }),
    /** The entry's `position`, kept by triggers (0034_entry_position); null sorts by `entry_id`. */
    position: text('position'),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId] }),
    index('entry_published_by_type').on(t.spaceId, t.environmentId, t.contentTypeApiId),
    index('entry_published_by_position').on(
      t.spaceId,
      t.environmentId,
      t.contentTypeApiId,
      sql`coalesce(${t.position}, ${t.entryId})`,
      t.entryId,
    ),
    // The lexical leg of hybrid search is not here: it lives in the SearchShard Durable Objects
    // (FTS5), fed by the index queue, so FTS writes never contend for D1's single writer and the
    // database stays exportable (D1 cannot export a database that holds a virtual table).
  ],
);

export const assets = sqliteTable(
  'assets',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    status: text('status').$type<'draft' | 'published' | 'archived'>().notNull(),
    file: text('file', { mode: 'json' }).$type<AssetFile>().notNull(),
    title: text('title', { mode: 'json' }).$type<LocalizedValue>().notNull(),
    description: text('description', { mode: 'json' }).$type<LocalizedValue>().notNull(),
    metadata: text('metadata', { mode: 'json' })
      .$type<AssetMetadata>()
      .notNull()
      .default({ altText: {}, tags: [] }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    // Copied out of `file` on every write (0007_dam), so the library filters and sorts in SQL.
    kind: text('kind').$type<AssetKind>().notNull().default('other'),
    mime: text('mime'),
    size: integer('size'),
    width: integer('width'),
    height: integer('height'),
    contentHash: text('content_hash'),
    folderId: text('folder_id'),
    version: integer('version').notNull().default(1),
    r2Key: text('r2_key'),
    /** 0 on a row the pre-0007 code inserted during a deploy; read as unknown. */
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`0`),
    createdBy: text('created_by'),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    rights: text('rights', { mode: 'json' }).$type<AssetRights>(),
    // Written by asset ingest only (0011_asset_ingest); NULL until it first runs.
    ingestStatus: text('ingest_status').$type<AssetIngestStatus>(),
    ingestError: text('ingest_error'),
    duplicateOf: text('duplicate_of'),
    aiSuggestions: text('ai_suggestions', { mode: 'json' }).$type<AssetAiSuggestions>(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('assets_by_ingest').on(t.spaceId, t.environmentId, t.ingestStatus),
    index('assets_by_updated').on(t.spaceId, t.environmentId, t.updatedAt, t.id),
    index('assets_by_created').on(t.spaceId, t.environmentId, t.createdAt, t.id),
    index('assets_by_kind').on(t.spaceId, t.environmentId, t.kind, t.updatedAt),
    index('assets_by_mime').on(t.spaceId, t.environmentId, t.mime),
    index('assets_by_folder').on(t.spaceId, t.environmentId, t.folderId, t.updatedAt),
    index('assets_by_status').on(t.spaceId, t.environmentId, t.status, t.updatedAt),
    index('assets_by_hash').on(t.spaceId, t.environmentId, t.contentHash),
    // Drafts whose upload never landed, oldest first, across scopes (0014_asset_upload_sweep).
    index('assets_awaiting_upload')
      .on(t.createdAt)
      .where(
        sql`${t.status} = 'draft' AND ${t.ingestStatus} IS NULL AND ${t.size} IS NULL AND ${t.r2Key} IS NOT NULL`,
      ),
  ],
);

/**
 * The asset library's folders. `path` is the materialized path of ids (`/a/b/`); `parentId` is
 * '' at the root so sibling names stay unique there too.
 */
export const assetFolders = sqliteTable(
  'asset_folders',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    parentId: text('parent_id').notNull().default(''),
    path: text('path').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    uniqueIndex('asset_folders_sibling_name').on(t.spaceId, t.environmentId, t.parentId, t.name),
    index('asset_folders_by_path').on(t.spaceId, t.environmentId, t.path),
  ],
);

/** Collections: named, ordered sets of assets (0016_asset_collections). */
export const assetCollections = sqliteTable(
  'asset_collections',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    createdBy: text('created_by'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('asset_collections_by_name').on(t.spaceId, t.environmentId, t.name, t.id),
  ],
);

/** A collection's members; `position` orders them (lower first, not necessarily dense). */
export const assetCollectionItems = sqliteTable(
  'asset_collection_items',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    collectionId: text('collection_id').notNull(),
    assetId: text('asset_id').notNull(),
    position: integer('position').notNull(),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.collectionId, t.assetId] }),
    index('asset_collection_items_by_position').on(
      t.spaceId,
      t.environmentId,
      t.collectionId,
      t.position,
      t.assetId,
    ),
    index('asset_collection_items_by_asset').on(t.spaceId, t.environmentId, t.assetId),
  ],
);

/** Expiring, revocable share links to an asset or a collection (0016_asset_collections). */
export const assetShareLinks = sqliteTable(
  'asset_share_links',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    targetType: text('target_type').$type<AssetShareTargetType>().notNull(),
    targetId: text('target_id').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    allowDownload: integer('allow_download', { mode: 'boolean' }).notNull().default(false),
    // PBKDF2 (`pbkdf2:<iterations>:<salt>:<hash>`), never the password.
    passwordHash: text('password_hash'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    createdBy: text('created_by'),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('asset_share_links_by_target').on(t.spaceId, t.environmentId, t.targetType, t.targetId),
    index('asset_share_links_by_created').on(t.spaceId, t.environmentId, t.createdAt),
  ],
);

/** Zip downloads and the engine Workflow's progress building them (0016_asset_collections). */
export const assetZipJobs = sqliteTable(
  'asset_zip_jobs',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    status: text('status').$type<AssetZipStatus>().notNull(),
    source: text('source', { mode: 'json' }).$type<AssetZipSource>().notNull(),
    fileName: text('file_name').notNull(),
    fileCount: integer('file_count'),
    totalBytes: integer('total_bytes'),
    partsDone: integer('parts_done').notNull().default(0),
    partCount: integer('part_count'),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    createdBy: text('created_by'),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('asset_zip_jobs_by_created').on(t.spaceId, t.environmentId, t.createdAt),
    index('asset_zip_jobs_by_expiry').on(t.expiresAt),
  ],
);

/** Multipart uploads in progress (0016_asset_collections). */
export const assetUploads = sqliteTable(
  'asset_uploads',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    assetId: text('asset_id').notNull(),
    uploadId: text('upload_id').notNull(),
    r2Key: text('r2_key').notNull(),
    size: integer('size').notNull(),
    partSize: integer('part_size').notNull(),
    contentType: text('content_type').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.assetId, t.uploadId] }),
    index('asset_uploads_by_created').on(t.createdAt),
  ],
);

/** The files an asset had before its current one, one row per replaced version. */
export const assetVersions = sqliteTable(
  'asset_versions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    assetId: text('asset_id').notNull(),
    version: integer('version').notNull(),
    file: text('file', { mode: 'json' }).$type<AssetFile>().notNull(),
    r2Key: text('r2_key'),
    contentHash: text('content_hash'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    createdBy: text('created_by'),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.assetId, t.version] })],
);

export const assetPublished = sqliteTable(
  'asset_published',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    assetId: text('asset_id').notNull(),
    file: text('file', { mode: 'json' }).$type<AssetFile>().notNull(),
    title: text('title', { mode: 'json' }).$type<LocalizedValue>().notNull(),
    description: text('description', { mode: 'json' }).$type<LocalizedValue>().notNull(),
    metadata: text('metadata', { mode: 'json' })
      .$type<AssetMetadata>()
      .notNull()
      .default({ altText: {}, tags: [] }),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }).notNull(),
    // What Delivery and the media Worker build URLs from (0009_asset_published_delivery).
    version: integer('version').notNull().default(1),
    r2Key: text('r2_key'),
    kind: text('kind').$type<AssetKind>().notNull().default('other'),
    rights: text('rights', { mode: 'json' }).$type<AssetRights>(),
    // `rights.expiresAt` copied out on every write (0015_asset_expiry), for the expiry sweep.
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.assetId] }),
    index('asset_published_by_time').on(t.spaceId, t.environmentId, t.publishedAt, t.assetId),
    index('asset_published_by_kind').on(t.spaceId, t.environmentId, t.kind, t.publishedAt),
    index('asset_published_by_expiry').on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
  ],
);

/** A space's named image presets (0008_asset_renditions); not environment-scoped. */
export const assetRenditions = sqliteTable(
  'asset_renditions',
  {
    spaceId: text('space_id').notNull(),
    name: text('name').notNull(),
    width: integer('width'),
    height: integer('height'),
    fit: text('fit').$type<RenditionFit>(),
    format: text('format').$type<RenditionFormat>(),
    quality: integer('quality'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.name] })],
);

export const references = sqliteTable(
  'references',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    fromEntryId: text('from_entry_id').notNull(),
    fromField: text('from_field').notNull(),
    toId: text('to_id').notNull(),
    toType: text('to_type').$type<'Entry' | 'Asset'>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.fromEntryId, t.fromField, t.toId] }),
    index('references_reverse').on(t.spaceId, t.environmentId, t.toId),
  ],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    kind: text('kind').$type<'cma' | 'cda' | 'cpa'>().notNull(),
    // Optional human label; the admin shows "Name (optional)".
    name: text('name'),
    hashedToken: text('hashed_token').notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false),
    // Granular RBAC: when set, permissions resolve live from this role.
    roleId: text('role_id'),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    // When set, the key stops authenticating after this instant (e.g. OIDC keys).
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    // Provenance: operator-minted key, OAuth-granted token, or personal access
    // token. Delegated issuances (oauth/pat) resolve to a `user` principal and
    // treat `scopes` as a ceiling over the live role.
    issuance: text('issuance').$type<'key' | 'oauth' | 'pat' | 'setup'>(),
    // The human the token acts for, and the OAuth client that obtained it.
    subject: text('subject'),
    clientId: text('client_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex('api_keys_hashed_token').on(t.hashedToken),
    index('api_keys_by_space').on(t.spaceId),
    index('api_keys_by_subject').on(t.spaceId, t.subject),
  ],
);

// Custom roles (granular RBAC): a named scope set plus per-content-type
// grants (with per-field deny/read-only rules), referenced by api_keys.role_id.
export const roles = sqliteTable(
  'roles',
  {
    spaceId: text('space_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    contentGrants: text('content_grants', { mode: 'json' }).$type<ContentTypeGrant[]>().notNull(),
    // Built-in role preset this role was seeded as (viewer … admin); null for custom roles.
    preset: text('preset').$type<RolePreset>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.id] }),
    // One role per preset per space, so racing lazy seeds can't duplicate a preset.
    uniqueIndex('roles_space_preset').on(t.spaceId, t.preset).where(sql`${t.preset} IS NOT NULL`),
  ],
);

// The people on a space's team: an email (unique per space), the OIDC subject once they sign in
// with SSO, and the role they hold. SSO sign-in resolves a person's role from here first.
export const spaceMembers = sqliteTable(
  'space_members',
  {
    spaceId: text('space_id').notNull(),
    id: text('id').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    subject: text('subject'),
    roleId: text('role_id').notNull(),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.id] }),
    uniqueIndex('space_members_email').on(t.spaceId, t.email),
  ],
);

// Invitations to the admin (0019), deployment-wide. Only the links' token hashes are stored;
// `version` is the compare-and-set that makes a link work once; `expired` is read, never written.
export const memberInvites = sqliteTable(
  'member_invites',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    role: text('role').$type<InviteRole>().notNull(),
    grants: text('grants', { mode: 'json' }).$type<InviteGrant[]>().notNull().default(sql`'[]'`),
    tokenHash: text('token_hash').notNull(),
    emailTokenHash: text('email_token_hash'),
    status: text('status').$type<StoredInviteStatus>().notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    version: integer('version').notNull(),
    invitedByKind: text('invited_by_kind').notNull(),
    invitedById: text('invited_by_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }).notNull(),
    sendCount: integer('send_count').notNull().default(1),
    emailedAt: integer('emailed_at', { mode: 'timestamp_ms' }),
    acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }),
    acceptedBy: text('accepted_by'),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    revokedByKind: text('revoked_by_kind'),
    revokedById: text('revoked_by_id'),
  },
  (t) => [
    uniqueIndex('member_invites_token').on(t.tokenHash),
    uniqueIndex('member_invites_email_token')
      .on(t.emailTokenHash)
      .where(sql`${t.emailTokenHash} IS NOT NULL`),
    index('member_invites_by_status').on(t.status, t.createdAt),
    index('member_invites_by_email').on(t.email, t.status),
  ],
);

// Deployment-wide settings (first-run setup state, per-space access settings), with a version
// for compare-and-set so two racing writers (two setup submissions) can't both win.
export const deploymentSettings = sqliteTable('deployment_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  version: integer('version').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
});

// The engine cron's heartbeat: when each sweep last ran, last succeeded and last failed (0012).
// Written once a tick by the cron only; `job = 'tick'` is the tick itself.
export const schedulerJobs = sqliteTable('scheduler_jobs', {
  job: text('job').primaryKey(),
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }).notNull(),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
  lastErrorAt: integer('last_error_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
});

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    workflow: text('workflow').notNull(),
    entryId: text('entry_id').notNull(),
    status: text('status').notNull(),
    decisions: text('decisions', { mode: 'json' }).$type<string[]>().notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('agent_runs_by_space').on(t.spaceId, t.createdAt)],
);

/** Append-only governance audit trail. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id'),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    status: integer('status').notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    detail: text('detail', { mode: 'json' }).$type<AuditDetail>(),
  },
  (t) => [
    index('audit_log_by_space').on(t.spaceId, t.at),
    index('audit_log_by_actor').on(t.spaceId, t.actor, t.at, t.id),
    index('audit_log_by_action').on(t.spaceId, t.action, t.at, t.id),
    index('audit_log_by_target').on(t.spaceId, t.targetId, t.at, t.id),
  ],
);

/**
 * Which entries each audit row is about: its target when that is an entry, and every entry its
 * `detail` names. Written only by the `audit_log_index_entries` trigger (0033) as a row is
 * appended, so every writer's rows are indexed; the store reads it, never writes it.
 */
export const auditLogEntries = sqliteTable(
  'audit_log_entries',
  {
    auditId: text('audit_id').notNull(),
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id'),
    entryId: text('entry_id').notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.auditId, t.entryId] }),
    index('audit_log_entries_by_entry').on(t.spaceId, t.environmentId, t.entryId, t.at, t.auditId),
  ],
);

/** Persisted, templated AI operations ("AI Actions"), env-scoped. */
export const aiActions = sqliteTable(
  'ai_actions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    promptTemplate: text('prompt_template').notNull(),
    variables: text('variables', { mode: 'json' }).$type<string[]>().notNull(),
    targetField: text('target_field'),
    tier: text('tier').$type<'flagship' | 'balanced' | 'fast'>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

/** User-defined functions invoked over HTTP on matching domain events. */
export const functions = sqliteTable(
  'functions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    eventPattern: text('event_pattern').notNull(),
    url: text('url').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

/** UI extensions the admin renders in a sandboxed iframe (custom field editors / sidebar widgets). */
export const appExtensions = sqliteTable(
  'app_extensions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    target: text('target').notNull(),
    entryUrl: text('entry_url').notNull(),
    fieldTypes: text('field_types', { mode: 'json' }).$type<string[]>(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    url: text('url').notNull(),
    topics: text('topics', { mode: 'json' }).$type<string[]>().notNull(),
    secret: text('secret').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    headers: text('headers', { mode: 'json' }).$type<Record<string, string>>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    /** The one environment whose events it receives; NULL for every environment (0005). */
    environmentId: text('environment_id'),
  },
  (t) => [index('webhooks_by_environment').on(t.spaceId, t.environmentId)],
);

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    spaceId: text('space_id').notNull(),
    webhookId: text('webhook_id').notNull(),
    eventId: text('event_id').notNull(),
    status: text('status').$type<'success' | 'failed'>().notNull(),
    statusCode: integer('status_code'),
    attempts: integer('attempts').notNull(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    /** The event's type; NULL on records from before it was kept (0022). */
    eventType: text('event_type'),
    /** The delivery this attempt resent, when an administrator asked for it again (0022). */
    resendOf: integer('resend_of'),
  },
  (t) => [
    index('webhook_deliveries_by_webhook').on(t.spaceId, t.webhookId),
    // Serves the retention sweep (deleteDeliveriesBefore).
    index('webhook_deliveries_by_created').on(t.createdAt),
  ],
);

export const releases = sqliteTable(
  'releases',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').$type<'open' | 'published' | 'archived'>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const releaseItems = sqliteTable(
  'release_items',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    releaseId: text('release_id').notNull(),
    entityType: text('entity_type').$type<'Entry'>().notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').$type<'publish' | 'unpublish'>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.releaseId, t.entityId] })],
);

export const scheduledActions = sqliteTable(
  'scheduled_actions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    action: text('action').$type<'publish' | 'unpublish'>().notNull(),
    entityType: text('entity_type').$type<'Entry' | 'Release'>().notNull(),
    entityId: text('entity_id').notNull(),
    scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }).notNull(),
    status: text('status').$type<'pending' | 'completed' | 'canceled' | 'failed'>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    executedAt: integer('executed_at', { mode: 'timestamp_ms' }),
    error: text('error'),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    // The worker scans for pending actions whose time has arrived.
    index('scheduled_actions_due').on(t.status, t.scheduledFor),
  ],
);

export const agentReviews = sqliteTable(
  'agent_reviews',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    workflow: text('workflow').notNull(),
    entryId: text('entry_id').notNull(),
    proposed: text('proposed', { mode: 'json' }).$type<EntryFields>().notNull(),
    notes: text('notes', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull(),
    awaiting: integer('awaiting', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    decidedBy: text('decided_by'),
    appliedAt: integer('applied_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    // Reviewers list pending reviews per scope, newest first.
    index('agent_reviews_pending').on(t.spaceId, t.environmentId, t.status, t.createdAt),
  ],
);

export const agentSchedules = sqliteTable(
  'agent_schedules',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    workflow: text('workflow').notNull(),
    contentTypeApiId: text('content_type_api_id'),
    cron: text('cron').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    autoApply: integer('auto_apply', { mode: 'boolean' }).notNull().default(false),
    lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
    cursorEntryId: text('cursor_entry_id'),
    nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    // The worker scans for enabled schedules whose next run has arrived.
    index('agent_schedules_due').on(t.enabled, t.nextRunAt),
  ],
);

export const comments = sqliteTable(
  'comments',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    entryId: text('entry_id').notNull(),
    parentId: text('parent_id'),
    author: text('author').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('comments_by_entry').on(t.spaceId, t.environmentId, t.entryId),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    entryId: text('entry_id').notNull(),
    assignee: text('assignee'),
    body: text('body').notNull(),
    status: text('status').$type<'open' | 'resolved'>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('tasks_by_entry').on(t.spaceId, t.environmentId, t.entryId),
  ],
);

export const workflowDefinitions = sqliteTable(
  'workflow_definitions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    /**
     * Legacy ordered steps. Kept (expand/contract) and written on every draft save, derived from
     * the graph's `content.stage` nodes, so steps-only readers keep working; dropped in the
     * contract PR once nothing reads it.
     */
    steps: text('steps', { mode: 'json' })
      .$type<{ id: string; name: string; requiredScope: string }[]>()
      .notNull(),
    description: text('description').notNull().default(''),
    // A JSON array in TEXT, the convention for every list here (SQLite has no array type).
    contentTypes: text('content_types', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** The editable draft graph; null for a legacy row stored only as `steps`. */
    graph: text('graph', { mode: 'json' }).$type<WorkflowGraph>(),
    gatesPublish: integer('gates_publish', { mode: 'boolean' }).notNull().default(false),
    /** Null for a legacy row never saved as a graph. */
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

/**
 * Immutable, numbered published snapshots of a workflow graph definition. Append-only: runs pin
 * `(workflow_id, version)`, so a row is never updated, and it outlives its definition row.
 */
export const workflowVersions = sqliteTable(
  'workflow_versions',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    version: integer('version').notNull(),
    /** The published `WorkflowGraphDefinition` (name, description, content types, graph, …). */
    definition: text('definition', { mode: 'json' }).$type<WorkflowGraphDefinition>().notNull(),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }).notNull(),
    publishedBy: text('published_by'),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.workflowId, t.version] })],
);

/**
 * Workflow runs: one row per run, holding the run's live state and the fields run lists filter
 * and sort on. Written with optimistic concurrency on `rev`.
 */
export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    workflowId: text('workflow_id').notNull(),
    version: integer('version').notNull(),
    generation: integer('generation').notNull(),
    entryId: text('entry_id').notNull(),
    contentTypeApiId: text('content_type_api_id').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    /** The planner's `PlanState`. */
    plan: text('plan', { mode: 'json' }).$type<WorkflowRun['plan']>().notNull(),
    /** Live per-node detail (`NodeRun` by node id). */
    nodes: text('nodes', { mode: 'json' }).$type<WorkflowRun['nodes']>().notNull(),
    vars: text('vars', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    input: text('input', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    seq: integer('seq').notNull(),
    waitingOn: text('waiting_on'),
    waitingAt: text('waiting_at'),
    waitingSince: integer('waiting_since', { mode: 'timestamp_ms' }),
    waitingDue: integer('waiting_due', { mode: 'timestamp_ms' }),
    waitingFor: text('waiting_for'),
    stoppedAt: text('stopped_at'),
    /** Events delivered before their wait opened (`EarlyEvent[]`). */
    earlyEvents: text('early_events', { mode: 'json' })
      .$type<WorkflowRun['earlyEvents']>()
      .notNull()
      .default([]),
    /** `{ id, principal }`: who the run acts as. */
    startedBy: text('started_by', { mode: 'json' }).$type<WorkflowRun['startedBy']>().notNull(),
    triggerEventId: text('trigger_event_id'),
    instanceId: text('instance_id').notNull(),
    logSeq: integer('log_seq').notNull(),
    rev: integer('rev').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('workflow_runs_by_entry').on(t.spaceId, t.environmentId, t.entryId),
    index('workflow_runs_by_status').on(t.spaceId, t.environmentId, t.status),
    index('workflow_runs_by_workflow').on(t.spaceId, t.environmentId, t.workflowId),
    index('workflow_runs_by_waiting_due').on(t.spaceId, t.environmentId, t.waitingDue),
    uniqueIndex('workflow_runs_trigger_event')
      .on(t.spaceId, t.environmentId, t.triggerEventId)
      .where(sql`${t.triggerEventId} IS NOT NULL`),
  ],
);

/** Finished node runs: timing and output, for dashboards and undo. */
export const workflowNodeRuns = sqliteTable(
  'workflow_node_runs',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    runId: text('run_id').notNull(),
    generation: integer('generation').notNull(),
    nodeId: text('node_id').notNull(),
    run: integer('run').notNull(),
    nodeType: text('node_type').notNull(),
    /** AI nodes: the model tier that answered, or `heuristic`. */
    model: text('model'),
    /** Audit identity the node ran as (the starter, or the approver upstream of it). */
    ranBy: text('ran_by'),
    status: text('status').notNull(),
    summary: text('summary'),
    output: text('output', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }).notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.spaceId, t.environmentId, t.runId, t.generation, t.nodeId, t.run],
    }),
  ],
);

/** A run's timeline. A keyed entry replaces its earlier row and takes a new `seq`. */
export const workflowTimeline = sqliteTable(
  'workflow_timeline',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    runId: text('run_id').notNull(),
    key: text('key').notNull(),
    seq: integer('seq').notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    kind: text('kind').notNull(),
    nodeId: text('node_id'),
    message: text('message').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.runId, t.key] }),
    index('workflow_timeline_by_seq').on(t.spaceId, t.environmentId, t.runId, t.seq),
  ],
);

/** Approvals, event waits and agent reviews runs hold open. */
export const workflowTasks = sqliteTable(
  'workflow_tasks',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    runId: text('run_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    nodeId: text('node_id').notNull(),
    eventType: text('event_type').notNull(),
    kind: text('kind').notNull(),
    entryId: text('entry_id').notNull(),
    contentTypeApiId: text('content_type_api_id').notNull(),
    title: text('title').notNull(),
    instructions: text('instructions').notNull().default(''),
    assignee: text('assignee'),
    event: text('event'),
    requiredScope: text('required_scope'),
    separateDuties: integer('separate_duties', { mode: 'boolean' }).notNull().default(false),
    reviewId: text('review_id'),
    deadline: integer('deadline', { mode: 'timestamp_ms' }).notNull(),
    status: text('status').notNull(),
    requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    decidedBy: text('decided_by'),
    note: text('note'),
    startedBy: text('started_by').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    uniqueIndex('workflow_tasks_run_event').on(t.spaceId, t.environmentId, t.runId, t.eventType),
    index('workflow_tasks_by_status_deadline').on(t.spaceId, t.environmentId, t.status, t.deadline),
    index('workflow_tasks_by_entry').on(t.spaceId, t.environmentId, t.entryId),
  ],
);

export const entryWorkflowState = sqliteTable(
  'entry_workflow_state',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    currentStepId: text('current_step_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId] })],
);

export const conceptSchemes = sqliteTable(
  'concept_schemes',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const concepts = sqliteTable(
  'concepts',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    schemeId: text('scheme_id').notNull(),
    prefLabel: text('pref_label').notNull(),
    broaderId: text('broader_id'),
    /** Unique within the scheme. NULL only on a row older code wrote (the recount sweep fills it). */
    slug: text('slug'),
    description: text('description'),
    /** Labels in the space's other locales (locale → label); `pref_label` is the default's. */
    labels: text('labels', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    index('concepts_by_scheme').on(t.spaceId, t.environmentId, t.schemeId),
    uniqueIndex('concepts_by_slug').on(t.spaceId, t.environmentId, t.schemeId, t.slug),
  ],
);

export const tags = sqliteTable(
  'tags',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    /** Unique in the environment. NULL only on a row older code wrote (the recount sweep fills it). */
    slug: text('slug'),
    description: text('description'),
    /** Labels in the space's other locales (locale → label); `name` is the default's. */
    labels: text('labels', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    uniqueIndex('tags_by_slug').on(t.spaceId, t.environmentId, t.slug),
  ],
);

/**
 * How many published entries of each content type carry each term (`kind` is `tag` or
 * `concept`). Kept by the store in the same batch as the published snapshots it counts.
 */
export const taxonomyUsage = sqliteTable(
  'taxonomy_usage',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    kind: text('kind').$type<'tag' | 'concept'>().notNull(),
    termId: text('term_id').notNull(),
    contentTypeApiId: text('content_type_api_id').notNull(),
    publishedCount: integer('published_count').notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.spaceId, t.environmentId, t.kind, t.termId, t.contentTypeApiId],
    }),
  ],
);

/** Redirects, as delivery data (0017_redirects). `locale` is '' for every locale. */
export const redirects = sqliteTable(
  'redirects',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    source: text('source').notNull(),
    locale: text('locale').notNull().default(''),
    destination: text('destination').notNull(),
    status: integer('status').$type<RedirectStatus>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    note: text('note'),
    origin: text('origin').$type<RedirectOrigin>().notNull(),
    entryId: text('entry_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    uniqueIndex('redirects_by_source').on(t.spaceId, t.environmentId, t.source, t.locale),
    index('redirects_by_destination').on(t.spaceId, t.environmentId, t.destination),
  ],
);

/** A redirect set's revision, the compare-and-set every write to it rides with (0017_redirects). */
export const redirectSets = sqliteTable(
  'redirect_sets',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    revision: integer('revision').notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId] })],
);

/** Navigation menus, each a JSON tree of items written whole at its revision (0020_menus). */
export const menus = sqliteTable(
  'menus',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    items: text('items', { mode: 'json' }).$type<MenuItem[]>().notNull(),
    revision: integer('revision').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.id] }),
    uniqueIndex('menus_by_handle').on(t.spaceId, t.environmentId, t.handle),
  ],
);

/**
 * Saved views of the entries list (0029_saved_views): a named structured query and columns,
 * personal or shared. Space-scoped: every environment of a space shows the same views.
 */
export const savedViews = sqliteTable(
  'saved_views',
  {
    spaceId: text('space_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    contentType: text('content_type'),
    visibility: text('visibility').$type<SavedViewVisibility>().notNull(),
    createdBy: text('created_by').notNull(),
    query: text('query', { mode: 'json' }).$type<SavedViewQuery>().notNull(),
    columns: text('columns', { mode: 'json' }).$type<string[]>(),
    revision: integer('revision').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.id] }),
    index('saved_views_by_owner').on(t.spaceId, t.visibility, t.createdBy),
  ],
);

export const entryMetadata = sqliteTable(
  'entry_metadata',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    concepts: text('concepts', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.entryId] })],
);

export const previewTokens = sqliteTable(
  'preview_tokens',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    entryId: text('entry_id').notNull(),
    hashedToken: text('hashed_token').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex('preview_tokens_hashed_token').on(t.hashedToken),
    index('preview_tokens_by_entry').on(t.spaceId, t.environmentId, t.entryId),
  ],
);

// OAuth 2.1 authorization server. Clients arrive through unauthenticated
// dynamic registration (RFC 7591), so they are deliberately NOT space-scoped —
// a client holds no authority until a human approves a grant for it, and the
// space is decided at that moment and recorded on the grant.
// Installed plugins. The manifest and the approved capability list live here;
// the bundle itself lives in the blob store, keyed by `bundle_key`, with
// `checksum` binding the two — a mismatch means the bytes are not the ones a
// human approved, and the runtime refuses to load them.
export const plugins = sqliteTable(
  'plugins',
  {
    spaceId: text('space_id').notNull(),
    id: text('id').notNull(),
    manifest: text('manifest', { mode: 'json' }).$type<PluginManifest>().notNull(),
    checksum: text('checksum').notNull(),
    bundleKey: text('bundle_key').notNull(),
    approvedCapabilities: text('approved_capabilities', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    installedBy: text('installed_by'),
    installedAt: integer('installed_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.id] })],
);

// A plugin's `kv:storage`: one row per key, per plugin, per environment. Every statement filters
// on the scope and the plugin id, which is the whole of the isolation between plugins; the
// application caps value size and key count.
export const pluginKv = sqliteTable(
  'plugin_kv',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.pluginId, t.key] })],
);

// An installed plugin's settings, per space. `secrets` maps each secret field to its value sealed
// under DATA_KEY (the `plugin_settings.secrets` column of the reseal sweep); `version` is the
// compare-and-set token for concurrent edits.
export const pluginSettings = sqliteTable(
  'plugin_settings',
  {
    spaceId: text('space_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    config: text('config', { mode: 'json' })
      .$type<Record<string, PluginSettingValue>>()
      .notNull()
      .default(sql`'{}'`),
    secrets: text('secrets', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    version: integer('version').notNull().default(1),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.pluginId] })],
);

export const oauthClients = sqliteTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    clientName: text('client_name').notNull(),
    redirectUris: text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull(),
    grantTypes: text('grant_types', { mode: 'json' }).$type<string[]>().notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull(),
    // Only set for confidential clients; the raw secret is never stored.
    hashedClientSecret: text('hashed_client_secret'),
    clientUri: text('client_uri'),
    logoUri: text('logo_uri'),
    softwareId: text('software_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
  },
  (t) => [index('oauth_clients_by_created').on(t.createdAt)],
);

// Authorization codes, device authorizations and refresh tokens share one table:
// same lifecycle (created → approved/denied → consumed/revoked), differing only
// in which digest finds them. `parent_id` links a refresh token to the code that
// produced it so replaying a consumed code can revoke the whole family.
export const oauthGrants = sqliteTable(
  'oauth_grants',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<'code' | 'device' | 'refresh'>().notNull(),
    clientId: text('client_id').notNull(),
    hashedCode: text('hashed_code').notNull(),
    hashedUserCode: text('hashed_user_code'),
    status: text('status')
      .$type<'pending' | 'approved' | 'denied' | 'consumed' | 'revoked'>()
      .notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    spaceId: text('space_id'),
    subject: text('subject'),
    roleId: text('role_id'),
    redirectUri: text('redirect_uri'),
    codeChallenge: text('code_challenge'),
    codeChallengeMethod: text('code_challenge_method'),
    resource: text('resource'),
    parentId: text('parent_id'),
    issuedKeyIds: text('issued_key_ids', { mode: 'json' }).$type<string[]>(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
  },
  (t) => [
    // Scoped by kind so a code can never be presented as a refresh token.
    uniqueIndex('oauth_grants_kind_hashed_code').on(t.kind, t.hashedCode),
    uniqueIndex('oauth_grants_hashed_user_code').on(t.hashedUserCode),
    index('oauth_grants_by_parent').on(t.parentId),
    index('oauth_grants_by_expiry').on(t.expiresAt),
    // Disconnecting an app looks grants up by who granted them to whom.
    index('oauth_grants_by_client_subject').on(t.clientId, t.subject),
  ],
);

export const bulkJobs = sqliteTable(
  'bulk_jobs',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    id: text('id').notNull(),
    action: text('action').$type<BulkJobAction>().notNull(),
    // Action-specific configuration; null for publish/unpublish, which need none.
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
    status: text('status').$type<'running' | 'completed' | 'cancelled'>().notNull(),
    totalItems: integer('total_items').notNull(),
    totalChunks: integer('total_chunks').notNull(),
    completedChunks: integer('completed_chunks').notNull().default(0),
    succeeded: integer('succeeded').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.environmentId, t.id] })],
);

export const bulkJobChunks = sqliteTable(
  'bulk_job_chunks',
  {
    spaceId: text('space_id').notNull(),
    environmentId: text('environment_id').notNull(),
    jobId: text('job_id').notNull(),
    chunkId: text('chunk_id').notNull(),
    entryIds: text('entry_ids', { mode: 'json' }).$type<string[]>().notNull(),
    // Blob key holding this chunk's work when it is not a list of entry ids.
    payloadKey: text('payload_key'),
    status: text('status').$type<'pending' | 'running' | 'completed' | 'failed'>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    failures: text('failures', { mode: 'json' })
      .$type<{ id: string; error: string }[]>()
      .notNull()
      .default([]),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(NOW_MS),
    claimedAt: integer('claimed_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.environmentId, t.jobId, t.chunkId] }),
    // Serves the cross-scope stall sweep: only open chunks are indexed.
    index('bulk_chunks_open')
      .on(t.status, t.createdAt)
      .where(sql`${t.status} IN ('pending', 'running')`),
  ],
);

export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<DomainEvent>().notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    relayedAt: integer('relayed_at', { mode: 'timestamp_ms' }),
    // Lease claim (D1 has no FOR UPDATE SKIP LOCKED): a relayer stamps the rows it takes with
    // its id and a lease expiry in one UPDATE … RETURNING; an expired lease is fair game again.
    claimedBy: text('claimed_by'),
    claimedUntil: integer('claimed_until', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('outbox_pending').on(t.occurredAt).where(sql`${t.relayedAt} IS NULL`),
    // Serves the retention sweep (deleteRelayedBefore); partial so the hot
    // pending rows never pay for it.
    index('outbox_relayed').on(t.relayedAt).where(sql`${t.relayedAt} IS NOT NULL`),
  ],
);

/**
 * Optimistic-concurrency guard for the unit of work (see `uow.ts`). A commit inserts a row
 * selecting the boolean its precondition must satisfy (`SELECT (current_version = ?)`); a false
 * precondition violates the CHECK, which aborts the whole D1 batch — D1's only rollback. The
 * table never holds a row: each guard insert is followed by a delete in the same batch.
 */
export const guard = sqliteTable(
  '_guard',
  {
    ok: integer('ok').notNull(),
  },
  (t) => [check('guard_ok', sql`${t.ok} = 1`)],
);
