import {
  type AgentReview,
  type AgentSchedule,
  type ApiKey,
  type Asset,
  type AssetCollection,
  type AssetFolder,
  type AssetIngestStatus,
  type AssetRendition,
  type AssetZipJob,
  assetKind,
  type Comment,
  type Concept,
  ConflictError,
  type ContentType,
  type DeliveredContentType,
  type DomainEvent,
  deliveredContentType,
  type Entry,
  type EntryFields,
  type EntryMetadata,
  type EntryVersion,
  type EventType,
  entrySysOf,
  type FieldDefinition,
  type InstalledPlugin,
  isWebhookSendRequest,
  type LocaleSettings,
  type MemberInvite,
  type Menu,
  matchesTopic,
  type OAuthClient,
  type OutboxEntry,
  type PluginSettings,
  type Promotion,
  type PublishedContentTypeDefinition,
  projectFields,
  type QueryFilter,
  QueryTooBroadError,
  type Redirect,
  type ReferenceEdge,
  type Release,
  type Role,
  runEntryQuery,
  type SavedView,
  type ScheduledAction,
  type Scope,
  type SpaceMember,
  type StoredAssetShareLink,
  type Tag,
  type Task,
  type TermKind,
  type TermUsage,
  type UniqueClaim,
  ValidationError,
  versionGatesPublish,
  type Webhook,
  type WorkflowDefinition,
  type WorkflowGraphDefinition,
  type WorkflowNodeRunRecord,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowTask,
  type WorkflowTaskStatus,
  type WorkflowTimelineRecord,
  type WorkflowVersion,
} from '@commerceworker/domain';
import type {
  AgentReviewRepo,
  AgentRunRecord,
  AgentRunRepo,
  AgentScheduleRepo,
  AIActionDefinition,
  AIActionRepo,
  AppExtension,
  AppExtensionRepo,
  ArchivableVersion,
  AssetCollectionRepo,
  AssetFilters,
  AssetFolderRepo,
  AssetRenditionRepo,
  AssetRepo,
  AssetShareLinkRepo,
  AssetSortField,
  AssetUpload,
  AssetUploadRepo,
  AssetVersionRecord,
  AssetZipJobRepo,
  AuditRepo,
  AuthRepo,
  BlobStore,
  BulkJob,
  BulkJobChunk,
  BulkJobRepo,
  CommentRepo,
  ContentStore,
  ContentStoreTx,
  ContentTypeRepo,
  DeliveryReadRepo,
  DeliveryReadRequest,
  DeliveryReadResult,
  DeploymentSettingsRepo,
  EntryQuery,
  EntryRepo,
  EntryWithFields,
  FunctionDefinition,
  FunctionRepo,
  InviteRepo,
  MemberRepo,
  MenuRead,
  MenuRepo,
  OAuthClientRepo,
  OAuthGrantRecord,
  OAuthGrantRepo,
  OutboxRepo,
  PluginRepo,
  PluginSettingsRepo,
  PluginStorageRepo,
  PreviewTokenRepo,
  PromotionRepo,
  PublishedAsset,
  PublishedAssetPage,
  PublishedAssetQuery,
  PublishedEntry,
  RedirectRepo,
  ReferenceRepo,
  ReleaseRepo,
  RoleRepo,
  SavedViewRepo,
  ScheduledActionRepo,
  SchedulerJobRepo,
  ScopedAgentSchedule,
  ScopedScheduledAction,
  SitemapEntryRow,
  SitemapQuery,
  SpaceConfig,
  SpaceRepo,
  StoredSecretRepo,
  TaskRepo,
  TaxonomyRepo,
  WebhookDeliveryRecord,
  WebhookRepo,
  WorkflowGraphRecord,
  WorkflowGraphRepo,
  WorkflowRepo,
  WorkflowRunRepo,
  WorkflowTaskRepo,
} from '@commerceworker/ports';
import { DEFAULT_ASSET_SORT, TransactionConflictError } from '@commerceworker/ports';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
  sum,
} from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { alias, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  chunked,
  createDb,
  type D1Like,
  type Db,
  directExec,
  type Exec,
  isUniqueViolation,
  mapD1Error,
  messageOf,
  selectChunked,
  UnitOfWork,
} from './exec';
import { buildFilterPrefilter, buildSearchPrefilter } from './query-pushdown';
import * as schema from './schema';

type Query = BatchItem<'sqlite'>;

/** The row's environment is registered (not deleted, nor being purged). */
const registered = (t: { spaceId: unknown; environmentId: unknown }) =>
  sql`EXISTS (SELECT 1 FROM ${schema.environments} WHERE ${schema.environments.spaceId} = ${t.spaceId} AND ${schema.environments.id} = ${t.environmentId})`;

const scopeFilter = (t: { spaceId: unknown; environmentId: unknown }, scope: Scope) =>
  and(eq(t.spaceId as never, scope.spaceId), eq(t.environmentId as never, scope.environmentId));

/**
 * Runs several write statements as one atomic step: inside a unit of work they join its batch;
 * outside one they go out as a single `db.batch()` (one round trip, all-or-nothing), never
 * separate auto-committed statements.
 */
async function writeAll(x: Exec, queries: readonly Query[]): Promise<void> {
  if (queries.length === 0) return;
  if (x.inUnit || queries.length === 1) {
    for (const q of queries) await x.write(q);
    return;
  }
  try {
    await x.db.batch(queries as unknown as [Query, ...Query[]]);
  } catch (err) {
    throw mapD1Error(err);
  }
}

/**
 * Guard statements that abort the batch (TransactionConflictError) unless the asset folder exists
 * in the scope when it runs: put them in front of a write that files something in it.
 */
function folderExists(x: Exec, scope: Scope, folderId: string): Query[] {
  const f = schema.assetFolders;
  return [
    x.db
      .insert(schema.guard)
      .select(
        sql`SELECT EXISTS (SELECT 1 FROM ${f} WHERE ${f.spaceId} = ${scope.spaceId} AND ${f.environmentId} = ${scope.environmentId} AND ${f.id} = ${folderId}) AS ok`,
      ),
    x.db.delete(schema.guard),
  ];
}

/**
 * A write whose result drives control flow (a `.returning()` compare-and-set) has no answer
 * until a unit of work commits. The methods the application calls inside `withTransaction`
 * have an in-unit branch; every other one refuses loudly instead of misreporting.
 */
function directOnly(x: Exec, method: string): void {
  if (x.inUnit) {
    throw new Error(
      `${method} reads its own write's result, so it cannot run inside withTransaction on D1; ` +
        'call it on the store directly',
    );
  }
}

/**
 * Multi-row INSERT split so no statement binds more than D1's 100 parameters. Drizzle emits
 * every column for every row, so the table's column count is the per-row cost.
 */
function insertChunks<T>(
  table: SQLiteTable,
  rows: readonly T[],
  build: (chunk: T[]) => Query,
): Query[] {
  const perRow = Object.keys(getTableColumns(table)).length;
  return chunked(rows, perRow, 0)
    .filter((c) => c.length > 0)
    .map(build);
}

/** Params a statement keeps for its own conditions on top of a chunked id list. */
const RESERVED = 6;

// Field-level filtering/ordering/search/projection runs in JS over the loaded
// rows (shared with the in-memory store for identical semantics), so `limit`/
// `offset` cannot be pushed into SQL for those queries. They are not unbounded
// though: superset prefilters (query-pushdown.ts) narrow the candidate rows in
// SQL and the scan is capped, so only plausible matches are materialized. The
// common `contentType + since + limit/skip` path is answered entirely in SQL.
/** Default ceiling on candidate rows loaded for exact query evaluation. */
export const DEFAULT_QUERY_SCAN_LIMIT = 5000;

/**
 * The direction of a query ordered by manual position alone, which SQL answers from the
 * `*_by_position` indexes (0034_entry_position) like a plain list; undefined for any other order,
 * or when an id cursor already fixes the order. Ties can't happen between keys a move writes
 * (each lies strictly between two others), so the id after it runs the same way, and the index is
 * read in one direction.
 */
const positionOrder = (q: EntryQuery): 'asc' | 'desc' | undefined => {
  const [o, ...rest] = q.order ?? [];
  if (!o || rest.length > 0 || o.field !== 'sys.position') return undefined;
  if (q.afterEntryId !== undefined || q.after !== undefined) return undefined;
  return o.direction;
};

const isAdvancedQuery = (q: EntryQuery) =>
  Boolean(
    q.filters?.length || q.where || (q.order?.length && !positionOrder(q)) || q.search || q.select,
  );

function makeContentTypeRepo(x: Exec): ContentTypeRepo {
  const db = x.db;
  return {
    async get(scope, apiId) {
      const [row] = await db
        .select(workingColumns)
        .from(schema.contentTypes)
        .where(and(scopeFilter(schema.contentTypes, scope), eq(schema.contentTypes.apiId, apiId)));
      return row ? toContentType(row) : null;
    },
    async list(scope) {
      return (await contentTypesQuery(db, scope)).map(toContentType);
    },
    async publishedDefinitions(scope) {
      const t = schema.contentTypes;
      const rows = await db
        .select({
          apiId: t.apiId,
          definition: keptDefinition,
          publishedSingleton: t.publishedSingleton,
        })
        .from(t)
        .where(and(scopeFilter(t, scope), ne(t.status, 'published'), isNotNull(keptDefinition)))
        // A replica behind 0030 has nothing kept to report.
        .catch((err: unknown) => {
          if (isBehind0030(err)) return [];
          throw err;
        });
      return new Map(
        rows.flatMap(({ apiId, definition, publishedSingleton }) =>
          definition ? [[apiId, toPublishedDefinition(definition, publishedSingleton)]] : [],
        ),
      );
    },
    async save(scope, ct) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        apiId: ct.apiId,
        name: ct.name,
        displayField: ct.displayField,
        fields: [...ct.fields],
        version: ct.version,
        status: ct.status,
        updatedAt: new Date(),
        urlPattern: ct.urlPattern ?? null,
        singleton: ct.singleton === true,
        // Delivery serves by the flag as last published: a draft save leaves it as it was.
        publishedSingleton: ct.status === 'published' && ct.singleton === true,
        group: ct.group ?? null,
        description: ct.description ?? null,
        icon: ct.icon ?? null,
        agentInstructions: ct.agentInstructions ?? null,
        layout: ct.layout ?? null,
        previewUrlTemplate: ct.preview?.urlTemplate ?? null,
      };
      await x.write(
        db
          .insert(schema.contentTypes)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.contentTypes.spaceId,
              schema.contentTypes.environmentId,
              schema.contentTypes.apiId,
            ],
            set: {
              name: values.name,
              displayField: values.displayField,
              fields: values.fields,
              version: values.version,
              status: values.status,
              updatedAt: values.updatedAt,
              urlPattern: values.urlPattern,
              singleton: values.singleton,
              publishedSingleton:
                ct.status === 'published'
                  ? values.publishedSingleton
                  : sql`${schema.contentTypes.publishedSingleton}`,
              group: values.group,
              description: values.description,
              icon: values.icon,
              agentInstructions: values.agentInstructions,
              layout: values.layout,
              previewUrlTemplate: values.previewUrlTemplate,
            },
          }),
      );
    },
    async create(scope, ct) {
      const insert = db
        .insert(schema.contentTypes)
        .values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          apiId: ct.apiId,
          name: ct.name,
          displayField: ct.displayField,
          fields: [...ct.fields],
          version: ct.version,
          status: ct.status,
          updatedAt: new Date(),
          urlPattern: ct.urlPattern ?? null,
          singleton: ct.singleton === true,
          publishedSingleton: ct.status === 'published' && ct.singleton === true,
          group: ct.group ?? null,
          description: ct.description ?? null,
          icon: ct.icon ?? null,
          agentInstructions: ct.agentInstructions ?? null,
          layout: ct.layout ?? null,
          previewUrlTemplate: ct.preview?.urlTemplate ?? null,
        })
        .onConflictDoNothing();
      if (x.inUnit) {
        await x.write(insert);
        x.expectChanged(1);
        return;
      }
      if ((await insert.returning({ apiId: schema.contentTypes.apiId })).length === 0) {
        throw new TransactionConflictError();
      }
    },
    async guard(scope, apiId, expected) {
      const t = schema.contentTypes;
      const e = schema.entries;
      // A no-op update whose WHERE is the guard: it matches the row only while the type is as the
      // caller read it, so the unit's expectChanged(1) fails the commit otherwise. The entries a
      // caller allows travel as one JSON parameter, whatever their number.
      const others = expected.entries
        ? sql`NOT EXISTS (SELECT 1 FROM ${e} WHERE ${e.spaceId} = ${scope.spaceId} AND ${e.environmentId} = ${scope.environmentId} AND ${e.contentTypeApiId} = ${apiId} AND ${e.status} != 'archived' AND ${e.id} NOT IN (SELECT value FROM json_each(${JSON.stringify(expected.entries)})))`
        : undefined;
      const touch = db
        .update(t)
        .set({ apiId: sql`${t.apiId}` })
        .where(
          and(
            scopeFilter(t, scope),
            eq(t.apiId, apiId),
            eq(t.singleton, expected.singleton),
            others,
          ),
        );
      if (x.inUnit) {
        await x.write(touch);
        x.expectChanged(1);
        return;
      }
      if ((await touch.returning({ apiId: t.apiId })).length === 0) {
        throw new TransactionConflictError();
      }
    },
    async delete(scope, apiId, version) {
      const t = schema.contentTypes;
      const e = schema.entries;
      // The entries check is the delete's own WHERE, so an entry written after the caller looked
      // (a create that read the type before this committed) leaves the type in place.
      const remove = db
        .delete(t)
        .where(
          and(
            scopeFilter(t, scope),
            eq(t.apiId, apiId),
            eq(t.version, version),
            sql`NOT EXISTS (SELECT 1 FROM ${e} WHERE ${e.spaceId} = ${scope.spaceId} AND ${e.environmentId} = ${scope.environmentId} AND ${e.contentTypeApiId} = ${apiId})`,
          ),
        );
      if (x.inUnit) {
        await x.write(remove);
        x.expectChanged(1);
        return;
      }
      if ((await remove.returning({ apiId: t.apiId })).length === 0) {
        throw new TransactionConflictError();
      }
    },
  };
}

/** How long after a version is superseded before its body may move to object storage. */
const ARCHIVE_DELAY_MS = 24 * 60 * 60 * 1000;
/** Archived bodies read at once when listing an entry's history. */
const VERSION_READ_CONCURRENCY = 6;

function makeEntryRepo(
  x: Exec,
  scanLimit = DEFAULT_QUERY_SCAN_LIMIT,
  versionBodies?: BlobStore,
): EntryRepo {
  const db = x.db;
  /** An archived body from object storage, or null when it is not there. */
  const readBody = async (bodyKey: string, what: string): Promise<EntryFields | null> => {
    if (!versionBodies) {
      throw new Error(`${what} is archived, and this store has no object storage to read it from`);
    }
    const raw = await versionBodies.get(bodyKey);
    return raw === null ? null : (JSON.parse(raw) as EntryFields);
  };
  /** A version row as a version: its body from object storage if it has moved there. A body
   *  missing there is marked `bodyUnavailable` (a list shows the rest), unless `strict`. */
  const resolveVersion = async (r: EntryVersionRow, strict: boolean): Promise<EntryVersion> => {
    if (!r.bodyKey) return toVersion(r);
    const fields = await readBody(r.bodyKey, `Version ${r.version} of entry ${r.entryId}`);
    if (fields) return { ...toVersion(r), fields };
    if (strict) throw new Error(`The archived body of version ${r.version} is missing`);
    return { ...toVersion(r), fields: {}, bodyUnavailable: true };
  };
  // The row's CURRENT version, joined in the same query (one join is cheaper on D1 than a
  // second, pair-chunked query and has no parameter-cap concern).
  const cv = alias(schema.entryVersions, 'cv');
  const currentVersionJoin = and(
    eq(cv.spaceId, schema.entries.spaceId),
    eq(cv.environmentId, schema.entries.environmentId),
    eq(cv.entryId, schema.entries.id),
    eq(cv.version, schema.entries.currentVersion),
  );
  const withFields = () =>
    db
      .select({ entry: schema.entries, fields: cv.fields, bodyKey: cv.bodyKey })
      .from(schema.entries)
      .leftJoin(cv, currentVersionJoin);
  type CurrentRow = { entry: EntryRow; fields: EntryFields | null; bodyKey: string | null };
  /**
   * The rows as entries with their current fields. A current version never has its body moved
   * (the sweep re-checks that as it marks), but should a lost update ever move an entry's current
   * version back onto an archived one, its body is read from object storage rather than shown
   * as `{}`: an entry never silently loses its content.
   */
  const toEntriesWithFields = (rows: readonly CurrentRow[]): Promise<EntryWithFields[]> =>
    Promise.all(
      rows.map(async (r) => ({
        entry: toEntry(r.entry),
        fields:
          (r.bodyKey
            ? await readBody(r.bodyKey, `The current version of entry ${r.entry.id}`)
            : r.fields) ?? {},
      })),
    );

  const putPublishedMany = async (
    scope: Scope,
    snapshots: readonly PublishedEntry[],
  ): Promise<void> => {
    if (snapshots.length === 0) return;
    const ids = idList(snapshots.map((s) => s.entryId));
    // The usage counts move in the same batch: the old snapshots' terms come off before the
    // upsert replaces them, the new ones' go on after it.
    // Each row's first publish is read from `entries` in the same batch, after the aggregate save
    // that set it with COALESCE: the copy can't diverge from it, whatever the snapshot carried.
    // That subquery binds three values where the column bound one, hence the wider rows.
    const perRow = Object.keys(getTableColumns(schema.entryPublished)).length + 2;
    await writeAll(x, [
      takeUsage(db, scope, ids),
      ...chunked(snapshots, perRow, 0).map((chunk) =>
        db
          .insert(schema.entryPublished)
          .values(
            chunk.map((s) => ({
              ...publishedRow(scope, s),
              firstPublishedAt: sql`(SELECT ${schema.entries.firstPublishedAt} FROM ${schema.entries} WHERE ${schema.entries.spaceId} = ${scope.spaceId} AND ${schema.entries.environmentId} = ${scope.environmentId} AND ${schema.entries.id} = ${s.entryId})`,
            })),
          )
          .onConflictDoUpdate({
            target: [
              schema.entryPublished.spaceId,
              schema.entryPublished.environmentId,
              schema.entryPublished.entryId,
            ],
            set: {
              contentTypeApiId: sql`excluded.content_type_api_id`,
              version: sql`excluded.version`,
              fields: sql`excluded.fields`,
              metadata: sql`excluded.metadata`,
              publishedAt: sql`excluded.published_at`,
              firstPublishedAt: sql`excluded.first_published_at`,
            },
          }),
      ),
      addUsage(db, scope, ids),
    ]);
  };
  const removePublishedMany = async (scope: Scope, entryIds: readonly string[]): Promise<void> => {
    if (entryIds.length === 0) return;
    await writeAll(x, [
      takeUsage(db, scope, idList(entryIds)),
      ...chunked(entryIds, 1, RESERVED).map((chunk) =>
        db
          .delete(schema.entryPublished)
          .where(
            and(
              scopeFilter(schema.entryPublished, scope),
              inArray(schema.entryPublished.entryId, chunk),
            ),
          ),
      ),
    ]);
  };
  const uniqueRows = (scope: Scope, entryId: string, claims: readonly UniqueClaim[]) =>
    claims.map((c) => ({
      spaceId: scope.spaceId,
      environmentId: scope.environmentId,
      contentTypeApiId: c.contentTypeApiId,
      fieldApiId: c.fieldApiId,
      locale: c.locale,
      value: c.value,
      entryId,
    }));
  const deleteClaims = (scope: Scope, entryId: string) =>
    db
      .delete(schema.entryUniqueValues)
      .where(
        and(
          scopeFilter(schema.entryUniqueValues, scope),
          eq(schema.entryUniqueValues.entryId, entryId),
        ),
      );
  return {
    async get(scope, id) {
      const [row] = await withFields().where(
        and(scopeFilter(schema.entries, scope), eq(schema.entries.id, id)),
      );
      return row ? ((await toEntriesWithFields([row]))[0] ?? null) : null;
    },
    async positionNeighbors(scope, contentTypeApiId, key, side, limit, excludeId) {
      const e = schema.entries;
      const position = sql<string>`coalesce(${e.position}, ${e.id})`;
      const conditions = [scopeFilter(e, scope), eq(e.contentTypeApiId, contentTypeApiId)];
      if (key !== null) {
        conditions.push(side === 'after' ? sql`${position} > ${key}` : sql`${position} < ${key}`);
      }
      if (excludeId !== undefined) conditions.push(ne(e.id, excludeId));
      return db
        .select({ id: e.id, position })
        .from(e)
        .where(and(...conditions))
        .orderBy(...(side === 'after' ? [asc(position), asc(e.id)] : [desc(position), desc(e.id)]))
        .limit(limit);
    },
    async setPositions(scope, contentTypeApiId, writes, guard) {
      const e = schema.entries;
      const position = sql`coalesce(${e.position}, ${e.id})`;
      const ok = (predicate: SQL) =>
        x.db.insert(schema.guard).select(sql`SELECT ${predicate} AS ok`);
      const queries: Query[] = [];
      // The anchor and the gap are checked before any key moves, against what the caller read.
      if (guard.anchor) {
        queries.push(
          ok(
            sql`EXISTS (SELECT 1 FROM ${e} WHERE ${scopeFilter(e, scope)} AND ${e.id} = ${guard.anchor.id} AND ${position} = ${guard.anchor.position})`,
          ),
        );
      }
      const lo = guard.lo === null ? sql`1` : sql`${position} > ${guard.lo}`;
      const hi = guard.hi === null ? sql`1` : sql`${position} < ${guard.hi}`;
      const moved = JSON.stringify(writes.map((w) => w.id));
      queries.push(
        ok(
          sql`NOT EXISTS (SELECT 1 FROM ${e} WHERE ${scopeFilter(e, scope)} AND ${e.contentTypeApiId} = ${contentTypeApiId} AND ${lo} AND ${hi} AND ${e.id} NOT IN (SELECT value FROM json_each(${moved})))`,
        ),
      );
      for (const w of writes) {
        queries.push(
          x.db
            .update(e)
            .set({ position: w.position })
            .where(and(scopeFilter(e, scope), eq(e.id, w.id), sql`${position} = ${w.expected}`)),
          ok(sql`changes() = 1`),
        );
      }
      queries.push(x.db.delete(schema.guard));
      await writeAll(x, queries);
    },
    async getMany(scope, ids) {
      const rows = await selectChunked(
        ids,
        (chunk) =>
          withFields().where(
            and(scopeFilter(schema.entries, scope), inArray(schema.entries.id, chunk)),
          ),
        1,
        RESERVED,
      );
      return toEntriesWithFields(rows);
    },
    async contentTypesOf(scope, ids) {
      const e = schema.entries;
      const rows = await selectChunked(
        [...new Set(ids)],
        (chunk) =>
          db
            .select({ id: e.id, contentTypeApiId: e.contentTypeApiId })
            .from(e)
            .where(and(scopeFilter(e, scope), inArray(e.id, chunk))),
        1,
        RESERVED,
      );
      return new Map(rows.map((r) => [r.id, r.contentTypeApiId]));
    },
    async idsMentioning(scope, text, limit) {
      const e = schema.entries;
      const v = schema.entryVersions;
      const rows = await db
        .select({ id: e.id })
        .from(e)
        .innerJoin(
          v,
          and(
            eq(v.spaceId, e.spaceId),
            eq(v.environmentId, e.environmentId),
            eq(v.entryId, e.id),
            eq(v.version, e.currentVersion),
          ),
        )
        .where(and(scopeFilter(e, scope), sql`instr(${v.fields}, ${text}) > 0`))
        .limit(limit);
      return rows.map((r) => r.id);
    },
    async list(scope, query: EntryQuery) {
      const advanced = isAdvancedQuery(query);
      const conditions = [scopeFilter(schema.entries, scope)];
      if (query.contentTypeApiId) {
        conditions.push(eq(schema.entries.contentTypeApiId, query.contentTypeApiId));
      }
      // Trash is hidden unless asked for. Pushed down rather than filtered in
      // JS so a space with a large trash cannot crowd out the scan window.
      conditions.push(
        query.archived
          ? eq(schema.entries.status, 'archived')
          : ne(schema.entries.status, 'archived'),
      );
      // Keyset paging by entry id, as on the published path: stable while
      // entries are edited mid-scan, which an updatedAt offset is not.
      const keyset = query.afterEntryId !== undefined;
      if (keyset && query.afterEntryId !== '') {
        conditions.push(gt(schema.entries.id, query.afterEntryId as string));
      }
      // Keyset paging in the list's own order. Without an `order` that is (updatedAt, id),
      // which SQL walks itself; an `order` is sorted in JS over the scan, which applies the
      // cursor there.
      const byPosition = positionOrder(query);
      const position = sql`coalesce(${schema.entries.position}, ${schema.entries.id})`;
      if (byPosition && query.afterRow && query.afterRow !== 'start') {
        const at = String(query.afterRow.values[0] ?? '');
        conditions.push(
          byPosition === 'asc'
            ? sql`(${position}, ${schema.entries.id}) > (${at}, ${query.afterRow.id})`
            : sql`(${position}, ${schema.entries.id}) < (${at}, ${query.afterRow.id})`,
        );
      }
      const rowKeyset = query.afterRow !== undefined && !query.order?.length;
      if (rowKeyset && query.afterRow !== 'start' && query.afterRow) {
        const at = Date.parse(String(query.afterRow.values[0] ?? ''));
        conditions.push(
          sql`(${schema.entries.updatedAt}, ${schema.entries.id}) > (${Number.isNaN(at) ? 0 : at}, ${query.afterRow.id})`,
        );
      }
      if (advanced) {
        // Draft field values live in entry_versions, so the superset prefilter
        // runs against the joined CURRENT version. Same contract as the
        // published path: narrows candidates, never changes the answer.
        const vFields = sql`${cv.fields}`;
        const p = buildFilterPrefilter(query, vFields, {
          entryId: sql`${schema.entries.id}`,
          contentTypeApiId: sql`${schema.entries.contentTypeApiId}`,
          createdBy: sql`${schema.entries.createdBy}`,
          updatedBy: sql`${schema.entries.modifiedBy}`,
        });
        if (p) conditions.push(p);
        if (query.search) {
          const p = buildSearchPrefilter(query.search, vFields);
          if (p) conditions.push(p);
        }
      }
      let select = withFields()
        .where(and(...conditions))
        .orderBy(
          ...(byPosition
            ? byPosition === 'asc'
              ? [asc(position), asc(schema.entries.id)]
              : [desc(position), desc(schema.entries.id)]
            : keyset
              ? [asc(schema.entries.id)]
              : rowKeyset
                ? [asc(schema.entries.updatedAt), asc(schema.entries.id)]
                : [asc(schema.entries.updatedAt)]),
        )
        .$dynamic();
      // SQL pagination is only valid when there are no JS-side field predicates;
      // otherwise bound the candidate scan (+1 to detect overflow).
      select = advanced
        ? select.limit(scanLimit + 1)
        : select.limit(query.limit ?? 100).offset(query.skip ?? 0);
      const rows = await select;
      if (advanced && rows.length > scanLimit) throw new QueryTooBroadError(scanLimit);
      const results = (await toEntriesWithFields(rows)).map((r, i) => ({
        ...r,
        updatedAt: (rows[i] as CurrentRow).entry.updatedAt.toISOString(),
      }));
      if (!advanced) return results;
      const filtered = runEntryQuery(
        results,
        query,
        (r) => r.fields,
        (r) => entrySysOf(r.entry, r.updatedAt),
      );
      if (!query.select) return filtered;
      return filtered.map((r) => ({
        ...r,
        fields: projectFields(r.fields, query.select as string[]),
      }));
    },
    async countByStatus(scope) {
      const rows = await db
        .select({
          contentType: schema.entries.contentTypeApiId,
          status: schema.entries.status,
          n: count(),
        })
        .from(schema.entries)
        .where(scopeFilter(schema.entries, scope))
        .groupBy(schema.entries.contentTypeApiId, schema.entries.status);
      return rows.map((r) => ({
        contentType: r.contentType,
        status: r.status,
        count: Number(r.n),
      }));
    },
    async distinctFieldValues(scope, query) {
      const e = schema.entries;
      const ofType = and(
        scopeFilter(e, scope),
        eq(e.contentTypeApiId, query.contentTypeApiId),
        ne(e.status, 'archived'),
      );
      // Grouping walks every entry of the type, so a type past the scan cap is refused, as a
      // field query over it would be. The count stops at the cap.
      const [counted] = await db.all<{ n: number }>(
        sql`SELECT count(*) AS n FROM (SELECT 1 FROM ${e} WHERE ${ofType} LIMIT ${scanLimit + 1})`,
      );
      if (Number(counted?.n ?? 0) > scanLimit) throw new QueryTooBroadError(scanLimit);
      // Every scalar value of the field in each entry's current version, in one pass: a locale's
      // value, or each element of a locale's list (a scalar walks a one-row stand-in list). The
      // field name, locale and cursor are bound values.
      const locale = query.locale === undefined ? sql`` : sql`AND kv.key = ${query.locale}`;
      // The order: booleans (as 0/1), then numbers, then strings (BINARY collation).
      const after = query.after;
      const afterKey =
        after === undefined
          ? sql``
          : sql`WHERE (kind, atom) > (${typeof after.value === 'boolean' ? 0 : typeof after.value === 'number' ? 1 : 2}, ${
              typeof after.value === 'boolean' ? (after.value ? 1 : 0) : after.value
            })`;
      const rows = await db.all<{ kind: number; atom: string | number; n: number }>(sql`
        WITH vals(entry_id, type, atom) AS (
          SELECT ${e.id},
                 CASE WHEN kv.type = 'array' THEN el.type ELSE kv.type END,
                 CASE WHEN kv.type = 'array' THEN el.atom ELSE kv.atom END
          FROM ${e} JOIN ${schema.entryVersions} AS ${cv} ON ${currentVersionJoin},
            json_each(${cv.fields}) AS fld, json_each(fld.value) AS kv,
            json_each(CASE WHEN kv.type = 'array' THEN kv.value ELSE '[null]' END) AS el
          WHERE ${ofType} AND fld.key = ${query.field} AND fld.type = 'object' ${locale}
        ),
        grouped(kind, atom, n) AS (
          SELECT CASE WHEN type IN ('true', 'false') THEN 0
                      WHEN type IN ('integer', 'real') THEN 1 ELSE 2 END,
                 atom, COUNT(DISTINCT entry_id)
          FROM vals WHERE type IN ('text', 'integer', 'real', 'true', 'false') GROUP BY 1, 2
        )
        SELECT kind, atom, n FROM grouped ${afterKey}
        ORDER BY kind, atom LIMIT ${Math.max(1, query.limit)}
      `);
      return rows.map((r) => ({
        value: r.kind === 0 ? Boolean(r.atom) : r.kind === 1 ? Number(r.atom) : String(r.atom),
        count: Number(r.n),
      }));
    },
    async idsOfType(scope, contentTypeApiId, page) {
      const e = schema.entries;
      const rows = await db
        .select({ id: e.id })
        .from(e)
        .where(
          and(
            scopeFilter(e, scope),
            eq(e.contentTypeApiId, contentTypeApiId),
            page.after ? gt(e.id, page.after) : undefined,
          ),
        )
        .orderBy(asc(e.id))
        .limit(page.limit);
      return rows.map((r) => r.id);
    },
    async create(scope, entry, version) {
      await writeAll(x, [
        db.insert(schema.entries).values(entryRow(scope, entry)),
        db.insert(schema.entryVersions).values(versionRow(scope, version)),
      ]);
    },
    async saveVersion(scope, entry, version) {
      await writeAll(x, [
        db.insert(schema.entryVersions).values(versionRow(scope, version)),
        saveEntryAggregate(db, scope, entry),
        // The version this one supersedes becomes due to have its body moved, a day from now.
        ...(version.version > 1
          ? [
              db
                .insert(schema.versionArchiveQueue)
                .values({
                  spaceId: scope.spaceId,
                  environmentId: scope.environmentId,
                  entryId: version.entryId,
                  version: version.version - 1,
                  dueAt: new Date(Date.now() + ARCHIVE_DELAY_MS),
                })
                .onConflictDoNothing(),
            ]
          : []),
      ]);
    },
    async saveAggregate(scope, entry) {
      await x.write(saveEntryAggregate(db, scope, entry));
    },
    async replaceUniqueClaims(scope, entryId, claims) {
      // The entry's own claims go first, so re-saving an entry that keeps a
      // value does not collide with itself.
      const statements: Query[] = [
        deleteClaims(scope, entryId),
        ...insertChunks(schema.entryUniqueValues, uniqueRows(scope, entryId, claims), (chunk) =>
          db.insert(schema.entryUniqueValues).values(chunk),
        ),
      ];
      try {
        await writeAll(x, statements);
      } catch (err) {
        // The race this constraint exists for: the pre-check passed and another
        // writer committed first. (Inside a unit of work the violation surfaces
        // at commit instead, as a generic ConflictError from the unit.)
        if (isUniqueViolation(err) || err instanceof ConflictError) {
          throw new ConflictError('Another entry already uses one of these values', {
            claims: claims.map((c) => ({ field: c.fieldApiId, locale: c.locale })),
          });
        }
        throw err;
      }
    },
    async findUniqueConflicts(scope, claims, excludeEntryId) {
      if (claims.length === 0) return [];
      const rows = await selectChunked(
        claims,
        (chunk) =>
          db
            .select()
            .from(schema.entryUniqueValues)
            .where(
              and(
                scopeFilter(schema.entryUniqueValues, scope),
                or(
                  ...chunk.map(
                    (c) =>
                      sql`(${schema.entryUniqueValues.contentTypeApiId} = ${c.contentTypeApiId} AND ${schema.entryUniqueValues.fieldApiId} = ${c.fieldApiId} AND ${schema.entryUniqueValues.locale} = ${c.locale} AND ${schema.entryUniqueValues.value} = ${c.value})`,
                  ),
                ) as SQL,
                ...(excludeEntryId ? [ne(schema.entryUniqueValues.entryId, excludeEntryId)] : []),
              ),
            ),
        4,
        RESERVED,
      );
      return rows.map((r) => ({
        fieldApiId: r.fieldApiId,
        locale: r.locale,
        value: r.value,
        entryId: r.entryId,
      }));
    },
    async releaseUniqueClaims(scope, entryId) {
      await x.write(deleteClaims(scope, entryId));
    },
    async listExpiredTrash(scope, before, limit, after) {
      const e = schema.entries;
      const r = schema.references;
      const rows = await db
        .select({ id: e.id, updatedAt: e.updatedAt })
        .from(e)
        .where(
          and(
            scopeFilter(e, scope),
            // A literal, not a bound value, so the planner can use the partial `entries_trashed`.
            sql`${e.status} = 'archived'`,
            lt(e.updatedAt, before),
            // Keyset: strictly after the cursor in (updated_at, id) order.
            after
              ? or(
                  gt(e.updatedAt, new Date(after.trashedAt)),
                  and(eq(e.updatedAt, new Date(after.trashedAt)), gt(e.id, after.id)),
                )
              : undefined,
            // Not under a published link (edges are recorded at publish), on `references_reverse`.
            sql`NOT EXISTS (SELECT 1 FROM ${r} WHERE ${r.spaceId} = ${e.spaceId} AND ${r.environmentId} = ${e.environmentId} AND ${r.toId} = ${e.id})`,
          ),
        )
        .orderBy(asc(e.updatedAt), asc(e.id))
        .limit(limit);
      return rows.map((row) => ({ id: row.id, trashedAt: row.updatedAt.toISOString() }));
    },
    async delete(scope, id) {
      // One atomic step (versions, claims, then the entry row).
      await writeAll(x, [
        db
          .delete(schema.entryVersions)
          .where(
            and(scopeFilter(schema.entryVersions, scope), eq(schema.entryVersions.entryId, id)),
          ),
        deleteClaims(scope, id),
        db
          .delete(schema.entries)
          .where(and(scopeFilter(schema.entries, scope), eq(schema.entries.id, id))),
      ]);
    },
    async saveAggregateMany(scope, entries) {
      if (entries.length === 0) return;
      // One UPDATE per row (SQLite has no UPDATE ... FROM (VALUES ...) with typed
      // casts), sent as one batch. Deliberately an UPDATE, not an upsert: like the
      // single-item saveEntryAggregate, a row deleted by a concurrent writer must
      // silently no-op, never be re-created as a versionless zombie.
      const at = new Date();
      await writeAll(
        x,
        entries.map((e) =>
          db
            .update(schema.entries)
            .set(aggregateSet(e, at))
            .where(and(scopeFilter(schema.entries, scope), eq(schema.entries.id, e.id))),
        ),
      );
    },
    async listVersions(scope, entryId) {
      const rows = await db
        .select()
        .from(schema.entryVersions)
        .where(
          and(scopeFilter(schema.entryVersions, scope), eq(schema.entryVersions.entryId, entryId)),
        )
        .orderBy(desc(schema.entryVersions.version));
      // Archived bodies a few at a time: an entry with a long history must not open hundreds of
      // object reads at once.
      const out: EntryVersion[] = [];
      for (let at = 0; at < rows.length; at += VERSION_READ_CONCURRENCY) {
        const slice = rows.slice(at, at + VERSION_READ_CONCURRENCY);
        out.push(...(await Promise.all(slice.map((r) => resolveVersion(r, false)))));
      }
      return out;
    },
    async getVersion(scope, entryId, version) {
      const [row] = await db
        .select()
        .from(schema.entryVersions)
        .where(
          and(
            scopeFilter(schema.entryVersions, scope),
            eq(schema.entryVersions.entryId, entryId),
            eq(schema.entryVersions.version, version),
          ),
        );
      return row ? resolveVersion(row, true) : null;
    },
    async claimArchivableVersions(limit, now) {
      directOnly(x, 'entries.claimArchivableVersions');
      const q = schema.versionArchiveQueue;
      const v = schema.entryVersions;
      const e = schema.entries;
      const p = schema.environmentPurges;
      const due = await db
        .select({
          spaceId: q.spaceId,
          environmentId: q.environmentId,
          entryId: q.entryId,
          version: q.version,
          fields: v.fields,
          bodyKey: v.bodyKey,
          createdAt: v.createdAt,
          rowExists: v.version,
          currentVersion: e.currentVersion,
          publishedVersion: e.publishedVersion,
          purging: p.spaceId,
        })
        .from(q)
        .leftJoin(
          v,
          and(
            eq(v.spaceId, q.spaceId),
            eq(v.environmentId, q.environmentId),
            eq(v.entryId, q.entryId),
            eq(v.version, q.version),
          ),
        )
        .leftJoin(
          e,
          and(eq(e.spaceId, q.spaceId), eq(e.environmentId, q.environmentId), eq(e.id, q.entryId)),
        )
        .leftJoin(p, and(eq(p.spaceId, q.spaceId), eq(p.environmentId, q.environmentId)))
        .where(lte(q.dueAt, now))
        .orderBy(asc(q.dueAt))
        .limit(limit);

      const archivable: ArchivableVersion[] = [];
      const housekeeping: Query[] = [];
      const queueRow = (r: (typeof due)[number]) =>
        and(
          eq(q.spaceId, r.spaceId),
          eq(q.environmentId, r.environmentId),
          eq(q.entryId, r.entryId),
          eq(q.version, r.version),
        );
      for (const r of due) {
        const gone =
          r.rowExists === null ||
          r.bodyKey !== null ||
          r.currentVersion === null ||
          r.purging !== null;
        if (gone) {
          housekeeping.push(db.delete(q).where(queueRow(r)));
        } else if (r.version >= (r.currentVersion ?? 0) || r.version === r.publishedVersion) {
          // Its entry's current or published version for now: look again in a day.
          housekeeping.push(
            db
              .update(q)
              .set({ dueAt: new Date(now.getTime() + ARCHIVE_DELAY_MS) })
              .where(queueRow(r)),
          );
        } else {
          archivable.push({
            scope: { spaceId: r.spaceId, environmentId: r.environmentId },
            entryId: r.entryId,
            version: r.version,
            createdAt: (r.createdAt as Date).toISOString(),
            fields: r.fields as EntryFields,
          });
        }
      }
      await writeAll(x, housekeeping);
      return archivable;
    },
    async markVersionsArchived(versions) {
      directOnly(x, 'entries.markVersionsArchived');
      if (versions.length === 0) return 0;
      const v = schema.entryVersions;
      const e = schema.entries;
      const q = schema.versionArchiveQueue;
      // Re-checked in the same write: still this row (created_at), still holding its body, and
      // still neither its entry's current nor its published version. A version that fails keeps
      // its body; its queue row stays (and is looked at again later).
      const statements: Query[] = [];
      for (const a of versions) {
        const row = and(
          scopeFilter(v, a.scope),
          eq(v.entryId, a.entryId),
          eq(v.version, a.version),
        );
        statements.push(
          db
            .update(v)
            .set({ fields: {}, bodyKey: a.bodyKey })
            .where(
              and(
                row,
                isNull(v.bodyKey),
                eq(v.createdAt, new Date(a.createdAt)),
                sql`EXISTS (SELECT 1 FROM ${e} WHERE ${e.spaceId} = ${v.spaceId} AND ${e.environmentId} = ${v.environmentId} AND ${e.id} = ${v.entryId} AND ${v.version} < ${e.currentVersion} AND (${e.publishedVersion} IS NULL OR ${v.version} <> ${e.publishedVersion}))`,
              ),
            ),
          // Out of the queue once its body has moved.
          db
            .delete(q)
            .where(
              and(
                scopeFilter(q, a.scope),
                eq(q.entryId, a.entryId),
                eq(q.version, a.version),
                sql`EXISTS (SELECT 1 FROM ${v} WHERE ${v.spaceId} = ${a.scope.spaceId} AND ${v.environmentId} = ${a.scope.environmentId} AND ${v.entryId} = ${a.entryId} AND ${v.version} = ${a.version} AND ${v.bodyKey} IS NOT NULL)`,
              ),
            ),
        );
      }
      let results: unknown[];
      try {
        results = await db.batch(statements as unknown as [Query, ...Query[]]);
      } catch (err) {
        throw mapD1Error(err);
      }
      // Every other statement is a version's UPDATE.
      return results.reduce<number>(
        (n, r, i) =>
          i % 2 === 0 ? n + ((r as { meta?: { changes?: number } }).meta?.changes ?? 0) : n,
        0,
      );
    },
    async putPublished(scope, snapshot) {
      await putPublishedMany(scope, [snapshot]);
    },
    putPublishedMany,
    async removePublished(scope, entryId) {
      await removePublishedMany(scope, [entryId]);
    },
    removePublishedMany,
    async getPublished(scope, id) {
      const [row] = await publishedEntriesQuery(db, scope, [id]);
      return row ? toPublished(row) : null;
    },
    async getPublishedMany(scope, ids) {
      const rows = await selectChunked(
        ids,
        (chunk) => publishedEntriesQuery(db, scope, chunk),
        1,
        RESERVED,
      );
      return rows.map(toPublished);
    },
    async listPublished(scope, query: EntryQuery) {
      const advanced = isAdvancedQuery(query);
      const conditions = [scopeFilter(schema.entryPublished, scope)];
      if (query.contentTypeApiId) {
        conditions.push(eq(schema.entryPublished.contentTypeApiId, query.contentTypeApiId));
      }
      if (query.since)
        conditions.push(gt(schema.entryPublished.publishedAt, new Date(query.since)));
      if (query.afterEntryId !== undefined && query.afterEntryId !== '')
        conditions.push(gt(schema.entryPublished.entryId, query.afterEntryId));
      if (query.after) {
        // Strictly after (publishedAt, entryId) in the default publish order —
        // exact across same-transaction publishes sharing a publish instant.
        const boundary = new Date(query.after.publishedAt);
        const cond = or(
          gt(schema.entryPublished.publishedAt, boundary),
          and(
            eq(schema.entryPublished.publishedAt, boundary),
            gt(schema.entryPublished.entryId, query.after.entryId),
          ),
        );
        if (cond) conditions.push(cond);
      }
      // Superset prefilters for the field-level predicates: they only narrow
      // the candidate set, never change the answer (the domain engine below
      // still decides). This is what keeps a filtered/searched query from
      // materializing the entire scoped published set.
      const fieldsCol = sql`${schema.entryPublished.fields}`;
      const sysCols = {
        entryId: sql`${schema.entryPublished.entryId}`,
        contentTypeApiId: sql`${schema.entryPublished.contentTypeApiId}`,
        publishedAt: sql`${schema.entryPublished.publishedAt}`,
        metadata: sql`${schema.entryPublished.metadata}`,
        // Published rows are what the reference edges describe: a link filter reads them.
        edges: scope,
      };
      // Reference filters answered exactly by the edge lookup. The edges record each link as the
      // type declared it at publish, so the engine, which reads today's type, doesn't recheck
      // them: an edited type must not hide an entry its published links still name.
      const decided = new Set<QueryFilter>();
      if (advanced) {
        const pre = buildFilterPrefilter(query, fieldsCol, sysCols, decided);
        if (pre) conditions.push(pre);
        if (query.search) {
          const pre = buildSearchPrefilter(query.search, fieldsCol);
          if (pre) conditions.push(pre);
        }
      }
      // A list in manual order, read from `entry_published_by_position` (see `positionOrder`).
      const byPosition = positionOrder(query);
      const publishedPosition = sql`coalesce(${schema.entryPublished.position}, ${schema.entryPublished.entryId})`;
      const publishedOrder = byPosition
        ? byPosition === 'asc'
          ? [asc(publishedPosition), asc(schema.entryPublished.entryId)]
          : [desc(publishedPosition), desc(schema.entryPublished.entryId)]
        : undefined;
      let select = db
        .select()
        .from(schema.entryPublished)
        .where(and(...conditions))
        // Keyset paging (afterEntryId) orders by entryId so the cursor stays
        // stable under concurrent publishes/unpublishes; otherwise publishedAt
        // with an entryId tie-break (same-transaction publishes share
        // publishedAt), which keeps offset paging reliable.
        .orderBy(
          ...(publishedOrder ??
            (query.afterEntryId !== undefined
              ? [asc(schema.entryPublished.entryId)]
              : [asc(schema.entryPublished.publishedAt), asc(schema.entryPublished.entryId)])),
        )
        .$dynamic();
      if (!advanced) {
        select = select.limit(query.limit ?? 100).offset(query.skip ?? 0);
      } else {
        // Bound the candidate scan. Ordering/pagination still happen in JS
        // (the engine's comparison semantics are type-dependent), so this cap
        // is the ceiling on rows pulled into memory — +1 to detect overflow
        // and report it instead of silently truncating the result.
        select = select.limit(scanLimit + 1);
      }
      const published = (await select).map(toPublished);
      if (!advanced) return published;
      if (published.length > scanLimit) {
        throw new QueryTooBroadError(scanLimit);
      }
      const filtered = runEntryQuery(
        published,
        decided.size ? { ...query, filters: query.filters?.filter((f) => !decided.has(f)) } : query,
        (r) => r.fields,
        (r) => ({
          id: r.entryId,
          contentType: r.contentTypeApiId,
          publishedAt: r.publishedAt,
          firstPublishedAt: r.firstPublishedAt,
          position: r.position ?? r.entryId,
          'metadata.tags': r.metadata?.tags ?? [],
          'metadata.concepts': r.metadata?.concepts ?? [],
        }),
      );
      if (!query.select) return filtered;
      return filtered.map((r) => ({
        ...r,
        fields: projectFields(r.fields, query.select as string[]),
      }));
    },
    async countPublished(scope, query) {
      const conditions = [scopeFilter(schema.entryPublished, scope)];
      if (query?.contentType) {
        conditions.push(eq(schema.entryPublished.contentTypeApiId, query.contentType));
      }
      const [row] = await db
        .select({ n: count() })
        .from(schema.entryPublished)
        .where(and(...conditions));
      return Number(row?.n ?? 0);
    },
    /**
     * D1 has no full-text index here, so this is the same "superset prefilter in SQL, exact
     * answer in JS" model as `listPublished`: every term must appear (case-insensitive LIKE
     * over the decoded string values), then each candidate is scored by total term frequency
     * across its string values in all locales (the in-memory store's ranking). The candidate
     * scan is capped like field-level queries ({@link QueryTooBroadError} past it).
     *
     * Production lexical search comes from the separate SearchShard index (the
     * `SearchIndex` port); this is its built-in fallback.
     */
    async searchPublished(scope, query, opts) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];
      const fieldsCol = sql`${schema.entryPublished.fields}`;
      const rows = await db
        .select({ entryId: schema.entryPublished.entryId, fields: schema.entryPublished.fields })
        .from(schema.entryPublished)
        .where(
          and(
            scopeFilter(schema.entryPublished, scope),
            ...terms.map((t) => buildSearchPrefilter(t, fieldsCol) as SQL),
          ),
        )
        .limit(scanLimit + 1);
      if (rows.length > scanLimit) throw new QueryTooBroadError(scanLimit);
      const hits: { entryId: string; score: number }[] = [];
      for (const row of rows) {
        const texts: string[] = [];
        for (const localized of Object.values(row.fields)) {
          if (!localized || typeof localized !== 'object') continue;
          for (const value of Object.values(localized)) {
            if (typeof value === 'string') texts.push(value.toLowerCase());
          }
        }
        const haystack = texts.join(' ');
        let score = 0;
        let matchedAll = true;
        for (const term of terms) {
          let n = 0;
          for (
            let at = haystack.indexOf(term);
            at !== -1;
            at = haystack.indexOf(term, at + term.length)
          ) {
            n += 1;
          }
          if (n === 0) {
            matchedAll = false;
            break;
          }
          score += n;
        }
        if (matchedAll) hits.push({ entryId: row.entryId, score });
      }
      return hits
        .sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId))
        .slice(0, opts.topK);
    },
  };
}

/** Largest asset page a listing returns, whatever the caller asks for. */
const MAX_ASSET_PAGE = 1000;

type AssetRow = typeof schema.assets.$inferSelect;

const toAsset = (r: AssetRow): Asset => ({
  id: r.id,
  status: r.status,
  file: r.file,
  title: r.title,
  description: r.description,
  metadata: r.metadata,
  version: r.version,
  ...(r.folderId ? { folderId: r.folderId } : {}),
  ...(r.r2Key ? { r2Key: r.r2Key } : {}),
  ...(r.contentHash ? { contentHash: r.contentHash } : {}),
  // 0: written by the pre-0007 code, which didn't record it.
  ...(r.createdAt.getTime() > 0 ? { createdAt: r.createdAt.toISOString() } : {}),
  ...(r.createdBy ? { createdBy: r.createdBy } : {}),
  ...(r.archivedAt ? { archivedAt: r.archivedAt.toISOString() } : {}),
  ...(r.rights ? { rights: r.rights } : {}),
  ...(r.ingestStatus ? { ingestStatus: r.ingestStatus } : {}),
  ...(r.ingestError ? { ingestError: r.ingestError } : {}),
  ...(r.duplicateOf ? { duplicateOf: r.duplicateOf } : {}),
  ...(r.aiSuggestions ? { aiSuggestions: r.aiSuggestions } : {}),
});

/** A content type without parameters, lowercased: the `mime` column's form. */
const mimeOf = (contentType: string): string =>
  (contentType.split(';')[0] ?? '').trim().toLowerCase();

/** The SQL a listing sorts by, and the same value read off a row for the next cursor. */
function assetSortKey(field: AssetSortField): { expr: SQL; of: (r: AssetRow) => number } {
  const t = schema.assets;
  switch (field) {
    case 'createdAt':
      return { expr: sql`${t.createdAt}`, of: (r) => r.createdAt.getTime() };
    case 'size':
      // Unknown sizes (a video before the host reports one) sort as the smallest.
      return { expr: sql`ifnull(${t.size}, -1)`, of: (r) => r.size ?? -1 };
    default:
      return { expr: sql`${t.updatedAt}`, of: (r) => r.updatedAt.getTime() };
  }
}

/** Keyset cursor: the last row's sort value and id. Opaque to callers. */
const encodeAssetCursor = (value: number, id: string): string =>
  btoa(JSON.stringify([value, id])).replace(/=+$/, '');

function decodeAssetCursor(cursor: string): [number, string] {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'number' &&
      typeof parsed[1] === 'string'
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Falls through to the refusal.
  }
  throw new ValidationError([{ field: 'cursor', message: 'cursor is not one this list returned' }]);
}

function assetFilterConditions(filters: AssetFilters): SQL[] {
  const t = schema.assets;
  const conds: SQL[] = [];
  const status = filters.status;
  if (status === undefined) conds.push(ne(t.status, 'archived'));
  else if (status !== 'all') conds.push(eq(t.status, status));
  if (filters.kind) conds.push(eq(t.kind, filters.kind));
  if (filters.mime) {
    const mime = filters.mime.trim().toLowerCase();
    if (mime.endsWith('/*')) {
      const family = mime.slice(0, -1);
      conds.push(sql`substr(${t.mime}, 1, ${family.length}) = ${family}`);
    } else {
      conds.push(eq(t.mime, mime));
    }
  }
  if (filters.tag) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM json_each(${t.metadata}, '$.tags') WHERE value = ${filters.tag})`,
    );
  }
  if (filters.folderId === null) conds.push(isNull(t.folderId));
  else if (filters.folderId !== undefined) conds.push(eq(t.folderId, filters.folderId));
  if (filters.contentHash) conds.push(eq(t.contentHash, filters.contentHash));
  return conds;
}

function makeAssetRepo(x: Exec): AssetRepo {
  const db = x.db;
  /** The asset's upsert, as one statement (a caller may put a guard in front of it). */
  const upsertDraft = (scope: Scope, asset: Asset) => {
    const columns = {
      status: asset.status,
      file: asset.file,
      title: asset.title,
      description: asset.description,
      metadata: asset.metadata,
      updatedAt: new Date(),
      kind: assetKind(asset.file.contentType),
      mime: mimeOf(asset.file.contentType),
      size: asset.file.size ?? null,
      width: asset.file.width ?? null,
      height: asset.file.height ?? null,
      contentHash: asset.contentHash ?? null,
      folderId: asset.folderId ?? null,
      version: asset.version ?? 1,
      r2Key: asset.r2Key ?? null,
      // An asset read off a row the pre-0007 code wrote has none: it gets one now.
      createdAt: new Date(asset.createdAt ?? Date.now()),
      createdBy: asset.createdBy ?? null,
      archivedAt: asset.archivedAt ? new Date(asset.archivedAt) : null,
      rights: asset.rights ?? null,
      aiSuggestions: asset.aiSuggestions ?? null,
    };
    // What ingest owns: written on insert (an imported asset keeps its source's), and on an update
    // only by recordIngest, so an editor's save made from a read taken before an ingest step
    // can't undo what the step found.
    const ingested = {
      contentHash: asset.contentHash ?? null,
      ingestStatus: asset.ingestStatus ?? null,
      ingestError: asset.ingestError ?? null,
      duplicateOf: asset.duplicateOf ?? null,
    };
    const { contentHash: _hash, ...edited } = columns;
    // What a file replace owns: the file and its version. A save made from a read taken before a
    // replace or restore committed carries the old version, and writing its file back would drop
    // the new one from the row (it was never put in the history) and hand its version number out
    // again. So those columns take the saved values only when the version matches the row's.
    const sameVersion = (column: string) =>
      sql.raw(
        `CASE WHEN "assets"."version" = excluded."version" THEN excluded."${column}" ELSE "assets"."${column}" END`,
      );
    const updated = {
      ...edited,
      file: sameVersion('file'),
      kind: sameVersion('kind'),
      mime: sameVersion('mime'),
      size: sameVersion('size'),
      width: sameVersion('width'),
      height: sameVersion('height'),
      r2Key: sameVersion('r2_key'),
      // SQLite reads every right-hand side against the row before the update, so this CASE
      // (always the row's own version) and the ones above all compare the same two values.
      version: sameVersion('version'),
    };
    return db
      .insert(schema.assets)
      .values({
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: asset.id,
        ...columns,
        ...ingested,
      })
      .onConflictDoUpdate({
        target: [schema.assets.spaceId, schema.assets.environmentId, schema.assets.id],
        set: updated,
      });
  };
  return {
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.assets)
        .where(and(scopeFilter(schema.assets, scope), eq(schema.assets.id, id)));
      return row ? toAsset(row) : null;
    },
    async getMany(scope, ids) {
      const rows = await selectChunked(
        ids,
        (chunk) =>
          db
            .select()
            .from(schema.assets)
            .where(and(scopeFilter(schema.assets, scope), inArray(schema.assets.id, chunk))),
        1,
        RESERVED,
      );
      return rows.map(toAsset);
    },
    async list(scope, query) {
      const t = schema.assets;
      const sort = query.sort ?? DEFAULT_ASSET_SORT;
      const key = assetSortKey(sort.field);
      const limit = Math.min(Math.max(1, query.limit ?? 100), MAX_ASSET_PAGE);
      const conds = [scopeFilter(t, scope), ...assetFilterConditions(query.filters ?? {})];
      if (query.cursor) {
        const [value, id] = decodeAssetCursor(query.cursor);
        // Row-value comparison: strictly past the last row in (sort value, id) order.
        conds.push(
          sort.direction === 'asc'
            ? sql`(${key.expr}, ${t.id}) > (${value}, ${id})`
            : sql`(${key.expr}, ${t.id}) < (${value}, ${id})`,
        );
      }
      const dir = sort.direction === 'asc' ? sql`ASC` : sql`DESC`;
      // One row past the page tells whether another page exists.
      const rows = await db
        .select()
        .from(t)
        .where(and(...conds))
        .orderBy(sql`${key.expr} ${dir}`, sql`${t.id} ${dir}`)
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toAsset),
        ...(rows.length > limit && last
          ? { nextCursor: encodeAssetCursor(key.of(last), last.id) }
          : {}),
      };
    },
    async create(scope, asset) {
      const write = upsertDraft(scope, asset);
      if (!asset.folderId) {
        await x.write(write);
        return;
      }
      // Its folder must still exist when the batch runs: one deleted since the use-case read it
      // aborts the create (TransactionConflictError) instead of filing the asset nowhere.
      await writeAll(x, [...folderExists(x, scope, asset.folderId), write]);
    },
    async save(scope, asset) {
      await x.write(upsertDraft(scope, asset));
    },
    async moveToFolder(scope, ids, folderId) {
      if (ids.length === 0) return;
      const t = schema.assets;
      // The ids ride as ONE JSON parameter, so a move of any size is one statement under D1's
      // 100-parameter cap.
      const move = db
        .update(t)
        .set({ folderId, updatedAt: new Date() })
        .where(
          and(
            scopeFilter(t, scope),
            sql`${t.id} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))`,
          ),
        );
      if (folderId === null) {
        await x.write(move);
        return;
      }
      // The folder must still exist when the batch runs: one deleted since the use-case read it
      // aborts the move (TransactionConflictError) instead of filing assets nowhere.
      await writeAll(x, [...folderExists(x, scope, folderId), move]);
    },
    async delete(scope, id) {
      const r = schema.references;
      const v = schema.assetVersions;
      // No entry may link to it when the batch runs: a link made since the use-case checked
      // aborts the deletion (TransactionConflictError) rather than leaving it dangling.
      await writeAll(x, [
        db
          .insert(schema.guard)
          .select(
            sql`SELECT NOT EXISTS (SELECT 1 FROM ${r} WHERE ${r.spaceId} = ${scope.spaceId} AND ${r.environmentId} = ${scope.environmentId} AND ${r.toId} = ${id}) AS ok`,
          ),
        db.delete(schema.guard),
        db
          .delete(schema.assetPublished)
          .where(
            and(scopeFilter(schema.assetPublished, scope), eq(schema.assetPublished.assetId, id)),
          ),
        db.delete(v).where(and(scopeFilter(v, scope), eq(v.assetId, id))),
        // Out of every collection with it, in the same batch: no membership outlives its asset.
        db
          .delete(schema.assetCollectionItems)
          .where(
            and(
              scopeFilter(schema.assetCollectionItems, scope),
              eq(schema.assetCollectionItems.assetId, id),
            ),
          ),
        db
          .delete(schema.assets)
          .where(and(scopeFilter(schema.assets, scope), eq(schema.assets.id, id))),
      ]);
    },
    async listAwaitingUpload(createdBefore, limit) {
      const t = schema.assets;
      // The partial index `assets_awaiting_upload` holds exactly these rows, by creation time.
      const rows = await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.status, 'draft'),
            isNull(t.ingestStatus),
            isNull(t.size),
            isNotNull(t.r2Key),
            gt(t.createdAt, new Date(0)),
            lt(t.createdAt, createdBefore),
          ),
        )
        .orderBy(asc(t.createdAt))
        .limit(Math.max(1, Math.min(limit, MAX_ASSET_PAGE)));
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        asset: toAsset(r),
      }));
    },
    async recordIngest(scope, id, version, patch) {
      const t = schema.assets;
      const set: Record<string, unknown> = {};
      if (patch.status !== undefined) set.ingestStatus = patch.status;
      if (patch.error !== undefined) set.ingestError = patch.error;
      if (patch.contentHash !== undefined) set.contentHash = patch.contentHash;
      if (patch.duplicateOf !== undefined) set.duplicateOf = patch.duplicateOf;
      // The file record is JSON: measurements go into it with json_set, so the rest of it (its
      // URL, name, a video) stays as the last save left it.
      const fileSets: SQL[] = [];
      if (patch.size !== undefined) {
        set.size = patch.size;
        fileSets.push(sql`'$.size', ${patch.size}`);
      }
      if (patch.width !== undefined) {
        set.width = patch.width;
        fileSets.push(sql`'$.width', ${patch.width}`);
      }
      if (patch.height !== undefined) {
        set.height = patch.height;
        fileSets.push(sql`'$.height', ${patch.height}`);
      }
      if (patch.placeholder !== undefined) {
        fileSets.push(sql`'$.placeholder', json(${JSON.stringify(patch.placeholder)})`);
      }
      if (patch.contentType !== undefined) {
        set.mime = mimeOf(patch.contentType);
        set.kind = assetKind(patch.contentType);
        fileSets.push(sql`'$.contentType', ${patch.contentType}`);
      }
      if (fileSets.length > 0) set.file = sql`json_set(${t.file}, ${sql.join(fileSets, sql`, `)})`;
      if (Object.keys(set).length === 0) return;
      const conds = [scopeFilter(t, scope), eq(t.id, id), eq(t.version, version)];
      if (patch.onlyFrom) {
        const statuses = patch.onlyFrom.filter((s): s is AssetIngestStatus => s !== null);
        const either: SQL[] = [];
        if (patch.onlyFrom.includes(null)) either.push(isNull(t.ingestStatus));
        if (statuses.length > 0) either.push(inArray(t.ingestStatus, statuses));
        conds.push(either.length > 0 ? (or(...either) as SQL) : sql`0`);
      }
      await x.write(
        db
          .update(t)
          .set(set)
          .where(and(...conds)),
      );
    },
    async recordPublishedFile(scope, id, version, measured) {
      const t = schema.assetPublished;
      const fileSets: SQL[] = [];
      if (measured.size !== undefined) fileSets.push(sql`'$.size', ${measured.size}`);
      if (measured.width !== undefined) fileSets.push(sql`'$.width', ${measured.width}`);
      if (measured.height !== undefined) fileSets.push(sql`'$.height', ${measured.height}`);
      if (measured.placeholder !== undefined) {
        fileSets.push(sql`'$.placeholder', json(${JSON.stringify(measured.placeholder)})`);
      }
      if (fileSets.length === 0) return;
      await x.write(
        db
          .update(t)
          .set({ file: sql`json_set(${t.file}, ${sql.join(fileSets, sql`, `)})` })
          .where(and(scopeFilter(t, scope), eq(t.assetId, id), eq(t.version, version))),
      );
    },
    async putPublished(scope, s) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        assetId: s.assetId,
        file: s.file,
        title: s.title,
        description: s.description,
        metadata: s.metadata,
        publishedAt: new Date(s.publishedAt),
        version: s.version ?? 1,
        r2Key: s.r2Key ?? null,
        kind: assetKind(s.file.contentType),
        rights: s.rights ?? null,
        expiresAt: expiryOf(s.rights),
      };
      await x.write(
        db
          .insert(schema.assetPublished)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.assetPublished.spaceId,
              schema.assetPublished.environmentId,
              schema.assetPublished.assetId,
            ],
            set: {
              file: values.file,
              title: values.title,
              description: values.description,
              metadata: values.metadata,
              publishedAt: values.publishedAt,
              version: values.version,
              r2Key: values.r2Key,
              kind: values.kind,
              rights: values.rights,
              expiresAt: values.expiresAt,
            },
          }),
      );
    },
    async replaceFile(scope, next, previous) {
      const t = schema.assets;
      const v = schema.assetVersions;
      const file = next.file;
      await writeAll(x, [
        // Still on the version the caller read when the batch runs: a replace or restore that
        // committed in between aborts this one (TransactionConflictError), so no version is
        // written twice and no file is lost from the history.
        db
          .insert(schema.guard)
          .select(
            sql`SELECT EXISTS (SELECT 1 FROM ${t} WHERE ${t.spaceId} = ${scope.spaceId} AND ${t.environmentId} = ${scope.environmentId} AND ${t.id} = ${next.id} AND ${t.version} = ${previous.version}) AS ok`,
          ),
        db.delete(schema.guard),
        db.insert(v).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          assetId: next.id,
          version: previous.version,
          file: previous.file,
          r2Key: previous.r2Key ?? null,
          contentHash: previous.contentHash ?? null,
          createdAt: new Date(previous.replacedAt),
          createdBy: previous.replacedBy ?? null,
        }),
        db
          .update(t)
          .set({
            file,
            updatedAt: new Date(),
            kind: assetKind(file.contentType),
            mime: mimeOf(file.contentType),
            size: file.size ?? null,
            width: file.width ?? null,
            height: file.height ?? null,
            version: next.version ?? 1,
            r2Key: next.r2Key ?? null,
            contentHash: next.contentHash ?? null,
            ingestStatus: next.ingestStatus ?? null,
            ingestError: next.ingestError ?? null,
            duplicateOf: next.duplicateOf ?? null,
          })
          .where(and(scopeFilter(t, scope), eq(t.id, next.id))),
      ]);
    },
    async listVersions(scope, id) {
      const v = schema.assetVersions;
      const rows = await db
        .select()
        .from(v)
        .where(and(scopeFilter(v, scope), eq(v.assetId, id)))
        .orderBy(desc(v.version));
      return rows.map(toAssetVersionRecord);
    },
    async getVersion(scope, id, version) {
      const v = schema.assetVersions;
      const [row] = await db
        .select()
        .from(v)
        .where(and(scopeFilter(v, scope), eq(v.assetId, id), eq(v.version, version)));
      return row ? toAssetVersionRecord(row) : null;
    },
    async findExpiredPublished(at, limit) {
      const p = schema.assetPublished;
      const rows = await db
        .select({
          spaceId: p.spaceId,
          environmentId: p.environmentId,
          assetId: p.assetId,
          expiresAt: p.expiresAt,
        })
        .from(p)
        .where(
          and(
            isNotNull(p.expiresAt),
            lte(p.expiresAt, at),
            // And the rights themselves say so. The column is a copy, and code that predates it
            // (a rollback) can rewrite a snapshot without it: a stale row the sweep only skipped
            // would stay first in line forever and, a hundred of them, starve real expiries.
            // Rounded to the millisecond as the 0015 backfill rounds it: julianday is a float,
            // and an expiry exactly at `at` must count as due.
            sql`round((julianday(json_extract(${p.rights}, '$.expiresAt')) - 2440587.5) * 86400000) <= ${at.getTime()}`,
            // Only in an environment that still exists: a deleted one's rows linger until purged.
            registered(p),
          ),
        )
        .orderBy(asc(p.expiresAt))
        .limit(Math.max(1, limit));
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        assetId: r.assetId,
        expiresAt: (r.expiresAt ?? at).toISOString(),
      }));
    },
    async removeExpiredPublished(scope, id, at) {
      const p = schema.assetPublished;
      await writeAll(x, [
        // Still expired when the batch runs: republished meanwhile under a later expiry (or none),
        // it stays delivered and the whole unit aborts (TransactionConflictError).
        db
          .insert(schema.guard)
          .select(
            sql`SELECT EXISTS (SELECT 1 FROM ${p} WHERE ${p.spaceId} = ${scope.spaceId} AND ${p.environmentId} = ${scope.environmentId} AND ${p.assetId} = ${id} AND ${p.expiresAt} <= ${at.getTime()}) AS ok`,
          ),
        db.delete(schema.guard),
        db.delete(p).where(and(scopeFilter(p, scope), eq(p.assetId, id))),
      ]);
    },
    async removePublished(scope, id) {
      await x.write(
        db
          .delete(schema.assetPublished)
          .where(
            and(scopeFilter(schema.assetPublished, scope), eq(schema.assetPublished.assetId, id)),
          ),
      );
    },
    async getPublished(scope, id) {
      const [row] = await publishedAssetsQuery(db, scope, [id]);
      return row ? toPublishedAsset(row) : null;
    },
    async getPublishedMany(scope, ids) {
      const rows = await selectChunked(
        ids,
        (chunk) => publishedAssetsQuery(db, scope, chunk),
        1,
        RESERVED,
      );
      return rows.map(toPublishedAsset);
    },
    async listPublished(scope, query) {
      const page = publishedAssetPage(db, scope, query);
      return page.of(await page.query);
    },
  };
}

/**
 * Published assets in publish order, filtered and paged: the statement and how to read its rows,
 * apart, so `delivery.read` can send it in a batch.
 */
function publishedAssetPage(
  db: Db,
  scope: Scope,
  query: PublishedAssetQuery,
  opts: { readonly withLocales?: boolean } = {},
) {
  const p = schema.assetPublished;
  const a = schema.assets;
  const filters = query.filters ?? {};
  const limit = Math.min(Math.max(1, query.limit ?? 100), MAX_ASSET_PAGE);
  const conds: (SQL | undefined)[] = [scopeFilter(p, scope)];
  if (filters.kind) conds.push(eq(p.kind, filters.kind));
  if (filters.tag) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM json_each(${p.metadata}, '$.tags') WHERE value = ${filters.tag})`,
    );
  }
  // Filing is the library's, not part of what was published: read it live off the asset row,
  // so moving a published asset moves it in Delivery's listing too.
  if (filters.folderId !== undefined) {
    conds.push(
      filters.folderId === null
        ? sql`EXISTS (SELECT 1 FROM ${a} WHERE ${a.spaceId} = ${p.spaceId} AND ${a.environmentId} = ${p.environmentId} AND ${a.id} = ${p.assetId} AND ${a.folderId} IS NULL)`
        : sql`EXISTS (SELECT 1 FROM ${a} WHERE ${a.spaceId} = ${p.spaceId} AND ${a.environmentId} = ${p.environmentId} AND ${a.id} = ${p.assetId} AND ${a.folderId} = ${filters.folderId})`,
    );
  }
  if (query.cursor) {
    const [value, id] = decodeAssetCursor(query.cursor);
    conds.push(sql`(${p.publishedAt}, ${p.assetId}) > (${value}, ${id})`);
  }
  return {
    query: assetSelection(db, scope, Boolean(opts.withLocales))
      .from(p)
      .where(and(...conds))
      .orderBy(asc(p.publishedAt), asc(p.assetId))
      .limit(limit + 1)
      .offset(query.cursor ? 0 : Math.max(0, query.skip ?? 0)),
    of(rows: PubAssetRow[]): PublishedAssetPage {
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toPublishedAsset),
        ...(rows.length > limit && last
          ? { nextCursor: encodeAssetCursor(last.publishedAt.getTime(), last.assetId) }
          : {}),
      };
    },
  };
}

function makeAssetRenditionRepo(x: Exec): AssetRenditionRepo {
  const db = x.db;
  const t = schema.assetRenditions;
  const byName = (scope: Scope, name: string) =>
    and(eq(t.spaceId, scope.spaceId), eq(t.name, name));
  return {
    async list(scope) {
      return (await renditionsQuery(db, scope)).map(toAssetRendition);
    },
    async get(scope, name) {
      const [row] = await db.select().from(t).where(byName(scope, name));
      return row ? toAssetRendition(row) : null;
    },
    async put(scope, r) {
      const columns = {
        width: r.width ?? null,
        height: r.height ?? null,
        fit: r.fit ?? null,
        format: r.format ?? null,
        quality: r.quality ?? null,
        updatedAt: new Date(r.updatedAt),
      };
      await x.write(
        db
          .insert(t)
          .values({
            spaceId: scope.spaceId,
            name: r.name,
            createdAt: new Date(r.createdAt),
            ...columns,
          })
          .onConflictDoUpdate({ target: [t.spaceId, t.name], set: columns }),
      );
    },
    async delete(scope, name) {
      await x.write(db.delete(t).where(byName(scope, name)));
    },
  };
}

type AssetFolderRow = typeof schema.assetFolders.$inferSelect;
const toAssetFolder = (r: AssetFolderRow): AssetFolder => ({
  id: r.id,
  name: r.name,
  ...(r.parentId ? { parentId: r.parentId } : {}),
  path: r.path,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

function makeAssetFolderRepo(x: Exec): AssetFolderRepo {
  const db = x.db;
  const f = schema.assetFolders;
  return {
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(f)
        .where(and(scopeFilter(f, scope), eq(f.id, id)));
      return row ? toAssetFolder(row) : null;
    },
    async list(scope) {
      const rows = await db.select().from(f).where(scopeFilter(f, scope)).orderBy(asc(f.path));
      return rows.map(toAssetFolder);
    },
    async create(scope, folder) {
      const insert = db.insert(f).values({
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId ?? '',
        path: folder.path,
        createdAt: new Date(folder.createdAt),
        updatedAt: new Date(folder.updatedAt),
      });
      if (!folder.parentId) {
        await x.write(insert);
        return;
      }
      // The parent must still exist when the batch runs: one deleted since the use-case read it
      // aborts the create (TransactionConflictError) rather than leaving an orphan.
      await writeAll(x, [...folderExists(x, scope, folder.parentId), insert]);
    },
    async save(scope, folder, previousPath) {
      const statements: Query[] = [];
      if (folder.path !== previousPath) {
        // The whole subtree in one statement (the folder's own row included): every path that
        // starts with the old prefix gets the new one. Compared with substr, not LIKE, so nothing
        // in a path is read as a wildcard.
        statements.push(
          db
            .update(f)
            .set({
              path: sql`${folder.path} || substr(${f.path}, ${previousPath.length + 1})`,
            })
            .where(
              and(
                scopeFilter(f, scope),
                sql`substr(${f.path}, 1, ${previousPath.length}) = ${previousPath}`,
              ),
            ),
        );
      }
      statements.push(
        db
          .update(f)
          .set({
            name: folder.name,
            parentId: folder.parentId ?? '',
            updatedAt: new Date(folder.updatedAt),
          })
          .where(and(scopeFilter(f, scope), eq(f.id, folder.id))),
      );
      await writeAll(x, statements);
    },
    async delete(scope, id) {
      const a = schema.assets;
      // Empty when the batch runs: a subfolder or an asset filed since the use-case checked
      // aborts the deletion (TransactionConflictError) rather than orphaning it.
      await writeAll(x, [
        db.insert(schema.guard).select(
          sql`SELECT NOT EXISTS (SELECT 1 FROM ${f} WHERE ${f.spaceId} = ${scope.spaceId} AND ${f.environmentId} = ${scope.environmentId} AND ${f.parentId} = ${id})
              AND NOT EXISTS (SELECT 1 FROM ${a} WHERE ${a.spaceId} = ${scope.spaceId} AND ${a.environmentId} = ${scope.environmentId} AND ${a.folderId} = ${id}) AS ok`,
        ),
        db.delete(schema.guard),
        db.delete(f).where(and(scopeFilter(f, scope), eq(f.id, id))),
      ]);
    },
  };
}

type AssetCollectionRow = typeof schema.assetCollections.$inferSelect;
const toAssetCollection = (r: AssetCollectionRow, itemCount: number): AssetCollection => ({
  id: r.id,
  name: r.name,
  ...(r.description ? { description: r.description } : {}),
  itemCount,
  createdAt: r.createdAt.toISOString(),
  ...(r.createdBy ? { createdBy: r.createdBy } : {}),
  updatedAt: r.updatedAt.toISOString(),
});

/** Keyset cursor over (text, id): a collection listing's (name, id). Opaque to callers. */
const encodeTextCursor = (value: string, id: string): string =>
  btoa(encodeURIComponent(JSON.stringify([value, id]))).replace(/=+$/, '');

function decodeTextCursor(cursor: string): [string, string] {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(atob(cursor)));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Falls through to the refusal.
  }
  throw new ValidationError([{ field: 'cursor', message: 'cursor is not one this list returned' }]);
}

/** A JSON array of distinct ids: one bound parameter whatever the count (read with json_each). */
const idList = (ids: readonly string[]): string => JSON.stringify([...new Set(ids)]);

// ---- Taxonomy usage counts --------------------------------------------------
// `taxonomy_usage` holds, per term and content type, how many published entries carry the term.
// It is maintained by SQL in the same batch as the published snapshots it counts, never by a read:
// the statements below read `entry_published` as the batch has left it so far (a batch's
// statements see each other's writes), so the unit-of-work rule (JS reads see committed state
// only) never comes into it. A republish with other tags takes the old snapshot's terms off and
// puts the new one's on; an unpublish, archive or trash takes them off.

/** Per term and content type, how many of the published entries `ids` (a JSON array) carry it. */
const publishedTermsOf = (scope: Scope, ids: string) => {
  const p = schema.entryPublished;
  const of = (kind: TermKind, path: string) => sql`
    SELECT ${kind} AS kind, j.value AS term_id, ${p.contentTypeApiId} AS ct,
      count(DISTINCT ${p.entryId}) AS n
    FROM ${p}, json_each(${p.metadata}, ${path}) j
    WHERE ${p.spaceId} = ${scope.spaceId} AND ${p.environmentId} = ${scope.environmentId}
      AND ${p.entryId} IN (SELECT value FROM json_each(${ids})) AND j.type = 'text'
    GROUP BY j.value, ${p.contentTypeApiId}`;
  return sql`${of('tag', '$.tags')} UNION ALL ${of('concept', '$.concepts')}`;
};

/** Takes the published entries `ids` off their terms' counts (before their snapshots change). */
const takeUsage = (db: Db, scope: Scope, ids: string): Query => {
  const u = schema.taxonomyUsage;
  return db
    .update(u)
    .set({ publishedCount: sql`max(0, ${u.publishedCount} - d.n)` })
    .from(sql`(${publishedTermsOf(scope, ids)}) AS d`)
    .where(
      and(
        scopeFilter(u, scope),
        sql`${u.kind} = d.kind AND ${u.termId} = d.term_id AND ${u.contentTypeApiId} = d.ct`,
      ),
    );
};

/** Puts the published entries `ids` on their terms' counts (after their snapshots are written). */
const addUsage = (db: Db, scope: Scope, ids: string): Query => {
  const u = schema.taxonomyUsage;
  // `WHERE true`: SQLite reads an upsert's ON CONFLICT after a bare SELECT … FROM as a join.
  return db
    .insert(u)
    .select(
      sql`SELECT ${scope.spaceId}, ${scope.environmentId}, d.kind, d.term_id, d.ct, d.n FROM (${publishedTermsOf(scope, ids)}) AS d WHERE true`,
    )
    .onConflictDoUpdate({
      target: [u.spaceId, u.environmentId, u.kind, u.termId, u.contentTypeApiId],
      set: { publishedCount: sql`${u.publishedCount} + excluded.published_count` },
    });
};

function makeAssetCollectionRepo(x: Exec): AssetCollectionRepo {
  const db = x.db;
  const c = schema.assetCollections;
  const i = schema.assetCollectionItems;
  const a = schema.assets;
  // Members whose asset exists: an import writes memberships before it creates their assets.
  const itemCount = sql<number>`(SELECT count(*) FROM ${i} WHERE ${i.spaceId} = ${c.spaceId} AND ${i.environmentId} = ${c.environmentId} AND ${i.collectionId} = ${c.id} AND EXISTS (SELECT 1 FROM ${a} WHERE ${a.spaceId} = ${i.spaceId} AND ${a.environmentId} = ${i.environmentId} AND ${a.id} = ${i.assetId}))`;
  const ofCollection = (scope: Scope, id: string) =>
    and(scopeFilter(i, scope), eq(i.collectionId, id));
  return {
    async get(scope, id) {
      const [row] = await db
        .select({ row: c, count: itemCount })
        .from(c)
        .where(and(scopeFilter(c, scope), eq(c.id, id)));
      return row ? toAssetCollection(row.row, Number(row.count)) : null;
    },
    async list(scope, query = {}) {
      const limit = Math.min(Math.max(1, query.limit ?? 100), MAX_ASSET_PAGE);
      const conds: (SQL | undefined)[] = [scopeFilter(c, scope)];
      if (query.cursor) {
        const [name, id] = decodeTextCursor(query.cursor);
        conds.push(sql`(${c.name}, ${c.id}) > (${name}, ${id})`);
      }
      const rows = await db
        .select({ row: c, count: itemCount })
        .from(c)
        .where(and(...conds))
        .orderBy(asc(c.name), asc(c.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => toAssetCollection(r.row, Number(r.count))),
        ...(rows.length > limit && last
          ? { nextCursor: encodeTextCursor(last.row.name, last.row.id) }
          : {}),
      };
    },
    async create(scope, collection) {
      await x.write(
        db.insert(c).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: collection.id,
          name: collection.name,
          description: collection.description ?? null,
          createdAt: new Date(collection.createdAt),
          createdBy: collection.createdBy ?? null,
          updatedAt: new Date(collection.updatedAt),
        }),
      );
    },
    async save(scope, collection) {
      const update = db
        .update(c)
        .set({
          name: collection.name,
          description: collection.description ?? null,
          updatedAt: new Date(collection.updatedAt),
        })
        .where(and(scopeFilter(c, scope), eq(c.id, collection.id)));
      if (x.inUnit) {
        // Deleted since the use-case read it: the unit (and its event) commits nothing.
        await x.write(update);
        x.expectChanged(1);
        return;
      }
      const changed = await update.returning({ id: c.id });
      if (changed.length === 0) throw new TransactionConflictError();
    },
    async delete(scope, id) {
      await writeAll(x, [
        db.delete(i).where(ofCollection(scope, id)),
        db.delete(c).where(and(scopeFilter(c, scope), eq(c.id, id))),
      ]);
    },
    async addItems(scope, id, assetIds, at, maxItems) {
      if (assetIds.length === 0) return;
      // One INSERT … SELECT over the ids as one JSON parameter: each goes after the current last
      // member, in the order given (json_each's key is its index). Only assets of this scope get
      // in, and members already there are left where they are.
      const insert = db.insert(i).select(
        sql`SELECT ${scope.spaceId}, ${scope.environmentId}, ${id}, j.value,
              (SELECT ifnull(max(${i.position}), -1) FROM ${i} WHERE ${ofCollection(scope, id)}) + 1 + j.key,
              ${at.getTime()}
            FROM json_each(${idList(assetIds)}) j
            WHERE EXISTS (SELECT 1 FROM ${a} WHERE ${a.spaceId} = ${scope.spaceId} AND ${a.environmentId} = ${scope.environmentId} AND ${a.id} = j.value)`,
      );
      await writeAll(x, [
        // The collection must still exist when the batch runs: one deleted since the use-case
        // read it aborts the add (TransactionConflictError) instead of leaving orphan members.
        db
          .insert(schema.guard)
          .select(
            sql`SELECT EXISTS (SELECT 1 FROM ${c} WHERE ${c.spaceId} = ${scope.spaceId} AND ${c.environmentId} = ${scope.environmentId} AND ${c.id} = ${id}) AS ok`,
          ),
        db.delete(schema.guard),
        insert.onConflictDoNothing(),
        // And it holds no more than the cap afterwards (a concurrent add counts too).
        db
          .insert(schema.guard)
          .select(
            sql`SELECT (SELECT count(*) FROM ${i} WHERE ${ofCollection(scope, id)} AND EXISTS (SELECT 1 FROM ${a} WHERE ${a.spaceId} = ${i.spaceId} AND ${a.environmentId} = ${i.environmentId} AND ${a.id} = ${i.assetId})) <= ${maxItems} AS ok`,
          ),
        db.delete(schema.guard),
        db
          .update(c)
          .set({ updatedAt: at })
          .where(and(scopeFilter(c, scope), eq(c.id, id))),
      ]);
    },
    async removeItems(scope, id, assetIds) {
      if (assetIds.length === 0) return;
      await x.write(
        db
          .delete(i)
          .where(
            and(
              ofCollection(scope, id),
              sql`${i.assetId} IN (SELECT value FROM json_each(${idList(assetIds)}))`,
            ),
          ),
      );
    },
    async reorder(scope, id, assetIds) {
      if (assetIds.length === 0) return;
      const ids = idList(assetIds);
      const n = JSON.parse(ids).length as number;
      await writeAll(x, [
        // The collection must still exist when the batch runs.
        db
          .insert(schema.guard)
          .select(
            sql`SELECT EXISTS (SELECT 1 FROM ${c} WHERE ${c.spaceId} = ${scope.spaceId} AND ${c.environmentId} = ${scope.environmentId} AND ${c.id} = ${id}) AS ok`,
          ),
        db.delete(schema.guard),
        // The rest keep their order, after the named ones: shifted by n, so no position collides
        // (positions are never negative). Each statement reads its own row only.
        db
          .update(i)
          .set({ position: sql`${i.position} + ${n}` })
          .where(
            and(
              ofCollection(scope, id),
              sql`${i.assetId} NOT IN (SELECT value FROM json_each(${ids}))`,
            ),
          ),
        db
          .update(i)
          .set({
            position: sql`(SELECT j.key FROM json_each(${ids}) j WHERE j.value = ${i.assetId})`,
          })
          .where(
            and(
              ofCollection(scope, id),
              sql`${i.assetId} IN (SELECT value FROM json_each(${ids}))`,
            ),
          ),
      ]);
    },
    async listItems(scope, id, query) {
      const limit = Math.min(Math.max(1, query.limit ?? 100), MAX_ASSET_PAGE);
      const conds: (SQL | undefined)[] = [
        ofCollection(scope, id),
        ...assetFilterConditions(query.filters ?? {}),
      ];
      if (query.cursor) {
        const [position, assetId] = decodeAssetCursor(query.cursor);
        conds.push(sql`(${i.position}, ${i.assetId}) > (${position}, ${assetId})`);
      }
      const rows = await db
        .select({ asset: a, position: i.position })
        .from(i)
        .innerJoin(
          a,
          and(eq(a.spaceId, i.spaceId), eq(a.environmentId, i.environmentId), eq(a.id, i.assetId)),
        )
        .where(and(...conds))
        .orderBy(asc(i.position), asc(i.assetId))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => toAsset(r.asset)),
        ...(rows.length > limit && last
          ? { nextCursor: encodeAssetCursor(last.position, last.asset.id) }
          : {}),
      };
    },
    async listItemIds(scope, id) {
      const rows = await db
        .select({ assetId: i.assetId })
        .from(i)
        .where(ofCollection(scope, id))
        .orderBy(asc(i.position), asc(i.assetId));
      return rows.map((r) => r.assetId);
    },
    async listPublishedItems(scope, id, query) {
      const p = schema.assetPublished;
      const limit = Math.min(Math.max(1, query.limit ?? 100), MAX_ASSET_PAGE);
      const conds: (SQL | undefined)[] = [ofCollection(scope, id)];
      if (query.cursor) {
        const [position, assetId] = decodeAssetCursor(query.cursor);
        conds.push(sql`(${i.position}, ${i.assetId}) > (${position}, ${assetId})`);
      }
      const rows = await db
        .select({ published: p, position: i.position })
        .from(i)
        .innerJoin(
          p,
          and(
            eq(p.spaceId, i.spaceId),
            eq(p.environmentId, i.environmentId),
            eq(p.assetId, i.assetId),
          ),
        )
        .where(and(...conds))
        .orderBy(asc(i.position), asc(i.assetId))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => toPublishedAsset(r.published)),
        ...(rows.length > limit && last
          ? { nextCursor: encodeAssetCursor(last.position, last.published.assetId) }
          : {}),
      };
    },
    async restore(scope, collection, assetIds) {
      const statements: Query[] = [
        db
          .insert(c)
          .values({
            spaceId: scope.spaceId,
            environmentId: scope.environmentId,
            id: collection.id,
            name: collection.name,
            description: collection.description ?? null,
            createdAt: new Date(collection.createdAt),
            createdBy: collection.createdBy ?? null,
            updatedAt: new Date(collection.updatedAt),
          })
          .onConflictDoNothing(),
      ];
      if (assetIds.length > 0) {
        // `WHERE true`: SQLite reads an upsert's ON CONFLICT after a bare SELECT … FROM as a join.
        statements.push(
          db
            .insert(i)
            .select(
              sql`SELECT ${scope.spaceId}, ${scope.environmentId}, ${collection.id}, j.value, j.key, ${Date.parse(collection.updatedAt)} FROM json_each(${idList(assetIds)}) j WHERE true`,
            )
            .onConflictDoNothing(),
        );
      }
      await writeAll(x, statements);
    },
    async hasItem(scope, id, assetId) {
      const [row] = await db
        .select({ ok: sql<number>`1` })
        .from(i)
        .where(and(ofCollection(scope, id), eq(i.assetId, assetId)))
        .limit(1);
      return row !== undefined;
    },
    async collectionsOf(scope, assetId, limit) {
      const rows = await db
        .select({ id: i.collectionId })
        .from(i)
        .where(and(scopeFilter(i, scope), eq(i.assetId, assetId)))
        .limit(Math.max(1, limit));
      return rows.map((r) => r.id);
    },
  };
}

type AssetShareLinkRow = typeof schema.assetShareLinks.$inferSelect;
const toShareLink = (r: AssetShareLinkRow): StoredAssetShareLink => ({
  id: r.id,
  targetType: r.targetType,
  targetId: r.targetId,
  expiresAt: r.expiresAt.toISOString(),
  allowDownload: r.allowDownload,
  ...(r.passwordHash ? { passwordHash: r.passwordHash } : {}),
  createdAt: r.createdAt.toISOString(),
  ...(r.createdBy ? { createdBy: r.createdBy } : {}),
  ...(r.revokedAt ? { revokedAt: r.revokedAt.toISOString() } : {}),
});

function makeAssetShareLinkRepo(x: Exec): AssetShareLinkRepo {
  const db = x.db;
  const l = schema.assetShareLinks;
  return {
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(l)
        .where(and(scopeFilter(l, scope), eq(l.id, id)));
      return row ? toShareLink(row) : null;
    },
    async list(scope, query) {
      const conds: (SQL | undefined)[] = [scopeFilter(l, scope)];
      if (query.targetType) conds.push(eq(l.targetType, query.targetType));
      if (query.targetId) conds.push(eq(l.targetId, query.targetId));
      if (!query.includeInactive) {
        conds.push(isNull(l.revokedAt), gt(l.expiresAt, query.now));
      }
      const rows = await db
        .select()
        .from(l)
        .where(and(...conds))
        .orderBy(desc(l.createdAt), desc(l.id))
        .limit(Math.min(Math.max(1, query.limit ?? 100), MAX_ASSET_PAGE));
      return rows.map(toShareLink);
    },
    async create(scope, link) {
      const target =
        link.targetType === 'asset'
          ? sql`SELECT EXISTS (SELECT 1 FROM ${schema.assets} WHERE ${schema.assets.spaceId} = ${scope.spaceId} AND ${schema.assets.environmentId} = ${scope.environmentId} AND ${schema.assets.id} = ${link.targetId}) AS ok`
          : sql`SELECT EXISTS (SELECT 1 FROM ${schema.assetCollections} WHERE ${schema.assetCollections.spaceId} = ${scope.spaceId} AND ${schema.assetCollections.environmentId} = ${scope.environmentId} AND ${schema.assetCollections.id} = ${link.targetId}) AS ok`;
      await writeAll(x, [
        // The target must still exist when the batch runs.
        db.insert(schema.guard).select(target),
        db.delete(schema.guard),
        db.insert(l).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: link.id,
          targetType: link.targetType,
          targetId: link.targetId,
          expiresAt: new Date(link.expiresAt),
          allowDownload: link.allowDownload,
          passwordHash: link.passwordHash ?? null,
          createdAt: new Date(link.createdAt),
          createdBy: link.createdBy ?? null,
          revokedAt: null,
        }),
      ]);
    },
    async revoke(scope, id, at) {
      const update = db
        .update(l)
        .set({ revokedAt: at })
        .where(and(scopeFilter(l, scope), eq(l.id, id), isNull(l.revokedAt)));
      if (x.inUnit) {
        // Revoked meanwhile: the unit (and its event) commits nothing.
        await x.write(update);
        x.expectChanged(1);
        return;
      }
      const changed = await update.returning({ id: l.id });
      if (changed.length === 0) throw new TransactionConflictError();
    },
  };
}

type AssetZipJobRow = typeof schema.assetZipJobs.$inferSelect;
const toZipJob = (r: AssetZipJobRow): AssetZipJob => ({
  id: r.id,
  status: r.status,
  source: r.source,
  fileName: r.fileName,
  ...(r.fileCount !== null ? { fileCount: r.fileCount } : {}),
  ...(r.totalBytes !== null ? { totalBytes: r.totalBytes } : {}),
  partsDone: r.partsDone,
  ...(r.partCount !== null ? { partCount: r.partCount } : {}),
  ...(r.error ? { error: r.error } : {}),
  createdAt: r.createdAt.toISOString(),
  ...(r.createdBy ? { createdBy: r.createdBy } : {}),
  ...(r.completedAt ? { completedAt: r.completedAt.toISOString() } : {}),
  expiresAt: r.expiresAt.toISOString(),
});

function makeAssetZipJobRepo(x: Exec): AssetZipJobRepo {
  const db = x.db;
  const z = schema.assetZipJobs;
  return {
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(z)
        .where(and(scopeFilter(z, scope), eq(z.id, id)));
      return row ? toZipJob(row) : null;
    },
    async list(scope, limit) {
      const rows = await db
        .select()
        .from(z)
        .where(scopeFilter(z, scope))
        .orderBy(desc(z.createdAt), desc(z.id))
        .limit(Math.min(Math.max(1, limit), MAX_ASSET_PAGE));
      return rows.map(toZipJob);
    },
    async create(scope, job) {
      await x.write(
        db.insert(z).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: job.id,
          status: job.status,
          source: job.source,
          fileName: job.fileName,
          fileCount: job.fileCount ?? null,
          totalBytes: job.totalBytes ?? null,
          partsDone: job.partsDone,
          partCount: job.partCount ?? null,
          error: job.error ?? null,
          createdAt: new Date(job.createdAt),
          createdBy: job.createdBy ?? null,
          completedAt: job.completedAt ? new Date(job.completedAt) : null,
          expiresAt: new Date(job.expiresAt),
        }),
      );
    },
    async update(scope, id, patch) {
      const set: Partial<typeof z.$inferInsert> = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.fileCount !== undefined) set.fileCount = patch.fileCount;
      if (patch.totalBytes !== undefined) set.totalBytes = patch.totalBytes;
      if (patch.partsDone !== undefined) set.partsDone = patch.partsDone;
      if (patch.partCount !== undefined) set.partCount = patch.partCount;
      if (patch.error !== undefined) set.error = patch.error;
      if (patch.completedAt !== undefined) set.completedAt = new Date(patch.completedAt);
      if (Object.keys(set).length === 0) return;
      await x.write(
        db
          .update(z)
          .set(set)
          .where(and(scopeFilter(z, scope), eq(z.id, id))),
      );
    },
    async listExpired(at, limit) {
      const rows = await db
        .select({ spaceId: z.spaceId, environmentId: z.environmentId, id: z.id })
        .from(z)
        .where(lte(z.expiresAt, at))
        .orderBy(asc(z.expiresAt))
        .limit(Math.max(1, Math.min(limit, MAX_ASSET_PAGE)));
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        id: r.id,
      }));
    },
    async delete(scope, id) {
      await x.write(db.delete(z).where(and(scopeFilter(z, scope), eq(z.id, id))));
    },
  };
}

type AssetUploadRow = typeof schema.assetUploads.$inferSelect;
const toAssetUpload = (r: AssetUploadRow): AssetUpload => ({
  assetId: r.assetId,
  uploadId: r.uploadId,
  r2Key: r.r2Key,
  size: r.size,
  partSize: r.partSize,
  contentType: r.contentType,
  createdAt: r.createdAt.toISOString(),
});

function makeAssetUploadRepo(x: Exec): AssetUploadRepo {
  const db = x.db;
  const u = schema.assetUploads;
  const one = (scope: Scope, assetId: string, uploadId: string) =>
    and(scopeFilter(u, scope), eq(u.assetId, assetId), eq(u.uploadId, uploadId));
  return {
    async get(scope, assetId, uploadId) {
      const [row] = await db
        .select()
        .from(u)
        .where(one(scope, assetId, uploadId));
      return row ? toAssetUpload(row) : null;
    },
    async create(scope, upload) {
      await x.write(
        db.insert(u).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          assetId: upload.assetId,
          uploadId: upload.uploadId,
          r2Key: upload.r2Key,
          size: upload.size,
          partSize: upload.partSize,
          contentType: upload.contentType,
          createdAt: new Date(upload.createdAt),
        }),
      );
    },
    async delete(scope, assetId, uploadId) {
      await x.write(db.delete(u).where(one(scope, assetId, uploadId)));
    },
    async listForAsset(scope, assetId) {
      // The primary key leads with scope and asset: a prefix read. An asset has a handful at most
      // (a new upload's, or a replacement's: starting one aborts the others), so no page.
      const rows = await db
        .select()
        .from(u)
        .where(and(scopeFilter(u, scope), eq(u.assetId, assetId)))
        .orderBy(asc(u.createdAt));
      return rows.map(toAssetUpload);
    },
    async listStartedBefore(before, limit) {
      const rows = await db
        .select()
        .from(u)
        .where(lt(u.createdAt, before))
        .orderBy(asc(u.createdAt))
        .limit(Math.max(1, Math.min(limit, MAX_ASSET_PAGE)));
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        upload: toAssetUpload(r),
      }));
    },
  };
}

function makeReferenceRepo(x: Exec): ReferenceRepo {
  const db = x.db;
  const insertEdges = (scope: Scope, edges: readonly ReferenceEdge[]) =>
    insertChunks(schema.references, edges, (chunk) =>
      db.insert(schema.references).values(
        chunk.map((e) => ({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          fromEntryId: e.fromEntryId,
          fromField: e.fromField,
          toId: e.toId,
          toType: e.toType,
        })),
      ),
    );
  const deleteFrom = (scope: Scope, fromEntryIds: readonly string[]) =>
    chunked(fromEntryIds, 1, RESERVED).map((chunk) =>
      db
        .delete(schema.references)
        .where(
          and(scopeFilter(schema.references, scope), inArray(schema.references.fromEntryId, chunk)),
        ),
    );
  return {
    async replaceForEntry(scope, fromEntryId, edges) {
      await writeAll(x, [...deleteFrom(scope, [fromEntryId]), ...insertEdges(scope, edges)]);
    },
    async replaceForEntries(scope, replacements) {
      if (replacements.length === 0) return;
      await writeAll(x, [
        ...deleteFrom(
          scope,
          replacements.map((r) => r.fromEntryId),
        ),
        ...insertEdges(
          scope,
          replacements.flatMap((r) => r.edges),
        ),
      ]);
    },
    async removeForEntry(scope, fromEntryId) {
      await writeAll(x, deleteFrom(scope, [fromEntryId]));
    },
    async findForward(scope, fromEntryId) {
      const rows = await db
        .select()
        .from(schema.references)
        .where(
          and(
            scopeFilter(schema.references, scope),
            eq(schema.references.fromEntryId, fromEntryId),
          ),
        );
      return rows.map(toEdge);
    },
    async findReverse(scope, toId) {
      const rows = await db
        .select()
        .from(schema.references)
        .where(and(scopeFilter(schema.references, scope), eq(schema.references.toId, toId)));
      return rows.map(toEdge);
    },
    async findReverseClosure(scope, toIds, opts) {
      if (toIds.length === 0) return [];
      // One recursive CTE over the (space, env, to_id) index replaces a
      // breadth-first walk of per-node round-trips. Working rows are
      // (entry_id, depth) tuples, so a cycle produces rows at increasing
      // depths — the `depth < maxDepth` bound is what terminates it (UNION
      // dedupe only collapses same-depth revisits); the outer LIMIT caps the
      // result set. Seeds are excluded from the output. The seed list is ONE
      // JSON-array parameter (`json_each`), so its size never meets D1's
      // 100-parameter cap.
      const seeds = JSON.stringify([...new Set(toIds)]);
      const rows = await db.all<{ entry_id: string }>(sql`
        WITH RECURSIVE closure(entry_id, depth) AS (
          SELECT r.from_entry_id, 1
          FROM ${schema.references} r
          WHERE r.space_id = ${scope.spaceId} AND r.environment_id = ${scope.environmentId}
            AND r.to_id IN (SELECT value FROM json_each(${seeds}))
          UNION
          SELECT r.from_entry_id, c.depth + 1
          FROM ${schema.references} r
          JOIN closure c ON r.to_id = c.entry_id
          WHERE r.space_id = ${scope.spaceId} AND r.environment_id = ${scope.environmentId}
            AND c.depth < ${opts.maxDepth}
        )
        SELECT DISTINCT entry_id FROM closure
        WHERE entry_id NOT IN (SELECT value FROM json_each(${seeds}))
        LIMIT ${opts.maxEntries}
      `);
      return rows.map((r) => r.entry_id);
    },
  };
}

function makeBulkJobRepo(x: Exec): BulkJobRepo {
  const db = x.db;
  const toJob = (row: typeof schema.bulkJobs.$inferSelect): BulkJob => ({
    id: row.id,
    action: row.action,
    status: row.status,
    totalItems: row.totalItems,
    totalChunks: row.totalChunks,
    completedChunks: row.completedChunks,
    succeeded: row.succeeded,
    failed: row.failed,
    createdAt: row.createdAt.toISOString(),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(row.config ? { config: row.config } : {}),
  });
  const toChunk = (row: typeof schema.bulkJobChunks.$inferSelect): BulkJobChunk => ({
    jobId: row.jobId,
    chunkId: row.chunkId,
    entryIds: row.entryIds,
    status: row.status,
    attempts: row.attempts,
    failures: row.failures,
    ...(row.payloadKey ? { payloadKey: row.payloadKey } : {}),
  });
  const jobWhere = (scope: Scope, id: string) =>
    and(scopeFilter(schema.bulkJobs, scope), eq(schema.bulkJobs.id, id));

  return {
    async createJob(scope, job) {
      await x.write(
        db.insert(schema.bulkJobs).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: job.id,
          action: job.action,
          status: job.status,
          totalItems: job.totalItems,
          totalChunks: job.totalChunks,
          completedChunks: job.completedChunks,
          succeeded: job.succeeded,
          failed: job.failed,
          createdAt: new Date(job.createdAt),
          config: job.config ?? null,
        }),
      );
    },
    async getJob(scope, id) {
      const [row] = await db.select().from(schema.bulkJobs).where(jobWhere(scope, id));
      return row ? toJob(row) : null;
    },
    async listJobs(scope, opts) {
      const rows = await db
        .select()
        .from(schema.bulkJobs)
        .where(scopeFilter(schema.bulkJobs, scope))
        .orderBy(desc(schema.bulkJobs.createdAt), desc(schema.bulkJobs.id))
        .limit(opts?.limit ?? 50);
      return rows.map(toJob);
    },
    async createChunks(scope, chunks) {
      if (chunks.length === 0) return;
      // Multi-row inserts sliced under D1's parameter cap (each row carries a
      // JSON id list as one bound parameter).
      await writeAll(
        x,
        insertChunks(schema.bulkJobChunks, chunks, (slice) =>
          db.insert(schema.bulkJobChunks).values(
            slice.map((c) => ({
              spaceId: scope.spaceId,
              environmentId: scope.environmentId,
              jobId: c.jobId,
              chunkId: c.chunkId,
              entryIds: [...c.entryIds],
              status: c.status,
              attempts: c.attempts,
              failures: [...c.failures],
              payloadKey: c.payloadKey ?? null,
            })),
          ),
        ),
      );
    },
    async listChunks(scope, jobId) {
      const rows = await db
        .select()
        .from(schema.bulkJobChunks)
        .where(and(scopeFilter(schema.bulkJobChunks, scope), eq(schema.bulkJobChunks.jobId, jobId)))
        .orderBy(asc(schema.bulkJobChunks.chunkId));
      return rows.map(toChunk);
    },
    async claimChunk(scope, jobId, chunkId, opts) {
      directOnly(x, 'bulkJobs.claimChunk');
      // Single-statement CAS: only a pending chunk or a stale running claim
      // transitions; a concurrent claimer's UPDATE matches zero rows.
      const claimed = await db
        .update(schema.bulkJobChunks)
        .set({ status: 'running', claimedAt: opts.now, attempts: sql`attempts + 1` })
        .where(
          and(
            scopeFilter(schema.bulkJobChunks, scope),
            eq(schema.bulkJobChunks.jobId, jobId),
            eq(schema.bulkJobChunks.chunkId, chunkId),
            or(
              eq(schema.bulkJobChunks.status, 'pending'),
              and(
                eq(schema.bulkJobChunks.status, 'running'),
                lt(schema.bulkJobChunks.claimedAt, opts.staleBefore),
              ),
            ),
          ),
        )
        .returning();
      return claimed[0] ? toChunk(claimed[0]) : null;
    },
    async completeChunk(scope, jobId, chunkId, outcome) {
      directOnly(x, 'bulkJobs.completeChunk');
      // One atomic batch: the chunk CAS, then
      // the counter fold guarded on `changes() = 1` (it applies only if the
      // chunk UPDATE just matched — a duplicate completion from a redelivered
      // event must not double-count), then the job as it now stands.
      const [chunkRows, , jobRows] = await db
        .batch([
          db
            .update(schema.bulkJobChunks)
            .set({
              status: outcome.status,
              failures: [...outcome.failures],
              completedAt: new Date(),
            })
            .where(
              and(
                scopeFilter(schema.bulkJobChunks, scope),
                eq(schema.bulkJobChunks.jobId, jobId),
                eq(schema.bulkJobChunks.chunkId, chunkId),
                eq(schema.bulkJobChunks.status, 'running'),
              ),
            )
            .returning({ chunkId: schema.bulkJobChunks.chunkId }),
          db
            .update(schema.bulkJobs)
            .set({
              completedChunks: sql`completed_chunks + 1`,
              succeeded: sql`succeeded + ${outcome.succeeded}`,
              failed: sql`failed + ${outcome.failed}`,
            })
            .where(and(jobWhere(scope, jobId), sql`changes() = 1`)),
          db.select().from(schema.bulkJobs).where(jobWhere(scope, jobId)),
        ])
        .catch((err: unknown) => {
          throw mapD1Error(err);
        });
      const [job] = jobRows;
      if (!job) {
        throw new Error(
          chunkRows.length > 0
            ? `Bulk job ${jobId} not found for completed chunk`
            : `Bulk job ${jobId} not found`,
        );
      }
      return toJob(job);
    },
    async mergeConfig(scope, id, patch) {
      // One statement, judged against the row as it stands: keys another writer merged stay.
      await x.write(
        db
          .update(schema.bulkJobs)
          .set({
            config: sql`json_patch(coalesce(${schema.bulkJobs.config}, '{}'), ${JSON.stringify(patch)})`,
          })
          .where(jobWhere(scope, id)),
      );
    },
    async finalizeJob(scope, id, status, at) {
      const running = and(jobWhere(scope, id), eq(schema.bulkJobs.status, 'running'));
      if (x.inUnit) {
        // Unit of work: decide from committed state, buffer the CAS, and let the
        // guard abort the unit (TransactionConflictError) if another finalizer
        // commits first. The returned job is the row as this write leaves it.
        const [row] = await db.select().from(schema.bulkJobs).where(jobWhere(scope, id));
        if (row?.status !== 'running') return null;
        await x.write(db.update(schema.bulkJobs).set({ status, completedAt: at }).where(running));
        x.expectChanged(1);
        return toJob({ ...row, status, completedAt: at });
      }
      const [row] = await db
        .update(schema.bulkJobs)
        .set({ status, completedAt: at })
        .where(running)
        .returning();
      return row ? toJob(row) : null;
    },
    async releaseChunk(scope, jobId, chunkId) {
      await x.write(
        db
          .update(schema.bulkJobChunks)
          .set({ status: 'pending', claimedAt: null })
          .where(
            and(
              scopeFilter(schema.bulkJobChunks, scope),
              eq(schema.bulkJobChunks.jobId, jobId),
              eq(schema.bulkJobChunks.chunkId, chunkId),
              eq(schema.bulkJobChunks.status, 'running'),
            ),
          ),
      );
    },
    async findStalledChunks(staleBefore, limit) {
      // Open chunks past the threshold, joined to their (running) jobs so a
      // cancelled job's leftovers are never re-nudged.
      const rows = await db
        .select({
          spaceId: schema.bulkJobChunks.spaceId,
          environmentId: schema.bulkJobChunks.environmentId,
          jobId: schema.bulkJobChunks.jobId,
          chunkId: schema.bulkJobChunks.chunkId,
        })
        .from(schema.bulkJobChunks)
        .innerJoin(
          schema.bulkJobs,
          and(
            eq(schema.bulkJobChunks.spaceId, schema.bulkJobs.spaceId),
            eq(schema.bulkJobChunks.environmentId, schema.bulkJobs.environmentId),
            eq(schema.bulkJobChunks.jobId, schema.bulkJobs.id),
          ),
        )
        .where(
          and(
            eq(schema.bulkJobs.status, 'running'),
            or(
              and(
                eq(schema.bulkJobChunks.status, 'pending'),
                lt(schema.bulkJobChunks.createdAt, staleBefore),
              ),
              and(
                eq(schema.bulkJobChunks.status, 'running'),
                lt(schema.bulkJobChunks.claimedAt, staleBefore),
              ),
            ),
          ),
        )
        .limit(limit);
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        jobId: r.jobId,
        chunkId: r.chunkId,
      }));
    },
    async findUnfinalizedJobs(limit) {
      const rows = await db
        .select({
          spaceId: schema.bulkJobs.spaceId,
          environmentId: schema.bulkJobs.environmentId,
          id: schema.bulkJobs.id,
        })
        .from(schema.bulkJobs)
        .where(
          and(
            eq(schema.bulkJobs.status, 'running'),
            gte(schema.bulkJobs.completedChunks, schema.bulkJobs.totalChunks),
          ),
        )
        .limit(limit);
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        jobId: r.id,
      }));
    },
  };
}

/** How long a `readPending` claim keeps other relayers off its rows. */
export const OUTBOX_LEASE_MS = 60_000;

function makeOutboxRepo(x: Exec): OutboxRepo {
  const db = x.db;
  const appendMany = async (events: readonly OutboxEntry[]): Promise<void> => {
    if (events.length === 0) return;
    await writeAll(
      x,
      insertChunks(schema.outbox, events, (chunk) =>
        db.insert(schema.outbox).values(
          chunk.map((event) => ({
            id: event.id,
            // A send request has no `type` (so no engine takes it for an event); its row is typed
            // by its `kind`.
            type: isWebhookSendRequest(event) ? event.kind : event.type,
            payload: event as DomainEvent,
            occurredAt: new Date(event.occurredAt),
          })),
        ),
      ),
    );
  };
  return {
    async append(event) {
      await appendMany([event]);
    },
    appendMany,
    /**
     * A lease claim, executed immediately even inside a unit of work (D1 has no
     * `FOR UPDATE SKIP LOCKED`): one UPDATE stamps the oldest unclaimed (or
     * lease-expired) pending rows with a fresh claimer id and a 60s lease and
     * returns them. D1 serializes writes, so concurrent relayers claim disjoint
     * rows. If the relayer dies before `markRelayed` commits, the lease lapses
     * and the rows are re-claimed (at-least-once).
     */
    async readPending(limit) {
      const now = new Date();
      const claimable = db
        .select({ id: schema.outbox.id })
        .from(schema.outbox)
        .where(
          and(
            isNull(schema.outbox.relayedAt),
            or(isNull(schema.outbox.claimedUntil), lt(schema.outbox.claimedUntil, now)),
          ),
        )
        .orderBy(asc(schema.outbox.occurredAt))
        .limit(limit);
      const rows = await db
        .update(schema.outbox)
        .set({
          claimedBy: crypto.randomUUID(),
          claimedUntil: new Date(now.getTime() + OUTBOX_LEASE_MS),
        })
        .where(inArray(schema.outbox.id, claimable))
        .returning();
      return rows
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        .map((r) => r.payload as OutboxEntry);
    },
    async markRelayed(eventIds) {
      if (eventIds.length === 0) return;
      const at = new Date();
      await writeAll(
        x,
        chunked(eventIds, 1, RESERVED).map((chunk) =>
          db.update(schema.outbox).set({ relayedAt: at }).where(inArray(schema.outbox.id, chunk)),
        ),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select({ payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(eq(schema.outbox.id, id));
      const event = row?.payload as OutboxEntry | undefined;
      // The outbox has no space column: the event's own scope says whose it is.
      return event?.scope?.spaceId === scope.spaceId ? event : null;
    },
    async deleteRelayedBefore(before, limit) {
      directOnly(x, 'outbox.deleteRelayedBefore');
      // Bound the sweep via an id subquery so a huge backlog is trimmed in
      // controlled slices.
      const victims = db
        .select({ id: schema.outbox.id })
        .from(schema.outbox)
        .where(and(isNotNull(schema.outbox.relayedAt), lt(schema.outbox.relayedAt, before)))
        .limit(limit);
      const deleted = await db
        .delete(schema.outbox)
        .where(inArray(schema.outbox.id, victims))
        .returning({ id: schema.outbox.id });
      return deleted.length;
    },
  };
}

/**
 * Raw access to sealed secret columns for the reseal sweep. Ordering and the
 * cursor use SQLite's default BINARY collation (byte order), so the page boundary is total and matches the in-memory
 * adapter; the prefix test uses `substr`, avoiding LIKE wildcard escaping
 * (`_` is a base64url character).
 */
function makeStoredSecretRepo(x: Exec): StoredSecretRepo {
  const db = x.db;
  const w = schema.webhooks;
  return {
    async scan(column, { excludePrefix, after, limit }) {
      if (column === 'webhooks.secret') {
        const rows = await db.all<{ id: string; value: string }>(sql`
          SELECT w.id AS id, w.secret AS value
          FROM ${w} w
          WHERE substr(w.secret, 1, length(${excludePrefix})) <> ${excludePrefix}
            ${after ? sql`AND w.id > ${after.id}` : sql``}
          ORDER BY w.id
          LIMIT ${limit}
        `);
        return rows.map((r) => ({ column, id: r.id, value: r.value }));
      }
      if (column === 'plugin_settings.secrets') {
        // Rows are keyed by (space, plugin); the ref's id is `<space>/<plugin>`, and the order
        // and cursor run on that same string, so pages match the in-memory adapter's.
        const p = schema.pluginSettings;
        const id = sql`(p.space_id || '/' || p.plugin_id)`;
        const rows = await db.all<{ id: string; key: string; value: string }>(sql`
          SELECT ${id} AS id, h.key AS key, h.value AS value
          FROM ${p} p, json_each(p.secrets) h
          WHERE json_type(p.secrets) = 'object' AND h.type = 'text'
            AND substr(h.value, 1, length(${excludePrefix})) <> ${excludePrefix}
            ${
              after
                ? sql`AND (${id} > ${after.id} OR (${id} = ${after.id} AND h.key > ${after.key ?? ''}))`
                : sql``
            }
          ORDER BY 1, 2
          LIMIT ${limit}
        `);
        return rows.map((r) => ({ column, id: r.id, key: r.key, value: r.value }));
      }
      const rows = await db.all<{ id: string; key: string; value: string }>(sql`
        SELECT w.id AS id, h.key AS key, h.value AS value
        FROM ${w} w, json_each(w.headers) h
        WHERE w.headers IS NOT NULL AND json_type(w.headers) = 'object'
          AND h.type = 'text'
          AND substr(h.value, 1, length(${excludePrefix})) <> ${excludePrefix}
          ${
            after
              ? sql`AND (w.id > ${after.id} OR (w.id = ${after.id} AND h.key > ${after.key ?? ''}))`
              : sql``
          }
        ORDER BY w.id, h.key
        LIMIT ${limit}
      `);
      return rows.map((r) => ({ column, id: r.id, key: r.key, value: r.value }));
    },
    async replace(ref, was, next) {
      directOnly(x, 'storedSecrets.replace');
      if (ref.column === 'webhooks.secret') {
        const rows = await db
          .update(w)
          .set({ secret: next })
          .where(and(eq(w.id, ref.id), eq(w.secret, was)))
          .returning({ id: w.id });
        return rows.length > 0;
      }
      if (ref.column === 'plugin_settings.secrets') {
        // Setting keys are `[A-Za-z][A-Za-z0-9_]*` (the manifest refuses anything else), so the
        // path quotes safely. The version is left alone: a reseal changes no value an operator
        // could be editing, so it must not make their next save lose its compare-and-set.
        const p = schema.pluginSettings;
        const slash = ref.id.indexOf('/');
        const path = `$."${ref.key ?? ''}"`;
        const rows = await db
          .update(p)
          .set({ secrets: sql`json_set(${p.secrets}, ${path}, ${next})` })
          .where(
            and(
              eq(p.spaceId, ref.id.slice(0, slash)),
              eq(p.pluginId, ref.id.slice(slash + 1)),
              sql`json_extract(${p.secrets}, ${path}) = ${was}`,
            ),
          )
          .returning({ v: p.version });
        return rows.length > 0;
      }
      const key = ref.key ?? '';
      if (!key.includes('"')) {
        // `$."key"` addresses the header without splicing it into SQL text; the
        // CAS compares only that header, so other headers may change concurrently.
        const path = `$."${key}"`;
        const rows = await db
          .update(w)
          .set({ headers: sql`json_set(${w.headers}, ${path}, ${next})` })
          .where(and(eq(w.id, ref.id), sql`json_extract(${w.headers}, ${path}) = ${was}`))
          .returning({ id: w.id });
        return rows.length > 0;
      }
      // A key SQLite's path syntax can't quote: edit in JS and compare-and-set the
      // whole column against the exact text read.
      const [row] = await db
        .select({ raw: sql<string | null>`${w.headers}` })
        .from(w)
        .where(eq(w.id, ref.id));
      if (!row?.raw) return false;
      const headers = JSON.parse(row.raw) as Record<string, string>;
      if (headers[key] !== was) return false;
      const rows = await db
        .update(w)
        .set({ headers: { ...headers, [key]: next } })
        .where(and(eq(w.id, ref.id), sql`${w.headers} = ${row.raw}`))
        .returning({ id: w.id });
      return rows.length > 0;
    },
  };
}

/** The space's webhooks that `scope`'s environment covers: its own and the space-wide (NULL) ones. */
const webhookVisibleIn = (scope: Scope) =>
  and(
    eq(schema.webhooks.spaceId, scope.spaceId),
    or(
      isNull(schema.webhooks.environmentId),
      eq(schema.webhooks.environmentId, scope.environmentId),
    ),
  );

function toDeliveryRecord(r: typeof schema.webhookDeliveries.$inferSelect): WebhookDeliveryRecord {
  return {
    id: r.id,
    webhookId: r.webhookId,
    eventId: r.eventId,
    status: r.status,
    statusCode: r.statusCode ?? undefined,
    attempts: r.attempts,
    error: r.error ?? undefined,
    ...(r.eventType ? { eventType: r.eventType as EventType } : {}),
    ...(r.resendOf !== null ? { resendOf: r.resendOf } : {}),
    createdAt: r.createdAt.toISOString(),
  };
}

function makeWebhookRepo(x: Exec): WebhookRepo {
  const db = x.db;
  return {
    async create(scope, webhook) {
      await x.write(
        db.insert(schema.webhooks).values({
          id: webhook.id,
          spaceId: scope.spaceId,
          url: webhook.url,
          topics: [...webhook.topics],
          secret: webhook.secret,
          active: webhook.active,
          headers: webhook.headers ?? null,
          environmentId: webhook.environmentId,
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.webhooks)
        .where(and(webhookVisibleIn(scope), eq(schema.webhooks.id, id)));
      return row ? toWebhook(row) : null;
    },
    async list(scope) {
      const rows = await db.select().from(schema.webhooks).where(webhookVisibleIn(scope));
      return rows.map(toWebhook);
    },
    async listByTopic(scope, type) {
      const rows = await db.select().from(schema.webhooks).where(webhookVisibleIn(scope));
      return rows.map(toWebhook).filter((w) => matchesTopic(w, type));
    },
    async update(scope, webhook) {
      await x.write(
        db
          .update(schema.webhooks)
          .set({
            url: webhook.url,
            topics: [...webhook.topics],
            secret: webhook.secret,
            active: webhook.active,
            headers: webhook.headers ?? null,
            environmentId: webhook.environmentId,
          })
          .where(and(webhookVisibleIn(scope), eq(schema.webhooks.id, webhook.id))),
      );
    },
    async delete(scope, id) {
      await x.write(
        db.delete(schema.webhooks).where(and(webhookVisibleIn(scope), eq(schema.webhooks.id, id))),
      );
    },
    async recordDelivery(scope, delivery) {
      await x.write(
        db.insert(schema.webhookDeliveries).values({
          spaceId: scope.spaceId,
          webhookId: delivery.webhookId,
          eventId: delivery.eventId,
          status: delivery.status,
          statusCode: delivery.statusCode ?? null,
          attempts: delivery.attempts,
          error: delivery.error ?? null,
          eventType: delivery.eventType ?? null,
          resendOf: delivery.resendOf ?? null,
        }),
      );
    },
    async getDelivery(scope, webhookId, id) {
      const [row] = await db
        .select()
        .from(schema.webhookDeliveries)
        .where(
          and(
            eq(schema.webhookDeliveries.spaceId, scope.spaceId),
            eq(schema.webhookDeliveries.webhookId, webhookId),
            eq(schema.webhookDeliveries.id, id),
          ),
        );
      return row ? toDeliveryRecord(row) : null;
    },
    async listDeliveries(scope, webhookId, opts) {
      const rows = await db
        .select()
        .from(schema.webhookDeliveries)
        .where(
          and(
            eq(schema.webhookDeliveries.spaceId, scope.spaceId),
            eq(schema.webhookDeliveries.webhookId, webhookId),
          ),
        )
        .orderBy(desc(schema.webhookDeliveries.createdAt))
        .limit(opts?.limit ?? 50);
      return rows.map(toDeliveryRecord);
    },
    async deleteDeliveriesBefore(before, limit) {
      directOnly(x, 'webhooks.deleteDeliveriesBefore');
      const victims = db
        .select({ id: schema.webhookDeliveries.id })
        .from(schema.webhookDeliveries)
        .where(lt(schema.webhookDeliveries.createdAt, before))
        .limit(limit);
      const deleted = await db
        .delete(schema.webhookDeliveries)
        .where(inArray(schema.webhookDeliveries.id, victims))
        .returning({ id: schema.webhookDeliveries.id });
      return deleted.length;
    },
  };
}

function makeAgentRunRepo(x: Exec): AgentRunRepo {
  const db = x.db;
  return {
    async record(scope, run) {
      await x.write(
        db.insert(schema.agentRuns).values({
          id: run.id,
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          workflow: run.workflow,
          entryId: run.entryId,
          status: run.status,
          decisions: [...run.decisions],
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          createdAt: new Date(run.createdAt),
        }),
      );
    },
    async list(scope, query) {
      const conds = [eq(schema.agentRuns.spaceId, scope.spaceId)];
      if (query.workflow) conds.push(eq(schema.agentRuns.workflow, query.workflow));
      const rows = await db
        .select()
        .from(schema.agentRuns)
        .where(and(...conds))
        .orderBy(desc(schema.agentRuns.createdAt))
        .limit(query.limit ?? 100);
      return rows.map(toAgentRun);
    },
    async usage(scope, query) {
      const conds = [eq(schema.agentRuns.spaceId, scope.spaceId)];
      if (query.workflow) conds.push(eq(schema.agentRuns.workflow, query.workflow));
      if (query.since) conds.push(gte(schema.agentRuns.createdAt, new Date(query.since)));
      const [row] = await db
        .select({
          runs: count(),
          inputTokens: sum(schema.agentRuns.inputTokens),
          outputTokens: sum(schema.agentRuns.outputTokens),
        })
        .from(schema.agentRuns)
        .where(and(...conds));
      return {
        runs: Number(row?.runs ?? 0),
        inputTokens: Number(row?.inputTokens ?? 0),
        outputTokens: Number(row?.outputTokens ?? 0),
      };
    },
  };
}

function makeAuditRepo(x: Exec): AuditRepo {
  const db = x.db;
  return {
    async append(entry) {
      await x.write(
        db.insert(schema.auditLog).values({
          id: entry.id,
          spaceId: entry.spaceId,
          environmentId: entry.environmentId ?? null,
          actor: entry.actor,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          status: entry.status,
          at: new Date(entry.at),
          detail: entry.detail ?? null,
        }),
      );
    },
    async list(spaceId, query) {
      const log = schema.auditLog;
      const about = schema.auditLogEntries;
      // An entry's activity walks the entry index (its space, environment and keyset columns),
      // joining each row it keeps; any other listing walks the log itself.
      const entryId = query.entryId;
      const at = entryId ? about.at : log.at;
      const id = entryId ? about.auditId : log.id;
      const conds = entryId
        ? [eq(about.spaceId, spaceId), eq(about.entryId, entryId)]
        : [eq(log.spaceId, spaceId)];
      if (query.environmentId) {
        conds.push(eq(entryId ? about.environmentId : log.environmentId, query.environmentId));
      }
      if (query.actor) conds.push(eq(log.actor, query.actor));
      if (query.action) conds.push(eq(log.action, query.action));
      if (query.targetType) conds.push(eq(log.targetType, query.targetType));
      if (query.targetId) conds.push(eq(log.targetId, query.targetId));
      if (query.from) conds.push(gte(at, new Date(query.from)));
      if (query.to) conds.push(lte(at, new Date(query.to)));
      if (query.after) {
        conds.push(sql`(${at}, ${id}) < (${Date.parse(query.after.at)}, ${query.after.id})`);
      }
      const limit = query.limit ?? 100;
      const rows = entryId
        ? await db
            .select(getTableColumns(log))
            .from(about)
            .innerJoin(log, eq(log.id, about.auditId))
            .where(and(...conds))
            .orderBy(desc(at), desc(id))
            .limit(limit)
        : await db
            .select()
            .from(log)
            .where(and(...conds))
            .orderBy(desc(at), desc(id))
            .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        spaceId: r.spaceId,
        environmentId: r.environmentId ?? undefined,
        actor: r.actor,
        action: r.action,
        targetType: r.targetType ?? undefined,
        targetId: r.targetId ?? undefined,
        status: r.status,
        at: r.at.toISOString(),
        ...(r.detail ? { detail: r.detail } : {}),
      }));
    },
  };
}

function makeAiActionRepo(x: Exec): AIActionRepo {
  const db = x.db;
  const toAction = (r: typeof schema.aiActions.$inferSelect): AIActionDefinition => ({
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    promptTemplate: r.promptTemplate,
    variables: r.variables,
    targetField: r.targetField ?? undefined,
    tier: r.tier,
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, action) {
      await x.write(
        db.insert(schema.aiActions).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: action.id,
          name: action.name,
          description: action.description ?? null,
          promptTemplate: action.promptTemplate,
          variables: [...action.variables],
          targetField: action.targetField ?? null,
          tier: action.tier,
          createdAt: new Date(action.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.aiActions)
        .where(and(scopeFilter(schema.aiActions, scope), eq(schema.aiActions.id, id)));
      return row ? toAction(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.aiActions)
        .where(scopeFilter(schema.aiActions, scope))
        .orderBy(desc(schema.aiActions.createdAt));
      return rows.map(toAction);
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.aiActions)
          .where(and(scopeFilter(schema.aiActions, scope), eq(schema.aiActions.id, id))),
      );
    },
  };
}

function makeFunctionRepo(x: Exec): FunctionRepo {
  const db = x.db;
  const toFn = (r: typeof schema.functions.$inferSelect): FunctionDefinition => ({
    id: r.id,
    name: r.name,
    eventPattern: r.eventPattern,
    url: r.url,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, fn) {
      await x.write(
        db.insert(schema.functions).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: fn.id,
          name: fn.name,
          eventPattern: fn.eventPattern,
          url: fn.url,
          active: fn.active,
          createdAt: new Date(fn.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.functions)
        .where(and(scopeFilter(schema.functions, scope), eq(schema.functions.id, id)));
      return row ? toFn(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.functions)
        .where(scopeFilter(schema.functions, scope))
        .orderBy(desc(schema.functions.createdAt));
      return rows.map(toFn);
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.functions)
          .where(and(scopeFilter(schema.functions, scope), eq(schema.functions.id, id))),
      );
    },
  };
}

function makeAppExtensionRepo(x: Exec): AppExtensionRepo {
  const db = x.db;
  const toApp = (r: typeof schema.appExtensions.$inferSelect): AppExtension => ({
    id: r.id,
    name: r.name,
    target: r.target as AppExtension['target'],
    entryUrl: r.entryUrl,
    fieldTypes: r.fieldTypes ?? undefined,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, app) {
      await x.write(
        db.insert(schema.appExtensions).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: app.id,
          name: app.name,
          target: app.target,
          entryUrl: app.entryUrl,
          fieldTypes: app.fieldTypes ? [...app.fieldTypes] : null,
          active: app.active,
          createdAt: new Date(app.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.appExtensions)
        .where(and(scopeFilter(schema.appExtensions, scope), eq(schema.appExtensions.id, id)));
      return row ? toApp(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.appExtensions)
        .where(scopeFilter(schema.appExtensions, scope))
        .orderBy(desc(schema.appExtensions.createdAt));
      return rows.map(toApp);
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.appExtensions)
          .where(and(scopeFilter(schema.appExtensions, scope), eq(schema.appExtensions.id, id))),
      );
    },
  };
}

function makeRoleRepo(x: Exec): RoleRepo {
  const db = x.db;
  return {
    async save(role) {
      const values = {
        spaceId: role.spaceId,
        id: role.id,
        name: role.name,
        description: role.description,
        scopes: [...role.scopes],
        contentGrants: [...role.contentGrants],
        preset: role.preset ?? null,
        updatedAt: new Date(),
      };
      await x.write(
        db
          .insert(schema.roles)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.roles.spaceId, schema.roles.id],
            set: {
              name: values.name,
              description: values.description,
              scopes: values.scopes,
              contentGrants: values.contentGrants,
              preset: values.preset,
              updatedAt: values.updatedAt,
            },
          }),
      );
    },
    async get(spaceId, id) {
      const [row] = await db
        .select()
        .from(schema.roles)
        .where(and(eq(schema.roles.spaceId, spaceId), eq(schema.roles.id, id)));
      return row ? toRole(row) : null;
    },
    async list(spaceId) {
      const rows = await db.select().from(schema.roles).where(eq(schema.roles.spaceId, spaceId));
      return rows.map(toRole);
    },
    async delete(spaceId, id) {
      await x.write(
        db
          .delete(schema.roles)
          .where(and(eq(schema.roles.spaceId, spaceId), eq(schema.roles.id, id))),
      );
    },
  };
}

function makeAuthRepo(x: Exec): AuthRepo {
  const db = x.db;
  return {
    async createApiKey(key) {
      await x.write(
        db.insert(schema.apiKeys).values({
          id: key.id,
          spaceId: key.spaceId,
          kind: key.kind,
          name: key.name,
          hashedToken: key.hashedToken,
          scopes: [...key.scopes],
          revoked: key.revoked,
          roleId: key.roleId,
          expiresAt: key.expiresAt ? new Date(key.expiresAt) : null,
          issuance: key.issuance,
          subject: key.subject,
          clientId: key.clientId,
        }),
      );
    },
    async findByHash(hashedToken) {
      const [row] = await db
        .select()
        .from(schema.apiKeys)
        .where(and(eq(schema.apiKeys.hashedToken, hashedToken), eq(schema.apiKeys.revoked, false)));
      return row ? toApiKey(row) : null;
    },
    async list(spaceId) {
      const rows = await db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.spaceId, spaceId));
      return rows.map(toApiKey);
    },
    async revoke(id) {
      await x.write(
        db.update(schema.apiKeys).set({ revoked: true }).where(eq(schema.apiKeys.id, id)),
      );
    },
    async touchLastUsed(id, at) {
      await x.write(
        db.update(schema.apiKeys).set({ lastUsedAt: at }).where(eq(schema.apiKeys.id, id)),
      );
    },
    async setRole(id, roleId, scopes) {
      await x.write(
        db
          .update(schema.apiKeys)
          .set({ roleId: roleId ?? null, scopes: [...scopes] })
          .where(eq(schema.apiKeys.id, id)),
      );
    },
  };
}

type InviteRow = typeof schema.memberInvites.$inferSelect;
const toInvite = (r: InviteRow): MemberInvite => ({
  id: r.id,
  email: r.email,
  role: r.role,
  grants: r.grants,
  tokenHash: r.tokenHash,
  ...(r.emailTokenHash ? { emailTokenHash: r.emailTokenHash } : {}),
  status: r.status,
  expiresAt: r.expiresAt.toISOString(),
  version: r.version,
  invitedBy: { kind: r.invitedByKind, id: r.invitedById },
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  sentAt: r.sentAt.toISOString(),
  sendCount: r.sendCount,
  ...(r.emailedAt ? { emailedAt: r.emailedAt.toISOString() } : {}),
  ...(r.acceptedAt ? { acceptedAt: r.acceptedAt.toISOString() } : {}),
  ...(r.acceptedBy ? { acceptedBy: r.acceptedBy } : {}),
  ...(r.revokedAt ? { revokedAt: r.revokedAt.toISOString() } : {}),
  ...(r.revokedByKind && r.revokedById
    ? { revokedBy: { kind: r.revokedByKind, id: r.revokedById } }
    : {}),
});

const inviteValues = (i: MemberInvite) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  grants: [...i.grants],
  tokenHash: i.tokenHash,
  emailTokenHash: i.emailTokenHash ?? null,
  status: i.status,
  expiresAt: new Date(i.expiresAt),
  version: i.version,
  invitedByKind: i.invitedBy.kind,
  invitedById: i.invitedBy.id,
  createdAt: new Date(i.createdAt),
  updatedAt: new Date(i.updatedAt),
  sentAt: new Date(i.sentAt),
  sendCount: i.sendCount,
  emailedAt: i.emailedAt ? new Date(i.emailedAt) : null,
  acceptedAt: i.acceptedAt ? new Date(i.acceptedAt) : null,
  acceptedBy: i.acceptedBy ?? null,
  revokedAt: i.revokedAt ? new Date(i.revokedAt) : null,
  revokedByKind: i.revokedBy?.kind ?? null,
  revokedById: i.revokedBy?.id ?? null,
});

function makeInviteRepo(x: Exec): InviteRepo {
  const db = x.db;
  const t = schema.memberInvites;
  return {
    async create(invite) {
      await x.write(db.insert(t).values(inviteValues(invite)));
    },
    async get(id) {
      const [row] = await db.select().from(t).where(eq(t.id, id));
      return row ? toInvite(row) : null;
    },
    async findByTokenHash(tokenHash) {
      const [row] = await db
        .select()
        .from(t)
        .where(or(eq(t.tokenHash, tokenHash), eq(t.emailTokenHash, tokenHash)))
        .limit(1);
      return row ? toInvite(row) : null;
    },
    async list({ now, status, email, limit }) {
      const stored = status === undefined ? undefined : status === 'expired' ? 'pending' : status;
      const rows = await db
        .select()
        .from(t)
        .where(
          and(
            stored ? eq(t.status, stored) : undefined,
            status === 'pending' ? gt(t.expiresAt, now) : undefined,
            status === 'expired' ? lte(t.expiresAt, now) : undefined,
            email ? eq(t.email, email) : undefined,
          ),
        )
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(Math.min(Math.max(limit ?? 100, 1), 500));
      return rows.map(toInvite);
    },
    async replace(invite, expectedVersion) {
      const { id: _id, createdAt: _created, ...set } = inviteValues(invite);
      const update = db
        .update(t)
        .set(set)
        .where(and(eq(t.id, invite.id), eq(t.version, expectedVersion)));
      if (x.inUnit) {
        // Another change since the caller read it (a resend, a revoke, a second accept) leaves
        // the row at another version: the guard aborts the whole unit at commit.
        await x.write(update);
        x.expectChanged(1);
        return;
      }
      const changed = await update.returning({ id: t.id });
      if (changed.length !== 1) throw new TransactionConflictError();
    },
    async recordEmailToken(id, version, emailTokenHash, emailedAt) {
      directOnly(x, 'invites.recordEmailToken');
      const changed = await db
        .update(t)
        .set({ emailTokenHash, emailedAt: emailedAt ? new Date(emailedAt) : null })
        .where(and(eq(t.id, id), eq(t.version, version), eq(t.status, 'pending')))
        .returning({ id: t.id });
      return changed.length === 1;
    },
  };
}

function makeMemberRepo(x: Exec): MemberRepo {
  const db = x.db;
  const m = schema.spaceMembers;
  return {
    async save(member) {
      const values = {
        spaceId: member.spaceId,
        id: member.id,
        email: member.email,
        name: member.name ?? null,
        subject: member.subject ?? null,
        roleId: member.roleId,
        disabled: member.disabled,
        createdAt: new Date(member.createdAt),
        updatedAt: new Date(member.updatedAt),
      };
      await x.write(
        db
          .insert(m)
          .values(values)
          .onConflictDoUpdate({
            target: [m.spaceId, m.id],
            set: {
              email: values.email,
              name: values.name,
              subject: values.subject,
              roleId: values.roleId,
              disabled: values.disabled,
              updatedAt: values.updatedAt,
            },
          }),
      );
    },
    async get(spaceId, id) {
      const [row] = await db
        .select()
        .from(m)
        .where(and(eq(m.spaceId, spaceId), eq(m.id, id)));
      return row ? toMember(row) : null;
    },
    async getByEmail(spaceId, email) {
      const [row] = await db
        .select()
        .from(m)
        .where(and(eq(m.spaceId, spaceId), eq(m.email, email)));
      return row ? toMember(row) : null;
    },
    async list(spaceId) {
      const rows = await db
        .select()
        .from(m)
        .where(eq(m.spaceId, spaceId))
        .orderBy(asc(m.createdAt));
      return rows.map(toMember);
    },
    async delete(spaceId, id) {
      await x.write(db.delete(m).where(and(eq(m.spaceId, spaceId), eq(m.id, id))));
    },
  };
}

function makeDeploymentSettingsRepo(x: Exec): DeploymentSettingsRepo {
  const db = x.db;
  const t = schema.deploymentSettings;
  return {
    async get(key) {
      const [row] = await db.select().from(t).where(eq(t.key, key));
      return row ? { value: row.value, version: row.version } : null;
    },
    async put(key, value, expectedVersion) {
      directOnly(x, 'settings.put');
      if (expectedVersion === null) {
        const rows = await db
          .insert(t)
          .values({ key, value, version: 1, updatedAt: new Date() })
          .onConflictDoNothing()
          .returning({ key: t.key });
        return rows.length > 0;
      }
      const rows = await db
        .update(t)
        .set({ value, version: expectedVersion + 1, updatedAt: new Date() })
        .where(and(eq(t.key, key), eq(t.version, expectedVersion)))
        .returning({ key: t.key });
      return rows.length > 0;
    },
  };
}

function makeSchedulerJobRepo(x: Exec): SchedulerJobRepo {
  const db = x.db;
  const t = schema.schedulerJobs;
  const iso = (d: Date | null) => (d ? d.toISOString() : undefined);
  return {
    async record(runs) {
      // The merge happens in SQL, so the cron never reads before it writes: a success keeps the
      // last error, a failure keeps the last success, and an older run never moves a timestamp
      // back (`excluded.x > t.x` is NULL, so false, when the run didn't set x).
      const newer = (col: typeof t.lastRunAt | typeof t.lastSuccessAt | typeof t.lastErrorAt) =>
        sql`CASE WHEN excluded.${sql.identifier(col.name)} > coalesce(${col}, 0) THEN excluded.${sql.identifier(col.name)} ELSE ${col} END`;
      const errorWins = sql`excluded.${sql.identifier(t.lastErrorAt.name)} > coalesce(${t.lastErrorAt}, 0)`;
      await writeAll(
        x,
        insertChunks(t, runs, (chunk) =>
          db
            .insert(t)
            .values(
              chunk.map((r) => ({
                job: r.job,
                lastRunAt: new Date(r.at),
                lastSuccessAt: r.error === undefined ? new Date(r.at) : null,
                lastErrorAt: r.error === undefined ? null : new Date(r.at),
                lastError: r.error ?? null,
              })),
            )
            .onConflictDoUpdate({
              target: t.job,
              set: {
                lastRunAt: newer(t.lastRunAt),
                lastSuccessAt: newer(t.lastSuccessAt),
                lastErrorAt: newer(t.lastErrorAt),
                lastError: sql`CASE WHEN ${errorWins} THEN excluded.${sql.identifier(t.lastError.name)} ELSE ${t.lastError} END`,
              },
            }),
        ),
      );
    },
    async list() {
      const rows = await db.select().from(t).orderBy(asc(t.job));
      return rows.map((r) => ({
        job: r.job,
        lastRunAt: r.lastRunAt.toISOString(),
        ...(r.lastSuccessAt ? { lastSuccessAt: iso(r.lastSuccessAt) } : {}),
        ...(r.lastErrorAt ? { lastErrorAt: iso(r.lastErrorAt) } : {}),
        ...(r.lastError !== null ? { lastError: r.lastError } : {}),
      }));
    },
  };
}

function makePreviewTokenRepo(x: Exec): PreviewTokenRepo {
  const db = x.db;
  return {
    async create(record) {
      await x.write(
        db.insert(schema.previewTokens).values({
          id: record.id,
          spaceId: record.spaceId,
          environmentId: record.environmentId,
          entryId: record.entryId,
          hashedToken: record.hashedToken,
          expiresAt: record.expiresAt,
          revoked: record.revoked,
        }),
      );
    },
    async findByHash(hashedToken) {
      const [row] = await db
        .select()
        .from(schema.previewTokens)
        .where(
          and(
            eq(schema.previewTokens.hashedToken, hashedToken),
            eq(schema.previewTokens.revoked, false),
          ),
        );
      return row
        ? {
            id: row.id,
            spaceId: row.spaceId,
            environmentId: row.environmentId,
            entryId: row.entryId,
            hashedToken: row.hashedToken,
            expiresAt: row.expiresAt,
            revoked: row.revoked,
          }
        : null;
    },
    async revoke(id) {
      await x.write(
        db
          .update(schema.previewTokens)
          .set({ revoked: true })
          .where(eq(schema.previewTokens.id, id)),
      );
    },
  };
}

function makePluginRepo(x: Exec): PluginRepo {
  const db = x.db;
  const toPlugin = (r: typeof schema.plugins.$inferSelect): InstalledPlugin => ({
    id: r.id,
    spaceId: r.spaceId,
    manifest: r.manifest,
    checksum: r.checksum,
    bundleKey: r.bundleKey,
    approvedCapabilities: r.approvedCapabilities as InstalledPlugin['approvedCapabilities'],
    enabled: r.enabled,
    installedAt: r.installedAt.toISOString(),
    installedBy: r.installedBy ?? undefined,
  });
  const values = (p: InstalledPlugin) => ({
    spaceId: p.spaceId,
    id: p.id,
    manifest: p.manifest,
    checksum: p.checksum,
    bundleKey: p.bundleKey,
    approvedCapabilities: [...p.approvedCapabilities],
    enabled: p.enabled,
    installedBy: p.installedBy,
    installedAt: new Date(p.installedAt),
  });
  return {
    async create(plugin) {
      await x.write(db.insert(schema.plugins).values(values(plugin)));
    },
    async get(spaceId, id) {
      const [row] = await db
        .select()
        .from(schema.plugins)
        .where(and(eq(schema.plugins.spaceId, spaceId), eq(schema.plugins.id, id)));
      return row ? toPlugin(row) : null;
    },
    async list(spaceId) {
      const rows = await db
        .select()
        .from(schema.plugins)
        .where(eq(schema.plugins.spaceId, spaceId));
      return rows.map(toPlugin);
    },
    async save(plugin) {
      await x.write(
        db
          .insert(schema.plugins)
          .values(values(plugin))
          .onConflictDoUpdate({
            target: [schema.plugins.spaceId, schema.plugins.id],
            set: {
              manifest: plugin.manifest,
              checksum: plugin.checksum,
              bundleKey: plugin.bundleKey,
              approvedCapabilities: [...plugin.approvedCapabilities],
              enabled: plugin.enabled,
            },
          }),
      );
    },
    async delete(spaceId, id) {
      await x.write(
        db
          .delete(schema.plugins)
          .where(and(eq(schema.plugins.spaceId, spaceId), eq(schema.plugins.id, id))),
      );
    },
  };
}

/**
 * Plugin settings. `save` is a compare-and-set on `version` (an insert that finds a row, or an
 * update that finds a different version, writes nothing), so two operators editing at once
 * cannot silently lose a field each.
 */
function makePluginSettingsRepo(x: Exec): PluginSettingsRepo {
  const db = x.db;
  const t = schema.pluginSettings;
  const one = (spaceId: string, pluginId: string) =>
    and(eq(t.spaceId, spaceId), eq(t.pluginId, pluginId));
  return {
    async get(spaceId, pluginId) {
      const [row] = await db.select().from(t).where(one(spaceId, pluginId));
      if (!row) return null;
      return {
        spaceId: row.spaceId,
        pluginId: row.pluginId,
        values: row.config,
        secrets: row.secrets,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
        ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
      } satisfies PluginSettings;
    },
    async save(settings, expectedVersion) {
      directOnly(x, 'pluginSettings.save');
      const set = {
        config: { ...settings.values },
        secrets: { ...settings.secrets },
        version: settings.version,
        updatedAt: new Date(settings.updatedAt),
        updatedBy: settings.updatedBy ?? null,
      };
      try {
        if (expectedVersion === 0) {
          const rows = await db
            .insert(t)
            .values({ spaceId: settings.spaceId, pluginId: settings.pluginId, ...set })
            .onConflictDoNothing()
            .returning({ v: t.version });
          return rows.length > 0;
        }
        const rows = await db
          .update(t)
          .set(set)
          .where(and(one(settings.spaceId, settings.pluginId), eq(t.version, expectedVersion)))
          .returning({ v: t.version });
        return rows.length > 0;
      } catch (err) {
        throw mapD1Error(err);
      }
    },
    async delete(spaceId, pluginId) {
      await x.write(db.delete(t).where(one(spaceId, pluginId)));
    },
  };
}

/**
 * `kv:storage`. Every statement filters on (space, environment, plugin): the plugin id comes from
 * the host's installed-plugin record, never from the plugin, so no statement here can reach
 * another plugin's keys. Prefixes compare with `substr` rather than LIKE, so `%` and `_` in a
 * key are ordinary characters.
 */
function makePluginStorageRepo(x: Exec): PluginStorageRepo {
  const db = x.db;
  const t = schema.pluginKv;
  const own = (scope: Scope, pluginId: string) =>
    and(scopeFilter(t, scope), eq(t.pluginId, pluginId));
  return {
    async get(scope, pluginId, key) {
      const [row] = await db
        .select({ value: t.value })
        .from(t)
        .where(and(own(scope, pluginId), eq(t.key, key)));
      return row?.value ?? null;
    },
    async put(scope, pluginId, key, value, { maxKeys, at }) {
      directOnly(x, 'pluginStorage.put');
      const { spaceId, environmentId } = scope;
      // One statement: the cap check and the write cannot be split by a concurrent put. An
      // existing key always passes (an overwrite adds nothing); a new one only under the cap.
      const rows = await db.all<{ key: string }>(sql`
        INSERT INTO ${t} (space_id, environment_id, plugin_id, key, value, updated_at)
        SELECT ${spaceId}, ${environmentId}, ${pluginId}, ${key}, ${value}, ${at.getTime()}
        WHERE EXISTS (
            SELECT 1 FROM ${t} WHERE space_id = ${spaceId} AND environment_id = ${environmentId}
              AND plugin_id = ${pluginId} AND key = ${key}
          )
          OR (
            SELECT count(*) FROM ${t} WHERE space_id = ${spaceId}
              AND environment_id = ${environmentId} AND plugin_id = ${pluginId}
          ) < ${maxKeys}
        ON CONFLICT (space_id, environment_id, plugin_id, key)
          DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        RETURNING key
      `);
      return rows.length > 0;
    },
    async delete(scope, pluginId, key) {
      directOnly(x, 'pluginStorage.delete');
      const rows = await db
        .delete(t)
        .where(and(own(scope, pluginId), eq(t.key, key)))
        .returning({ key: t.key });
      return rows.length > 0;
    },
    async list(scope, pluginId, { prefix, after, limit }) {
      const rows = await db
        .select({ key: t.key })
        .from(t)
        .where(
          and(
            own(scope, pluginId),
            prefix ? sql`substr(${t.key}, 1, length(${prefix})) = ${prefix}` : undefined,
            after !== undefined ? gt(t.key, after) : undefined,
          ),
        )
        .orderBy(asc(t.key))
        .limit(limit);
      return rows.map((r) => r.key);
    },
    async deleteAll(spaceId, pluginId) {
      await x.write(db.delete(t).where(and(eq(t.spaceId, spaceId), eq(t.pluginId, pluginId))));
    },
  };
}

function makeOAuthClientRepo(x: Exec): OAuthClientRepo {
  const db = x.db;
  return {
    async create(client) {
      await x.write(
        db.insert(schema.oauthClients).values({
          id: client.id,
          clientName: client.clientName,
          redirectUris: [...client.redirectUris],
          grantTypes: [...client.grantTypes],
          scopes: [...client.scopes],
          tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
          hashedClientSecret: client.hashedClientSecret,
          clientUri: client.clientUri,
          logoUri: client.logoUri,
          softwareId: client.softwareId,
          createdAt: new Date(client.createdAt),
        }),
      );
    },
    async get(clientId) {
      const [row] = await db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.id, clientId));
      return row ? toOAuthClient(row) : null;
    },
    async list() {
      const rows = await db.select().from(schema.oauthClients);
      return rows.map(toOAuthClient);
    },
    async delete(clientId) {
      await x.write(db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, clientId)));
    },
  };
}

function makeOAuthGrantRepo(x: Exec): OAuthGrantRepo {
  const db = x.db;
  const values = (record: OAuthGrantRecord) => ({
    id: record.id,
    kind: record.kind,
    clientId: record.clientId,
    hashedCode: record.hashedCode,
    hashedUserCode: record.hashedUserCode,
    status: record.status,
    scopes: [...record.scopes],
    spaceId: record.spaceId,
    subject: record.subject,
    roleId: record.roleId,
    redirectUri: record.redirectUri,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
    resource: record.resource,
    parentId: record.parentId,
    issuedKeyIds: record.issuedKeyIds ? [...record.issuedKeyIds] : undefined,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  });

  return {
    async create(record) {
      await x.write(db.insert(schema.oauthGrants).values(values(record)));
    },
    async findByHash(kind, hashedCode) {
      const [row] = await db
        .select()
        .from(schema.oauthGrants)
        .where(
          and(eq(schema.oauthGrants.kind, kind), eq(schema.oauthGrants.hashedCode, hashedCode)),
        );
      return row ? toOAuthGrant(row) : null;
    },
    async findByUserCodeHash(hashedUserCode) {
      const [row] = await db
        .select()
        .from(schema.oauthGrants)
        .where(eq(schema.oauthGrants.hashedUserCode, hashedUserCode));
      return row ? toOAuthGrant(row) : null;
    },
    async save(record) {
      // Status transitions are the hot path; upsert keeps this one round-trip.
      await x.write(
        db
          .insert(schema.oauthGrants)
          .values(values(record))
          .onConflictDoUpdate({
            target: schema.oauthGrants.id,
            set: {
              status: record.status,
              scopes: [...record.scopes],
              spaceId: record.spaceId,
              subject: record.subject,
              roleId: record.roleId,
            },
          }),
      );
    },
    async listByParent(parentId) {
      const rows = await db
        .select()
        .from(schema.oauthGrants)
        .where(or(eq(schema.oauthGrants.parentId, parentId), eq(schema.oauthGrants.id, parentId)));
      return rows.map(toOAuthGrant);
    },
    async listByClientAndSubject(clientId, subject) {
      const rows = await db
        .select()
        .from(schema.oauthGrants)
        .where(
          and(eq(schema.oauthGrants.clientId, clientId), eq(schema.oauthGrants.subject, subject)),
        );
      return rows.map(toOAuthGrant);
    },
    async deleteExpiredBefore(before) {
      directOnly(x, 'oauthGrants.deleteExpiredBefore');
      const rows = await db
        .delete(schema.oauthGrants)
        .where(lt(schema.oauthGrants.expiresAt, before))
        .returning({ id: schema.oauthGrants.id });
      return rows.length;
    },
  };
}

type SpaceRow = typeof schema.spaces.$inferSelect;

/** One mapping, so `getConfig` and `list` cannot drift apart. */
function toSpaceConfig(row: SpaceRow): SpaceConfig {
  return {
    spaceId: row.id,
    name: row.name,
    defaultLocale: row.defaultLocale,
    locales: row.locales,
    ...(row.fallbacks ? { fallbacks: row.fallbacks } : {}),
    ...(row.localeSettings && Object.keys(row.localeSettings).length > 0
      ? { localeSettings: row.localeSettings }
      : {}),
    ...(row.workflowSeparateDuties ? { workflowSeparateDuties: true } : {}),
    ...(row.trashRetentionDays !== null ? { trashRetentionDays: row.trashRetentionDays } : {}),
  };
}

function makeSpaceRepo(x: Exec): SpaceRepo {
  const db = x.db;
  return {
    async getConfig(scope) {
      const [row] = await spaceConfigQuery(db, scope);
      if (!row) return null;
      return toSpaceConfig(row);
    },
    async list() {
      const rows = await db.select().from(schema.spaces).orderBy(asc(schema.spaces.createdAt));
      return rows.map(toSpaceConfig);
    },
    async create(config) {
      await x.write(
        db
          .insert(schema.spaces)
          .values({
            id: config.spaceId,
            name: config.name,
            defaultLocale: config.defaultLocale,
            locales: [...config.locales],
            fallbacks: config.fallbacks ?? null,
            localeSettings: config.localeSettings ? { ...config.localeSettings } : null,
            workflowSeparateDuties: config.workflowSeparateDuties ?? false,
            trashRetentionDays: config.trashRetentionDays ?? null,
          })
          .onConflictDoUpdate({
            target: schema.spaces.id,
            set: {
              name: config.name,
              defaultLocale: config.defaultLocale,
              locales: [...config.locales],
              fallbacks: config.fallbacks ?? null,
              // Kept unless the config names its own: re-creating a space keeps what was set.
              ...(config.localeSettings ? { localeSettings: { ...config.localeSettings } } : {}),
            },
          }),
      );
    },
    async getTrashSweepCursor(scope) {
      const e = schema.environments;
      const [row] = await db
        .select({ cursor: e.trashSweepCursor })
        .from(e)
        .where(and(eq(e.spaceId, scope.spaceId), eq(e.id, scope.environmentId)));
      return row?.cursor ?? null;
    },
    async setTrashSweepCursor(scope, cursor) {
      const e = schema.environments;
      await x.write(
        db
          .update(e)
          .set({ trashSweepCursor: cursor ? { trashedAt: cursor.trashedAt, id: cursor.id } : null })
          .where(and(eq(e.spaceId, scope.spaceId), eq(e.id, scope.environmentId))),
      );
    },
    async setTrashRetentionDays(spaceId, days) {
      await x.write(
        db
          .update(schema.spaces)
          .set({ trashRetentionDays: days })
          .where(eq(schema.spaces.id, spaceId)),
      );
    },
    async setLocaleSettings(spaceId, settings, expected) {
      const s = schema.spaces;
      // The column holds the JSON text this repo wrote, which a read parses and re-serializes to the
      // same text (key order kept), so comparing text is comparing what the caller read.
      const unchanged =
        expected && Object.keys(expected).length > 0
          ? eq(sql`${s.localeSettings}`, JSON.stringify(expected))
          : isNull(s.localeSettings);
      const cas = and(eq(s.id, spaceId), unchanged);
      const set = { localeSettings: Object.keys(settings).length > 0 ? { ...settings } : null };
      if (x.inUnit) {
        await x.write(db.update(s).set(set).where(cas));
        x.expectChanged(1);
        return;
      }
      const rows = await db.update(s).set(set).where(cas).returning({ id: s.id });
      if (rows.length !== 1) throw new TransactionConflictError();
    },
    async setWorkflowSeparateDuties(spaceId, value) {
      await x.write(
        db
          .update(schema.spaces)
          .set({ workflowSeparateDuties: value })
          .where(eq(schema.spaces.id, spaceId)),
      );
    },
    async createEnvironment(spaceId, environmentId, name) {
      const p = schema.environmentPurges;
      await writeAll(x, [
        // Not while a deleted environment of this id is still being purged: it would inherit
        // whatever rows are left (TransactionConflictError).
        db
          .insert(schema.guard)
          .select(
            sql`SELECT NOT EXISTS (SELECT 1 FROM ${p} WHERE ${p.spaceId} = ${spaceId} AND ${p.environmentId} = ${environmentId}) AS ok`,
          ),
        db
          .insert(schema.environments)
          .values({ id: environmentId, spaceId, name })
          .onConflictDoNothing(),
        db.delete(schema.guard),
      ]);
    },
    async listEnvironments(spaceId) {
      const rows = await db
        .select()
        .from(schema.environments)
        .where(eq(schema.environments.spaceId, spaceId))
        .orderBy(asc(schema.environments.createdAt));
      return rows.map((r) => ({ id: r.id, name: r.name }));
    },
    async setAlias(spaceId, alias, targetEnvironmentId, at) {
      const e = schema.environments;
      await writeAll(x, [
        // The target still exists when the alias lands: an environment deleted since the
        // use-case checked aborts the batch (TransactionConflictError) instead of being aliased.
        db
          .insert(schema.guard)
          .select(
            sql`SELECT EXISTS (SELECT 1 FROM ${e} WHERE ${e.spaceId} = ${spaceId} AND ${e.id} = ${targetEnvironmentId}) AS ok`,
          ),
        db
          .insert(schema.environmentAliases)
          .values({ spaceId, alias, targetEnvironmentId, updatedAt: new Date(at) })
          .onConflictDoUpdate({
            target: [schema.environmentAliases.spaceId, schema.environmentAliases.alias],
            set: { targetEnvironmentId, updatedAt: new Date(at) },
          }),
        db.delete(schema.guard),
      ]);
    },
    async resolveName(spaceId, name) {
      const a = schema.environmentAliases;
      const p = schema.environmentPurges;
      // One round trip: this runs on every request that names an environment.
      const [row] = await db.all<{ target: string | null; purging: number }>(sql`
        SELECT
          (SELECT ${a.targetEnvironmentId} FROM ${a} WHERE ${a.spaceId} = ${spaceId} AND ${a.alias} = ${name}) AS target,
          EXISTS (SELECT 1 FROM ${p} WHERE ${p.spaceId} = ${spaceId} AND ${p.environmentId} = ${name}) AS purging
      `);
      return { targetEnvironmentId: row?.target ?? null, purging: row?.purging === 1 };
    },
    async getAlias(spaceId, alias) {
      const [row] = await db
        .select()
        .from(schema.environmentAliases)
        .where(
          and(
            eq(schema.environmentAliases.spaceId, spaceId),
            eq(schema.environmentAliases.alias, alias),
          ),
        );
      return row
        ? {
            alias: row.alias,
            targetEnvironmentId: row.targetEnvironmentId,
            updatedAt: row.updatedAt.toISOString(),
          }
        : null;
    },
    async listAliases(spaceId) {
      const rows = await db
        .select()
        .from(schema.environmentAliases)
        .where(eq(schema.environmentAliases.spaceId, spaceId))
        .orderBy(asc(schema.environmentAliases.alias));
      return rows.map((r) => ({
        alias: r.alias,
        targetEnvironmentId: r.targetEnvironmentId,
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
    async deleteAlias(spaceId, alias) {
      await x.write(
        db
          .delete(schema.environmentAliases)
          .where(
            and(
              eq(schema.environmentAliases.spaceId, spaceId),
              eq(schema.environmentAliases.alias, alias),
            ),
          ),
      );
    },
    async deleteEnvironment(spaceId, environmentId, events, audit) {
      // One atomic batch: the registry row goes (the environment stops resolving), a purge marker
      // takes its place, and the events and audit row ride along. The rows themselves go in
      // bounded steps afterwards (purgeEnvironmentStep): D1 refuses one statement that modifies
      // hundreds of thousands of rows.
      const a = schema.environmentAliases;
      const at = new Date(audit.at);
      await writeAll(x, [
        // No alias points at it when the batch runs: one set since the use-case checked aborts
        // the whole deletion (TransactionConflictError) rather than leaving the alias dangling.
        db
          .insert(schema.guard)
          .select(
            sql`SELECT NOT EXISTS (SELECT 1 FROM ${a} WHERE ${a.spaceId} = ${spaceId} AND ${a.targetEnvironmentId} = ${environmentId}) AS ok`,
          ),
        db.delete(schema.guard),
        db
          .insert(schema.environmentPurges)
          .values({ spaceId, environmentId, requestedAt: at, nudgedAt: at })
          .onConflictDoNothing(),
        db
          .delete(schema.environments)
          .where(
            and(
              eq(schema.environments.spaceId, spaceId),
              eq(schema.environments.id, environmentId),
            ),
          ),
        ...insertChunks(schema.outbox, events, (chunk) =>
          db.insert(schema.outbox).values(
            chunk.map((event) => ({
              id: event.id,
              type: event.type,
              payload: event,
              occurredAt: new Date(event.occurredAt),
            })),
          ),
        ),
        db.insert(schema.auditLog).values({
          id: audit.id,
          spaceId: audit.spaceId,
          environmentId: audit.environmentId ?? null,
          actor: audit.actor,
          action: audit.action,
          targetType: audit.targetType ?? null,
          targetId: audit.targetId ?? null,
          status: audit.status,
          at: new Date(audit.at),
          detail: audit.detail ?? null,
        }),
      ]);
    },
    async purgeEnvironmentStep(spaceId, environmentId, rowsPerTable, at) {
      directOnly(x, 'spaces.purgeEnvironmentStep');
      const scope = { spaceId, environmentId };
      const p = schema.environmentPurges;
      // One bounded DELETE per table (by rowid, so each statement touches at most rowsPerTable
      // rows), plus the progress mark the stall sweep reads. One round trip. Every DELETE needs the
      // purge marker: a late or duplicate step, run after the purge finished and the id was used
      // again, must find nothing to do rather than empty the new environment.
      const marked = sql`EXISTS (SELECT 1 FROM ${p} WHERE ${p.spaceId} = ${spaceId} AND ${p.environmentId} = ${environmentId})`;
      const statements = [
        ...ENVIRONMENT_SCOPED_TABLES.map((table) =>
          db
            .delete(table)
            .where(
              sql`${marked} AND rowid IN (SELECT rowid FROM ${table} WHERE ${scopeFilter(table, scope)} LIMIT ${rowsPerTable})`,
            ),
        ),
        db
          .update(p)
          .set({ nudgedAt: at })
          .where(and(eq(p.spaceId, spaceId), eq(p.environmentId, environmentId))),
      ];
      let results: unknown[];
      try {
        results = await db.batch(statements as unknown as [Query, ...Query[]]);
      } catch (err) {
        throw mapD1Error(err);
      }
      // Every result but the last (the progress mark) is a table's delete.
      return results
        .slice(0, -1)
        .reduce<number>(
          (n, r) => n + ((r as { meta?: { changes?: number } }).meta?.changes ?? 0),
          0,
        );
    },
    async markEnvironmentPurgeProgress(spaceId, environmentId, at) {
      const p = schema.environmentPurges;
      await x.write(
        db
          .update(p)
          .set({ nudgedAt: at })
          .where(and(eq(p.spaceId, spaceId), eq(p.environmentId, environmentId))),
      );
    },
    async finishEnvironmentPurge(spaceId, environmentId) {
      const p = schema.environmentPurges;
      await x.write(
        db.delete(p).where(and(eq(p.spaceId, spaceId), eq(p.environmentId, environmentId))),
      );
    },
    async claimStalledPurges(staleBefore, at, limit) {
      directOnly(x, 'spaces.claimStalledPurges');
      const p = schema.environmentPurges;
      const rows = await db
        .update(p)
        .set({ nudgedAt: at })
        .where(
          sql`rowid IN (SELECT rowid FROM ${p} WHERE ${p.nudgedAt} < ${staleBefore.getTime()} LIMIT ${limit})`,
        )
        .returning({ spaceId: p.spaceId, environmentId: p.environmentId });
      return rows;
    },
  };
}

/**
 * Every table whose rows belong to one environment, cleared when it is deleted. Not the audit log:
 * it is a hash chain (and a record of what happened in the environment), so it stays.
 */
const ENVIRONMENT_SCOPED_TABLES = [
  schema.contentTypes,
  schema.entries,
  schema.entryUniqueValues,
  schema.entryVersions,
  schema.entryPublished,
  schema.assets,
  schema.assetPublished,
  schema.assetFolders,
  schema.assetVersions,
  schema.assetCollections,
  schema.assetCollectionItems,
  schema.assetShareLinks,
  schema.assetZipJobs,
  schema.assetUploads,
  schema.references,
  schema.agentRuns,
  schema.aiActions,
  schema.functions,
  schema.appExtensions,
  schema.releases,
  schema.releaseItems,
  schema.scheduledActions,
  schema.agentReviews,
  schema.agentSchedules,
  schema.comments,
  schema.tasks,
  schema.workflowDefinitions,
  schema.workflowVersions,
  schema.workflowRuns,
  schema.workflowNodeRuns,
  schema.workflowTimeline,
  schema.workflowTasks,
  schema.entryWorkflowState,
  schema.conceptSchemes,
  schema.concepts,
  schema.tags,
  schema.taxonomyUsage,
  schema.entryMetadata,
  schema.redirects,
  schema.redirectSets,
  schema.menus,
  schema.previewTokens,
  schema.bulkJobs,
  schema.bulkJobChunks,
  schema.versionArchiveQueue,
  schema.pluginKv,
  // Only the hooks scoped to it: a space-wide hook (NULL) never matches the environment filter.
  // Their delivery records are left to the retention sweep, as when a hook is deleted.
  schema.webhooks,
] as const;

type ReleaseRow = typeof schema.releases.$inferSelect;
const toRelease = (r: ReleaseRow): Release => ({
  id: r.id,
  title: r.title,
  description: r.description ?? undefined,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  publishedAt: r.publishedAt?.toISOString(),
});

type PromotionRow = typeof schema.environmentPromotions.$inferSelect;
const toPromotion = (r: PromotionRow): Promotion => ({
  id: r.id,
  spaceId: r.spaceId,
  source: r.sourceEnvironmentId,
  target: r.targetEnvironmentId,
  contentTypes: r.contentTypes,
  entries: r.entries,
  status: r.status,
  risk: r.risk,
  requestedBy: r.requestedBy,
  ...(r.decidedBy ? { decidedBy: r.decidedBy } : {}),
  ...(r.result ? { result: r.result } : {}),
  ...(r.error ? { error: r.error } : {}),
  createdAt: r.createdAt.toISOString(),
  ...(r.decidedAt ? { decidedAt: r.decidedAt.toISOString() } : {}),
  ...(r.completedAt ? { completedAt: r.completedAt.toISOString() } : {}),
});

function makePromotionRepo(x: Exec): PromotionRepo {
  const db = x.db;
  const p = schema.environmentPromotions;
  const byId = (spaceId: string, id: string) => and(eq(p.spaceId, spaceId), eq(p.id, id));
  return {
    async create(promotion) {
      await x.write(
        db.insert(p).values({
          spaceId: promotion.spaceId,
          id: promotion.id,
          sourceEnvironmentId: promotion.source,
          targetEnvironmentId: promotion.target,
          contentTypes: [...promotion.contentTypes],
          entries: [...promotion.entries],
          status: promotion.status,
          risk: promotion.risk,
          requestedBy: promotion.requestedBy,
          decidedBy: promotion.decidedBy ?? null,
          result: promotion.result ?? null,
          error: promotion.error ?? null,
          createdAt: new Date(promotion.createdAt),
          decidedAt: promotion.decidedAt ? new Date(promotion.decidedAt) : null,
          completedAt: promotion.completedAt ? new Date(promotion.completedAt) : null,
        }),
      );
    },
    async get(spaceId, id) {
      const [row] = await db.select().from(p).where(byId(spaceId, id));
      return row ? toPromotion(row) : null;
    },
    async list(spaceId, opts = {}) {
      const rows = await db
        .select()
        .from(p)
        .where(and(eq(p.spaceId, spaceId), opts.status ? eq(p.status, opts.status) : undefined))
        .orderBy(desc(p.createdAt))
        .limit(Math.min(opts.limit ?? 50, 200));
      return rows.map(toPromotion);
    },
    async transition(spaceId, id, from, patch) {
      directOnly(x, 'promotions.transition');
      const [row] = await db
        .update(p)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.decidedBy !== undefined ? { decidedBy: patch.decidedBy } : {}),
          ...(patch.decidedAt ? { decidedAt: new Date(patch.decidedAt) } : {}),
          ...(patch.result ? { result: patch.result } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.completedAt ? { completedAt: new Date(patch.completedAt) } : {}),
        })
        .where(and(byId(spaceId, id), eq(p.status, from)))
        .returning();
      return row ? toPromotion(row) : null;
    },
  };
}

function makeReleaseRepo(x: Exec): ReleaseRepo {
  const db = x.db;
  return {
    async create(scope, release) {
      await x.write(
        db.insert(schema.releases).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: release.id,
          title: release.title,
          description: release.description ?? null,
          status: release.status,
          createdAt: new Date(release.createdAt),
          publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.releases)
        .where(and(scopeFilter(schema.releases, scope), eq(schema.releases.id, id)));
      return row ? toRelease(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.releases)
        .where(scopeFilter(schema.releases, scope))
        .orderBy(desc(schema.releases.createdAt));
      return rows.map(toRelease);
    },
    async save(scope, release) {
      await x.write(
        db
          .update(schema.releases)
          .set({
            title: release.title,
            description: release.description ?? null,
            status: release.status,
            publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
          })
          .where(and(scopeFilter(schema.releases, scope), eq(schema.releases.id, release.id))),
      );
    },
    async delete(scope, id) {
      await writeAll(x, [
        db
          .delete(schema.releaseItems)
          .where(
            and(scopeFilter(schema.releaseItems, scope), eq(schema.releaseItems.releaseId, id)),
          ),
        db
          .delete(schema.releases)
          .where(and(scopeFilter(schema.releases, scope), eq(schema.releases.id, id))),
      ]);
    },
    async addItem(scope, releaseId, item) {
      await x.write(
        db
          .insert(schema.releaseItems)
          .values({
            spaceId: scope.spaceId,
            environmentId: scope.environmentId,
            releaseId,
            entityType: item.entityType,
            entityId: item.entityId,
            action: item.action,
          })
          .onConflictDoUpdate({
            target: [
              schema.releaseItems.spaceId,
              schema.releaseItems.environmentId,
              schema.releaseItems.releaseId,
              schema.releaseItems.entityId,
            ],
            set: { action: item.action, entityType: item.entityType },
          }),
      );
    },
    async removeItem(scope, releaseId, entityId) {
      await x.write(
        db
          .delete(schema.releaseItems)
          .where(
            and(
              scopeFilter(schema.releaseItems, scope),
              eq(schema.releaseItems.releaseId, releaseId),
              eq(schema.releaseItems.entityId, entityId),
            ),
          ),
      );
    },
    async listItems(scope, releaseId) {
      const rows = await db
        .select()
        .from(schema.releaseItems)
        .where(
          and(
            scopeFilter(schema.releaseItems, scope),
            eq(schema.releaseItems.releaseId, releaseId),
          ),
        );
      return rows.map((r) => ({
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
      }));
    },
    async countItems(scope, releaseIds) {
      const ri = schema.releaseItems;
      const rows = await selectChunked(
        [...new Set(releaseIds)],
        (chunk) =>
          db
            .select({ releaseId: ri.releaseId, n: count() })
            .from(ri)
            .where(and(scopeFilter(ri, scope), inArray(ri.releaseId, chunk)))
            .groupBy(ri.releaseId),
        1,
        RESERVED,
      );
      return new Map(rows.map((r) => [r.releaseId, r.n]));
    },
  };
}

type ScheduledRow = typeof schema.scheduledActions.$inferSelect;
const toScheduled = (r: ScheduledRow): ScheduledAction => ({
  id: r.id,
  action: r.action,
  entityType: r.entityType,
  entityId: r.entityId,
  scheduledFor: r.scheduledFor.toISOString(),
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  executedAt: r.executedAt?.toISOString(),
  error: r.error ?? undefined,
});

function makeAgentReviewRepo(x: Exec): AgentReviewRepo {
  const db = x.db;
  type Row = typeof schema.agentReviews.$inferSelect;
  const toReview = (r: Row): AgentReview => ({
    id: r.id,
    workflow: r.workflow,
    entryId: r.entryId,
    proposed: r.proposed,
    notes: r.notes,
    status: r.status,
    awaiting: r.awaiting,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString(),
    decidedBy: r.decidedBy ?? undefined,
    appliedAt: r.appliedAt?.toISOString(),
  });
  return {
    async create(scope, review) {
      await x.write(
        db.insert(schema.agentReviews).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: review.id,
          workflow: review.workflow,
          entryId: review.entryId,
          proposed: review.proposed,
          notes: [...review.notes],
          status: review.status,
          awaiting: review.awaiting,
          createdAt: new Date(review.createdAt),
          decidedAt: review.decidedAt ? new Date(review.decidedAt) : null,
          decidedBy: review.decidedBy ?? null,
          appliedAt: review.appliedAt ? new Date(review.appliedAt) : null,
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.agentReviews)
        .where(and(scopeFilter(schema.agentReviews, scope), eq(schema.agentReviews.id, id)));
      return row ? toReview(row) : null;
    },
    async list(scope, query) {
      const conditions = [scopeFilter(schema.agentReviews, scope)];
      if (query?.status) conditions.push(eq(schema.agentReviews.status, query.status));
      if (query?.entryId) conditions.push(eq(schema.agentReviews.entryId, query.entryId));
      const rows = await db
        .select()
        .from(schema.agentReviews)
        .where(and(...conditions))
        .orderBy(desc(schema.agentReviews.createdAt), asc(schema.agentReviews.id))
        .limit(Math.min(query?.limit ?? 100, 1000));
      return rows.map(toReview);
    },
    async countPending(scope) {
      // One grouped read on agent_reviews_pending, joined to each review's entry for its type
      // (null when the entry is gone), so the count needs no per-review lookup.
      const r = schema.agentReviews;
      const e = schema.entries;
      return db
        .select({ contentTypeApiId: e.contentTypeApiId, count: count() })
        .from(r)
        .leftJoin(
          e,
          and(eq(e.spaceId, r.spaceId), eq(e.environmentId, r.environmentId), eq(e.id, r.entryId)),
        )
        .where(and(scopeFilter(r, scope), eq(r.status, 'pending')))
        .groupBy(e.contentTypeApiId);
    },
    async decide(scope, id, decision) {
      directOnly(x, 'agentReviews.decide');
      const updated = await db
        .update(schema.agentReviews)
        .set({
          status: decision.status,
          decidedAt: new Date(decision.decidedAt),
          decidedBy: decision.decidedBy ?? null,
        })
        .where(
          and(
            scopeFilter(schema.agentReviews, scope),
            eq(schema.agentReviews.id, id),
            eq(schema.agentReviews.status, 'pending'),
          ),
        )
        .returning({ id: schema.agentReviews.id });
      return updated.length > 0;
    },
    async markAwaiting(scope, id) {
      directOnly(x, 'agentReviews.markAwaiting');
      const armed = await db
        .update(schema.agentReviews)
        .set({ awaiting: true })
        .where(
          and(
            scopeFilter(schema.agentReviews, scope),
            eq(schema.agentReviews.id, id),
            eq(schema.agentReviews.status, 'pending'),
            eq(schema.agentReviews.awaiting, false),
          ),
        )
        .returning({ id: schema.agentReviews.id });
      if (armed.length > 0) return 'armed';
      const [row] = await db
        .select({ status: schema.agentReviews.status })
        .from(schema.agentReviews)
        .where(and(scopeFilter(schema.agentReviews, scope), eq(schema.agentReviews.id, id)));
      return row?.status ?? 'pending';
    },
    async clearAwaiting(scope, id) {
      await x.write(
        db
          .update(schema.agentReviews)
          .set({ awaiting: false })
          .where(and(scopeFilter(schema.agentReviews, scope), eq(schema.agentReviews.id, id))),
      );
    },
    async markApplied(scope, id, at) {
      directOnly(x, 'agentReviews.markApplied');
      const won = await db
        .update(schema.agentReviews)
        .set({ appliedAt: new Date(at) })
        .where(
          and(
            scopeFilter(schema.agentReviews, scope),
            eq(schema.agentReviews.id, id),
            isNull(schema.agentReviews.appliedAt),
          ),
        )
        .returning({ id: schema.agentReviews.id });
      return won.length > 0;
    },
    async clearApplied(scope, id) {
      await x.write(
        db
          .update(schema.agentReviews)
          .set({ appliedAt: null })
          .where(and(scopeFilter(schema.agentReviews, scope), eq(schema.agentReviews.id, id))),
      );
    },
  };
}

function makeAgentScheduleRepo(x: Exec): AgentScheduleRepo {
  const db = x.db;
  type Row = typeof schema.agentSchedules.$inferSelect;
  const toSchedule = (r: Row): AgentSchedule => ({
    id: r.id,
    workflow: r.workflow,
    contentTypeApiId: r.contentTypeApiId ?? undefined,
    cron: r.cron,
    enabled: r.enabled,
    autoApply: r.autoApply,
    lastRunAt: r.lastRunAt?.toISOString(),
    cursorEntryId: r.cursorEntryId ?? undefined,
    nextRunAt: r.nextRunAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, s) {
      await x.write(
        db.insert(schema.agentSchedules).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: s.id,
          workflow: s.workflow,
          contentTypeApiId: s.contentTypeApiId ?? null,
          cron: s.cron,
          enabled: s.enabled,
          autoApply: s.autoApply,
          lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
          cursorEntryId: s.cursorEntryId ?? null,
          nextRunAt: new Date(s.nextRunAt),
          createdAt: new Date(s.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.agentSchedules)
        .where(and(scopeFilter(schema.agentSchedules, scope), eq(schema.agentSchedules.id, id)));
      return row ? toSchedule(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.agentSchedules)
        .where(scopeFilter(schema.agentSchedules, scope))
        .orderBy(asc(schema.agentSchedules.createdAt), asc(schema.agentSchedules.id));
      return rows.map(toSchedule);
    },
    async save(scope, s) {
      await x.write(
        db
          .update(schema.agentSchedules)
          .set({
            workflow: s.workflow,
            contentTypeApiId: s.contentTypeApiId ?? null,
            cron: s.cron,
            enabled: s.enabled,
            autoApply: s.autoApply,
            lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
            cursorEntryId: s.cursorEntryId ?? null,
            nextRunAt: new Date(s.nextRunAt),
          })
          .where(
            and(scopeFilter(schema.agentSchedules, scope), eq(schema.agentSchedules.id, s.id)),
          ),
      );
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.agentSchedules)
          .where(and(scopeFilter(schema.agentSchedules, scope), eq(schema.agentSchedules.id, id))),
      );
    },
    async claimNextRun(scope, id, expectedNextRunAt, nextRunAt) {
      directOnly(x, 'agentSchedules.claimNextRun');
      const claimed = await db
        .update(schema.agentSchedules)
        .set({ nextRunAt: new Date(nextRunAt) })
        .where(
          and(
            scopeFilter(schema.agentSchedules, scope),
            eq(schema.agentSchedules.id, id),
            eq(schema.agentSchedules.nextRunAt, new Date(expectedNextRunAt)),
          ),
        )
        .returning({ id: schema.agentSchedules.id });
      return claimed.length > 0;
    },
    async saveRunState(scope, id, state) {
      await x.write(
        db
          .update(schema.agentSchedules)
          .set({
            lastRunAt: new Date(state.lastRunAt),
            cursorEntryId: state.cursorEntryId ?? null,
          })
          .where(and(scopeFilter(schema.agentSchedules, scope), eq(schema.agentSchedules.id, id))),
      );
    },
    async findDue(now, limit = 100): Promise<ScopedAgentSchedule[]> {
      const rows = await db
        .select()
        .from(schema.agentSchedules)
        .where(
          and(
            eq(schema.agentSchedules.enabled, true),
            lte(schema.agentSchedules.nextRunAt, new Date(now)),
            // Only in an environment that still exists: a deleted one's rows linger until purged.
            registered(schema.agentSchedules),
          ),
        )
        .orderBy(asc(schema.agentSchedules.nextRunAt))
        .limit(limit);
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        schedule: toSchedule(r),
      }));
    },
  };
}

function makeScheduledActionRepo(x: Exec): ScheduledActionRepo {
  const db = x.db;
  const rowValues = (scope: Scope, a: ScheduledAction) => ({
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    id: a.id,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    scheduledFor: new Date(a.scheduledFor),
    status: a.status,
    createdAt: new Date(a.createdAt),
    executedAt: a.executedAt ? new Date(a.executedAt) : null,
    error: a.error ?? null,
  });
  return {
    async create(scope, action) {
      await x.write(db.insert(schema.scheduledActions).values(rowValues(scope, action)));
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.scheduledActions)
        .where(
          and(scopeFilter(schema.scheduledActions, scope), eq(schema.scheduledActions.id, id)),
        );
      return row ? toScheduled(row) : null;
    },
    async list(scope, query) {
      const conditions = [scopeFilter(schema.scheduledActions, scope)];
      if (query?.status)
        conditions.push(eq(schema.scheduledActions.status, query.status as ScheduledRow['status']));
      const rows = await db
        .select()
        .from(schema.scheduledActions)
        .where(and(...conditions))
        .orderBy(asc(schema.scheduledActions.scheduledFor));
      return rows.map(toScheduled);
    },
    async save(scope, action) {
      await x.write(
        db
          .update(schema.scheduledActions)
          .set({
            status: action.status,
            executedAt: action.executedAt ? new Date(action.executedAt) : null,
            error: action.error ?? null,
          })
          .where(
            and(
              scopeFilter(schema.scheduledActions, scope),
              eq(schema.scheduledActions.id, action.id),
            ),
          ),
      );
    },
    async findDue(now, limit = 100): Promise<ScopedScheduledAction[]> {
      const rows = await db
        .select()
        .from(schema.scheduledActions)
        .where(
          and(
            eq(schema.scheduledActions.status, 'pending'),
            lte(schema.scheduledActions.scheduledFor, new Date(now)),
            // Only in an environment that still exists: a deleted one's rows linger until purged.
            registered(schema.scheduledActions),
          ),
        )
        .orderBy(asc(schema.scheduledActions.scheduledFor))
        .limit(limit);
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        action: toScheduled(r),
      }));
    },
  };
}

function makeCommentRepo(x: Exec): CommentRepo {
  const db = x.db;
  const toComment = (r: typeof schema.comments.$inferSelect): Comment => ({
    id: r.id,
    entryId: r.entryId,
    parentId: r.parentId,
    author: r.author,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, comment) {
      await x.write(
        db.insert(schema.comments).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: comment.id,
          entryId: comment.entryId,
          parentId: comment.parentId,
          author: comment.author,
          body: comment.body,
          createdAt: new Date(comment.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.comments)
        .where(and(scopeFilter(schema.comments, scope), eq(schema.comments.id, id)));
      return row ? toComment(row) : null;
    },
    async listForEntry(scope, entryId) {
      const rows = await db
        .select()
        .from(schema.comments)
        .where(and(scopeFilter(schema.comments, scope), eq(schema.comments.entryId, entryId)))
        .orderBy(asc(schema.comments.createdAt));
      return rows.map(toComment);
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.comments)
          .where(and(scopeFilter(schema.comments, scope), eq(schema.comments.id, id))),
      );
    },
  };
}

function makeTaskRepo(x: Exec): TaskRepo {
  const db = x.db;
  const toTask = (r: typeof schema.tasks.$inferSelect): Task => ({
    id: r.id,
    entryId: r.entryId,
    assignee: r.assignee,
    body: r.body,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString(),
  });
  const values = (scope: Scope, t: Task) => ({
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    id: t.id,
    entryId: t.entryId,
    assignee: t.assignee,
    body: t.body,
    status: t.status,
    createdAt: new Date(t.createdAt),
    resolvedAt: t.resolvedAt ? new Date(t.resolvedAt) : null,
  });
  return {
    async create(scope, task) {
      await x.write(db.insert(schema.tasks).values(values(scope, task)));
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.tasks)
        .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.id, id)));
      return row ? toTask(row) : null;
    },
    async listForEntry(scope, entryId) {
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.entryId, entryId)))
        .orderBy(asc(schema.tasks.createdAt));
      return rows.map(toTask);
    },
    async save(scope, task) {
      await x.write(
        db
          .update(schema.tasks)
          .set({
            assignee: task.assignee,
            body: task.body,
            status: task.status,
            resolvedAt: task.resolvedAt ? new Date(task.resolvedAt) : null,
          })
          .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.id, task.id))),
      );
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.tasks)
          .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.id, id))),
      );
    },
  };
}

function makeWorkflowRepo(x: Exec): WorkflowRepo {
  const db = x.db;
  const toDef = (r: typeof schema.workflowDefinitions.$inferSelect): WorkflowDefinition => ({
    id: r.id,
    name: r.name,
    steps: r.steps as WorkflowStep[],
  });
  return {
    async saveDefinition(scope, def) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: def.id,
        name: def.name,
        steps: [...def.steps],
      };
      await x.write(
        db
          .insert(schema.workflowDefinitions)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.workflowDefinitions.spaceId,
              schema.workflowDefinitions.environmentId,
              schema.workflowDefinitions.id,
            ],
            set: { name: values.name, steps: values.steps },
          }),
      );
    },
    async getDefinition(scope, id) {
      const [row] = await db
        .select()
        .from(schema.workflowDefinitions)
        .where(
          and(
            scopeFilter(schema.workflowDefinitions, scope),
            eq(schema.workflowDefinitions.id, id),
          ),
        );
      return row ? toDef(row) : null;
    },
    async listDefinitions(scope) {
      const rows = await db
        .select()
        .from(schema.workflowDefinitions)
        .where(scopeFilter(schema.workflowDefinitions, scope));
      return rows.map(toDef);
    },
    async deleteDefinition(scope, id) {
      await x.write(
        db
          .delete(schema.workflowDefinitions)
          .where(
            and(
              scopeFilter(schema.workflowDefinitions, scope),
              eq(schema.workflowDefinitions.id, id),
            ),
          ),
      );
    },
    async getState(scope, entryId) {
      const [row] = await db
        .select()
        .from(schema.entryWorkflowState)
        .where(
          and(
            scopeFilter(schema.entryWorkflowState, scope),
            eq(schema.entryWorkflowState.entryId, entryId),
          ),
        );
      return row
        ? { entryId: row.entryId, workflowId: row.workflowId, currentStepId: row.currentStepId }
        : null;
    },
    async saveState(scope, state) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        entryId: state.entryId,
        workflowId: state.workflowId,
        currentStepId: state.currentStepId,
      };
      await x.write(
        db
          .insert(schema.entryWorkflowState)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.entryWorkflowState.spaceId,
              schema.entryWorkflowState.environmentId,
              schema.entryWorkflowState.entryId,
            ],
            set: { workflowId: values.workflowId, currentStepId: values.currentStepId },
          }),
      );
    },
  };
}

/** Attempts at the next-version insert before a concurrent-publish race is surfaced. */
const PUBLISH_VERSION_ATTEMPTS = 5;

function makeWorkflowGraphRepo(x: Exec): WorkflowGraphRepo {
  const db = x.db;
  const d = schema.workflowDefinitions;
  const v = schema.workflowVersions;
  const toRecord = (
    r: typeof d.$inferSelect,
    latestVersion: number | null,
  ): WorkflowGraphRecord => ({
    id: r.id,
    name: r.name,
    description: r.description,
    contentTypes: r.contentTypes,
    graph: r.graph ?? null,
    gatesPublish: r.gatesPublish,
    steps: r.steps as WorkflowStep[],
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    latestVersion,
  });
  const toVersion = (r: typeof v.$inferSelect): WorkflowVersion => ({
    ...r.definition,
    id: r.workflowId,
    version: r.version,
    publishedAt: r.publishedAt.toISOString(),
    ...(r.publishedBy ? { publishedBy: r.publishedBy } : {}),
  });
  const versionFilter = (scope: Scope, workflowId: string) =>
    and(scopeFilter(v, scope), eq(v.workflowId, workflowId));
  // One grouped query for every listed workflow's latest version (no N+1).
  const latestByWorkflow = async (scope: Scope, ids: readonly string[]) => {
    if (ids.length === 0) return new Map<string, number>();
    const rows = await selectChunked(
      ids,
      (chunk) =>
        db
          .select({
            workflowId: v.workflowId,
            latest: sql<number>`max(${v.version})`.mapWith(Number),
          })
          .from(v)
          .where(and(scopeFilter(v, scope), inArray(v.workflowId, chunk)))
          .groupBy(v.workflowId),
      1,
      RESERVED,
    );
    return new Map(rows.map((r) => [r.workflowId, r.latest]));
  };

  return {
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(d)
        .where(and(scopeFilter(d, scope), eq(d.id, id)));
      if (!row) return null;
      const latest = await latestByWorkflow(scope, [id]);
      return toRecord(row, latest.get(id) ?? null);
    },
    async list(scope) {
      const rows = await db.select().from(d).where(scopeFilter(d, scope));
      const latest = await latestByWorkflow(
        scope,
        rows.map((r) => r.id),
      );
      return rows.map((r) => toRecord(r, latest.get(r.id) ?? null));
    },
    async saveDraft(scope, draft) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: draft.id,
        name: draft.name,
        steps: draft.steps.map((s) => ({ ...s })),
        description: draft.description,
        contentTypes: [...draft.contentTypes],
        graph: draft.graph,
        gatesPublish: draft.gatesPublish ?? false,
        updatedAt: new Date(draft.updatedAt),
      };
      await x.write(
        db
          .insert(d)
          .values(values)
          .onConflictDoUpdate({
            target: [d.spaceId, d.environmentId, d.id],
            set: {
              name: values.name,
              steps: values.steps,
              description: values.description,
              contentTypes: values.contentTypes,
              graph: values.graph,
              gatesPublish: values.gatesPublish,
              updatedAt: values.updatedAt,
            },
          }),
      );
    },
    async publishVersion(scope, definition, meta) {
      directOnly(x, 'workflowGraphs.publishVersion');
      const stored: WorkflowGraphDefinition = {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        contentTypes: [...definition.contentTypes],
        graph: definition.graph,
        ...(definition.gatesPublish !== undefined ? { gatesPublish: definition.gatesPublish } : {}),
      };
      // The atomic next-version insert: the number is
      // computed inside the INSERT, so it never reads a stale max. Two concurrent publishes can
      // still compute the same number (in practice D1 serializes writes); the PK rejects the loser and
      // it retries.
      for (let attempt = 1; ; attempt++) {
        try {
          const [row] = await db
            .insert(v)
            .values({
              spaceId: scope.spaceId,
              environmentId: scope.environmentId,
              workflowId: definition.id,
              version: sql`(select coalesce(max(${v.version}), 0) + 1 from ${v} where ${versionFilter(scope, definition.id)})`,
              definition: stored,
              publishedAt: new Date(meta.publishedAt),
              publishedBy: meta.publishedBy ?? null,
            })
            .returning();
          if (!row) throw new Error('workflow_versions insert returned no row');
          return toVersion(row);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          if (attempt >= PUBLISH_VERSION_ATTEMPTS) {
            throw new ConflictError('Another publish of this workflow won the race; retry', {
              workflowId: definition.id,
            });
          }
        }
      }
    },
    async listVersions(scope, workflowId) {
      const rows = await db
        .select()
        .from(v)
        .where(versionFilter(scope, workflowId))
        .orderBy(desc(v.version));
      return rows.map(toVersion);
    },
    async getVersion(scope, workflowId, version) {
      const [row] = await db
        .select()
        .from(v)
        .where(and(versionFilter(scope, workflowId), eq(v.version, version)));
      return row ? toVersion(row) : null;
    },
    async listPublishGates(scope) {
      // One grouped query: SQLite takes the bare columns of a `max()` aggregate from the row
      // holding the max, so each workflow's gating, content types and nodes come from its
      // latest version (the nodes only to tell whether a run can publish; edges stay behind).
      // The join drops a deleted workflow, which no admin could otherwise ungate.
      const rows = await db
        .select({
          workflowId: v.workflowId,
          version: sql<number>`max(${v.version})`.mapWith(Number),
          name: d.name,
          gatesPublish: sql<number | null>`json_extract(${v.definition}, '$.gatesPublish')`,
          contentTypes: sql<string | null>`json_extract(${v.definition}, '$.contentTypes')`,
          nodes: sql<string | null>`json_extract(${v.definition}, '$.graph.nodes')`,
        })
        .from(v)
        .innerJoin(
          d,
          and(
            eq(d.spaceId, v.spaceId),
            eq(d.environmentId, v.environmentId),
            eq(d.id, v.workflowId),
          ),
        )
        .where(scopeFilter(v, scope))
        .groupBy(v.workflowId);
      return rows
        .filter((r) =>
          versionGatesPublish({
            gatesPublish: Number(r.gatesPublish) === 1,
            graph: { nodes: r.nodes ? (JSON.parse(r.nodes) as { type: string }[]) : [] },
          }),
        )
        .map((r) => ({
          workflowId: r.workflowId,
          name: r.name,
          version: r.version,
          contentTypes: r.contentTypes ? (JSON.parse(r.contentTypes) as string[]) : [],
        }));
    },
    async getLatestVersion(scope, workflowId) {
      const [row] = await db
        .select()
        .from(v)
        .where(versionFilter(scope, workflowId))
        .orderBy(desc(v.version))
        .limit(1);
      return row ? toVersion(row) : null;
    },
    async listLatestVersions(scope, workflowIds) {
      // Each workflow's highest version, picked inside the query: only the latest definitions
      // (graphs can be large) cross the wire, not every workflow's whole history.
      const lv = alias(v, 'lv');
      const rows = await selectChunked(
        [...new Set(workflowIds)],
        (chunk) =>
          db
            .select()
            .from(v)
            .where(
              and(
                scopeFilter(v, scope),
                inArray(v.workflowId, chunk),
                eq(
                  v.version,
                  db
                    .select({ latest: sql`max(${lv.version})` })
                    .from(lv)
                    .where(
                      and(
                        eq(lv.spaceId, v.spaceId),
                        eq(lv.environmentId, v.environmentId),
                        eq(lv.workflowId, v.workflowId),
                      ),
                    ),
                ),
              ),
            ),
        1,
        RESERVED,
      );
      return rows.map(toVersion);
    },
  };
}

const ms = (d: Date) => d.getTime();
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function makeWorkflowRunRepo(x: Exec): WorkflowRunRepo {
  const db = x.db;
  const r = schema.workflowRuns;
  const nr = schema.workflowNodeRuns;
  const tl = schema.workflowTimeline;
  const toRun = (row: typeof r.$inferSelect): WorkflowRun => ({
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    generation: row.generation,
    entryId: row.entryId,
    contentTypeApiId: row.contentTypeApiId,
    status: row.status as WorkflowRunStatus,
    reason: row.reason,
    plan: row.plan,
    nodes: row.nodes,
    vars: row.vars,
    input: row.input,
    seq: row.seq,
    waitingOn: row.waitingOn,
    waitingAt: row.waitingAt,
    waitingSince: iso(row.waitingSince),
    waitingDue: iso(row.waitingDue),
    waitingFor: row.waitingFor,
    stoppedAt: row.stoppedAt,
    earlyEvents: row.earlyEvents ?? [],
    startedBy: row.startedBy,
    triggerEventId: row.triggerEventId,
    instanceId: row.instanceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    logSeq: row.logSeq,
    rev: row.rev,
  });
  const toRow = (scope: Scope, run: WorkflowRun) => ({
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    id: run.id,
    workflowId: run.workflowId,
    version: run.version,
    generation: run.generation,
    entryId: run.entryId,
    contentTypeApiId: run.contentTypeApiId,
    status: run.status,
    reason: run.reason,
    plan: run.plan,
    nodes: run.nodes,
    vars: run.vars,
    input: run.input,
    seq: run.seq,
    waitingOn: run.waitingOn,
    waitingAt: run.waitingAt,
    waitingSince: run.waitingSince ? new Date(run.waitingSince) : null,
    waitingDue: run.waitingDue ? new Date(run.waitingDue) : null,
    waitingFor: run.waitingFor,
    stoppedAt: run.stoppedAt,
    earlyEvents: [...run.earlyEvents],
    startedBy: run.startedBy,
    triggerEventId: run.triggerEventId,
    instanceId: run.instanceId,
    logSeq: run.logSeq,
    rev: run.rev,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  });
  const toNodeRun = (row: typeof nr.$inferSelect): WorkflowNodeRunRecord => ({
    runId: row.runId,
    generation: row.generation,
    nodeId: row.nodeId,
    run: row.run,
    nodeType: row.nodeType,
    model: row.model,
    ranBy: row.ranBy,
    status: row.status as WorkflowNodeRunRecord['status'],
    summary: row.summary,
    output: row.output ?? null,
    error: row.error,
    startedAt: ms(row.startedAt),
    endedAt: ms(row.endedAt),
    durationMs: row.durationMs,
  });
  return {
    async create(scope, run) {
      try {
        await x.write(db.insert(r).values(toRow(scope, run)));
      } catch (err) {
        if (isUniqueViolation(err) || err instanceof ConflictError) {
          throw new ConflictError(`Workflow run ${run.id} exists`, { runId: run.id });
        }
        throw err;
      }
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(r)
        .where(and(scopeFilter(r, scope), eq(r.id, id)));
      return row ? toRun(row) : null;
    },
    async list(scope, query = {}) {
      const conds: SQL[] = [scopeFilter(r, scope) as SQL];
      if (query.entryId) conds.push(eq(r.entryId, query.entryId));
      if (query.workflowId) conds.push(eq(r.workflowId, query.workflowId));
      if (query.status) conds.push(eq(r.status, query.status));
      const rows = await db
        .select()
        .from(r)
        .where(and(...conds))
        .orderBy(desc(r.createdAt), desc(r.id))
        .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
      return rows.map(toRun);
    },
    async save(scope, run, expectedRev) {
      const { spaceId: _s, environmentId: _e, id: _i, createdAt: _c, ...set } = toRow(scope, run);
      const cas = and(scopeFilter(r, scope), eq(r.id, run.id), eq(r.rev, expectedRev));
      if (x.inUnit) {
        // Unit of work: the outcome is the precondition; a lost race aborts the
        // whole unit at commit with TransactionConflictError.
        await x.write(db.update(r).set(set).where(cas));
        x.expectChanged(1);
        return true;
      }
      const rows = await db.update(r).set(set).where(cas).returning({ id: r.id });
      return rows.length === 1;
    },
    async recordNodeRun(scope, rec) {
      await x.write(
        db
          .insert(nr)
          .values({
            spaceId: scope.spaceId,
            environmentId: scope.environmentId,
            runId: rec.runId,
            generation: rec.generation,
            nodeId: rec.nodeId,
            run: rec.run,
            nodeType: rec.nodeType,
            model: rec.model,
            ranBy: rec.ranBy,
            status: rec.status,
            summary: rec.summary,
            output: rec.output ?? null,
            error: rec.error,
            startedAt: new Date(rec.startedAt),
            endedAt: new Date(rec.endedAt),
            durationMs: rec.durationMs,
          })
          .onConflictDoNothing(),
      );
    },
    async listNodeRuns(scope, runId) {
      const rows = await db
        .select()
        .from(nr)
        .where(and(scopeFilter(nr, scope), eq(nr.runId, runId)))
        .orderBy(asc(nr.endedAt), asc(nr.generation), asc(nr.run));
      return rows.map(toNodeRun);
    },
    async markNodeRunRolledBack(scope, k) {
      directOnly(x, 'workflowRuns.markNodeRunRolledBack');
      const rows = await db
        .update(nr)
        .set({ status: 'rolled_back' })
        .where(
          and(
            scopeFilter(nr, scope),
            eq(nr.runId, k.runId),
            eq(nr.generation, k.generation),
            eq(nr.nodeId, k.nodeId),
            eq(nr.run, k.run),
            eq(nr.status, 'succeeded'),
          ),
        )
        .returning({ runId: nr.runId });
      return rows.length === 1;
    },
    async putTimeline(scope, runId, e) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        runId,
        key: e.key,
        seq: e.seq,
        at: new Date(e.at),
        kind: e.kind,
        nodeId: e.nodeId ?? null,
        message: e.message,
      };
      await x.write(
        db
          .insert(tl)
          .values(values)
          .onConflictDoUpdate({
            target: [tl.spaceId, tl.environmentId, tl.runId, tl.key],
            set: {
              seq: values.seq,
              at: values.at,
              kind: values.kind,
              nodeId: values.nodeId,
              message: values.message,
            },
          }),
      );
    },
    async listTimeline(scope, runId) {
      const rows = await db
        .select()
        .from(tl)
        .where(and(scopeFilter(tl, scope), eq(tl.runId, runId)))
        .orderBy(asc(tl.seq));
      return rows.map((row) => ({
        seq: row.seq,
        key: row.key,
        at: ms(row.at),
        kind: row.kind as WorkflowTimelineRecord['kind'],
        ...(row.nodeId ? { nodeId: row.nodeId } : {}),
        message: row.message,
      }));
    },
    async trimTimeline(scope, runId, upTo) {
      await x.write(
        db.delete(tl).where(and(scopeFilter(tl, scope), eq(tl.runId, runId), lte(tl.seq, upTo))),
      );
    },
  };
}

function makeWorkflowTaskRepo(x: Exec): WorkflowTaskRepo {
  const db = x.db;
  const t = schema.workflowTasks;
  const toTask = (row: typeof t.$inferSelect): WorkflowTask => ({
    id: row.id,
    runId: row.runId,
    workflowId: row.workflowId,
    nodeId: row.nodeId,
    eventType: row.eventType,
    kind: row.kind as WorkflowTask['kind'],
    entryId: row.entryId,
    contentTypeApiId: row.contentTypeApiId,
    title: row.title,
    instructions: row.instructions,
    assignee: row.assignee,
    event: row.event,
    requiredScope: row.requiredScope,
    separateDuties: row.separateDuties,
    reviewId: row.reviewId,
    deadline: row.deadline.toISOString(),
    status: row.status as WorkflowTaskStatus,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    decidedBy: row.decidedBy,
    note: row.note,
    startedBy: row.startedBy,
  });
  return {
    async create(scope, task) {
      const insert = db
        .insert(t)
        .values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          ...task,
          deadline: new Date(task.deadline),
          requestedAt: new Date(task.requestedAt),
          decidedAt: task.decidedAt ? new Date(task.decidedAt) : null,
        })
        .onConflictDoNothing();
      if (x.inUnit) {
        // Unit of work: a task already committed (same id, or same run + event)
        // reports false now, as a direct insert would; a concurrent insert
        // that commits first aborts this unit at commit (TransactionConflictError).
        const [existing] = await db
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              scopeFilter(t, scope),
              or(eq(t.id, task.id), and(eq(t.runId, task.runId), eq(t.eventType, task.eventType))),
            ),
          )
          .limit(1);
        if (existing) return false;
        await x.write(insert);
        x.expectChanged(1);
        return true;
      }
      const rows = await insert.returning({ id: t.id });
      return rows.length === 1;
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(t)
        .where(and(scopeFilter(t, scope), eq(t.id, id)));
      return row ? toTask(row) : null;
    },
    async getByEvent(scope, runId, eventType) {
      const [row] = await db
        .select()
        .from(t)
        .where(and(scopeFilter(t, scope), eq(t.runId, runId), eq(t.eventType, eventType)));
      return row ? toTask(row) : null;
    },
    async list(scope, query = {}) {
      const conds: SQL[] = [scopeFilter(t, scope) as SQL];
      if (query.status) conds.push(eq(t.status, query.status));
      if (query.runId) conds.push(eq(t.runId, query.runId));
      if (query.entryId) conds.push(eq(t.entryId, query.entryId));
      if (query.kind) conds.push(eq(t.kind, query.kind));
      const rows = await db
        .select()
        .from(t)
        .where(and(...conds))
        .orderBy(
          ...(query.status === 'pending'
            ? [asc(t.deadline), asc(t.id)]
            : [desc(t.requestedAt), desc(t.id)]),
        )
        .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
      return rows.map(toTask);
    },
    async countPending(scope) {
      // Grouped on workflow_tasks_by_status_deadline: uncapped, one read.
      return db
        .select({ contentTypeApiId: t.contentTypeApiId, count: count() })
        .from(t)
        .where(and(scopeFilter(t, scope), eq(t.status, 'pending')))
        .groupBy(t.contentTypeApiId);
    },
    async settle(scope, id, outcome) {
      const update = db
        .update(t)
        .set({
          status: outcome.status,
          decidedAt: new Date(outcome.decidedAt),
          decidedBy: outcome.decidedBy,
          note: outcome.note,
        })
        .where(and(scopeFilter(t, scope), eq(t.id, id), eq(t.status, 'pending')));
      if (x.inUnit) {
        // Same pattern as `create`: decide from committed state, guard at commit.
        const [row] = await db
          .select({ status: t.status })
          .from(t)
          .where(and(scopeFilter(t, scope), eq(t.id, id)));
        if (row?.status !== 'pending') return false;
        await x.write(update);
        x.expectChanged(1);
        return true;
      }
      const rows = await update.returning({ id: t.id });
      return rows.length === 1;
    },
  };
}
type TagRow = typeof schema.tags.$inferSelect;
type ConceptRow = typeof schema.concepts.$inferSelect;
// A row older code wrote has no slug until the recount sweep gives it one: '' until then.
const toTag = (r: TagRow): Tag => ({
  id: r.id,
  name: r.name,
  slug: r.slug ?? '',
  description: r.description,
  labels: r.labels ?? {},
});
const toConcept = (r: ConceptRow): Concept => ({
  id: r.id,
  schemeId: r.schemeId,
  prefLabel: r.prefLabel,
  slug: r.slug ?? '',
  description: r.description,
  labels: r.labels ?? {},
  broaderId: r.broaderId,
});
const toTermUsage = (r: typeof schema.taxonomyUsage.$inferSelect): TermUsage => ({
  kind: r.kind,
  termId: r.termId,
  contentTypeApiId: r.contentTypeApiId,
  count: r.publishedCount,
});

/** A scope's tags, or the ones holding one of `slugs` (any number: one JSON parameter). */
const tagsQuery = (db: Db, scope: Scope, q: { readonly slugs?: readonly string[] }) =>
  db
    .select()
    .from(schema.tags)
    .where(
      and(
        scopeFilter(schema.tags, scope),
        q.slugs
          ? sql`${schema.tags.slug} IN (SELECT value FROM json_each(${idList(q.slugs)}))`
          : undefined,
      ),
    );

/** A scope's concepts, narrowed to a scheme and/or to the ones holding one of `slugs`. */
const conceptsQuery = (
  db: Db,
  scope: Scope,
  q: { readonly schemeId?: string | undefined; readonly slugs?: readonly string[] },
) =>
  db
    .select()
    .from(schema.concepts)
    .where(
      and(
        scopeFilter(schema.concepts, scope),
        q.schemeId ? eq(schema.concepts.schemeId, q.schemeId) : undefined,
        q.slugs
          ? sql`${schema.concepts.slug} IN (SELECT value FROM json_each(${idList(q.slugs)}))`
          : undefined,
      ),
    );

/**
 * One kind's usage rows, narrowed as {@link tagsQuery} / {@link conceptsQuery} narrow the terms
 * (by joining the term table, so a lookup by slug reads only that term's rows).
 */
const termUsageQuery = (
  db: Db,
  scope: Scope,
  q: { readonly kind: TermKind; readonly schemeId?: string; readonly slugs?: readonly string[] },
) => {
  const u = schema.taxonomyUsage;
  const t = q.kind === 'tag' ? schema.tags : schema.concepts;
  const narrowed = q.slugs !== undefined || (q.kind === 'concept' && q.schemeId !== undefined);
  return db
    .select()
    .from(u)
    .where(
      and(
        scopeFilter(u, scope),
        eq(u.kind, q.kind),
        gt(u.publishedCount, 0),
        narrowed
          ? sql`${u.termId} IN (SELECT ${t.id} FROM ${t} WHERE ${t.spaceId} = ${scope.spaceId} AND ${t.environmentId} = ${scope.environmentId}${
              q.kind === 'concept' && q.schemeId
                ? sql` AND ${schema.concepts.schemeId} = ${q.schemeId}`
                : sql``
            }${q.slugs ? sql` AND ${t.slug} IN (SELECT value FROM json_each(${idList(q.slugs)}))` : sql``})`
          : undefined,
      ),
    );
};

type RedirectRow = typeof schema.redirects.$inferSelect;
const toRedirect = (r: RedirectRow): Redirect => ({
  id: r.id,
  source: r.source,
  destination: r.destination,
  status: r.status,
  ...(r.locale ? { locale: r.locale } : {}),
  enabled: r.enabled,
  ...(r.note ? { note: r.note } : {}),
  origin: r.origin,
  ...(r.entryId ? { entryId: r.entryId } : {}),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

function makeRedirectRepo(x: Exec): RedirectRepo {
  const db = x.db;
  const t = schema.redirects;
  const sets = schema.redirectSets;
  return {
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(t)
        .where(and(scopeFilter(t, scope), eq(t.id, id)));
      return row ? toRedirect(row) : null;
    },
    async all(scope, opts = {}) {
      const rows = await db
        .select()
        .from(t)
        .where(and(scopeFilter(t, scope), opts.enabledOnly ? eq(t.enabled, true) : undefined))
        .orderBy(asc(t.source), asc(t.id));
      return rows.map(toRedirect);
    },
    async list(scope, query = {}) {
      const limit = Math.min(Math.max(1, query.limit ?? 100), MAX_ASSET_PAGE);
      const conds: (SQL | undefined)[] = [scopeFilter(t, scope)];
      const q = query.q?.trim().toLowerCase();
      if (q) {
        conds.push(
          sql`(instr(lower(${t.source}), ${q}) > 0 OR instr(lower(${t.destination}), ${q}) > 0 OR instr(lower(ifnull(${t.note}, '')), ${q}) > 0)`,
        );
      }
      if (query.cursor) {
        const [source, id] = decodeTextCursor(query.cursor);
        conds.push(sql`(${t.source}, ${t.id}) > (${source}, ${id})`);
      }
      const rows = await db
        .select()
        .from(t)
        .where(and(...conds))
        .orderBy(asc(t.source), asc(t.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toRedirect),
        ...(rows.length > limit && last
          ? { nextCursor: encodeTextCursor(last.source, last.id) }
          : {}),
      };
    },
    async involving(scope, paths) {
      if (paths.length === 0) return [];
      // The paths as one JSON parameter: one statement, however many.
      const list = idList(paths);
      const rows = await db
        .select()
        .from(t)
        .where(
          and(
            scopeFilter(t, scope),
            sql`(${t.source} IN (SELECT value FROM json_each(${list})) OR ${t.destination} IN (SELECT value FROM json_each(${list})))`,
          ),
        )
        .orderBy(asc(t.source), asc(t.id));
      return rows.map(toRedirect);
    },
    async state(scope) {
      // An aggregate always answers one row, with or without a revision yet.
      const [row] = await db
        .select({
          count: sql<number>`count(*)`,
          revision: sql<number>`ifnull((SELECT ${sets.revision} FROM ${sets} WHERE ${sets.spaceId} = ${scope.spaceId} AND ${sets.environmentId} = ${scope.environmentId}), 0)`,
        })
        .from(t)
        .where(scopeFilter(t, scope));
      return { revision: Number(row?.revision ?? 0), count: Number(row?.count ?? 0) };
    },
    async saveMany(scope, redirects) {
      if (redirects.length === 0) return;
      const rows = redirects.map((r) => ({
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: r.id,
        source: r.source,
        locale: r.locale ?? '',
        destination: r.destination,
        status: r.status,
        enabled: r.enabled,
        note: r.note ?? null,
        origin: r.origin,
        entryId: r.entryId ?? null,
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt),
      }));
      await writeAll(
        x,
        insertChunks(t, rows, (chunk) =>
          db
            .insert(t)
            .values(chunk)
            .onConflictDoUpdate({
              target: [t.spaceId, t.environmentId, t.id],
              set: {
                source: sql`excluded.source`,
                locale: sql`excluded.locale`,
                destination: sql`excluded.destination`,
                status: sql`excluded.status`,
                enabled: sql`excluded.enabled`,
                note: sql`excluded.note`,
                origin: sql`excluded.origin`,
                entryId: sql`excluded.entry_id`,
                updatedAt: sql`excluded.updated_at`,
              },
            }),
        ),
      );
    },
    async removeMany(scope, ids) {
      if (ids.length === 0) return;
      await x.write(
        db
          .delete(t)
          .where(
            and(
              scopeFilter(t, scope),
              sql`${t.id} IN (SELECT value FROM json_each(${idList(ids)}))`,
            ),
          ),
      );
    },
    async advance(scope, expected) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        revision: (expected ?? 0) + 1,
      };
      const target = [sets.spaceId, sets.environmentId];
      if (expected === undefined) {
        await x.write(
          db
            .insert(sets)
            .values(values)
            .onConflictDoUpdate({ target, set: { revision: sql`${sets.revision} + 1` } }),
        );
        return;
      }
      const upsert = db
        .insert(sets)
        .values(values)
        .onConflictDoUpdate({
          target,
          set: { revision: expected + 1 },
          setWhere: eq(sets.revision, expected),
        });
      if (x.inUnit) {
        // Another writer moved the set since it was read: the unit commits nothing.
        await x.write(upsert);
        x.expectChanged(1);
        return;
      }
      const changed = await upsert.returning({ revision: sets.revision });
      if (changed.length === 0) throw new TransactionConflictError();
    },
  };
}

type MenuRow = typeof schema.menus.$inferSelect;
const toMenu = (r: MenuRow): Menu => ({
  id: r.id,
  handle: r.handle,
  name: r.name,
  ...(r.description ? { description: r.description } : {}),
  items: r.items,
  revision: r.revision,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const menuByHandleQuery = (db: Db, scope: Scope, handle: string) =>
  db
    .select()
    .from(schema.menus)
    .where(and(scopeFilter(schema.menus, scope), eq(schema.menus.handle, handle)));

/**
 * The ids a menu's links name, as a subquery over its own row: every `{ type: 'entry' }` (or
 * `'term'` of `termKind`) object in the item tree. Item attributes can't hold a `type` key, so
 * only links match. However many links, a handful of bound parameters.
 */
const menuLinkIds = (
  scope: Scope,
  handle: string,
  link: { readonly type: 'entry' } | { readonly type: 'term'; readonly termKind: TermKind },
) => {
  const m = schema.menus;
  const id = link.type === 'entry' ? '$.entryId' : '$.termId';
  const kind =
    link.type === 'term' ? sql` AND json_extract(j.value, '$.termKind') = ${link.termKind}` : sql``;
  return sql`(SELECT json_extract(j.value, ${id}) FROM ${m}, json_tree(${m.items}) AS j WHERE ${m.spaceId} = ${scope.spaceId} AND ${m.environmentId} = ${scope.environmentId} AND ${m.handle} = ${handle} AND j.type = 'object' AND json_extract(j.value, '$.type') = ${link.type}${kind})`;
};

function makeMenuRepo(x: Exec): MenuRepo {
  const db = x.db;
  const t = schema.menus;
  const one = (scope: Scope, id: string) => and(scopeFilter(t, scope), eq(t.id, id));
  return {
    async all(scope) {
      const rows = await db.select().from(t).where(scopeFilter(t, scope)).orderBy(asc(t.handle));
      return rows.map(toMenu);
    },
    async get(scope, id) {
      const [row] = await db.select().from(t).where(one(scope, id));
      return row ? toMenu(row) : null;
    },
    async getByHandle(scope, handle) {
      const [row] = await menuByHandleQuery(db, scope, handle);
      return row ? toMenu(row) : null;
    },
    async save(scope, menu, expected) {
      const values = {
        handle: menu.handle,
        name: menu.name,
        description: menu.description ?? null,
        items: [...menu.items],
        revision: menu.revision,
        updatedAt: new Date(menu.updatedAt),
      };
      if (expected === undefined) {
        await x.write(
          db.insert(t).values({
            spaceId: scope.spaceId,
            environmentId: scope.environmentId,
            id: menu.id,
            createdAt: new Date(menu.createdAt),
            ...values,
          }),
        );
        return;
      }
      const update = db
        .update(t)
        .set(values)
        .where(and(one(scope, menu.id), eq(t.revision, expected)));
      if (x.inUnit) {
        // Saved by someone else since `expected` was read: the unit commits nothing.
        await x.write(update);
        x.expectChanged(1);
        return;
      }
      const changed = await update.returning({ id: t.id });
      if (changed.length === 0) throw new TransactionConflictError();
    },
    async delete(scope, id, expected) {
      const remove = db.delete(t).where(and(one(scope, id), eq(t.revision, expected)));
      if (x.inUnit) {
        await x.write(remove);
        x.expectChanged(1);
        return;
      }
      const changed = await remove.returning({ id: t.id });
      if (changed.length === 0) throw new TransactionConflictError();
    },
  };
}

type SavedViewRow = typeof schema.savedViews.$inferSelect;
const toSavedView = (r: SavedViewRow): SavedView => ({
  id: r.id,
  name: r.name,
  contentTypeApiId: r.contentType,
  visibility: r.visibility,
  createdBy: r.createdBy,
  query: r.query,
  ...(r.columns ? { columns: r.columns } : {}),
  revision: r.revision,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** Saved views are the space's: every read and write keys on `scope.spaceId` alone. */
function makeSavedViewRepo(x: Exec): SavedViewRepo {
  const db = x.db;
  const t = schema.savedViews;
  const one = (scope: Scope, id: string) => and(eq(t.spaceId, scope.spaceId), eq(t.id, id));
  return {
    async list(scope, opts = {}) {
      const shared = eq(t.visibility, 'shared');
      const mine =
        opts.owner === undefined
          ? shared
          : or(shared, and(eq(t.visibility, 'personal'), eq(t.createdBy, opts.owner)));
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.spaceId, scope.spaceId), mine))
        .orderBy(asc(t.name), asc(t.id));
      return rows.map(toSavedView);
    },
    async get(scope, id) {
      const [row] = await db.select().from(t).where(one(scope, id));
      return row ? toSavedView(row) : null;
    },
    async save(scope, view, expected) {
      const values = {
        name: view.name,
        contentType: view.contentTypeApiId,
        visibility: view.visibility,
        query: view.query,
        columns: view.columns ? [...view.columns] : null,
        revision: view.revision,
        updatedAt: new Date(view.updatedAt),
      };
      if (expected === undefined) {
        await x.write(
          db.insert(t).values({
            spaceId: scope.spaceId,
            id: view.id,
            createdBy: view.createdBy,
            createdAt: new Date(view.createdAt),
            ...values,
          }),
        );
        return;
      }
      const changed = await db
        .update(t)
        .set(values)
        .where(and(one(scope, view.id), eq(t.revision, expected)))
        .returning({ id: t.id });
      if (changed.length === 0) throw new TransactionConflictError();
    },
    async delete(scope, id, expected) {
      const changed = await db
        .delete(t)
        .where(and(one(scope, id), eq(t.revision, expected)))
        .returning({ id: t.id });
      if (changed.length === 0) throw new TransactionConflictError();
    },
  };
}

function makeTaxonomyRepo(x: Exec): TaxonomyRepo {
  const db = x.db;
  const u = schema.taxonomyUsage;
  /** Deletes a term's usage rows (with the term, in one batch). */
  const dropUsage = (scope: Scope, kind: TermKind, id: string) =>
    db.delete(u).where(and(scopeFilter(u, scope), eq(u.kind, kind), eq(u.termId, id)));
  return {
    async createScheme(scope, scheme) {
      await x.write(
        db
          .insert(schema.conceptSchemes)
          .values({ spaceId: scope.spaceId, environmentId: scope.environmentId, ...scheme })
          .onConflictDoUpdate({
            target: [
              schema.conceptSchemes.spaceId,
              schema.conceptSchemes.environmentId,
              schema.conceptSchemes.id,
            ],
            set: { name: scheme.name },
          }),
      );
    },
    async listSchemes(scope) {
      return db
        .select()
        .from(schema.conceptSchemes)
        .where(scopeFilter(schema.conceptSchemes, scope));
    },
    async getScheme(scope, id) {
      const [row] = await db
        .select()
        .from(schema.conceptSchemes)
        .where(and(scopeFilter(schema.conceptSchemes, scope), eq(schema.conceptSchemes.id, id)));
      return row ?? null;
    },
    async deleteScheme(scope, id) {
      await x.write(
        db
          .delete(schema.conceptSchemes)
          .where(and(scopeFilter(schema.conceptSchemes, scope), eq(schema.conceptSchemes.id, id))),
      );
    },
    async createConcept(scope, concept) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: concept.id,
        schemeId: concept.schemeId,
        prefLabel: concept.prefLabel,
        broaderId: concept.broaderId,
        slug: concept.slug,
        description: concept.description,
        labels: { ...concept.labels },
      };
      const { spaceId: _s, environmentId: _e, id: _i, ...set } = values;
      await x.write(
        db
          .insert(schema.concepts)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.concepts.spaceId, schema.concepts.environmentId, schema.concepts.id],
            set,
          }),
      );
    },
    async getConcept(scope, id) {
      const [row] = await db
        .select()
        .from(schema.concepts)
        .where(and(scopeFilter(schema.concepts, scope), eq(schema.concepts.id, id)));
      return row ? toConcept(row) : null;
    },
    async listConcepts(scope, schemeId) {
      return (await conceptsQuery(db, scope, { schemeId })).map(toConcept);
    },
    async findConceptsBySlug(scope, slugs, schemeId) {
      if (slugs.length === 0) return [];
      return (await conceptsQuery(db, scope, { schemeId, slugs })).map(toConcept);
    },
    async deleteConcept(scope, id) {
      await writeAll(x, [
        db
          .delete(schema.concepts)
          .where(and(scopeFilter(schema.concepts, scope), eq(schema.concepts.id, id))),
        dropUsage(scope, 'concept', id),
      ]);
    },
    async createTag(scope, tag) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: tag.id,
        name: tag.name,
        slug: tag.slug,
        description: tag.description,
        labels: { ...tag.labels },
      };
      const { spaceId: _s, environmentId: _e, id: _i, ...set } = values;
      await x.write(
        db
          .insert(schema.tags)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.tags.spaceId, schema.tags.environmentId, schema.tags.id],
            set,
          }),
      );
    },
    async getTag(scope, id) {
      const [row] = await db
        .select()
        .from(schema.tags)
        .where(and(scopeFilter(schema.tags, scope), eq(schema.tags.id, id)));
      return row ? toTag(row) : null;
    },
    async listTags(scope) {
      return (await tagsQuery(db, scope, {})).map(toTag);
    },
    async findTagsBySlug(scope, slugs) {
      if (slugs.length === 0) return [];
      return (await tagsQuery(db, scope, { slugs })).map(toTag);
    },
    async deleteTag(scope, id) {
      await writeAll(x, [
        db.delete(schema.tags).where(and(scopeFilter(schema.tags, scope), eq(schema.tags.id, id))),
        dropUsage(scope, 'tag', id),
      ]);
    },
    async slugsLike(scope, namespace, base) {
      // `base` is a slug (letters, digits, hyphens), so LIKE needs no escaping.
      const like = (col: SQLiteColumn) => or(eq(col, base), sql`${col} LIKE ${`${base}-%`}`);
      if (namespace.kind === 'tag') {
        const t = schema.tags;
        const rows = await db
          .select({ slug: t.slug })
          .from(t)
          .where(and(scopeFilter(t, scope), like(t.slug)));
        return rows.flatMap((r) => (r.slug ? [r.slug] : []));
      }
      const c = schema.concepts;
      const rows = await db
        .select({ slug: c.slug })
        .from(c)
        .where(and(scopeFilter(c, scope), eq(c.schemeId, namespace.schemeId), like(c.slug)));
      return rows.flatMap((r) => (r.slug ? [r.slug] : []));
    },
    async listUsage(scope, query) {
      const rows = await db
        .select()
        .from(u)
        .where(
          and(
            scopeFilter(u, scope),
            eq(u.kind, query.kind),
            gt(u.publishedCount, 0),
            query.termIds
              ? sql`${u.termId} IN (SELECT value FROM json_each(${idList(query.termIds)}))`
              : undefined,
          ),
        );
      return rows.map(toTermUsage);
    },
    async recountUsage(scope) {
      const p = schema.entryPublished;
      const of = (kind: TermKind, path: string) => sql`
        SELECT ${scope.spaceId}, ${scope.environmentId}, ${kind}, j.value, ${p.contentTypeApiId},
          count(DISTINCT ${p.entryId})
        FROM ${p}, json_each(${p.metadata}, ${path}) j
        WHERE ${p.spaceId} = ${scope.spaceId} AND ${p.environmentId} = ${scope.environmentId}
          AND j.type = 'text'
        GROUP BY j.value, ${p.contentTypeApiId}`;
      // One batch: the counts are replaced, never seen half-rebuilt.
      await writeAll(x, [
        db.delete(u).where(scopeFilter(u, scope)),
        db.insert(u).select(of('tag', '$.tags')),
        db.insert(u).select(of('concept', '$.concepts')),
      ]);
    },
    async getEntryMetadata(scope, entryId) {
      const [row] = await db
        .select()
        .from(schema.entryMetadata)
        .where(
          and(scopeFilter(schema.entryMetadata, scope), eq(schema.entryMetadata.entryId, entryId)),
        );
      return row ? { tags: row.tags, concepts: row.concepts } : null;
    },
    async getEntryMetadataMany(scope, entryIds) {
      const rows = await selectChunked(
        entryIds,
        (chunk) =>
          db
            .select()
            .from(schema.entryMetadata)
            .where(
              and(
                scopeFilter(schema.entryMetadata, scope),
                inArray(schema.entryMetadata.entryId, chunk),
              ),
            ),
        1,
        RESERVED,
      );
      return rows.map((row) => ({
        entryId: row.entryId,
        metadata: { tags: row.tags, concepts: row.concepts },
      }));
    },
    async setEntryMetadata(scope, entryId, metadata: EntryMetadata) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        entryId,
        tags: [...metadata.tags],
        concepts: [...metadata.concepts],
      };
      await x.write(
        db
          .insert(schema.entryMetadata)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.entryMetadata.spaceId,
              schema.entryMetadata.environmentId,
              schema.entryMetadata.entryId,
            ],
            set: { tags: values.tags, concepts: values.concepts },
          }),
      );
    },
  };
}

// ---- Delivery's reads -------------------------------------------------------
// One statement per read, shared by the repo methods and `delivery.read`, so a batched read and
// a lone one run the same SQL.

const spaceConfigQuery = (db: Db, scope: Scope) =>
  db.select().from(schema.spaces).where(eq(schema.spaces.id, scope.spaceId));

// A working definition has no use for the copy of the published one: nothing reads it there.
const { publishedDefinition: _kept, ...workingColumns } = getTableColumns(schema.contentTypes);

const contentTypesQuery = (db: Db, scope: Scope) =>
  db
    .select(workingColumns)
    .from(schema.contentTypes)
    .where(scopeFilter(schema.contentTypes, scope));

/**
 * `published_definition`, always with its table. Drizzle leaves a single table's columns bare, and
 * SQLite reads a double-quoted name it can't find as a string, so on a replica behind 0030 a bare
 * column isn't an error: every row "has" the text `published_definition`. Qualified, it fails as
 * {@link isBehind0030} expects.
 */
const keptDefinition =
  sql<schema.StoredPublishedDefinition | null>`${sql.identifier('content_types')}.${sql.identifier('published_definition')}`.mapWith(
    schema.contentTypes.publishedDefinition,
  );

/**
 * The columns the published view reads: the row's, and the kept definition. A row that has one
 * brings no draft `fields` beside it, so the read is no larger than a row with only its own.
 *
 * `behind0030` is for a read replica that hasn't reached the migration ({@link isBehind0030}): the
 * same shape without naming the column. Nothing is kept there, as nothing was before it, so each
 * row is served as it stands.
 */
const deliveredContentTypeColumns = (behind0030: boolean) => {
  const t = schema.contentTypes;
  return {
    apiId: t.apiId,
    name: t.name,
    displayField: t.displayField,
    fields: behind0030
      ? t.fields
      : sql<
          FieldDefinition[]
        >`CASE WHEN ${t.status} <> 'published' AND ${keptDefinition} IS NOT NULL THEN '[]' ELSE ${t.fields} END`.mapWith(
          t.fields,
        ),
    urlPattern: t.urlPattern,
    version: t.version,
    status: t.status,
    publishedSingleton: t.publishedSingleton,
    publishedDefinition: behind0030
      ? sql<schema.StoredPublishedDefinition | null>`NULL`
      : keptDefinition,
  };
};

const deliveredContentTypesQuery = (db: Db, scope: Scope, behind0030: boolean, apiId?: string) => {
  const t = schema.contentTypes;
  return db
    .select(deliveredContentTypeColumns(behind0030))
    .from(t)
    .where(and(scopeFilter(t, scope), apiId === undefined ? undefined : eq(t.apiId, apiId)));
};

/**
 * Whether a read failed because the replica that answered predates 0030_published_definition. CI
 * migrates and then deploys with no wait, and Delivery's session starts on any replica, which D1
 * only promises is asynchronously up to date: a new Worker can name the column on a replica still
 * catching up. The retry costs nothing unless that happens. Remove it once every deployment is
 * past 0030.
 */
const isBehind0030 = (err: unknown): boolean =>
  /no such column: .*published_definition/.test(messageOf(err));

/** Rendition presets are the space's, not an environment's. */
const renditionsQuery = (db: Db, scope: Scope) =>
  db
    .select()
    .from(schema.assetRenditions)
    .where(eq(schema.assetRenditions.spaceId, scope.spaceId))
    .orderBy(asc(schema.assetRenditions.name));

/** At most `100 - RESERVED` ids: callers chunk. */
const publishedEntriesQuery = (db: Db, scope: Scope, ids: readonly string[]) =>
  db
    .select()
    .from(schema.entryPublished)
    .where(
      and(
        scopeFilter(schema.entryPublished, scope),
        ids.length === 1
          ? eq(schema.entryPublished.entryId, ids[0] as string)
          : inArray(schema.entryPublished.entryId, [...ids]),
      ),
    );

/** At most `100 - RESERVED` ids: callers chunk. */
/**
 * The space's `locale_settings`, as a column an asset statement can carry: a constant subquery,
 * which SQLite evaluates once per statement, so an all-locale asset read costs no statement of
 * its own for the config it needs.
 */
const spaceLocalesColumn = (scope: Scope) =>
  sql<
    string | null
  >`(SELECT ${schema.spaces.localeSettings} FROM ${schema.spaces} WHERE ${schema.spaces.id} = ${scope.spaceId})`.as(
    'space_locale_settings',
  );

/** The settings an asset row carried (see {@link spaceLocalesColumn}), `{}` for none. */
const localesOfRow = (row: { spaceLocaleSettings?: string | null }) =>
  row.spaceLocaleSettings
    ? (JSON.parse(row.spaceLocaleSettings) as Record<string, LocaleSettings>)
    : {};

const assetSelection = (db: Db, scope: Scope, withLocales: boolean) =>
  withLocales
    ? db.select({
        ...getTableColumns(schema.assetPublished),
        spaceLocaleSettings: spaceLocalesColumn(scope),
      })
    : db.select({
        ...getTableColumns(schema.assetPublished),
        spaceLocaleSettings: sql<string | null>`NULL`.as('space_locale_settings'),
      });

const publishedAssetsQuery = (
  db: Db,
  scope: Scope,
  ids: readonly string[],
  opts: { readonly withLocales?: boolean } = {},
) =>
  assetSelection(db, scope, Boolean(opts.withLocales))
    .from(schema.assetPublished)
    .where(
      and(
        scopeFilter(schema.assetPublished, scope),
        ids.length === 1
          ? eq(schema.assetPublished.assetId, ids[0] as string)
          : inArray(schema.assetPublished.assetId, [...ids]),
      ),
    );

/**
 * The sitemap's page of published entries: by entry id from `from` (up to `before`), each with
 * only the named fields of its body, picked out in SQL so a page of thousands never ships a
 * rich-text body. The content types and field names are one JSON parameter each, so the statement
 * binds at most seven parameters however many there are. Field apiIds are identifiers (letters
 * and digits), safe to quote into a JSON path.
 */
function sitemapPageQuery(db: Db, scope: Scope, query: SitemapQuery) {
  const p = schema.entryPublished;
  return db
    .select({
      entryId: p.entryId,
      contentTypeApiId: p.contentTypeApiId,
      publishedAt: p.publishedAt,
      fields: sql<string | null>`(
        SELECT json_group_object(f.value, json(${p.fields} -> ('$."' || f.value || '"')))
        FROM json_each(${idList(query.fields)}) f
        WHERE json_type(${p.fields}, '$."' || f.value || '"') IS NOT NULL)`,
    })
    .from(p)
    .where(
      and(
        scopeFilter(p, scope),
        sql`${p.contentTypeApiId} IN (SELECT value FROM json_each(${idList(query.contentTypes)}))`,
        query.from !== undefined ? gte(p.entryId, query.from) : undefined,
        query.before !== undefined ? lt(p.entryId, query.before) : undefined,
      ),
    )
    .orderBy(asc(p.entryId))
    .limit(Math.max(1, query.limit));
}

/** The first entry id of every page of `size` sitemap entries: what a sitemap index lists. */
function sitemapPageStartsQuery(db: Db, scope: Scope, query: SitemapQuery, size: number) {
  const p = schema.entryPublished;
  const numbered = db
    .select({
      entryId: p.entryId,
      n: sql<number>`row_number() OVER (ORDER BY ${p.entryId})`.as('n'),
    })
    .from(p)
    .where(
      and(
        scopeFilter(p, scope),
        sql`${p.contentTypeApiId} IN (SELECT value FROM json_each(${idList(query.contentTypes)}))`,
      ),
    )
    .as('numbered');
  return db
    .select({ entryId: numbered.entryId })
    .from(numbered)
    .where(sql`(${numbered.n} - 1) % ${Math.max(1, size)} = 0`)
    .orderBy(asc(numbered.entryId));
}

/**
 * Sends every read a Delivery step asked for as ONE `db.batch()`: one round trip, however many
 * statements (id lists still split under the 100-parameter cap, each chunk its own statement in
 * the same batch). Only reads, so the batch's implicit transaction changes nothing but latency,
 * and it runs on whatever the store was built over (a read-replica session included).
 */
function makeDeliveryReadRepo(x: Exec): DeliveryReadRepo {
  const db = x.db;
  const readOn = async (
    scope: Scope,
    request: DeliveryReadRequest,
    behind0030: boolean,
  ): Promise<DeliveryReadResult> => {
    const queries: Query[] = [];
    const settle: ((rows: never[]) => void)[] = [];
    const add = <R>(query: PromiseLike<R[]>, take: (rows: R[]) => void) => {
      queries.push(query as unknown as Query);
      settle.push(take as (rows: never[]) => void);
    };
    const result: { -readonly [K in keyof DeliveryReadResult]: DeliveryReadResult[K] } = {};

    if (request.config) {
      add(spaceConfigQuery(db, scope), ([row]) => {
        result.config = row ? toSpaceConfig(row) : null;
      });
    }
    if (request.contentTypes) {
      // Delivery's view: each type as last published, not as a draft has it.
      add(deliveredContentTypesQuery(db, scope, behind0030), (rows) => {
        result.contentTypes = rows.map(toDeliveredContentType);
      });
    }
    if (request.renditions) {
      add(renditionsQuery(db, scope), (rows) => {
        result.renditions = rows.map(toAssetRendition);
      });
    }
    if (request.entryId !== undefined) {
      add(publishedEntriesQuery(db, scope, [request.entryId]), ([row]) => {
        result.entry = row ? toPublished(row) : null;
      });
    }
    if (request.assetId !== undefined) {
      const query = request.assetLocales
        ? publishedAssetsQuery(db, scope, [request.assetId], { withLocales: true })
        : publishedAssetsQuery(db, scope, [request.assetId]);
      add(query, ([row]) => {
        result.asset = row ? toPublishedAsset(row) : null;
        if (row && request.assetLocales) result.assetLocales = localesOfRow(row);
      });
    }
    if (request.entryIds) {
      const entries: PublishedEntry[] = [];
      result.entries = entries;
      for (const chunk of chunked(request.entryIds, 1, RESERVED)) {
        add(publishedEntriesQuery(db, scope, chunk), (rows) => {
          entries.push(...rows.map(toPublished));
        });
      }
    }
    if (request.assetIds) {
      const assets: PublishedAsset[] = [];
      result.assets = assets;
      for (const chunk of chunked(request.assetIds, 1, RESERVED)) {
        add(publishedAssetsQuery(db, scope, chunk), (rows) => {
          assets.push(...rows.map(toPublishedAsset));
        });
      }
    }
    if (request.assetPage) {
      const page = publishedAssetPage(db, scope, request.assetPage, {
        withLocales: Boolean(request.assetLocales),
      });
      add(page.query, (rows) => {
        result.assetPage = page.of(rows);
        const [first] = rows;
        if (first && request.assetLocales) result.assetLocales = localesOfRow(first);
      });
    }
    if (request.tags) {
      add(tagsQuery(db, scope, request.tags), (rows) => {
        result.tags = rows.map(toTag);
      });
    }
    if (request.concepts) {
      add(conceptsQuery(db, scope, request.concepts), (rows) => {
        result.concepts = rows.map(toConcept);
      });
    }
    if (request.termUsage) {
      add(termUsageQuery(db, scope, request.termUsage), (rows) => {
        result.termUsage = rows.map(toTermUsage);
      });
    }

    if (request.sitemap) {
      const query = request.sitemap;
      const items: SitemapEntryRow[] = [];
      result.sitemap = { items };
      add(sitemapPageQuery(db, scope, query), (rows) => {
        items.push(
          ...rows.map((r) => ({
            entryId: r.entryId,
            contentTypeApiId: r.contentTypeApiId,
            fields: r.fields ? (JSON.parse(r.fields) as EntryFields) : {},
            publishedAt: r.publishedAt.toISOString(),
          })),
        );
      });
      if (query.pageStarts !== undefined) {
        const starts: string[] = [];
        result.sitemap = { items, pageStarts: starts };
        add(sitemapPageStartsQuery(db, scope, query, query.pageStarts), (rows) => {
          starts.push(...rows.map((r) => r.entryId));
        });
      }
    }
    if (request.menu) {
      // The menu and what its links name, as four statements of the same batch: the links are
      // read through the menu's own row, so nothing waits on a first round trip.
      const { handle } = request.menu;
      const read: { menu?: Menu; entries: PublishedEntry[]; tags: Tag[]; concepts: Concept[] } = {
        entries: [],
        tags: [],
        concepts: [],
      };
      add(menuByHandleQuery(db, scope, handle), ([row]) => {
        if (row) read.menu = toMenu(row);
        result.menu = read.menu ? (read as MenuRead) : null;
      });
      const ep = schema.entryPublished;
      add(
        db
          .select()
          .from(ep)
          .where(
            and(
              scopeFilter(ep, scope),
              sql`${ep.entryId} IN ${menuLinkIds(scope, handle, { type: 'entry' })}`,
            ),
          ),
        (rows) => {
          read.entries = rows.map(toPublished);
        },
      );
      add(
        db
          .select()
          .from(schema.tags)
          .where(
            and(
              scopeFilter(schema.tags, scope),
              sql`${schema.tags.id} IN ${menuLinkIds(scope, handle, { type: 'term', termKind: 'tag' })}`,
            ),
          ),
        (rows) => {
          read.tags = rows.map(toTag);
        },
      );
      add(
        db
          .select()
          .from(schema.concepts)
          .where(
            and(
              scopeFilter(schema.concepts, scope),
              sql`${schema.concepts.id} IN ${menuLinkIds(scope, handle, { type: 'term', termKind: 'concept' })}`,
            ),
          ),
        (rows) => {
          read.concepts = rows.map(toConcept);
        },
      );
    }

    if (request.singleton) {
      // The type and its published entry, two statements of the same batch: whether the type is
      // a singleton at all is the caller's to judge, from the row read here.
      const apiId = request.singleton.contentType;
      const read: {
        contentType: ContentType | null;
        publishedSingleton: boolean;
        entry: PublishedEntry | null;
      } = { contentType: null, publishedSingleton: false, entry: null };
      result.singleton = read;
      add(deliveredContentTypesQuery(db, scope, behind0030, apiId), ([row]) => {
        read.contentType = row ? toDeliveredContentType(row) : null;
        read.publishedSingleton = row?.publishedSingleton === true;
      });
      const ep = schema.entryPublished;
      add(
        db
          .select()
          .from(ep)
          .where(and(scopeFilter(ep, scope), eq(ep.contentTypeApiId, apiId)))
          .orderBy(asc(ep.entryId))
          .limit(1),
        ([row]) => {
          read.entry = row ? toPublished(row) : null;
        },
      );
    }

    if (queries.length === 0) return result;
    const rows =
      queries.length === 1
        ? [await (queries[0] as unknown as PromiseLike<unknown[]>)]
        : ((await db.batch(queries as unknown as [Query, ...Query[]])) as unknown[][]);
    settle.forEach((take, i) => {
      take((rows[i] ?? []) as never[]);
    });
    return result;
  };
  return {
    // Once more without the column only when the replica lacks it, so a read pays nothing for this.
    // That second read can land on a replica past 0030, where it ignores a kept definition and
    // serves the row: one response, possibly cached until the next purge or its max-age, and the
    // next read is right. Accepted as rare and self-clearing. Remove this once every deployment is
    // past 0030.
    read: (scope, request) =>
      readOn(scope, request, false).catch((err: unknown) => {
        if (!isBehind0030(err)) throw err;
        return readOn(scope, request, true);
      }),
  };
}

export interface D1StoreOptions {
  /**
   * Max candidate rows a field-level query (or the built-in text search) may pull into memory
   * for exact evaluation (see query-pushdown.ts). Exceeding it raises
   * {@link QueryTooBroadError} rather than silently truncating. Default 5000.
   */
  readonly queryScanLimit?: number;
  /**
   * Where superseded version bodies live once the archive sweep has moved them
   * (`entries.markVersionsArchived`). Without it, reading an archived version throws.
   */
  readonly versionBodies?: BlobStore;
}

/** The repos `withTransaction` hands out, built over one unit of work. */
function makeTx(x: Exec, scanLimit: number, versionBodies?: BlobStore): ContentStoreTx {
  return {
    spaces: (({ markEnvironmentPurgeProgress, setLocaleSettings }) => ({
      markEnvironmentPurgeProgress,
      setLocaleSettings,
    }))(makeSpaceRepo(x)),
    contentTypes: makeContentTypeRepo(x),
    entries: makeEntryRepo(x, scanLimit, versionBodies),
    assets: makeAssetRepo(x),
    assetFolders: makeAssetFolderRepo(x),
    assetCollections: makeAssetCollectionRepo(x),
    assetShareLinks: makeAssetShareLinkRepo(x),
    assetZips: makeAssetZipJobRepo(x),
    assetUploads: makeAssetUploadRepo(x),
    assetRenditions: makeAssetRenditionRepo(x),
    references: makeReferenceRepo(x),
    releases: makeReleaseRepo(x),
    promotions: makePromotionRepo(x),
    taxonomy: makeTaxonomyRepo(x),
    redirects: makeRedirectRepo(x),
    menus: makeMenuRepo(x),
    bulkJobs: makeBulkJobRepo(x),
    workflowRuns: makeWorkflowRunRepo(x),
    workflowTasks: makeWorkflowTaskRepo(x),
    workflowGraphs: { listPublishGates: makeWorkflowGraphRepo(x).listPublishGates },
    outbox: makeOutboxRepo(x),
    invites: makeInviteRepo(x),
    members: makeMemberRepo(x),
  };
}

/**
 * Creates the D1-backed ContentStore over a database binding or a read-replica session
 * (`env.DB.withSession(bookmark)`). No D1 or Drizzle type crosses the `ContentStore` boundary.
 */
export function createD1Store(d1: D1Like, options: D1StoreOptions = {}): ContentStore {
  const db = createDb(d1);
  const x = directExec(db);
  const scanLimit = options.queryScanLimit ?? DEFAULT_QUERY_SCAN_LIMIT;
  return {
    spaces: makeSpaceRepo(x),
    contentTypes: makeContentTypeRepo(x),
    entries: makeEntryRepo(x, scanLimit, options.versionBodies),
    assets: makeAssetRepo(x),
    assetFolders: makeAssetFolderRepo(x),
    assetCollections: makeAssetCollectionRepo(x),
    assetShareLinks: makeAssetShareLinkRepo(x),
    assetZips: makeAssetZipJobRepo(x),
    assetUploads: makeAssetUploadRepo(x),
    assetRenditions: makeAssetRenditionRepo(x),
    references: makeReferenceRepo(x),
    webhooks: makeWebhookRepo(x),
    auth: makeAuthRepo(x),
    roles: makeRoleRepo(x),
    members: makeMemberRepo(x),
    invites: makeInviteRepo(x),
    settings: makeDeploymentSettingsRepo(x),
    schedulerJobs: makeSchedulerJobRepo(x),
    agentRuns: makeAgentRunRepo(x),
    audit: makeAuditRepo(x),
    aiActions: makeAiActionRepo(x),
    functions: makeFunctionRepo(x),
    appExtensions: makeAppExtensionRepo(x),
    previewTokens: makePreviewTokenRepo(x),
    plugins: makePluginRepo(x),
    pluginSettings: makePluginSettingsRepo(x),
    pluginStorage: makePluginStorageRepo(x),
    oauthClients: makeOAuthClientRepo(x),
    oauthGrants: makeOAuthGrantRepo(x),
    releases: makeReleaseRepo(x),
    promotions: makePromotionRepo(x),
    scheduledActions: makeScheduledActionRepo(x),
    agentSchedules: makeAgentScheduleRepo(x),
    agentReviews: makeAgentReviewRepo(x),
    comments: makeCommentRepo(x),
    tasks: makeTaskRepo(x),
    workflows: makeWorkflowRepo(x),
    workflowGraphs: makeWorkflowGraphRepo(x),
    workflowRuns: makeWorkflowRunRepo(x),
    workflowTasks: makeWorkflowTaskRepo(x),
    taxonomy: makeTaxonomyRepo(x),
    redirects: makeRedirectRepo(x),
    menus: makeMenuRepo(x),
    savedViews: makeSavedViewRepo(x),
    bulkJobs: makeBulkJobRepo(x),
    outbox: makeOutboxRepo(x),
    storedSecrets: makeStoredSecretRepo(x),
    delivery: makeDeliveryReadRepo(x),
    /**
     * One unit of work per call: `fn`'s writes are buffered and committed as a single D1 batch
     * once it returns; if it throws, nothing is sent. See `ContentStore.withTransaction`.
     */
    async withTransaction<T>(fn: (tx: ContentStoreTx) => Promise<T>): Promise<T> {
      const uow = new UnitOfWork(db);
      const result = await fn(makeTx(uow, scanLimit, options.versionBodies));
      await uow.commit();
      return result;
    },
  };
}

// ---- row mappers ----------------------------------------------------------

type CtRow = Omit<typeof schema.contentTypes.$inferSelect, 'publishedDefinition'>;
type EntryRow = typeof schema.entries.$inferSelect;
type PubRow = typeof schema.entryPublished.$inferSelect;

/**
 * What `agent_instructions` reads as on a replica behind 0032: Drizzle leaves the column bare, and
 * SQLite reads a double-quoted name it can't find as a string (see {@link keptDefinition}). Treated
 * as unset, so the admin can't load the column's name and save it back for agents to read. Remove
 * this once every deployment is past 0032.
 */
const BEHIND_0032 = 'agent_instructions';

/** What `preview_url_template` reads as on a replica behind 0035, as {@link BEHIND_0032}. */
const BEHIND_0035 = 'preview_url_template';

const toContentType = (r: CtRow): ContentType => ({
  apiId: r.apiId,
  name: r.name,
  displayField: r.displayField,
  fields: r.fields,
  ...(r.urlPattern ? { urlPattern: r.urlPattern } : {}),
  ...(r.singleton ? { singleton: true as const } : {}),
  ...(r.group ? { group: r.group } : {}),
  ...(r.description ? { description: r.description } : {}),
  ...(r.icon ? { icon: r.icon } : {}),
  ...(r.agentInstructions && r.agentInstructions !== BEHIND_0032
    ? { agentInstructions: r.agentInstructions }
    : {}),
  ...(r.layout ? { layout: r.layout } : {}),
  ...(r.previewUrlTemplate && r.previewUrlTemplate !== BEHIND_0035
    ? { preview: { urlTemplate: r.previewUrlTemplate } }
    : {}),
  version: r.version,
  status: r.status,
});

const toPublishedDefinition = (
  { urlPattern, ...definition }: schema.StoredPublishedDefinition,
  publishedSingleton: boolean,
): PublishedContentTypeDefinition => ({
  ...definition,
  ...(urlPattern ? { urlPattern } : {}),
  ...(publishedSingleton ? { singleton: true as const } : {}),
});

const toDeliveredContentType = (r: {
  apiId: string;
  name: string;
  displayField: string;
  fields: FieldDefinition[];
  urlPattern: string | null;
  version: number;
  status: ContentType['status'];
  publishedSingleton: boolean;
  publishedDefinition: schema.StoredPublishedDefinition | null;
}): DeliveredContentType =>
  deliveredContentType(
    {
      apiId: r.apiId,
      name: r.name,
      displayField: r.displayField,
      fields: r.fields,
      ...(r.urlPattern ? { urlPattern: r.urlPattern } : {}),
      version: r.version,
      status: r.status,
    },
    r.publishedDefinition
      ? toPublishedDefinition(r.publishedDefinition, r.publishedSingleton)
      : null,
    r.publishedSingleton,
  );

const toEntry = (r: EntryRow): Entry => ({
  id: r.id,
  contentTypeApiId: r.contentTypeApiId,
  status: r.status,
  currentVersion: r.currentVersion,
  publishedVersion: r.publishedVersion,
  createdAt: r.createdAt?.toISOString() ?? null,
  createdBy: r.createdBy,
  updatedBy: r.modifiedBy,
  firstPublishedAt: r.firstPublishedAt?.toISOString() ?? null,
  position: r.position,
});

type AgentRunRow = typeof schema.agentRuns.$inferSelect;
const toAgentRun = (r: AgentRunRow): AgentRunRecord => ({
  id: r.id,
  workflow: r.workflow,
  entryId: r.entryId,
  status: r.status,
  decisions: r.decisions,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  createdAt: r.createdAt.toISOString(),
});

type ApiKeyRow = typeof schema.apiKeys.$inferSelect;
const toApiKey = (r: ApiKeyRow): ApiKey => ({
  id: r.id,
  spaceId: r.spaceId,
  kind: r.kind,
  name: r.name ?? undefined,
  hashedToken: r.hashedToken,
  scopes: r.scopes,
  revoked: r.revoked,
  roleId: r.roleId ?? undefined,
  lastUsedAt: r.lastUsedAt?.toISOString(),
  expiresAt: r.expiresAt?.toISOString(),
  // Rows written before OAuth existed have no issuance; they are operator keys.
  issuance: r.issuance ?? undefined,
  subject: r.subject ?? undefined,
  clientId: r.clientId ?? undefined,
});

type OAuthClientRow = typeof schema.oauthClients.$inferSelect;
const toOAuthClient = (r: OAuthClientRow): OAuthClient => ({
  id: r.id,
  clientName: r.clientName,
  redirectUris: r.redirectUris,
  grantTypes: r.grantTypes as OAuthClient['grantTypes'],
  scopes: r.scopes,
  tokenEndpointAuthMethod: r.tokenEndpointAuthMethod as OAuthClient['tokenEndpointAuthMethod'],
  hashedClientSecret: r.hashedClientSecret ?? undefined,
  clientUri: r.clientUri ?? undefined,
  logoUri: r.logoUri ?? undefined,
  softwareId: r.softwareId ?? undefined,
  createdAt: r.createdAt.toISOString(),
});

type OAuthGrantRow = typeof schema.oauthGrants.$inferSelect;
const toOAuthGrant = (r: OAuthGrantRow): OAuthGrantRecord => ({
  id: r.id,
  kind: r.kind,
  clientId: r.clientId,
  hashedCode: r.hashedCode,
  hashedUserCode: r.hashedUserCode ?? undefined,
  status: r.status,
  scopes: r.scopes,
  spaceId: r.spaceId ?? undefined,
  subject: r.subject ?? undefined,
  roleId: r.roleId ?? undefined,
  redirectUri: r.redirectUri ?? undefined,
  codeChallenge: r.codeChallenge ?? undefined,
  codeChallengeMethod: r.codeChallengeMethod ?? undefined,
  resource: r.resource ?? undefined,
  parentId: r.parentId ?? undefined,
  issuedKeyIds: r.issuedKeyIds ?? undefined,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
});

type RoleRow = typeof schema.roles.$inferSelect;
const toRole = (r: RoleRow): Role => ({
  id: r.id,
  spaceId: r.spaceId,
  name: r.name,
  description: r.description ?? undefined,
  scopes: r.scopes,
  contentGrants: r.contentGrants,
  ...(r.preset ? { preset: r.preset } : {}),
});

type MemberRow = typeof schema.spaceMembers.$inferSelect;
const toMember = (r: MemberRow): SpaceMember => ({
  id: r.id,
  spaceId: r.spaceId,
  email: r.email,
  ...(r.name ? { name: r.name } : {}),
  ...(r.subject ? { subject: r.subject } : {}),
  roleId: r.roleId,
  disabled: r.disabled,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

type WebhookRow = typeof schema.webhooks.$inferSelect;
const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  url: r.url,
  topics: r.topics as Webhook['topics'],
  secret: r.secret,
  active: r.active,
  headers: r.headers ?? undefined,
  environmentId: r.environmentId,
});

type PubAssetRow = typeof schema.assetPublished.$inferSelect;
/** The epoch instant a snapshot's rights expire at, for its `expires_at` column; `null`: none. */
function expiryOf(rights: { readonly expiresAt?: string } | null | undefined): Date | null {
  const ms = rights?.expiresAt ? Date.parse(rights.expiresAt) : Number.NaN;
  return Number.isNaN(ms) ? null : new Date(ms);
}

type AssetVersionRow = typeof schema.assetVersions.$inferSelect;
const toAssetVersionRecord = (r: AssetVersionRow): AssetVersionRecord => ({
  version: r.version,
  file: r.file,
  ...(r.r2Key ? { r2Key: r.r2Key } : {}),
  ...(r.contentHash ? { contentHash: r.contentHash } : {}),
  replacedAt: r.createdAt.toISOString(),
  ...(r.createdBy ? { replacedBy: r.createdBy } : {}),
});

const toPublishedAsset = (r: PubAssetRow): PublishedAsset => ({
  assetId: r.assetId,
  file: r.file,
  title: r.title,
  description: r.description,
  metadata: r.metadata,
  publishedAt: r.publishedAt.toISOString(),
  version: r.version,
  ...(r.r2Key ? { r2Key: r.r2Key } : {}),
  ...(r.rights ? { rights: r.rights } : {}),
});

type RenditionRow = typeof schema.assetRenditions.$inferSelect;
const toAssetRendition = (r: RenditionRow): AssetRendition => ({
  name: r.name,
  ...(r.width !== null ? { width: r.width } : {}),
  ...(r.height !== null ? { height: r.height } : {}),
  ...(r.fit ? { fit: r.fit } : {}),
  ...(r.format ? { format: r.format } : {}),
  ...(r.quality !== null ? { quality: r.quality } : {}),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

type RefRow = typeof schema.references.$inferSelect;
const toEdge = (r: RefRow): ReferenceEdge => ({
  fromEntryId: r.fromEntryId,
  fromField: r.fromField,
  toId: r.toId,
  toType: r.toType,
});

const toPublished = (r: PubRow): PublishedEntry => ({
  entryId: r.entryId,
  contentTypeApiId: r.contentTypeApiId,
  version: r.version,
  fields: r.fields,
  publishedAt: r.publishedAt.toISOString(),
  ...(r.firstPublishedAt ? { firstPublishedAt: r.firstPublishedAt.toISOString() } : {}),
  ...(r.metadata ? { metadata: r.metadata } : {}),
  ...(r.position ? { position: r.position } : {}),
});

const publishedRow = (scope: Scope, snapshot: PublishedEntry) => ({
  spaceId: scope.spaceId,
  environmentId: scope.environmentId,
  entryId: snapshot.entryId,
  contentTypeApiId: snapshot.contentTypeApiId,
  version: snapshot.version,
  fields: snapshot.fields,
  metadata: snapshot.metadata
    ? { tags: [...snapshot.metadata.tags], concepts: [...snapshot.metadata.concepts] }
    : null,
  publishedAt: new Date(snapshot.publishedAt),
  firstPublishedAt: snapshot.firstPublishedAt ? new Date(snapshot.firstPublishedAt) : null,
});

const isoDate = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);

const entryRow = (scope: Scope, entry: Entry) => {
  const at = new Date();
  return {
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    id: entry.id,
    contentTypeApiId: entry.contentTypeApiId,
    status: entry.status,
    currentVersion: entry.currentVersion,
    publishedVersion: entry.publishedVersion,
    updatedAt: at,
    createdAt: isoDate(entry.createdAt) ?? at,
    createdBy: entry.createdBy ?? null,
    modifiedBy: entry.updatedBy ?? null,
    firstPublishedAt: isoDate(entry.firstPublishedAt),
  };
};

const versionRow = (scope: Scope, version: EntryVersion) => ({
  spaceId: scope.spaceId,
  environmentId: scope.environmentId,
  entryId: version.entryId,
  version: version.version,
  fields: version.fields,
  // Honor a use-case-supplied timestamp (deterministic via the clock); else the
  // column defaults to the insert instant.
  ...(version.createdAt ? { createdAt: new Date(version.createdAt) } : {}),
  createdBy: version.createdBy ?? null,
});

type EntryVersionRow = typeof schema.entryVersions.$inferSelect;
const toVersion = (r: EntryVersionRow): EntryVersion => ({
  entryId: r.entryId,
  version: r.version,
  fields: r.fields,
  createdAt: r.createdAt.toISOString(),
  createdBy: r.createdBy,
});

/**
 * What an aggregate save writes: the pointers, the change's time and author, and the first
 * publish. Creation is never rewritten, and `first_published_at` only fills in: a lost race
 * between two first publishes, or a stale aggregate, can't move it.
 */
const aggregateSet = (entry: Entry, at: Date) => ({
  status: entry.status,
  currentVersion: entry.currentVersion,
  publishedVersion: entry.publishedVersion ?? null,
  updatedAt: at,
  modifiedBy: entry.updatedBy ?? null,
  ...(entry.firstPublishedAt
    ? {
        firstPublishedAt: sql`COALESCE(${schema.entries.firstPublishedAt}, ${Date.parse(entry.firstPublishedAt)})`,
      }
    : {}),
});

/** The aggregate UPDATE (an UPDATE, so a concurrently deleted row stays deleted). */
function saveEntryAggregate(db: Db, scope: Scope, entry: Entry) {
  return db
    .update(schema.entries)
    .set(aggregateSet(entry, new Date()))
    .where(and(scopeFilter(schema.entries, scope), eq(schema.entries.id, entry.id)));
}
