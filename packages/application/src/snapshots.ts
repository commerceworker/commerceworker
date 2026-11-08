import {
  type Asset,
  type AssetCollection,
  type AssetFolder,
  AssetRightsError,
  analyzeRedirects,
  applyDefaults,
  assetCollectionDescription,
  assetCollectionName,
  assetFolderName,
  assetFolderPath,
  type Concept,
  type ConceptScheme,
  type ContentType,
  type ContentTypeDraft,
  carriedAuthorshipIssues,
  checkMenuDescription,
  checkMenuHandle,
  checkMenuItems,
  checkMenuName,
  checkRedirect,
  DomainError,
  defineContentType,
  ENTRY_ID_RULE,
  type EntryFields,
  type EntryMetadata,
  extractReferences,
  type FieldIssue,
  isEntryId,
  MAX_ASSET_FOLDER_DEPTH,
  MAX_COLLECTION_ITEMS,
  MAX_MENUS,
  MAX_REDIRECTS,
  type Menu,
  type MenuItem,
  NotFoundError,
  normalizeLegacyFields,
  type PublishedContentTypeDefinition,
  type Redirect,
  redirectKey,
  redirectSetError,
  reviseContentType,
  type Scope,
  type Tag,
  ValidationError,
  validateEntryFields,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowVersion,
} from '@commerceworker/domain';
import { startAssetReindex } from './asset-ingest';
import { allAssets, publishAsset } from './assets';
import { createContentType, publishContentType, SYSTEM_CALLER } from './content-types';
import type { AppContext } from './context';
import { createEntry, updateEntry } from './entries';
import { allPages } from './paging';
import { grantSnapshotImport } from './publish-gate';
import { publishEntry } from './publishing';
import { createConcept, createScheme, createTag, setEntryMetadata } from './taxonomy';
import {
  createWorkflowDraft,
  defineWorkflow,
  listWorkflows,
  publishWorkflowVersion,
  saveWorkflowDraft,
} from './workflows';

/**
 * Environment snapshots: export an environment to portable JSON, and replay it
 * into another one.
 *
 * Scoped to an environment rather than a whole space because that is the unit
 * every other operation takes — a space export is "export each environment" —
 * and because the useful destinations (a new space for a customer, a staging
 * branch, a restore) are all environment-shaped.
 *
 * Import **replays domain operations** rather than injecting rows: entries are
 * created through `createEntry` and published through `publishEntry`. That is
 * slower than a bulk insert and deliberately so — it means validation, the
 * reference graph, the published read model, the outbox and the search index
 * all end up in the state they would have reached organically, instead of a
 * snapshot format silently becoming a second, half-correct way to write data.
 */

/** Bumped when the shape changes incompatibly; import refuses what it can't read. */
export const SNAPSHOT_VERSION = 1;

export interface SnapshotEntry {
  readonly id: string;
  readonly contentTypeApiId: string;
  /** `published` entries are republished on import; everything else lands as a draft. */
  readonly status: string;
  /** The current (draft) fields. */
  readonly fields: EntryFields;
  /**
   * For a `changed` entry (published, with edits since), the live version's fields: the import
   * publishes these, then lays the draft on top, as the source has it. Absent in older snapshots,
   * whose changed entries import as drafts.
   */
  readonly publishedFields?: EntryFields;
  readonly metadata?: EntryMetadata;
  /**
   * Its authorship. A clone keeps all three rather than crediting whoever ran it; an uploaded
   * snapshot keeps the instants (checked) and credits its importer as the creator, since anyone
   * can write any name into a file. Absent in older snapshots (and when unknown): the import's
   * own principal is then its creator, created now.
   */
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly firstPublishedAt?: string;
}

/**
 * A content type in a snapshot. `published` is the definition a live type serves while `status` is
 * `draft`; a snapshot from before these were kept has none, and the type imports as a plain draft.
 */
export type SnapshotContentType = ContentType & {
  readonly published?: PublishedContentTypeDefinition;
};

export interface EnvironmentSnapshot {
  readonly snapshotVersion: number;
  readonly exportedAt: string;
  readonly source: { readonly spaceId: string; readonly environmentId: string };
  readonly contentTypes: readonly SnapshotContentType[];
  readonly entries: readonly SnapshotEntry[];
  /** Metadata only — binaries stay in the blob store and are never copied. */
  readonly assets: readonly Asset[];
  /**
   * The asset library's folders, a parent before its children, with their ids (the assets'
   * `folderId`s name them). Absent in snapshots written before folders: their assets import at the
   * library root.
   */
  readonly assetFolders?: readonly AssetFolder[];
  /**
   * Collections, each with its members' asset ids in order. Absent in snapshots written before
   * collections. An import keeps only the members whose asset the snapshot carries or the target
   * already holds.
   */
  readonly assetCollections?: readonly SnapshotCollection[];
  /** The environment's redirects. Absent in snapshots written before redirects. */
  readonly redirects?: readonly Redirect[];
  /**
   * The environment's menus, with their ids and item ids. Absent in snapshots written before
   * menus. Entry links keep their ids (entries import with theirs); term links are remapped.
   */
  readonly menus?: readonly Menu[];
  readonly taxonomy: {
    readonly schemes: readonly ConceptScheme[];
    readonly concepts: readonly Concept[];
    readonly tags: readonly Tag[];
  };
  readonly workflows: readonly SnapshotWorkflow[];
}

/** A collection in a snapshot: its record and its members, in order. */
export interface SnapshotCollection {
  readonly collection: AssetCollection;
  readonly assetIds: readonly string[];
}

/**
 * A workflow in a snapshot. Format 2 (written since versioned graphs) carries the draft graph and
 * the published versions; `steps` is the derived legacy view, kept so older importers still read
 * it. Format 1 (no `format` field) is the legacy `{id, name, steps}` shape, still accepted.
 */
export type SnapshotWorkflow = SnapshotWorkflowV2 | WorkflowDefinition;

export interface SnapshotWorkflowV2 extends WorkflowDefinition {
  readonly format: 2;
  readonly description: string;
  readonly contentTypes: readonly string[];
  readonly graph: WorkflowGraph;
  readonly gatesPublish: boolean;
  /** Published versions, oldest first. Replayed in order on import (renumbered from 1). */
  readonly versions?: readonly WorkflowVersion[];
}

const isV2 = (w: SnapshotWorkflow): w is SnapshotWorkflowV2 =>
  (w as { format?: unknown }).format === 2;

export interface ExportOptions {
  /** Cap on entries per content type. Omit for everything. */
  readonly limit?: number;
}

/**
 * Reads an environment into a snapshot.
 *
 * Deliberately excluded, and not by oversight: API keys, OAuth clients and
 * grants, preview tokens and webhook signing secrets are credentials, and a
 * snapshot is a file people email themselves. The audit log and the outbox are
 * history rather than state. Asset *binaries* stay in the blob store — the
 * snapshot carries their metadata, so a restore into a space pointing at the
 * same bucket works and one pointing elsewhere has dangling files, which is
 * visible rather than silent.
 */
export async function exportSnapshot(
  ctx: AppContext,
  scope: Scope,
  options: ExportOptions = {},
): Promise<EnvironmentSnapshot> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);

  const [workingTypes, publishedTypes] = await Promise.all([
    ctx.store.contentTypes.list(scope),
    ctx.store.contentTypes.publishedDefinitions(scope),
  ]);
  const contentTypes = workingTypes.map((ct): SnapshotContentType => {
    const published = publishedTypes.get(ct.apiId);
    return published ? { ...ct, published } : ct;
  });
  // Every page, not the store's default first page (100 on D1): a snapshot that silently stopped
  // at 100 entries made exports and clones of any real environment incomplete.
  const rows =
    options.limit !== undefined
      ? await ctx.store.entries.list(scope, { limit: options.limit })
      : await allPages((skip, limit) => ctx.store.entries.list(scope, { skip, limit }));
  const metadata = await ctx.store.taxonomy.getEntryMetadataMany(
    scope,
    rows.map((r) => r.entry.id),
  );
  const byEntry = new Map(metadata.map((m) => [m.entryId, m]));
  // The live version of every entry with unpublished edits, so the copy keeps both.
  const changedIds = rows.filter((r) => r.entry.status === 'changed').map((r) => r.entry.id);
  const live = new Map(
    (await ctx.store.entries.getPublishedMany(scope, changedIds)).map((p) => [p.entryId, p.fields]),
  );

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    exportedAt: ctx.clock.now().toISOString(),
    source: { spaceId: scope.spaceId, environmentId: scope.environmentId },
    contentTypes,
    entries: rows.map((r) => ({
      id: r.entry.id,
      contentTypeApiId: r.entry.contentTypeApiId,
      status: r.entry.status,
      fields: r.fields,
      ...(live.has(r.entry.id) ? { publishedFields: live.get(r.entry.id) } : {}),
      metadata: byEntry.get(r.entry.id)?.metadata,
      ...(r.entry.createdAt ? { createdAt: r.entry.createdAt } : {}),
      ...(r.entry.createdBy ? { createdBy: r.entry.createdBy } : {}),
      ...(r.entry.firstPublishedAt ? { firstPublishedAt: r.entry.firstPublishedAt } : {}),
    })),
    assets: await allAssets(ctx, scope),
    assetFolders: await ctx.store.assetFolders.list(scope),
    assetCollections: await exportCollections(ctx, scope),
    redirects: await ctx.store.redirects.all(scope),
    menus: await ctx.store.menus.all(scope),
    taxonomy: {
      schemes: await ctx.store.taxonomy.listSchemes(scope),
      concepts: await ctx.store.taxonomy.listConcepts(scope),
      tags: await ctx.store.taxonomy.listTags(scope),
    },
    workflows: await exportWorkflows(ctx, scope),
  };
}

/** Every collection in the scope, with its members in order. */
async function exportCollections(ctx: AppContext, scope: Scope): Promise<SnapshotCollection[]> {
  const out: SnapshotCollection[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.store.assetCollections.list(scope, {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const collection of page.items) {
      out.push({
        collection,
        assetIds: await ctx.store.assetCollections.listItemIds(scope, collection.id),
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

async function exportWorkflows(ctx: AppContext, scope: Scope): Promise<SnapshotWorkflowV2[]> {
  const out: SnapshotWorkflowV2[] = [];
  for (const w of await listWorkflows(ctx, scope)) {
    const versions = await ctx.store.workflowGraphs.listVersions(scope, w.id);
    out.push({
      format: 2,
      id: w.id,
      name: w.name,
      steps: w.steps,
      description: w.description,
      contentTypes: w.contentTypes,
      graph: w.graph,
      gatesPublish: w.gatesPublish,
      ...(versions.length > 0 ? { versions: [...versions].reverse() } : {}),
    });
  }
  return out;
}

/**
 * Replays one snapshot workflow through the use-cases. Format 1 goes through `defineWorkflow`
 * (convert + publish v1). Format 2 replays each published version (draft save + publish, so each
 * is re-validated) and then restores the draft; a version today's validator refuses is skipped
 * and named rather than aborting the whole import.
 */
async function importWorkflow(
  ctx: AppContext,
  target: Scope,
  workflow: SnapshotWorkflow,
  skipped: string[],
): Promise<void> {
  if (!isV2(workflow)) {
    await defineWorkflow(ctx, target, { name: workflow.name, steps: workflow.steps });
    return;
  }
  const versions = workflow.versions ?? [];
  const first = versions[0];
  const { workflow: created } = await createWorkflowDraft(ctx, target, {
    name: first?.name ?? workflow.name,
    description: first?.description ?? workflow.description,
    contentTypes: first?.contentTypes ?? workflow.contentTypes,
    gatesPublish: first?.gatesPublish ?? workflow.gatesPublish,
    graph: first?.graph ?? workflow.graph,
  });
  for (const version of versions) {
    await saveWorkflowDraft(ctx, target, created.id, {
      name: version.name,
      description: version.description,
      contentTypes: version.contentTypes,
      gatesPublish: version.gatesPublish ?? false,
      graph: version.graph,
    });
    try {
      await publishWorkflowVersion(ctx, target, created.id, {
        ...(version.publishedBy ? { publishedBy: version.publishedBy } : {}),
      });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      skipped.push(
        `workflow "${workflow.name}" version ${version.version}: no longer passes validation`,
      );
    }
  }
  await saveWorkflowDraft(ctx, target, created.id, {
    name: workflow.name,
    description: workflow.description,
    contentTypes: workflow.contentTypes,
    gatesPublish: workflow.gatesPublish,
    graph: workflow.graph,
  });
}

export interface ImportOptions {
  /** Report what would happen without writing anything. */
  readonly dryRun?: boolean;
  /**
   * Republish entries that were published in the snapshot. On by default:
   * a clone that silently arrives entirely as drafts looks like data loss.
   */
  readonly publish?: boolean;
  /**
   * Send the imported assets through ingest once they are written (an `asset_reindex` job), so
   * the target's search indexes them. Callers set it when the ingest queue is bound.
   */
  readonly reindexAssets?: boolean;
  /**
   * The space whose files the snapshot's assets may keep pointing at: a clone's source, which the
   * caller can read. Unset, only the target's own. Never taken from a request: an uploaded
   * snapshot is anyone's JSON.
   */
  readonly filesFrom?: string;
  /**
   * Keep each entry's `createdBy` from the snapshot. Only a clone sets it (the snapshot is the
   * server's own export of the source); never taken from a request, where it would let anyone
   * credit an entry to someone else. Unset, the importer is every entry's creator.
   */
  readonly keepCreators?: boolean;
}

/**
 * The snapshot with every asset file key that names a space other than `target`'s (or
 * `filesFrom`) dropped, so the asset falls back to its own key in the target. A file key is
 * served as it stands (signed reads, the media gate, ingest), so an uploaded snapshot naming
 * another space's key would otherwise read that space's files, drafts and replaced versions too.
 */
export function confineSnapshotFiles(
  target: Scope,
  snapshot: EnvironmentSnapshot,
  filesFrom?: string,
): EnvironmentSnapshot {
  const allowed = new Set([target.spaceId, ...(filesFrom ? [filesFrom] : [])]);
  const foreign = (key: string | undefined) =>
    key !== undefined && !allowed.has(key.split('/')[0] ?? '');
  if (!snapshot.assets.some((a) => foreign(a.r2Key))) return snapshot;
  return {
    ...snapshot,
    assets: snapshot.assets.map((asset) => {
      if (!foreign(asset.r2Key)) return asset;
      const { r2Key: _foreign, ...rest } = asset;
      return rest;
    }),
  };
}

export interface ImportReport {
  readonly dryRun: boolean;
  readonly contentTypes: number;
  readonly entries: number;
  readonly published: number;
  readonly taxonomy: number;
  readonly workflows: number;
  /** Things that were present in the snapshot and deliberately not imported. */
  readonly skipped: readonly string[];
}

/**
 * Replays a snapshot into `target`.
 *
 * Refuses a target that already holds content types, because the alternative —
 * merging two content models — is a different and much harder operation than
 * "make this environment look like that one", and doing it badly silently
 * corrupts both. Use a fresh environment, or `compareEnvironments`/
 * `mergeEnvironments` for the intra-space case.
 */
export async function importSnapshot(
  ctx: AppContext,
  target: Scope,
  snapshot: EnvironmentSnapshot,
  options: ImportOptions = {},
): Promise<ImportReport> {
  snapshot = normalizeSnapshotModel(confineSnapshotFiles(target, snapshot, options.filesFrom));
  const { report, publishable } = await prepareSnapshotImport(ctx, target, snapshot, options);
  if (options.dryRun) return report;
  const publishing = options.publish !== false;
  const taxonomyIds = await writeSnapshotModel(ctx, target, snapshot, report.skipped as string[]);

  // Asset records keep their ids (and their files, which stay where they are), so the entries'
  // asset links resolve; published ones are published again below, before the entries.
  for (const asset of snapshot.assets) await createSnapshotAsset(ctx, target, asset);
  if (publishing) {
    for (const asset of snapshot.assets) {
      if (asset.status !== 'published') continue;
      try {
        await publishAsset(ctx, target, asset.id);
      } catch (err) {
        // Its rights lapsed since the export (or an embargo older code never enforced): it stays a
        // draft, named, rather than stopping the import half-written where a retry can't follow.
        if (!(err instanceof AssetRightsError)) throw err;
        (report.skipped as string[]).push(`asset ${asset.id}: left as a draft (${err.message})`);
      }
    }
  }

  for (const entry of snapshot.entries) {
    await createSnapshotEntry(
      ctx,
      target,
      stagedEntry(entry, taxonomyIds, publishing, options.keepCreators),
    );
  }
  if (publishing) {
    for (const entry of publishable) {
      await publishSnapshotEntry(ctx, target, stagedPublication(entry));
    }
  }
  if (options.reindexAssets && snapshot.assets.length > 0) await startAssetReindex(ctx, target);
  return report;
}

/** What `prepareSnapshotImport` found: the report, and the entries an import publishes. */
export interface PreparedSnapshotImport {
  readonly report: ImportReport;
  /** Published entries, and changed ones whose live version the snapshot carries. */
  readonly publishable: readonly SnapshotEntry[];
}

/**
 * Everything checked before an import writes anything, and the report it will produce: the
 * snapshot version, the space and target environment (which must exist and hold no content
 * types), and every entry against the snapshot's content model (`preflight`). An import that
 * stopped in the middle would leave a half-filled environment that refuses a retry (not empty).
 *
 * Refuses a target that already holds content types, because the alternative — merging two
 * content models — is a different and much harder operation than "make this environment look
 * like that one", and doing it badly silently corrupts both. Use a fresh environment, or
 * `compareEnvironments`/`mergeEnvironments` for the intra-space case.
 */
export async function prepareSnapshotImport(
  ctx: AppContext,
  target: Scope,
  snapshot: EnvironmentSnapshot,
  options: ImportOptions & { readonly remoteFiles?: ReadonlyMap<string, string> } = {},
): Promise<PreparedSnapshotImport> {
  if (snapshot.snapshotVersion !== SNAPSHOT_VERSION) {
    throw new ValidationError([
      {
        field: 'snapshotVersion',
        message: `Unsupported snapshot version ${snapshot.snapshotVersion}; this server reads version ${SNAPSHOT_VERSION}`,
      },
    ]);
  }
  const config = await ctx.store.spaces.getConfig(target);
  if (!config) throw new NotFoundError('Space', target.spaceId);
  // Only into an environment that exists: otherwise the rows would belong to no environment.
  if (
    !(await ctx.store.spaces.listEnvironments(target.spaceId)).some(
      (e) => e.id === target.environmentId,
    )
  ) {
    throw new NotFoundError('Environment', `${target.spaceId}/${target.environmentId}`);
  }

  const existing = await ctx.store.contentTypes.list(target);
  if (existing.length > 0) {
    throw new ValidationError([
      {
        field: 'target',
        message: `Target environment "${target.environmentId}" already defines ${existing.length} content type(s); import expects an empty environment`,
      },
    ]);
  }

  const problems = preflight(snapshot, config, options.publish !== false);
  if (problems.length > 0) throw new ValidationError(problems);

  const skipped: string[] = [];
  // Assets whose file the import copies from elsewhere (a space export) do bring their bytes.
  const recordsOnly = snapshot.assets.filter((a) => !options.remoteFiles?.has(a.id)).length;
  if (recordsOnly > 0) {
    // Named rather than silently dropped: an operator restoring content should
    // know the binaries did not travel with it.
    skipped.push(`${recordsOnly} asset(s): records copied, binaries stay in the source blob store`);
  }
  const publishable = snapshot.entries.filter(
    (e) => e.status === 'published' || (e.status === 'changed' && e.publishedFields),
  );
  return {
    publishable,
    report: {
      dryRun: options.dryRun === true,
      contentTypes: snapshot.contentTypes.length,
      entries: snapshot.entries.length,
      published: options.publish === false ? 0 : publishable.length,
      taxonomy:
        snapshot.taxonomy.schemes.length +
        snapshot.taxonomy.concepts.length +
        snapshot.taxonomy.tags.length,
      workflows: snapshot.workflows.length,
      skipped,
    },
  };
}

/**
 * The snapshot with its content model made writable: definitions stored before guidance and
 * options were checked keep what is usable (`normalizeLegacyFields`) rather than failing the
 * import. Done once, before the checks, so every entry is validated against the model that will
 * be written: an entry holding a dropped option is refused before anything is written, not by
 * `createEntry` halfway through.
 */
export function normalizeSnapshotModel(snapshot: EnvironmentSnapshot): EnvironmentSnapshot {
  return {
    ...snapshot,
    contentTypes: snapshot.contentTypes.map((ct) => ({
      ...ct,
      fields: normalizeLegacyFields(ct.fields),
      ...(ct.published
        ? { published: { ...ct.published, fields: normalizeLegacyFields(ct.published.fields) } }
        : {}),
    })),
  };
}

/**
 * Writes a snapshot's content model, taxonomy and workflows: the small, ordered part of an import
 * that everything else depends on. Returns the snapshot's taxonomy ids mapped to the new ones,
 * for remapping entry metadata. Workflow versions that no longer validate are named in `skipped`.
 */
export async function writeSnapshotModel(
  ctx: AppContext,
  target: Scope,
  snapshot: EnvironmentSnapshot,
  skipped: string[],
): Promise<ReadonlyMap<string, string>> {
  // Content model first: entries cannot be validated without it. The singleton flag is the
  // snapshot's either way: left out, a revision would keep the target's, and a clone promoted or
  // merged back would then turn production's off (or keep one the source no longer has).
  for (const ct of snapshot.contentTypes) {
    // A live type with a draft: published first, so the draft lands over it as it did at the source
    // and the target serves what the source served. Versions start again here, as for any type.
    // Only into a target without it: a retried write finds it there, its entries perhaps already
    // holding draft-only values, which going back through the published definition would refuse.
    if (
      ct.status !== 'published' &&
      ct.published &&
      !(await ctx.store.contentTypes.get(target, ct.apiId))
    ) {
      await createContentType(ctx, SYSTEM_CALLER, target, publishedDraftOf(ct, ct.published));
      await publishContentType(ctx, target, ct.apiId);
    }
    await createContentType(ctx, SYSTEM_CALLER, target, workingDraftOf(ct));
    if (ct.status === 'published') await publishContentType(ctx, target, ct.apiId);
  }

  // Folders before assets, so the assets' folderIds have something to point at.
  await writeSnapshotFolders(ctx, target, snapshot.assetFolders ?? []);
  // Collections too, with the members whose asset the snapshot brings (created after this) or
  // the target already holds.
  await writeSnapshotCollections(ctx, target, snapshot);

  await writeSnapshotRedirects(ctx, target, snapshot.redirects ?? []);

  // Taxonomy before entries, so entry metadata has something to point at.
  const taxonomyIds = new Map<string, string>();
  for (const scheme of snapshot.taxonomy.schemes) {
    const created = await createScheme(ctx, target, { name: scheme.name });
    taxonomyIds.set(scheme.id, created.id);
  }
  // Slugs, descriptions and localized labels come along. A snapshot made before terms had them
  // (or a slug the target already uses) gets one made like a new term's; labels in a locale the
  // target space doesn't have are left behind rather than failing the import.
  const locales = new Set((await ctx.store.spaces.getConfig(target))?.locales ?? []);
  const termFields = (term: Partial<Pick<Tag, 'slug' | 'description' | 'labels'>>) => ({
    ...(term.slug ? { slug: term.slug } : {}),
    ...(term.description ? { description: term.description } : {}),
    ...(term.labels
      ? {
          labels: Object.fromEntries(
            Object.entries(term.labels).filter(([locale]) => locales.has(locale)),
          ),
        }
      : {}),
  });
  for (const concept of snapshot.taxonomy.concepts) {
    const created = await createConcept(
      ctx,
      target,
      {
        schemeId: taxonomyIds.get(concept.schemeId) ?? concept.schemeId,
        prefLabel: concept.prefLabel,
        ...termFields(concept),
      },
      { slugTaken: 'renumber' },
    );
    taxonomyIds.set(concept.id, created.id);
  }
  for (const tag of snapshot.taxonomy.tags) {
    const created = await createTag(
      ctx,
      target,
      { name: tag.name, ...termFields(tag) },
      { slugTaken: 'renumber' },
    );
    taxonomyIds.set(tag.id, created.id);
  }

  // After taxonomy, so term links point at the target's terms. Entry links keep their ids: the
  // entries come after, with theirs, and a menu resolves its links only when it is read.
  await writeSnapshotMenus(ctx, target, snapshot.menus ?? [], taxonomyIds);

  for (const workflow of snapshot.workflows) {
    await importWorkflow(ctx, target, workflow, skipped);
  }
  return taxonomyIds;
}

/**
 * Writes the snapshot's menus with their ids, in one unit and one `menus.changed` (`preflight`
 * has checked each). A menu whose id or handle the target already holds (a retried import, or a
 * menu made there since) keeps the target's.
 */
async function writeSnapshotMenus(
  ctx: AppContext,
  target: Scope,
  menus: readonly Menu[],
  taxonomyIds: ReadonlyMap<string, string>,
): Promise<void> {
  if (menus.length === 0) return;
  const held = await ctx.store.menus.all(target);
  const ids = new Set(held.map((m) => m.id));
  const handles = new Set(held.map((m) => m.handle));
  const at = ctx.clock.now().toISOString();
  const remap = (items: readonly MenuItem[]): MenuItem[] =>
    items.map((item) => ({
      ...item,
      link:
        item.link.type === 'term'
          ? { ...item.link, termId: taxonomyIds.get(item.link.termId) ?? item.link.termId }
          : item.link,
      children: remap(item.children),
    }));
  const adding: Menu[] = [];
  for (const m of menus) {
    // Rebuilt from the checked fields: a snapshot is anyone's JSON.
    const handle = checkMenuHandle(m.handle);
    if (ids.has(m.id) || handles.has(handle)) continue;
    if (held.length + adding.length >= MAX_MENUS) break;
    const description = checkMenuDescription(m.description);
    adding.push({
      // An id is a path segment on every surface: one that isn't id-shaped gets a fresh one.
      id: typeof m.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(m.id) ? m.id : ctx.ids.newId(),
      handle,
      name: checkMenuName(m.name),
      ...(description ? { description } : {}),
      items: remap(checkMenuItems(m.items, () => ctx.ids.newId())),
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
    handles.add(handle);
  }
  if (adding.length === 0) return;
  await ctx.store.withTransaction(async (tx) => {
    for (const menu of adding) await tx.menus.save(target, menu);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'menus.changed',
      scope: target,
      occurredAt: ctx.clock.now().toISOString(),
    });
  });
}

/** An entry as an import writes it: the fields to create it with, and its remapped metadata. */
export interface StagedSnapshotEntry {
  readonly id: string;
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  readonly tags: readonly string[];
  readonly concepts: readonly string[];
  /** The source entry's authorship, when the snapshot carries it. */
  readonly authorship?: Pick<SnapshotEntry, 'createdAt' | 'createdBy' | 'firstPublishedAt'>;
}

/** A publication an import makes: the entry, and the draft to lay on top of a changed one. */
export interface StagedSnapshotPublication {
  readonly id: string;
  readonly draft?: EntryFields;
}

/**
 * A changed entry starts from its live version (when publishing); the draft goes on top later.
 * Its creator comes along only with `keepCreator` (a clone, {@link ImportOptions.keepCreators}).
 */
export function stagedEntry(
  entry: SnapshotEntry,
  taxonomyIds: ReadonlyMap<string, string>,
  publishing: boolean,
  keepCreator = false,
): StagedSnapshotEntry {
  const createdBy = keepCreator ? entry.createdBy : undefined;
  return {
    id: entry.id,
    contentTypeApiId: entry.contentTypeApiId,
    fields: (publishing && entry.publishedFields) || entry.fields,
    tags: entry.metadata?.tags.map((t) => taxonomyIds.get(t) ?? t) ?? [],
    concepts: entry.metadata?.concepts.map((c) => taxonomyIds.get(c) ?? c) ?? [],
    ...(entry.createdAt || createdBy || entry.firstPublishedAt
      ? {
          authorship: {
            ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
            ...(createdBy ? { createdBy } : {}),
            ...(entry.firstPublishedAt ? { firstPublishedAt: entry.firstPublishedAt } : {}),
          },
        }
      : {}),
  };
}

export function stagedPublication(entry: SnapshotEntry): StagedSnapshotPublication {
  return entry.publishedFields ? { id: entry.id, draft: entry.fields } : { id: entry.id };
}

/**
 * Creates the snapshot's asset folders with their ids, so the assets filed in them land in the
 * same place; each path is rebuilt from its parent's (`preflight` has checked names, parents and
 * depth), so a parent is created first. A folder already there (a retried import) is kept.
 */
async function writeSnapshotFolders(
  ctx: AppContext,
  target: Scope,
  folders: readonly AssetFolder[],
): Promise<void> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const depth = (f: AssetFolder) => chainDepth(byId, f) ?? 0;
  const created = new Map<string, AssetFolder>();
  for (const folder of [...folders].sort((a, b) => depth(a) - depth(b))) {
    const existing = await ctx.store.assetFolders.get(target, folder.id);
    if (existing) {
      created.set(folder.id, existing);
      continue;
    }
    const parent = folder.parentId ? (created.get(folder.parentId) ?? null) : null;
    const { parentId: _parentId, ...rest } = folder;
    const copy: AssetFolder = {
      ...rest,
      name: assetFolderName(folder.name),
      ...(parent ? { parentId: parent.id } : {}),
      path: assetFolderPath(parent, folder.id),
    };
    await ctx.store.assetFolders.create(target, copy);
    created.set(folder.id, copy);
  }
}

/**
 * Writes the snapshot's collections with their ids and member order, keeping only the members
 * whose asset the snapshot carries or the target already has. A collection already there (a
 * retried import) is kept as it is.
 */
async function writeSnapshotCollections(
  ctx: AppContext,
  target: Scope,
  snapshot: EnvironmentSnapshot,
): Promise<void> {
  const collections = snapshot.assetCollections ?? [];
  if (collections.length === 0) return;
  const carried = new Set(snapshot.assets.map((a) => a.id));
  const others = [
    ...new Set(collections.flatMap((c) => c.assetIds).filter((id) => !carried.has(id))),
  ];
  const present = new Set(
    others.length > 0 ? (await ctx.store.assets.getMany(target, others)).map((a) => a.id) : [],
  );
  for (const { collection, assetIds } of collections) {
    const description = collection.description
      ? assetCollectionDescription(collection.description)
      : undefined;
    const { description: _d, ...rest } = collection;
    await ctx.store.assetCollections.restore(
      target,
      {
        ...rest,
        name: assetCollectionName(collection.name),
        ...(description ? { description } : {}),
      },
      [...new Set(assetIds)]
        .filter((id) => carried.has(id) || present.has(id))
        .slice(0, MAX_COLLECTION_ITEMS),
    );
  }
}

/**
 * Writes the snapshot's redirects with their ids, in one unit with the set's compare-and-set
 * (`preflight` has checked each, and the set). A source the target already redirects (a retried
 * import, or a redirect made there since) keeps the target's.
 */
async function writeSnapshotRedirects(
  ctx: AppContext,
  target: Scope,
  redirects: readonly Redirect[],
): Promise<void> {
  if (redirects.length === 0) return;
  const [held, state] = await Promise.all([
    ctx.store.redirects.all(target),
    ctx.store.redirects.state(target),
  ]);
  const config = await ctx.store.spaces.getConfig(target);
  const at = ctx.clock.now().toISOString();
  // Rebuilt from the checked fields: a snapshot is anyone's JSON.
  const restored = redirects.map((r): Redirect => {
    const valid = (t: unknown) => typeof t === 'string' && !Number.isNaN(Date.parse(t));
    return {
      id: typeof r.id === 'string' && r.id ? r.id : ctx.ids.newId(),
      ...checkRedirect(r, config?.locales),
      origin: r.origin === 'slug' || r.origin === 'manual' ? r.origin : 'import',
      ...(typeof r.entryId === 'string' ? { entryId: r.entryId } : {}),
      createdAt: valid(r.createdAt) ? new Date(r.createdAt).toISOString() : at,
      updatedAt: valid(r.updatedAt) ? new Date(r.updatedAt).toISOString() : at,
    };
  });
  const taken = new Set(held.map(redirectKey));
  const ids = new Set(held.map((r) => r.id));
  const adding = restored
    .filter((r) => !taken.has(redirectKey(r)) && !ids.has(r.id))
    .slice(0, Math.max(0, MAX_REDIRECTS - held.length));
  if (adding.length === 0) return;
  await ctx.store.withTransaction(async (tx) => {
    await tx.redirects.saveMany(target, adding);
    await tx.redirects.advance(target, state.revision);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'redirects.changed',
      scope: target,
      occurredAt: ctx.clock.now().toISOString(),
      count: adding.length,
    });
  });
}

/**
 * How deep a folder sits by its chain of parents (1 at the root), or null when the chain loops.
 * A parent missing from `folders` ends the chain.
 */
function chainDepth(folders: ReadonlyMap<string, AssetFolder>, folder: AssetFolder): number | null {
  const seen = new Set([folder.id]);
  for (let p = folder.parentId; p; p = folders.get(p)?.parentId) {
    if (seen.has(p)) return null;
    seen.add(p);
  }
  return seen.size;
}

/**
 * Creates an asset record as an import does (as a draft, keeping its id). An archived asset
 * arrives as a draft without its `archivedAt`, and one filed in a folder the target lacks (a
 * snapshot from before folders) at the library root. What ingest found in the source
 * (its status and error, the duplicate it pointed at, its unsaved AI suggestion marks) stays
 * behind: the target's search has never indexed the asset, so it arrives never ingested, for the
 * reindex the import starts. Already there (a job chunk running again) counts as done.
 */
export async function createSnapshotAsset(
  ctx: AppContext,
  target: Scope,
  asset: Asset,
): Promise<void> {
  if (await ctx.store.assets.get(target, asset.id)) return;
  const {
    archivedAt: _archivedAt,
    folderId,
    ingestStatus: _ingestStatus,
    ingestError: _ingestError,
    duplicateOf: _duplicateOf,
    aiSuggestions: _aiSuggestions,
    ...rest
  } = asset;
  const filed =
    folderId && (await ctx.store.assetFolders.get(target, folderId)) ? { folderId } : {};
  await ctx.store.assets.create(target, { ...rest, ...filed, status: 'draft' });
}

/**
 * Creates an entry through the real use-case, so a snapshot cannot introduce content that would
 * fail today's validation. It keeps its id: links between entries carry those ids, so new ones
 * would leave every reference pointing at the source environment. Already there (a job chunk
 * running again) counts as done.
 */
export async function createSnapshotEntry(
  ctx: AppContext,
  target: Scope,
  entry: StagedSnapshotEntry,
): Promise<void> {
  if (!(await ctx.store.entries.get(target, entry.id))) {
    // A copy of the source's entry, judged as the preflight judged it: on what it holds, so a
    // field its rules disable keeps the source's value (see `EntryWriteOptions.copy`).
    await createEntry(
      ctx,
      target,
      {
        contentTypeApiId: entry.contentTypeApiId,
        fields: entry.fields,
        id: entry.id,
        ...(entry.authorship ? { authorship: entry.authorship } : {}),
      },
      { copy: true },
    );
  }
  if (entry.tags.length > 0 || entry.concepts.length > 0) {
    await setEntryMetadata(ctx, target, entry.id, { tags: entry.tags, concepts: entry.concepts });
  }
}

/**
 * Publishes an imported entry through the use-case (rebuilding the read model, the reference
 * edges and the outbox event), then lays a changed entry's pending draft on top. Safe to run
 * again: an entry already published, or already carrying its draft, is not published twice (a
 * second publish would make the draft live).
 */
export async function publishSnapshotEntry(
  ctx: AppContext,
  target: Scope,
  publication: StagedSnapshotPublication,
): Promise<void> {
  const current = await ctx.store.entries.get(target, publication.id);
  if (!current) throw new NotFoundError('Entry', publication.id);
  const status = current.entry.status;
  if (status === 'changed') return; // published, and its draft is already on top
  // Past every publish gate in the target, including any it held before the import: the copy
  // reproduces the source's published state (see `grantSnapshotImport`).
  if (status !== 'published') {
    await publishEntry(ctx, target, publication.id, { grant: grantSnapshotImport() });
  }
  if (publication.draft) {
    await updateEntry(ctx, target, publication.id, publication.draft, { copy: true });
  }
}

/** What a live type's published definition is written as, before its draft goes over it. */
const publishedDraftOf = (
  ct: SnapshotContentType,
  published: PublishedContentTypeDefinition,
): ContentTypeDraft => ({
  apiId: ct.apiId,
  name: published.name,
  displayField: published.displayField,
  fields: [...published.fields],
  ...(published.urlPattern ? { urlPattern: published.urlPattern } : {}),
  singleton: published.singleton === true,
});

/**
 * What a snapshot's type is written as. `urlPattern` is stated either way: left out, a revision
 * would keep the pattern just published under it, and a draft that dropped the slug it names
 * couldn't be saved at all.
 */
const workingDraftOf = (ct: SnapshotContentType): ContentTypeDraft => ({
  apiId: ct.apiId,
  name: ct.name,
  displayField: ct.displayField,
  fields: [...ct.fields],
  urlPattern: ct.urlPattern ?? null,
  singleton: ct.singleton === true,
  ...(ct.group ? { group: ct.group } : {}),
  ...(ct.description ? { description: ct.description } : {}),
  ...(ct.icon ? { icon: ct.icon } : {}),
  ...(ct.agentInstructions ? { agentInstructions: ct.agentInstructions } : {}),
  ...(ct.layout ? { layout: ct.layout } : {}),
  ...(ct.preview ? { preview: ct.preview } : {}),
});

/** Shown at most, so a broken snapshot's error stays readable. */
const MAX_PREFLIGHT_ISSUES = 50;

/**
 * What would stop this snapshot importing into a space with `config`'s locales, found without
 * writing: an entry of a type the snapshot lacks, fields the content model rejects (validated as
 * `createEntry` does, defaults first), and links from what will be published to entries or assets
 * the snapshot doesn't carry (publishing refuses a dangling link). Each issue names the entry.
 */
function preflight(
  snapshot: EnvironmentSnapshot,
  config: { defaultLocale: string; locales: readonly string[] },
  publishing: boolean,
): FieldIssue[] {
  const types = new Map(snapshot.contentTypes.map((t) => [t.apiId, t]));
  const entryIds = new Set(snapshot.entries.map((e) => e.id));
  const assetIds = new Set(snapshot.assets.map((a) => a.id));
  const vctx = { defaultLocale: config.defaultLocale, locales: config.locales };
  const issues: FieldIssue[] = [];

  // The model is written first, one type at a time: one that can't be written would stop the import
  // partway, in an environment no longer empty, so it can't be run again. Stopped here instead, by
  // doing what the write will do: a live type's draft is a revision over its published definition,
  // anything else a definition from nothing (where a stray `published` means nothing).
  const writable = <T>(ct: SnapshotContentType, label: string, write: () => T): T | null => {
    try {
      return write();
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      const said =
        err instanceof ValidationError
          ? err.issues.map((i) => `${i.field}: ${i.message}`).join('; ')
          : err.message;
      issues.push({ field: 'contentTypes', message: `${label} of "${ct.apiId}": ${said}` });
      return null;
    }
  };
  for (const ct of snapshot.contentTypes) {
    const live = ct.status !== 'published' ? ct.published : undefined;
    if (live) {
      const base = writable(ct, 'The published definition', () =>
        defineContentType(publishedDraftOf(ct, live)),
      );
      if (base) writable(ct, 'The definition', () => reviseContentType(base, workingDraftOf(ct)));
    } else {
      writable(ct, 'The definition', () => defineContentType(workingDraftOf(ct)));
    }
  }

  // Folders are created before anything that could fail on them: a bad one stops the import here.
  const folders = new Map((snapshot.assetFolders ?? []).map((f) => [f.id, f]));
  for (const folder of folders.values()) {
    const refuse = (message: string) =>
      issues.push({ field: 'assetFolders', message: `Folder ${folder.id}: ${message}` });
    if (folder.parentId && !folders.has(folder.parentId)) {
      refuse(`its parent "${folder.parentId}" is not in the snapshot`);
      continue;
    }
    try {
      assetFolderName(folder.name);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      refuse(`its name "${folder.name}" is not a folder name`);
      continue;
    }
    // The import rebuilds each path from the parents, so only the chain itself has to hold.
    const depth = chainDepth(folders, folder);
    if (depth === null) refuse('its parents form a cycle');
    else if (depth > MAX_ASSET_FOLDER_DEPTH) {
      refuse(`it nests ${depth} deep; folders nest at most ${MAX_ASSET_FOLDER_DEPTH} deep`);
    }
  }

  // Collections are written with the model: a bad one stops the import here too.
  for (const { collection } of snapshot.assetCollections ?? []) {
    try {
      assetCollectionName(collection.name);
      if (collection.description) assetCollectionDescription(collection.description);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      issues.push({
        field: 'assetCollections',
        message: `Collection ${collection.id}: ${err.issues[0]?.message ?? err.message}`,
      });
    }
  }

  // Redirects are written with the model too: each must hold today, and the set as a whole.
  const redirects = snapshot.redirects ?? [];
  if (redirects.length > MAX_REDIRECTS) {
    issues.push({ field: 'redirects', message: `At most ${MAX_REDIRECTS} redirects` });
  }
  for (const r of redirects) {
    try {
      if (typeof r?.source !== 'string' || typeof r.destination !== 'string') {
        throw new ValidationError([
          { field: 'source', message: 'a source and a destination are required' },
        ]);
      }
      const fields = checkRedirect(r, vctx.locales);
      if (fields.source !== r.source) {
        throw new ValidationError([{ field: 'source', message: `${r.source} is not normalized` }]);
      }
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      issues.push({
        field: 'redirects',
        message: `Redirect ${String(r?.id)}: ${err.issues[0]?.message ?? err.message}`,
      });
    }
  }
  const setError = redirectSetError(analyzeRedirects(redirects));
  for (const issue of setError?.issues ?? []) issues.push({ ...issue, field: 'redirects' });

  // Menus are written with the model too: each must hold today, without checking its links
  // (the entries they name are written after them).
  const menus = snapshot.menus ?? [];
  if (menus.length > MAX_MENUS) {
    issues.push({ field: 'menus', message: `At most ${MAX_MENUS} menus` });
  }
  for (const m of menus) {
    try {
      checkMenuHandle(m?.handle);
      checkMenuName(m.name);
      checkMenuDescription(m.description);
      // Stand-in ids no item can be given, so only the snapshot's own can collide.
      let n = 0;
      checkMenuItems(m.items, () => `\u0000${++n}`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const first = err.issues[0];
      issues.push({
        field: 'menus',
        message: `Menu ${String(m?.handle ?? m?.id)}: ${first ? `${first.field}: ${first.message}` : err.message}`,
      });
    }
  }

  const add = (entryId: string, issue: FieldIssue) =>
    issues.push({ ...issue, message: `Entry ${entryId}: ${issue.message}` });

  for (const [position, entry] of snapshot.entries.entries()) {
    if (issues.length >= MAX_PREFLIGHT_ISSUES) break;
    // By position: the id is what's wrong, and it could be anything.
    if (!isEntryId(entry.id)) {
      issues.push({ field: 'entries', message: `Entry at position ${position}: ${ENTRY_ID_RULE}` });
      continue;
    }
    const type = types.get(entry.contentTypeApiId);
    if (!type) {
      add(entry.id, {
        field: '',
        message: `content type "${entry.contentTypeApiId}" is not in the snapshot`,
      });
      continue;
    }
    for (const issue of carriedAuthorshipIssues(entry)) add(entry.id, issue);
    const versions =
      publishing && entry.publishedFields ? [entry.publishedFields, entry.fields] : [entry.fields];
    for (const fields of versions) {
      const withDefaults = applyDefaults(type, fields, vctx.locales, vctx.defaultLocale);
      for (const issue of validateEntryFields(type, withDefaults, vctx)) add(entry.id, issue);
    }
    const published = entry.status === 'published' ? entry.fields : entry.publishedFields;
    if (publishing && published && (entry.status === 'published' || entry.status === 'changed')) {
      for (const edge of extractReferences(entry.id, published, type)) {
        const known = edge.toType === 'Entry' ? entryIds.has(edge.toId) : assetIds.has(edge.toId);
        if (!known) {
          add(entry.id, {
            field: edge.fromField,
            message: `links ${edge.toType.toLowerCase()} "${edge.toId}", which the snapshot doesn't carry`,
          });
        }
      }
    }
  }
  return issues.slice(0, MAX_PREFLIGHT_ISSUES);
}

/**
 * Copies one environment onto another — export plus import, with no file in
 * between. The cross-space case that `mergeEnvironments` does not cover.
 */
export async function cloneEnvironment(
  ctx: AppContext,
  source: Scope,
  target: Scope,
  options: ImportOptions = {},
): Promise<ImportReport> {
  return importSnapshot(ctx, target, await exportSnapshot(ctx, source), {
    ...options,
    filesFrom: source.spaceId,
    keepCreators: true,
  });
}
