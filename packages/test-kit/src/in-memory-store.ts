import {
  type AgentReview,
  type AgentSchedule,
  type ApiKey,
  type Asset,
  type AssetCollection,
  type AssetFolder,
  type AssetRendition,
  type AssetZipJob,
  assetKind,
  type Comment,
  type Concept,
  type ConceptScheme,
  ConflictError,
  type ContentType,
  cloneJson,
  coversEnvironment,
  type DeliveredContentType,
  type DomainEvent,
  deliveredContentType,
  type Entry,
  type EntryFields,
  type EntryMetadata,
  type EntryVersion,
  type EntryWorkflowState,
  entrySysOf,
  type InstalledPlugin,
  inviteStatus,
  isWebhookSendRequest,
  type MemberInvite,
  type Menu,
  matchesTopic,
  menuTargets,
  type OAuthClient,
  type OutboxEntry,
  type PluginSettings,
  type Promotion,
  type PublishedContentTypeDefinition,
  projectFields,
  type Redirect,
  type ReferenceEdge,
  type Release,
  type ReleaseItem,
  type Role,
  runEntryQuery,
  type SavedView,
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
  type WorkflowNodeRunRecord,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowTask,
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
  AssetFolderRepo,
  AssetRenditionRepo,
  AssetRepo,
  AssetShareLinkRepo,
  AssetUpload,
  AssetUploadRepo,
  AssetVersionRecord,
  AssetZipJobRepo,
  AuditEntry,
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
  DeliveryReadResult,
  DeploymentSettingsRepo,
  EntryQuery,
  EntryRepo,
  EntryStatusCount,
  EntryWithFields,
  EnvironmentAlias,
  ExpiredTrashEntry,
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
  PendingCount,
  PluginRepo,
  PluginSettingsRepo,
  PluginStorageRepo,
  PreviewTokenRecord,
  PreviewTokenRepo,
  PromotionRepo,
  PublishedAsset,
  PublishedEntry,
  RedirectRepo,
  ReferenceRepo,
  ReleaseRepo,
  RoleRepo,
  SavedViewRepo,
  ScheduledActionRepo,
  SchedulerJobRepo,
  SchedulerJobStatus,
  ScopedScheduledAction,
  SingletonRead,
  SitemapPage,
  SpaceConfig,
  SpaceRepo,
  StoredSecret,
  StoredSecretRepo,
  StoredSetting,
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
import { JournaledMap } from './journaled-map';

const scopeKey = (s: Scope) => `${s.spaceId}::${s.environmentId}`;

/** Tallies content types into the `countPending` shape (one row per type). */
function countByType(types: readonly (string | null)[]): PendingCount[] {
  const counts = new Map<string | null, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts].map(([contentTypeApiId, count]) => ({ contentTypeApiId, count }));
}

/**
 * A deep copy for workflow rows/versions, so a caller mutating what it read (or wrote) can never
 * change stored state — the property that makes published versions immutable.
 */
const clone = <T>(value: T): T => cloneJson(value);

const toLegacyDefinition = (row: {
  id: string;
  name: string;
  steps: readonly WorkflowStep[];
}): WorkflowDefinition => ({ id: row.id, name: row.name, steps: clone([...row.steps]) });

/** The claim's identity — mirrors the D1 store's unique index columns exactly. */
const claimKey = (scope: Scope, c: UniqueClaim): string =>
  `${scopeKey(scope)}::${c.contentTypeApiId}::${c.fieldApiId}::${c.locale}::${c.value}`;

/**
 * An in-memory ContentStore for fast, infra-free tests. It mirrors the D1
 * store's observable behavior (scoping, versioning, published read model,
 * outbox) without isolation guarantees — transactions simply run the callback.
 */
export class InMemoryContentStore implements ContentStore {
  /**
   * Time source for adapter-stamped instants (outbox `relayedAt`) — the fields
   * the REAL adapter stamps with database time, not the use-case clock. Tests
   * exercising retention point this at their FixedClock for determinism.
   */
  nowMs: () => number = () => Date.now();

  private readonly spaceConfigs = new Map<string, SpaceConfig>();
  /** Where the trash retention sweep resumes, by environment (as `environments.trash_sweep_cursor`). */
  private readonly trashSweepCursors = new Map<string, ExpiredTrashEntry>();
  private readonly contentTypeData = new JournaledMap<string, ContentType>();
  /** As the D1 column: each type's `singleton` as last saved published, which Delivery serves by. */
  private readonly publishedSingletonData = new JournaledMap<string, boolean>();
  /** As `content_types.published_definition`: kept while a draft revision holds the type. */
  private readonly publishedDefinitionData = new JournaledMap<
    string,
    PublishedContentTypeDefinition
  >();
  private readonly entryData = new JournaledMap<string, Entry>();
  /**
   * When each entry last changed, standing in for D1's `updated_at`: stamped from `nowMs`, and
   * nudged a millisecond past the last stamp so write order is total even on a frozen clock.
   */
  private readonly entryTouched = new JournaledMap<string, string>();
  private lastEntryTouch = 0;
  private readonly versionData = new JournaledMap<string, EntryVersion[]>();
  /** Archived versions' object keys, by `${scopeKey}::${entryId}::${version}`. */
  private readonly archivedBodies = new Map<string, string>();
  /** Where archived version bodies are read from (as the D1 store's `versionBodies`). */
  versionBodies?: BlobStore;

  private async resolveVersion(scope: Scope, v: EntryVersion): Promise<EntryVersion> {
    const bodyKey = this.archivedBodies.get(`${scopeKey(scope)}::${v.entryId}::${v.version}`);
    if (!bodyKey) return v;
    const raw = this.versionBodies ? await this.versionBodies.get(bodyKey) : null;
    if (raw === null) return { ...v, fields: {}, bodyUnavailable: true };
    return { ...v, fields: JSON.parse(raw) as EntryFields };
  }
  private readonly publishedData = new JournaledMap<string, PublishedEntry>();
  private readonly outboxData: { event: OutboxEntry; relayed: boolean; relayedAt?: number }[] = [];

  private readonly environmentData = new Map<string, { id: string; name: string }[]>();
  private readonly purgeData = new Map<
    string,
    { spaceId: string; environmentId: string; nudgedAt: Date }
  >();
  private readonly aliasData = new Map<string, EnvironmentAlias>();

  readonly spaces: SpaceRepo = {
    getConfig: async (scope) => this.spaceConfigs.get(scope.spaceId) ?? null,
    list: async () => [...this.spaceConfigs.values()],
    create: async (config) => {
      // As D1: re-creating a space keeps its locale settings unless the config names its own.
      const kept = this.spaceConfigs.get(config.spaceId)?.localeSettings;
      this.spaceConfigs.set(
        config.spaceId,
        !config.localeSettings && kept ? { ...config, localeSettings: kept } : config,
      );
    },
    setLocaleSettings: async (spaceId, settings, expected) => {
      const config = this.spaceConfigs.get(spaceId);
      // As D1's compare-and-set: changed (or gone) since the caller read it is a lost race.
      const was = config?.localeSettings;
      const same = (a: unknown) => (a && Object.keys(a).length > 0 ? JSON.stringify(a) : null);
      if (!config || same(was) !== same(expected)) throw new TransactionConflictError();
      const { localeSettings: _was, ...rest } = config;
      this.spaceConfigs.set(
        spaceId,
        Object.keys(settings).length > 0 ? { ...rest, localeSettings: { ...settings } } : rest,
      );
    },
    getTrashSweepCursor: async (scope) => this.trashSweepCursors.get(scopeKey(scope)) ?? null,
    setTrashSweepCursor: async (scope, cursor) => {
      if (cursor) this.trashSweepCursors.set(scopeKey(scope), cursor);
      else this.trashSweepCursors.delete(scopeKey(scope));
    },
    setTrashRetentionDays: async (spaceId, days) => {
      const config = this.spaceConfigs.get(spaceId);
      if (!config) return;
      const { trashRetentionDays: _was, ...rest } = config;
      this.spaceConfigs.set(spaceId, days === null ? rest : { ...rest, trashRetentionDays: days });
    },
    setWorkflowSeparateDuties: async (spaceId, value) => {
      const config = this.spaceConfigs.get(spaceId);
      if (config) this.spaceConfigs.set(spaceId, { ...config, workflowSeparateDuties: value });
    },
    createEnvironment: async (spaceId, environmentId, name) => {
      // As the D1 store's guard: not while a deleted environment of this id is being purged.
      if (this.purgeData.has(`${spaceId}::${environmentId}`)) throw new TransactionConflictError();
      const list = this.environmentData.get(spaceId) ?? [];
      if (!list.some((e) => e.id === environmentId)) list.push({ id: environmentId, name });
      this.environmentData.set(spaceId, list);
    },
    listEnvironments: async (spaceId) => this.environmentData.get(spaceId) ?? [],
    setAlias: async (spaceId, alias, targetEnvironmentId, at) => {
      // As the D1 store's guard: the target must still exist when the alias lands.
      if (!(this.environmentData.get(spaceId) ?? []).some((e) => e.id === targetEnvironmentId)) {
        throw new TransactionConflictError();
      }
      this.aliasData.set(`${spaceId}::${alias}`, { alias, targetEnvironmentId, updatedAt: at });
    },
    getAlias: async (spaceId, alias) => this.aliasData.get(`${spaceId}::${alias}`) ?? null,
    resolveName: async (spaceId, name) => ({
      targetEnvironmentId: this.aliasData.get(`${spaceId}::${name}`)?.targetEnvironmentId ?? null,
      purging: this.purgeData.has(`${spaceId}::${name}`),
    }),
    listAliases: async (spaceId) => {
      const prefix = `${spaceId}::`;
      return [...this.aliasData.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
    deleteAlias: async (spaceId, alias) => {
      this.aliasData.delete(`${spaceId}::${alias}`);
    },
    deleteEnvironment: async (spaceId, environmentId, events, audit) => {
      // As the D1 store's guard: no alias may point at it when the deletion runs.
      if (
        [...this.aliasData.entries()].some(
          ([k, v]) => k.startsWith(`${spaceId}::`) && v.targetEnvironmentId === environmentId,
        )
      ) {
        throw new TransactionConflictError();
      }
      const list = this.environmentData.get(spaceId) ?? [];
      this.environmentData.set(
        spaceId,
        list.filter((e) => e.id !== environmentId),
      );
      // The rows stay until purged, as on D1; the name can't be reused meanwhile.
      this.purgeData.set(`${spaceId}::${environmentId}`, {
        spaceId,
        environmentId,
        nudgedAt: new Date(audit.at),
      });
      for (const event of events) this.outboxData.push({ event, relayed: false });
      this.auditData.push(audit);
    },
    purgeEnvironmentStep: async (spaceId, environmentId, rowsPerTable, at) => {
      // As the D1 store: nothing without the purge marker (the id may be in use again).
      if (!this.purgeData.has(`${spaceId}::${environmentId}`)) return 0;
      const scope = { spaceId, environmentId };
      const key = scopeKey(scope);
      // The environment-scoped collections, named (a sweep by key prefix would also catch
      // space-level keys such as an alias that shares the environment's name). Not the audit log.
      const scoped: Map<string, unknown>[] = [
        this.contentTypeData,
        this.publishedSingletonData,
        this.publishedDefinitionData,
        this.entryData,
        this.entryTouched,
        this.versionData,
        this.publishedData,
        this.assetData,
        this.publishedAssetData,
        this.assetVersionData,
        this.assetTouched,
        this.assetFolderData,
        this.collectionData,
        this.collectionItemData,
        this.shareLinkData,
        this.zipJobData,
        this.uploadData,
        this.referenceData,
        this.agentRunData,
        this.releaseData,
        this.releaseItemData,
        this.scheduledActionData,
        this.agentReviewData,
        this.agentScheduleData,
        this.commentData,
        this.taskData,
        this.workflowData,
        this.workflowStateData,
        this.workflowVersionData,
        this.workflowRunData,
        this.workflowNodeRunData,
        this.workflowTimelineData,
        this.workflowTaskData,
        this.schemeData,
        this.conceptData,
        this.tagData,
        this.entryMetadataData,
        this.redirectData,
        this.redirectRevisionData,
        this.menuData,
        this.aiActionData,
        this.functionData,
        this.appExtensionData,
        this.previewTokenData,
        this.uniqueData,
        this.bulkJobData,
        this.bulkChunkData,
        this.pluginKvData,
      ];
      let deleted = 0;
      for (const map of scoped) {
        let fromThis = 0;
        for (const [k, v] of map) {
          if (fromThis >= rowsPerTable) break;
          const own = (v as { scope?: Scope } | null)?.scope;
          if (k === key || k.startsWith(`${key}::`) || (own && scopeKey(own) === key)) {
            map.delete(k);
            fromThis += 1;
          }
        }
        deleted += fromThis;
      }
      // The hooks scoped to it (kept per space here, not by scope key); space-wide ones stay.
      const hooks = this.webhookData.get(spaceId) ?? [];
      const doomed = hooks.filter((w) => w.environmentId === environmentId).slice(0, rowsPerTable);
      if (doomed.length > 0) {
        this.webhookData.set(
          spaceId,
          hooks.filter((w) => !doomed.includes(w)),
        );
        deleted += doomed.length;
      }
      const purge = this.purgeData.get(`${spaceId}::${environmentId}`);
      if (purge) purge.nudgedAt = at;
      return deleted;
    },
    markEnvironmentPurgeProgress: async (spaceId, environmentId, at) => {
      const purge = this.purgeData.get(`${spaceId}::${environmentId}`);
      if (purge) purge.nudgedAt = at;
    },
    finishEnvironmentPurge: async (spaceId, environmentId) => {
      this.purgeData.delete(`${spaceId}::${environmentId}`);
    },
    claimStalledPurges: async (staleBefore, at, limit) => {
      const stalled = [...this.purgeData.values()]
        .filter((p) => p.nudgedAt < staleBefore)
        .slice(0, limit);
      for (const p of stalled) p.nudgedAt = at;
      return stalled.map((p) => ({ spaceId: p.spaceId, environmentId: p.environmentId }));
    },
  };

  readonly contentTypes: ContentTypeRepo = {
    get: async (scope, apiId) => this.contentTypeData.get(`${scopeKey(scope)}::${apiId}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.contentTypeData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    // As 0030_published_definition's triggers: leaving published keeps what it was, publishing
    // drops it, and a draft over a draft leaves it alone.
    publishedDefinitions: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return new Map(
        [...this.publishedDefinitionData.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, definition]) => {
            const singleton = this.publishedSingletonData.get(k) === true;
            return [
              k.slice(prefix.length),
              { ...definition, ...(singleton ? { singleton: true as const } : {}) },
            ];
          }),
      );
    },
    save: async (scope, ct) => {
      const key = `${scopeKey(scope)}::${ct.apiId}`;
      const was = this.contentTypeData.get(key);
      if (ct.status === 'published') {
        this.publishedDefinitionData.delete(key);
      } else if (was?.status === 'published') {
        this.publishedDefinitionData.set(key, {
          name: was.name,
          displayField: was.displayField,
          fields: was.fields,
          ...(was.urlPattern ? { urlPattern: was.urlPattern } : {}),
          version: was.version,
        });
      }
      this.contentTypeData.set(key, ct);
      if (ct.status === 'published') this.publishedSingletonData.set(key, ct.singleton === true);
    },
    // As the D1 store's insert: never over a type already there.
    create: async (scope, ct) => {
      const key = `${scopeKey(scope)}::${ct.apiId}`;
      if (this.contentTypeData.has(key)) throw new TransactionConflictError();
      await this.contentTypes.save(scope, ct);
    },
    // As the D1 store's guard: the type as the caller read it, and no other entry outside the trash.
    guard: async (scope, apiId, expected) => {
      const ct = this.contentTypeData.get(`${scopeKey(scope)}::${apiId}`);
      if (!ct || (ct.singleton === true) !== expected.singleton) {
        throw new TransactionConflictError();
      }
      if (expected.entries) {
        const allowed = new Set(expected.entries);
        const prefix = `${scopeKey(scope)}::`;
        const other = [...this.entryData].some(
          ([k, e]) =>
            k.startsWith(prefix) &&
            e.contentTypeApiId === apiId &&
            e.status !== 'archived' &&
            !allowed.has(e.id),
        );
        if (other) throw new TransactionConflictError();
      }
    },
    // Judged at the call, as the D1 store's WHERE judges it at commit.
    delete: async (scope, apiId, version) => {
      const key = `${scopeKey(scope)}::${apiId}`;
      const prefix = `${scopeKey(scope)}::`;
      const hasEntries = [...this.entryData.entries()].some(
        ([k, e]) => k.startsWith(prefix) && e.contentTypeApiId === apiId,
      );
      if (this.contentTypeData.get(key)?.version !== version || hasEntries) {
        throw new TransactionConflictError();
      }
      this.contentTypeData.delete(key);
      this.publishedSingletonData.delete(key);
      this.publishedDefinitionData.delete(key);
    },
  };

  /** As the D1 delivery read: the published view of one type. */
  private deliveredContentType(scope: Scope, ct: ContentType): DeliveredContentType {
    const key = `${scopeKey(scope)}::${ct.apiId}`;
    return deliveredContentType(
      ct,
      this.publishedDefinitionData.get(key) ?? null,
      this.publishedSingletonData.get(key) === true,
    );
  }

  /** As the D1 delivery read: each type as last published. */
  private async deliveredContentTypes(scope: Scope): Promise<DeliveredContentType[]> {
    return (await this.contentTypes.list(scope)).map((ct) => this.deliveredContentType(scope, ct));
  }

  /**
   * As D1 writes an entry: a create records its authorship whole; a later save keeps the creation
   * and fills in the first publish only once (`COALESCE`), whatever the aggregate it is handed says.
   */
  /** As D1: the snapshot's first publish is the entry's, as its aggregate holds it now. */
  private setPublished(scope: Scope, snapshot: PublishedEntry): void {
    const key = `${scopeKey(scope)}::${snapshot.entryId}`;
    const { firstPublishedAt: _carried, position: _place, ...rest } = snapshot;
    const entry = this.entryData.get(key);
    const first = entry?.firstPublishedAt;
    // As 0034's triggers: the published row is where the entry is in its type's order.
    const position = entry?.position;
    this.publishedData.set(key, {
      ...rest,
      ...(first ? { firstPublishedAt: first } : {}),
      ...(position ? { position } : {}),
    });
  }

  /** Every entry of a type in its manual order, trashed ones included, as D1's index reads it. */
  private placesOf(scope: Scope, contentTypeApiId: string): { id: string; position: string }[] {
    const prefix = `${scopeKey(scope)}::`;
    const out: { id: string; position: string }[] = [];
    for (const [key, entry] of this.entryData.entries()) {
      if (!key.startsWith(prefix) || entry.contentTypeApiId !== contentTypeApiId) continue;
      out.push({ id: entry.id, position: entry.position ?? entry.id });
    }
    return out.sort((a, b) =>
      a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
    );
  }

  private setEntry(scope: Scope, entry: Entry, created = false): void {
    const key = `${scopeKey(scope)}::${entry.id}`;
    const before = created ? undefined : this.entryData.get(key);
    this.entryData.set(key, {
      ...entry,
      createdAt: before
        ? (before.createdAt ?? null)
        : (entry.createdAt ?? new Date(this.nowMs()).toISOString()),
      createdBy: before ? (before.createdBy ?? null) : (entry.createdBy ?? null),
      updatedBy: entry.updatedBy ?? null,
      firstPublishedAt: before?.firstPublishedAt ?? entry.firstPublishedAt ?? null,
      // As D1: no save writes the manual order, so an aggregate read before a move can't undo it.
      position: before?.position ?? null,
    });
    this.lastEntryTouch = Math.max(this.nowMs(), this.lastEntryTouch + 1);
    this.entryTouched.set(key, new Date(this.lastEntryTouch).toISOString());
  }

  readonly entries: EntryRepo = {
    get: async (scope, id) => {
      const entry = this.entryData.get(`${scopeKey(scope)}::${id}`);
      if (!entry) return null;
      const versions = this.versionData.get(`${scopeKey(scope)}::${id}`) ?? [];
      const current = versions.find((v) => v.version === entry.currentVersion);
      const result: EntryWithFields = { entry, fields: current?.fields ?? {} };
      return result;
    },
    positionNeighbors: async (scope, contentTypeApiId, key, side, limit, excludeId) => {
      const places = this.placesOf(scope, contentTypeApiId).filter(
        (p) =>
          p.id !== excludeId &&
          (key === null || (side === 'after' ? p.position > key : p.position < key)),
      );
      return (side === 'after' ? places : places.reverse()).slice(0, limit);
    },
    setPositions: async (scope, contentTypeApiId, writes, guard) => {
      // As D1: every check against what the caller read, before any key moves.
      const places = this.placesOf(scope, contentTypeApiId);
      const at = new Map(places.map((p) => [p.id, p.position]));
      if (guard.anchor && at.get(guard.anchor.id) !== guard.anchor.position) {
        throw new TransactionConflictError();
      }
      const moved = new Set(writes.map((w) => w.id));
      const inGap = places.some(
        (p) =>
          !moved.has(p.id) &&
          (guard.lo === null || p.position > guard.lo) &&
          (guard.hi === null || p.position < guard.hi),
      );
      if (inGap || writes.some((w) => at.get(w.id) !== w.expected)) {
        throw new TransactionConflictError();
      }
      for (const w of writes) {
        const key = `${scopeKey(scope)}::${w.id}`;
        const entry = this.entryData.get(key);
        if (entry) this.entryData.set(key, { ...entry, position: w.position });
        // As 0034's trigger: a published row follows.
        const published = this.publishedData.get(key);
        if (published) this.publishedData.set(key, { ...published, position: w.position });
      }
    },
    getMany: async (scope, ids) =>
      // Dedupe first: the D1 store's inArray returns each matching row once, so
      // duplicate input ids must not yield duplicate rows here either.
      [...new Set(ids)].flatMap((id) => {
        const entry = this.entryData.get(`${scopeKey(scope)}::${id}`);
        if (!entry) return [];
        const versions = this.versionData.get(`${scopeKey(scope)}::${id}`) ?? [];
        const current = versions.find((v) => v.version === entry.currentVersion);
        return [{ entry, fields: current?.fields ?? {} }];
      }),
    idsMentioning: async (scope, text, limit) => {
      const prefix = `${scopeKey(scope)}::`;
      const ids: string[] = [];
      for (const [key, entry] of this.entryData) {
        if (!key.startsWith(prefix) || ids.length >= limit) continue;
        const versions = this.versionData.get(key) ?? [];
        const current = versions.find((v) => v.version === entry.currentVersion);
        if (JSON.stringify(current?.fields ?? {}).includes(text)) ids.push(entry.id);
      }
      return ids;
    },
    contentTypesOf: async (scope, ids) =>
      new Map(
        ids.flatMap((id) => {
          const entry = this.entryData.get(`${scopeKey(scope)}::${id}`);
          return entry ? [[id, entry.contentTypeApiId] as const] : [];
        }),
      ),
    list: async (scope, query: EntryQuery) => {
      const prefix = `${scopeKey(scope)}::`;
      let entries = [...this.entryData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
      if (query.contentTypeApiId) {
        entries = entries.filter((e) => e.contentTypeApiId === query.contentTypeApiId);
      }
      // Trash is hidden unless explicitly asked for; `archived: true` is the
      // trash view itself.
      entries = entries.filter((e) =>
        query.archived ? e.status === 'archived' : e.status !== 'archived',
      );
      // Keyset paging by entry id, as the D1 store.
      if (query.afterEntryId !== undefined) {
        const cursor = query.afterEntryId;
        entries = entries
          .filter((e) => cursor === '' || e.id > cursor)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
      const withFields: EntryWithFields[] = entries.map((entry) => {
        const versions = this.versionData.get(`${scopeKey(scope)}::${entry.id}`) ?? [];
        const current = versions.find((v) => v.version === entry.currentVersion);
        const updatedAt = this.entryTouched.get(`${scopeKey(scope)}::${entry.id}`);
        return { entry, fields: current?.fields ?? {}, ...(updatedAt ? { updatedAt } : {}) };
      });
      const filtered = runEntryQuery(
        withFields,
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
    idsOfType: async (scope, contentTypeApiId, page) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.entryData]
        .filter(
          ([k, e]) =>
            k.startsWith(prefix) &&
            e.contentTypeApiId === contentTypeApiId &&
            (!page.after || e.id > page.after),
        )
        .map(([, e]) => e.id)
        .sort()
        .slice(0, page.limit);
    },
    countByStatus: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      const groups = new Map<string, EntryStatusCount>();
      for (const [k, e] of this.entryData) {
        if (!k.startsWith(prefix)) continue;
        const key = `${e.contentTypeApiId}\u0000${e.status}`;
        const g = groups.get(key);
        groups.set(key, {
          contentType: e.contentTypeApiId,
          status: e.status,
          count: (g?.count ?? 0) + 1,
        });
      }
      return [...groups.values()];
    },
    distinctFieldValues: async (scope, query) => {
      const prefix = `${scopeKey(scope)}::`;
      // value key -> (value, entries holding it). Numbers key by number, so 5 and 5.0 are one.
      const groups = new Map<string, { value: string | number | boolean; ids: Set<string> }>();
      for (const [k, e] of this.entryData) {
        if (!k.startsWith(prefix)) continue;
        if (e.contentTypeApiId !== query.contentTypeApiId || e.status === 'archived') continue;
        const versions = this.versionData.get(k) ?? [];
        const localized = versions.find((v) => v.version === e.currentVersion)?.fields[query.field];
        if (!localized || typeof localized !== 'object' || Array.isArray(localized)) continue;
        for (const [locale, raw] of Object.entries(localized)) {
          if (query.locale !== undefined && locale !== query.locale) continue;
          for (const v of Array.isArray(raw) ? raw : [raw]) {
            if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
            const key = `${typeof v}:${String(v)}`;
            const g = groups.get(key) ?? { value: v, ids: new Set<string>() };
            g.ids.add(e.id);
            groups.set(key, g);
          }
        }
      }
      const after = query.after;
      return [...groups.values()]
        .map((g) => ({ value: g.value, count: g.ids.size }))
        .filter((g) => !after || compareFieldValues(g.value, after.value) > 0)
        .sort((a, b) => compareFieldValues(a.value, b.value))
        .slice(0, query.limit);
    },
    create: async (scope, entry, version) => {
      this.setEntry(scope, entry, true);
      this.versionData.set(`${scopeKey(scope)}::${entry.id}`, [version]);
    },
    saveVersion: async (scope, entry, version) => {
      this.setEntry(scope, entry);
      const key = `${scopeKey(scope)}::${entry.id}`;
      const versions = this.versionData.get(key) ?? [];
      versions.push(version);
      this.versionData.set(key, versions);
    },
    saveAggregate: async (scope, entry) => {
      this.setEntry(scope, entry);
    },
    saveAggregateMany: async (scope, entries) => {
      for (const entry of entries) this.setEntry(scope, entry);
    },
    listExpiredTrash: async (scope, before, limit, after) => {
      const prefix = `${scopeKey(scope)}::`;
      const linked = new Set(
        [...this.referenceData.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .flatMap(([, edges]) => edges.map((e) => e.toId)),
      );
      return [...this.entryData.entries()]
        .filter(([k, e]) => k.startsWith(prefix) && e.status === 'archived' && !linked.has(e.id))
        .map(([k, e]) => ({ id: e.id, trashedAt: this.entryTouched.get(k) ?? '' }))
        .filter((e) => e.trashedAt < before.toISOString())
        .filter(
          (e) =>
            !after ||
            e.trashedAt > after.trashedAt ||
            (e.trashedAt === after.trashedAt && e.id > after.id),
        )
        .sort((a, b) =>
          a.trashedAt === b.trashedAt ? (a.id < b.id ? -1 : 1) : a.trashedAt < b.trashedAt ? -1 : 1,
        )
        .slice(0, limit);
    },
    delete: async (scope, id) => {
      this.entryData.delete(`${scopeKey(scope)}::${id}`);
      this.entryTouched.delete(`${scopeKey(scope)}::${id}`);
      this.versionData.delete(`${scopeKey(scope)}::${id}`);
      this.releaseClaims(scope, id);
    },
    // Mirrors the D1 store's unique index rather than merely recording claims:
    // a fake that cannot reject a duplicate would let every uniqueness test
    // pass against behaviour the real store does not have.
    replaceUniqueClaims: async (scope, entryId, claims) => {
      this.releaseClaims(scope, entryId);
      const taken = claims.filter((c) => this.uniqueData.has(claimKey(scope, c)));
      if (taken.length > 0) {
        throw new ConflictError('Another entry already uses one of these values', {
          claims: taken.map((c) => ({ field: c.fieldApiId, locale: c.locale })),
        });
      }
      for (const c of claims) this.uniqueData.set(claimKey(scope, c), { ...c, entryId });
    },
    findUniqueConflicts: async (scope, claims, excludeEntryId) =>
      claims
        .map((c) => this.uniqueData.get(claimKey(scope, c)))
        .filter((held): held is UniqueClaim & { entryId: string } => !!held)
        .filter((held) => held.entryId !== excludeEntryId)
        .map((held) => ({
          fieldApiId: held.fieldApiId,
          locale: held.locale,
          value: held.value,
          entryId: held.entryId,
        })),
    releaseUniqueClaims: async (scope, entryId) => {
      this.releaseClaims(scope, entryId);
    },
    listVersions: async (scope, entryId) =>
      Promise.all(
        [...(this.versionData.get(`${scopeKey(scope)}::${entryId}`) ?? [])]
          .sort((a, b) => b.version - a.version)
          .map((v) => this.resolveVersion(scope, v)),
      ),
    getVersion: async (scope, entryId, version) => {
      const found = this.versionData
        .get(`${scopeKey(scope)}::${entryId}`)
        ?.find((v) => v.version === version);
      return found ? this.resolveVersion(scope, found) : null;
    },
    // The D1 store queues versions as they are superseded and makes them due a day later; here
    // every superseded, unpublished version is due at once (tests drive the sweep directly).
    claimArchivableVersions: async (limit, _now) => {
      const out: ArchivableVersion[] = [];
      for (const [key, versions] of this.versionData) {
        const entry = this.entryData.get(key);
        if (!entry) continue;
        const [spaceId = '', environmentId = ''] = key.split('::');
        for (const v of versions) {
          if (out.length >= limit) return out;
          if (
            !this.archivedBodies.has(`${key}::${v.version}`) &&
            v.version < entry.currentVersion &&
            v.version !== entry.publishedVersion
          ) {
            out.push({
              scope: { spaceId, environmentId },
              entryId: v.entryId,
              version: v.version,
              createdAt: v.createdAt ?? '',
              fields: v.fields,
            });
          }
        }
      }
      return out;
    },
    markVersionsArchived: async (versions) => {
      let marked = 0;
      for (const a of versions) {
        const key = `${scopeKey(a.scope)}::${a.entryId}`;
        const entry = this.entryData.get(key);
        const list = this.versionData.get(key) ?? [];
        const i = list.findIndex((v) => v.version === a.version);
        const existing = list[i];
        // As on D1: re-checked as it marks.
        if (
          !entry ||
          !existing ||
          this.archivedBodies.has(`${key}::${a.version}`) ||
          (existing.createdAt ?? '') !== a.createdAt ||
          a.version >= entry.currentVersion ||
          a.version === entry.publishedVersion
        ) {
          continue;
        }
        list[i] = { ...existing, fields: {} };
        this.archivedBodies.set(`${key}::${a.version}`, a.bodyKey);
        marked += 1;
      }
      return marked;
    },
    putPublished: async (scope, snapshot) => {
      this.setPublished(scope, snapshot);
    },
    putPublishedMany: async (scope, snapshots) => {
      for (const s of snapshots) this.setPublished(scope, s);
    },
    removePublished: async (scope, entryId) => {
      this.publishedData.delete(`${scopeKey(scope)}::${entryId}`);
    },
    removePublishedMany: async (scope, entryIds) => {
      for (const id of entryIds) this.publishedData.delete(`${scopeKey(scope)}::${id}`);
    },
    getPublished: async (scope, id) => this.publishedData.get(`${scopeKey(scope)}::${id}`) ?? null,
    getPublishedMany: async (scope, ids) =>
      [...new Set(ids)].flatMap((id) => this.publishedData.get(`${scopeKey(scope)}::${id}`) ?? []),
    countPublished: async (scope, query) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.publishedData.entries()].filter(
        ([k, v]) =>
          k.startsWith(prefix) && (!query?.contentType || v.contentTypeApiId === query.contentType),
      ).length;
    },
    listPublished: async (scope, query: EntryQuery) => {
      const prefix = `${scopeKey(scope)}::`;
      let rows = [...this.publishedData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
      if (query.contentTypeApiId) {
        rows = rows.filter((r) => r.contentTypeApiId === query.contentTypeApiId);
      }
      if (query.since) rows = rows.filter((r) => r.publishedAt > (query.since as string));
      if (query.afterEntryId !== undefined && query.afterEntryId !== '') {
        const cursor = query.afterEntryId;
        rows = rows.filter((r) => r.entryId > cursor);
      }
      if (query.after) {
        const { publishedAt, entryId } = query.after;
        rows = rows.filter(
          (r) =>
            r.publishedAt > publishedAt || (r.publishedAt === publishedAt && r.entryId > entryId),
        );
      }
      // Keyset paging (afterEntryId, '' = from the start) orders by entryId
      // (stable cursor); the default is publishedAt asc so a `since` cursor
      // advances deterministically. Explicit `order` overrides in runEntryQuery.
      rows.sort((a, b) =>
        query.afterEntryId !== undefined
          ? a.entryId < b.entryId
            ? -1
            : a.entryId > b.entryId
              ? 1
              : 0
          : a.publishedAt < b.publishedAt
            ? -1
            : a.publishedAt > b.publishedAt
              ? 1
              : a.entryId < b.entryId
                ? -1
                : a.entryId > b.entryId
                  ? 1
                  : 0,
      );
      const filtered = runEntryQuery(
        rows,
        query,
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
    searchPublished: async (scope, query, opts) => {
      // Mirrors the D1 store's built-in search: every
      // term must be present; score is total term frequency across all string
      // field values (all locales).
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];
      const prefix = `${scopeKey(scope)}::`;
      const hits: { entryId: string; score: number }[] = [];
      for (const [key, row] of this.publishedData.entries()) {
        if (!key.startsWith(prefix)) continue;
        const texts: string[] = [];
        for (const localized of Object.values(row.fields)) {
          for (const value of Object.values(localized)) {
            if (typeof value === 'string') texts.push(value.toLowerCase());
          }
        }
        const haystack = texts.join(' ');
        let score = 0;
        let matchedAll = true;
        for (const term of terms) {
          let count = 0;
          let at = haystack.indexOf(term);
          while (at !== -1) {
            count += 1;
            at = haystack.indexOf(term, at + term.length);
          }
          if (count === 0) {
            matchedAll = false;
            break;
          }
          score += count;
        }
        if (matchedAll) hits.push({ entryId: row.entryId, score });
      }
      return hits
        .sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId))
        .slice(0, opts.topK);
    },
  };

  private readonly assetData = new JournaledMap<string, Asset>();
  private readonly publishedAssetData = new JournaledMap<string, PublishedAsset>();
  /** Earlier files, keyed `scope::assetId::version`. */
  private readonly assetVersionData = new JournaledMap<string, AssetVersionRecord>();
  /** Write order per asset key, standing in for D1's `updated_at` (the clock may be frozen). */
  private readonly assetTouched = new JournaledMap<string, number>();
  private assetWrites = 0;
  private readonly assetFolderData = new JournaledMap<string, AssetFolder>();

  private touchAsset(scope: Scope, asset: Asset): void {
    const key = `${scopeKey(scope)}::${asset.id}`;
    this.assetData.set(key, asset);
    this.assetTouched.set(key, ++this.assetWrites);
  }

  readonly assets: AssetRepo = {
    get: async (scope, id) => this.assetData.get(`${scopeKey(scope)}::${id}`) ?? null,
    getMany: async (scope, ids) =>
      [...new Set(ids)].flatMap((id) => this.assetData.get(`${scopeKey(scope)}::${id}`) ?? []),
    list: async (scope, query) => {
      // As the D1 store: filters, then (sort value, id) keyset order, a page plus one.
      const prefix = `${scopeKey(scope)}::`;
      const f = query.filters ?? {};
      const sort = query.sort ?? DEFAULT_ASSET_SORT;
      const sortValue = (key: string, a: Asset): number =>
        sort.field === 'size'
          ? (a.file.size ?? -1)
          : sort.field === 'createdAt'
            ? Date.parse(a.createdAt ?? '1970-01-01T00:00:00Z')
            : (this.assetTouched.get(key) ?? 0);
      const mimeOf = (ct: string) => (ct.split(';')[0] ?? '').trim().toLowerCase();
      const wanted = f.mime?.trim().toLowerCase();
      const rows = [...this.assetData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .filter(([, a]) =>
          f.status === undefined
            ? a.status !== 'archived'
            : f.status === 'all' || a.status === f.status,
        )
        .filter(([, a]) => !f.kind || assetKind(a.file.contentType) === f.kind)
        .filter(([, a]) =>
          !wanted
            ? true
            : wanted.endsWith('/*')
              ? mimeOf(a.file.contentType).startsWith(wanted.slice(0, -1))
              : mimeOf(a.file.contentType) === wanted,
        )
        .filter(([, a]) => !f.tag || a.metadata.tags.includes(f.tag))
        .filter(([, a]) => (f.folderId === undefined ? true : (a.folderId ?? null) === f.folderId))
        .filter(([, a]) => !f.contentHash || a.contentHash === f.contentHash)
        .map(([k, a]) => ({ a, v: sortValue(k, a) }));
      const dir = sort.direction === 'asc' ? 1 : -1;
      rows.sort((x, y) => dir * (x.v - y.v || x.a.id.localeCompare(y.a.id)));
      let start = 0;
      if (query.cursor) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(query.cursor);
        } catch {
          parsed = null;
        }
        if (
          !Array.isArray(parsed) ||
          typeof parsed[0] !== 'number' ||
          typeof parsed[1] !== 'string'
        ) {
          throw new ValidationError([
            { field: 'cursor', message: 'cursor is not one this list returned' },
          ]);
        }
        const [v, id] = parsed as [number, string];
        start = rows.findIndex(
          (r) => dir * (r.v - v) > 0 || (r.v === v && dir * r.a.id.localeCompare(id) > 0),
        );
        if (start < 0) start = rows.length;
      }
      const limit = Math.min(Math.max(1, query.limit ?? 100), 1000);
      const page = rows.slice(start, start + limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => r.a),
        ...(rows.length > start + limit && last
          ? { nextCursor: JSON.stringify([last.v, last.a.id]) }
          : {}),
      };
    },
    create: async (scope, asset) => {
      // As the D1 store's guard: its folder must still exist.
      if (asset.folderId && !this.assetFolderData.has(`${scopeKey(scope)}::${asset.folderId}`)) {
        throw new TransactionConflictError();
      }
      this.touchAsset(scope, asset);
    },
    save: async (scope, asset) => {
      // As the D1 store: an update leaves what ingest owns as ingest last wrote it.
      const current = this.assetData.get(`${scopeKey(scope)}::${asset.id}`);
      if (!current) {
        this.touchAsset(scope, asset);
        return;
      }
      const {
        contentHash: _h,
        ingestStatus: _s,
        ingestError: _e,
        duplicateOf: _d,
        ...edited
      } = asset;
      // As the D1 store: a save from a read taken before a replace committed keeps the file.
      const sameVersion = (current.version ?? 1) === (asset.version ?? 1);
      const { file: _f, r2Key: _k, version: _v, ...kept } = edited;
      this.touchAsset(scope, {
        ...(sameVersion
          ? edited
          : {
              ...kept,
              file: current.file,
              ...(current.r2Key ? { r2Key: current.r2Key } : {}),
              ...(current.version !== undefined ? { version: current.version } : {}),
            }),
        ...(current.contentHash ? { contentHash: current.contentHash } : {}),
        ...(current.ingestStatus ? { ingestStatus: current.ingestStatus } : {}),
        ...(current.ingestError ? { ingestError: current.ingestError } : {}),
        ...(current.duplicateOf ? { duplicateOf: current.duplicateOf } : {}),
      });
    },
    listAwaitingUpload: async (createdBefore, limit) => {
      const out: { scope: Scope; asset: Asset }[] = [];
      for (const [key, a] of this.assetData) {
        const created = a.createdAt ? Date.parse(a.createdAt) : 0;
        if (a.status !== 'draft' || a.ingestStatus || a.file.size !== undefined) continue;
        if (!a.r2Key || created <= 0 || created >= createdBefore.getTime()) continue;
        const [spaceId = '', environmentId = ''] = key.split('::');
        out.push({ scope: { spaceId, environmentId }, asset: a });
      }
      out.sort((x, y) => Date.parse(x.asset.createdAt ?? '') - Date.parse(y.asset.createdAt ?? ''));
      return out.slice(0, Math.max(1, limit));
    },
    recordIngest: async (scope, id, version, patch) => {
      const key = `${scopeKey(scope)}::${id}`;
      const current = this.assetData.get(key);
      if (!current || (current.version ?? 1) !== version) return;
      if (patch.onlyFrom && !patch.onlyFrom.includes(current.ingestStatus ?? null)) return;
      const next: Record<string, unknown> = { ...current };
      const setOrClear = (field: string, value: string | null | undefined) => {
        if (value === undefined) return;
        if (value === null) delete next[field];
        else next[field] = value;
      };
      if (patch.status !== undefined) next.ingestStatus = patch.status;
      setOrClear('ingestError', patch.error);
      setOrClear('contentHash', patch.contentHash);
      setOrClear('duplicateOf', patch.duplicateOf);
      const file = { ...current.file };
      if (patch.size !== undefined) Object.assign(file, { size: patch.size });
      if (patch.width !== undefined) Object.assign(file, { width: patch.width });
      if (patch.height !== undefined) Object.assign(file, { height: patch.height });
      if (patch.placeholder !== undefined) Object.assign(file, { placeholder: patch.placeholder });
      if (patch.contentType !== undefined) Object.assign(file, { contentType: patch.contentType });
      next.file = file;
      // Not a touch: ingest doesn't move the asset in the library's order.
      this.assetData.set(key, next as unknown as Asset);
    },
    recordPublishedFile: async (scope, id, version, measured) => {
      const key = `${scopeKey(scope)}::${id}`;
      const current = this.publishedAssetData.get(key);
      if (!current || (current.version ?? 1) !== version) return;
      const file = { ...current.file };
      if (measured.size !== undefined) Object.assign(file, { size: measured.size });
      if (measured.width !== undefined) Object.assign(file, { width: measured.width });
      if (measured.height !== undefined) Object.assign(file, { height: measured.height });
      if (measured.placeholder !== undefined) {
        Object.assign(file, { placeholder: measured.placeholder });
      }
      this.publishedAssetData.set(key, { ...current, file });
    },
    moveToFolder: async (scope, ids, folderId) => {
      if (folderId !== null && !this.assetFolderData.has(`${scopeKey(scope)}::${folderId}`)) {
        throw new TransactionConflictError();
      }
      for (const id of new Set(ids)) {
        const current = this.assetData.get(`${scopeKey(scope)}::${id}`);
        if (!current) continue;
        const { folderId: _old, ...rest } = current;
        this.touchAsset(scope, folderId === null ? rest : { ...rest, folderId });
      }
    },
    delete: async (scope, id) => {
      // As the D1 store's guard: no entry may link to it.
      const prefix = `${scopeKey(scope)}::`;
      const linked = [...this.referenceData.entries()].some(
        ([k, edges]) => k.startsWith(prefix) && edges.some((e) => e.toId === id),
      );
      if (linked) throw new TransactionConflictError();
      const key = `${prefix}${id}`;
      this.assetData.delete(key);
      this.assetTouched.delete(key);
      this.publishedAssetData.delete(key);
      for (const k of [...this.assetVersionData.keys()]) {
        if (k.startsWith(`${key}::v`)) this.assetVersionData.delete(k);
      }
      // As the D1 store: out of every collection, in the same unit.
      for (const [k, m] of [...this.collectionItemData]) {
        if (k.startsWith(prefix) && m.assetId === id) this.collectionItemData.delete(k);
      }
    },
    replaceFile: async (scope, next, previous) => {
      // As the D1 store's guard: still on the version the caller read.
      const key = `${scopeKey(scope)}::${next.id}`;
      const current = this.assetData.get(key);
      if (!current || (current.version ?? 1) !== previous.version) {
        throw new TransactionConflictError();
      }
      this.assetVersionData.set(`${key}::v${previous.version}`, previous);
      const {
        contentHash: _h,
        ingestStatus: _s,
        ingestError: _e,
        duplicateOf: _d,
        ...kept
      } = current;
      this.touchAsset(scope, {
        ...kept,
        file: next.file,
        version: next.version ?? 1,
        ...(next.r2Key ? { r2Key: next.r2Key } : {}),
        ...(next.contentHash ? { contentHash: next.contentHash } : {}),
        ...(next.ingestStatus ? { ingestStatus: next.ingestStatus } : {}),
        ...(next.ingestError ? { ingestError: next.ingestError } : {}),
        ...(next.duplicateOf ? { duplicateOf: next.duplicateOf } : {}),
      });
    },
    listVersions: async (scope, id) =>
      [...this.assetVersionData.entries()]
        .filter(([k]) => k.startsWith(`${scopeKey(scope)}::${id}::v`))
        .map(([, v]) => v)
        .sort((a, b) => b.version - a.version),
    getVersion: async (scope, id, version) =>
      this.assetVersionData.get(`${scopeKey(scope)}::${id}::v${version}`) ?? null,
    findExpiredPublished: async (at, limit) =>
      [...this.publishedAssetData.entries()]
        .flatMap(([k, p]) => {
          const ms = p.rights?.expiresAt ? Date.parse(p.rights.expiresAt) : Number.NaN;
          if (Number.isNaN(ms) || ms > at.getTime()) return [];
          const [spaceId = '', environmentId = ''] = k.split('::');
          const scope = { spaceId, environmentId };
          if (!this.registered(scope)) return [];
          return [{ scope, assetId: p.assetId, expiresAt: new Date(ms).toISOString(), ms }];
        })
        .sort((a, b) => a.ms - b.ms)
        .slice(0, Math.max(1, limit))
        .map(({ ms: _ms, ...found }) => found),
    removeExpiredPublished: async (scope, id, at) => {
      // As the D1 store's guard: still expired by `at`.
      const key = `${scopeKey(scope)}::${id}`;
      const p = this.publishedAssetData.get(key);
      const ms = p?.rights?.expiresAt ? Date.parse(p.rights.expiresAt) : Number.NaN;
      if (!p || Number.isNaN(ms) || ms > at.getTime()) throw new TransactionConflictError();
      this.publishedAssetData.delete(key);
    },
    putPublished: async (scope, snapshot) => {
      this.publishedAssetData.set(`${scopeKey(scope)}::${snapshot.assetId}`, snapshot);
    },
    removePublished: async (scope, id) => {
      this.publishedAssetData.delete(`${scopeKey(scope)}::${id}`);
    },
    getPublished: async (scope, id) =>
      this.publishedAssetData.get(`${scopeKey(scope)}::${id}`) ?? null,
    getPublishedMany: async (scope, ids) =>
      [...new Set(ids)].flatMap(
        (id) => this.publishedAssetData.get(`${scopeKey(scope)}::${id}`) ?? [],
      ),
    listPublished: async (scope, query) => {
      // As the D1 store: filters, then (publishedAt, id) keyset order, a page plus one.
      const prefix = `${scopeKey(scope)}::`;
      const f = query.filters ?? {};
      const rows = [...this.publishedAssetData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, p]) => ({ p, t: Date.parse(p.publishedAt) }))
        .filter(({ p }) => !f.kind || assetKind(p.file.contentType) === f.kind)
        .filter(({ p }) => !f.tag || p.metadata.tags.includes(f.tag))
        .filter(({ p }) =>
          f.folderId === undefined
            ? true
            : (this.assetData.get(`${prefix}${p.assetId}`)?.folderId ?? null) === f.folderId,
        )
        .sort((x, y) => x.t - y.t || x.p.assetId.localeCompare(y.p.assetId));
      let start = Math.max(0, query.skip ?? 0);
      if (query.cursor) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(query.cursor);
        } catch {
          parsed = null;
        }
        if (
          !Array.isArray(parsed) ||
          typeof parsed[0] !== 'number' ||
          typeof parsed[1] !== 'string'
        ) {
          throw new ValidationError([
            { field: 'cursor', message: 'cursor is not one this list returned' },
          ]);
        }
        const [t, id] = parsed as [number, string];
        start = rows.findIndex((r) => r.t > t || (r.t === t && r.p.assetId.localeCompare(id) > 0));
        if (start < 0) start = rows.length;
      }
      const limit = Math.min(Math.max(1, query.limit ?? 100), 1000);
      const page = rows.slice(start, start + limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => r.p),
        ...(rows.length > start + limit && last
          ? { nextCursor: JSON.stringify([last.t, last.p.assetId]) }
          : {}),
      };
    },
  };

  /** Rendition presets, keyed by space (they belong to it, not to an environment). */
  private readonly renditionData = new JournaledMap<string, AssetRendition>();

  readonly assetRenditions: AssetRenditionRepo = {
    list: async (scope) =>
      [...this.renditionData.entries()]
        .filter(([k]) => k.startsWith(`${scope.spaceId}::`))
        .map(([, r]) => r)
        .sort((a, b) => a.name.localeCompare(b.name)),
    get: async (scope, name) => this.renditionData.get(`${scope.spaceId}::${name}`) ?? null,
    put: async (scope, rendition) => {
      const key = `${scope.spaceId}::${rendition.name}`;
      const existing = this.renditionData.get(key);
      this.renditionData.set(
        key,
        existing ? { ...rendition, createdAt: existing.createdAt } : rendition,
      );
    },
    delete: async (scope, name) => {
      this.renditionData.delete(`${scope.spaceId}::${name}`);
    },
  };

  readonly assetFolders: AssetFolderRepo = {
    get: async (scope, id) => this.assetFolderData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.assetFolderData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, f]) => f)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    create: async (scope, folder) => {
      const prefix = `${scopeKey(scope)}::`;
      // As the D1 store's guard: the parent must still exist.
      if (folder.parentId && !this.assetFolderData.has(`${prefix}${folder.parentId}`)) {
        throw new TransactionConflictError();
      }
      // As D1's unique index on (parent, name).
      for (const [k, f] of this.assetFolderData) {
        if (k.startsWith(prefix) && f.parentId === folder.parentId && f.name === folder.name) {
          throw new ConflictError('A unique value is already taken');
        }
      }
      this.assetFolderData.set(`${prefix}${folder.id}`, folder);
    },
    save: async (scope, folder, previousPath) => {
      const prefix = `${scopeKey(scope)}::`;
      for (const [k, f] of this.assetFolderData) {
        if (
          k.startsWith(prefix) &&
          f.id !== folder.id &&
          f.parentId === folder.parentId &&
          f.name === folder.name
        ) {
          throw new ConflictError('A unique value is already taken');
        }
      }
      if (folder.path !== previousPath) {
        for (const [k, f] of this.assetFolderData) {
          if (k.startsWith(prefix) && f.path.startsWith(previousPath)) {
            this.assetFolderData.set(k, {
              ...f,
              path: folder.path + f.path.slice(previousPath.length),
            });
          }
        }
      }
      this.assetFolderData.set(`${prefix}${folder.id}`, folder);
    },
    delete: async (scope, id) => {
      const prefix = `${scopeKey(scope)}::`;
      const hasChild = [...this.assetFolderData.entries()].some(
        ([k, f]) => k.startsWith(prefix) && f.parentId === id,
      );
      const hasAsset = [...this.assetData.entries()].some(
        ([k, a]) => k.startsWith(prefix) && a.folderId === id,
      );
      if (hasChild || hasAsset) throw new TransactionConflictError();
      this.assetFolderData.delete(`${prefix}${id}`);
    },
  };

  private readonly collectionData = new JournaledMap<string, Omit<AssetCollection, 'itemCount'>>();
  /** Memberships by `${scopeKey}::${collectionId}::${assetId}`. */
  private readonly collectionItemData = new JournaledMap<
    string,
    { collectionId: string; assetId: string; position: number; addedAt: string }
  >();

  /** A collection's memberships, in order (position, then asset id). */
  private membersOf(scope: Scope, id: string) {
    const prefix = `${scopeKey(scope)}::${id}::`;
    return [...this.collectionItemData.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v)
      .sort((a, b) => a.position - b.position || a.assetId.localeCompare(b.assetId));
  }

  private withCount(scope: Scope, c: Omit<AssetCollection, 'itemCount'>): AssetCollection {
    // As the D1 store: members whose asset exists.
    const count = this.membersOf(scope, c.id).filter((m) =>
      this.assetData.has(`${scopeKey(scope)}::${m.assetId}`),
    ).length;
    return { ...c, itemCount: count };
  }

  readonly assetCollections: AssetCollectionRepo = {
    get: async (scope, id) => {
      const c = this.collectionData.get(`${scopeKey(scope)}::${id}`);
      return c ? this.withCount(scope, c) : null;
    },
    list: async (scope, query = {}) => {
      const prefix = `${scopeKey(scope)}::`;
      const all = [...this.collectionData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, c]) => c)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id)));
      let start = 0;
      if (query.cursor) {
        const [name, id] = JSON.parse(query.cursor) as [string, string];
        start = all.findIndex((c) => c.name > name || (c.name === name && c.id > id));
        if (start < 0) start = all.length;
      }
      const limit = Math.min(Math.max(1, query.limit ?? 100), 1000);
      const page = all.slice(start, start + limit);
      const last = page.at(-1);
      return {
        items: page.map((c) => this.withCount(scope, c)),
        ...(all.length > start + limit && last
          ? { nextCursor: JSON.stringify([last.name, last.id]) }
          : {}),
      };
    },
    create: async (scope, collection) => {
      const { itemCount: _count, ...rest } = collection;
      this.collectionData.set(`${scopeKey(scope)}::${collection.id}`, rest);
    },
    save: async (scope, collection) => {
      const key = `${scopeKey(scope)}::${collection.id}`;
      const current = this.collectionData.get(key);
      // As the D1 store's compare-and-set: the collection must still exist.
      if (!current) throw new TransactionConflictError();
      const { description: _d, ...kept } = current;
      this.collectionData.set(key, {
        ...kept,
        name: collection.name,
        ...(collection.description ? { description: collection.description } : {}),
        updatedAt: collection.updatedAt,
      });
    },
    delete: async (scope, id) => {
      for (const m of this.membersOf(scope, id)) {
        this.collectionItemData.delete(`${scopeKey(scope)}::${id}::${m.assetId}`);
      }
      this.collectionData.delete(`${scopeKey(scope)}::${id}`);
    },
    addItems: async (scope, id, assetIds, at, maxItems) => {
      const key = `${scopeKey(scope)}::${id}`;
      const collection = this.collectionData.get(key);
      // As the D1 store's guard: the collection must still exist.
      if (!collection) throw new TransactionConflictError();
      const members = this.membersOf(scope, id);
      const present = new Set(members.map((m) => m.assetId));
      // As D1's INSERT … SELECT: only assets of this scope, members already there skipped.
      const adding = [...new Set(assetIds)].filter(
        (a) => !present.has(a) && this.assetData.has(`${scopeKey(scope)}::${a}`),
      );
      // As the D1 store's guard: no more than the cap afterwards.
      const counted = members.filter((m) => this.assetData.has(`${scopeKey(scope)}::${m.assetId}`));
      if (counted.length + adding.length > maxItems) throw new TransactionConflictError();
      const base = Math.max(-1, ...members.map((m) => m.position)) + 1;
      const order = [...new Set(assetIds)];
      for (const assetId of adding) {
        this.collectionItemData.set(`${key}::${assetId}`, {
          collectionId: id,
          assetId,
          position: base + order.indexOf(assetId),
          addedAt: at.toISOString(),
        });
      }
      this.collectionData.set(key, { ...collection, updatedAt: at.toISOString() });
    },
    removeItems: async (scope, id, assetIds) => {
      for (const assetId of assetIds) {
        this.collectionItemData.delete(`${scopeKey(scope)}::${id}::${assetId}`);
      }
    },
    reorder: async (scope, id, assetIds) => {
      // As the D1 store's guard: the collection must still exist.
      if (!this.collectionData.has(`${scopeKey(scope)}::${id}`)) {
        throw new TransactionConflictError();
      }
      const order = [...new Set(assetIds)];
      const named = new Set(order);
      for (const m of this.membersOf(scope, id)) {
        const k = `${scopeKey(scope)}::${id}::${m.assetId}`;
        this.collectionItemData.set(k, {
          ...m,
          position: named.has(m.assetId) ? order.indexOf(m.assetId) : m.position + order.length,
        });
      }
    },
    listItems: async (scope, id, query) => {
      // The library's filters, applied as its listing applies them.
      const allowed = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.assets.list(scope, {
          limit: 1000,
          filters: query.filters ?? {},
          ...(cursor ? { cursor } : {}),
        });
        for (const a of page.items) allowed.add(a.id);
        cursor = page.nextCursor;
      } while (cursor);
      let rows = this.membersOf(scope, id).filter((m) => allowed.has(m.assetId));
      if (query.cursor) {
        const [position, assetId] = JSON.parse(query.cursor) as [number, string];
        rows = rows.filter(
          (m) => m.position > position || (m.position === position && m.assetId > assetId),
        );
      }
      const limit = Math.min(Math.max(1, query.limit ?? 100), 1000);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.flatMap((m) => {
          const a = this.assetData.get(`${scopeKey(scope)}::${m.assetId}`);
          return a ? [a] : [];
        }),
        ...(rows.length > limit && last
          ? { nextCursor: JSON.stringify([last.position, last.assetId]) }
          : {}),
      };
    },
    listItemIds: async (scope, id) => this.membersOf(scope, id).map((m) => m.assetId),
    listPublishedItems: async (scope, id, query) => {
      let rows = this.membersOf(scope, id).filter((m) =>
        this.publishedAssetData.has(`${scopeKey(scope)}::${m.assetId}`),
      );
      if (query.cursor) {
        const [position, assetId] = JSON.parse(query.cursor) as [number, string];
        rows = rows.filter(
          (m) => m.position > position || (m.position === position && m.assetId > assetId),
        );
      }
      const limit = Math.min(Math.max(1, query.limit ?? 100), 1000);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.flatMap((m) => {
          const p = this.publishedAssetData.get(`${scopeKey(scope)}::${m.assetId}`);
          return p ? [p] : [];
        }),
        ...(rows.length > limit && last
          ? { nextCursor: JSON.stringify([last.position, last.assetId]) }
          : {}),
      };
    },
    restore: async (scope, collection, assetIds) => {
      const key = `${scopeKey(scope)}::${collection.id}`;
      if (!this.collectionData.has(key)) {
        const { itemCount: _count, ...rest } = collection;
        this.collectionData.set(key, rest);
      }
      [...new Set(assetIds)].forEach((assetId, position) => {
        const k = `${key}::${assetId}`;
        if (this.collectionItemData.has(k)) return;
        this.collectionItemData.set(k, {
          collectionId: collection.id,
          assetId,
          position,
          addedAt: collection.updatedAt,
        });
      });
    },
    hasItem: async (scope, id, assetId) =>
      this.collectionItemData.has(`${scopeKey(scope)}::${id}::${assetId}`),
    collectionsOf: async (scope, assetId, limit) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.collectionItemData.entries()]
        .filter(([k, m]) => k.startsWith(prefix) && m.assetId === assetId)
        .map(([, m]) => m.collectionId)
        .slice(0, Math.max(1, limit));
    },
  };

  private readonly shareLinkData = new JournaledMap<string, StoredAssetShareLink>();

  readonly assetShareLinks: AssetShareLinkRepo = {
    get: async (scope, id) => this.shareLinkData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope, query) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.shareLinkData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, l]) => l)
        .filter(
          (l) =>
            (!query.targetType || l.targetType === query.targetType) &&
            (!query.targetId || l.targetId === query.targetId) &&
            (query.includeInactive ||
              (!l.revokedAt && Date.parse(l.expiresAt) > query.now.getTime())),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, Math.min(Math.max(1, query.limit ?? 100), 1000));
    },
    create: async (scope, link) => {
      // As the D1 store's guard: the target must still exist.
      const target =
        link.targetType === 'asset'
          ? this.assetData.has(`${scopeKey(scope)}::${link.targetId}`)
          : this.collectionData.has(`${scopeKey(scope)}::${link.targetId}`);
      if (!target) throw new TransactionConflictError();
      this.shareLinkData.set(`${scopeKey(scope)}::${link.id}`, link);
    },
    revoke: async (scope, id, at) => {
      const key = `${scopeKey(scope)}::${id}`;
      const link = this.shareLinkData.get(key);
      // As the D1 store's compare-and-set: only a link not revoked yet.
      if (!link || link.revokedAt) throw new TransactionConflictError();
      this.shareLinkData.set(key, { ...link, revokedAt: at.toISOString() });
    },
  };

  private readonly zipJobData = new JournaledMap<string, AssetZipJob>();

  readonly assetZips: AssetZipJobRepo = {
    get: async (scope, id) => this.zipJobData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope, limit) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.zipJobData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, j]) => j)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, Math.max(1, limit));
    },
    create: async (scope, job) => {
      this.zipJobData.set(`${scopeKey(scope)}::${job.id}`, job);
    },
    update: async (scope, id, patch) => {
      const key = `${scopeKey(scope)}::${id}`;
      const job = this.zipJobData.get(key);
      if (!job) return;
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ) as Partial<AssetZipJob>;
      this.zipJobData.set(key, { ...job, ...defined });
    },
    listExpired: async (at, limit) =>
      [...this.zipJobData.entries()]
        .filter(([, j]) => Date.parse(j.expiresAt) <= at.getTime())
        .sort(([, a], [, b]) => a.expiresAt.localeCompare(b.expiresAt))
        .slice(0, Math.max(1, limit))
        .map(([k, j]) => {
          const [spaceId = '', environmentId = ''] = k.split('::');
          return { scope: { spaceId, environmentId }, id: j.id };
        }),
    delete: async (scope, id) => {
      this.zipJobData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly uploadData = new JournaledMap<string, AssetUpload>();

  readonly assetUploads: AssetUploadRepo = {
    get: async (scope, assetId, uploadId) =>
      this.uploadData.get(`${scopeKey(scope)}::${assetId}::${uploadId}`) ?? null,
    create: async (scope, upload) => {
      this.uploadData.set(`${scopeKey(scope)}::${upload.assetId}::${upload.uploadId}`, upload);
    },
    delete: async (scope, assetId, uploadId) => {
      this.uploadData.delete(`${scopeKey(scope)}::${assetId}::${uploadId}`);
    },
    listForAsset: async (scope, assetId) =>
      [...this.uploadData.entries()]
        .filter(([k]) => k.startsWith(`${scopeKey(scope)}::${assetId}::`))
        .map(([, u]) => u)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    listStartedBefore: async (before, limit) =>
      [...this.uploadData.entries()]
        .filter(([, u]) => Date.parse(u.createdAt) < before.getTime())
        .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, Math.max(1, limit))
        .map(([k, upload]) => {
          const [spaceId = '', environmentId = ''] = k.split('::');
          return { scope: { spaceId, environmentId }, upload };
        }),
  };

  private readonly referenceData = new JournaledMap<string, ReferenceEdge[]>();

  readonly references: ReferenceRepo = {
    replaceForEntry: async (scope, fromEntryId, edges) => {
      this.referenceData.set(`${scopeKey(scope)}::${fromEntryId}`, [...edges]);
    },
    replaceForEntries: async (scope, replacements) => {
      for (const r of replacements) {
        this.referenceData.set(`${scopeKey(scope)}::${r.fromEntryId}`, [...r.edges]);
      }
    },
    removeForEntry: async (scope, fromEntryId) => {
      this.referenceData.delete(`${scopeKey(scope)}::${fromEntryId}`);
    },
    findForward: async (scope, fromEntryId) =>
      this.referenceData.get(`${scopeKey(scope)}::${fromEntryId}`) ?? [],
    findReverse: async (scope, toId) => {
      const prefix = `${scopeKey(scope)}::`;
      const out: ReferenceEdge[] = [];
      for (const [k, edges] of this.referenceData.entries()) {
        if (!k.startsWith(prefix)) continue;
        out.push(...edges.filter((e) => e.toId === toId));
      }
      return out;
    },
    findReverseClosure: async (scope, toIds, opts) => {
      // BFS mirror of the D1 store's recursive CTE: bounded by depth and count,
      // cycle-safe via the visited set, seeds excluded from the output.
      const prefix = `${scopeKey(scope)}::`;
      const reverse = new Map<string, string[]>();
      for (const [k, edges] of this.referenceData.entries()) {
        if (!k.startsWith(prefix)) continue;
        for (const e of edges) {
          const list = reverse.get(e.toId) ?? [];
          list.push(e.fromEntryId);
          reverse.set(e.toId, list);
        }
      }
      const seeds = new Set(toIds);
      const visited = new Set<string>();
      let frontier = [...seeds];
      for (let depth = 0; depth < opts.maxDepth && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const from of reverse.get(id) ?? []) {
            if (seeds.has(from) || visited.has(from)) continue;
            if (visited.size >= opts.maxEntries) return [...visited];
            visited.add(from);
            next.push(from);
          }
        }
        frontier = next;
      }
      return [...visited];
    },
  };

  private readonly webhookData = new Map<string, Webhook[]>();
  /** As the D1 store: the hooks scoped to the scope's environment, and the space-wide ones. */
  private visibleWebhooks(scope: Scope): Webhook[] {
    return (this.webhookData.get(scope.spaceId) ?? []).filter((w) =>
      coversEnvironment(w, scope.environmentId),
    );
  }
  readonly webhookDeliveries: WebhookDeliveryRecord[] = [];
  /** The space each delivery record belongs to (the records keep the port's shape). */
  private readonly deliverySpace = new Map<number, string>();
  private deliverySeq = 0;

  readonly webhooks: WebhookRepo = {
    create: async (scope, webhook) => {
      const key = scope.spaceId;
      const list = this.webhookData.get(key) ?? [];
      list.push(webhook);
      this.webhookData.set(key, list);
    },
    get: async (scope, id) => this.visibleWebhooks(scope).find((w) => w.id === id) ?? null,
    list: async (scope) => this.visibleWebhooks(scope),
    listByTopic: async (scope, type) =>
      this.visibleWebhooks(scope).filter((w) => matchesTopic(w, type)),
    update: async (scope, webhook) => {
      const list = this.webhookData.get(scope.spaceId) ?? [];
      this.webhookData.set(
        scope.spaceId,
        list.map((w) =>
          w.id === webhook.id && coversEnvironment(w, scope.environmentId) ? webhook : w,
        ),
      );
    },
    delete: async (scope, id) => {
      const list = this.webhookData.get(scope.spaceId) ?? [];
      this.webhookData.set(
        scope.spaceId,
        list.filter((w) => !(w.id === id && coversEnvironment(w, scope.environmentId))),
      );
    },
    recordDelivery: async (scope, delivery) => {
      this.deliverySeq += 1;
      this.deliverySpace.set(this.deliverySeq, scope.spaceId);
      this.webhookDeliveries.push({
        ...delivery,
        id: this.deliverySeq,
        // Stamped from the injectable time source (like the real adapter's
        // DB default) so retention tests can control record age.
        createdAt: new Date(this.nowMs()).toISOString(),
      });
    },
    getDelivery: async (scope, webhookId, id) =>
      this.webhookDeliveries.find(
        (d) =>
          d.id === id &&
          d.webhookId === webhookId &&
          this.deliverySpace.get(d.id) === scope.spaceId,
      ) ?? null,
    listDeliveries: async (scope, webhookId, opts) =>
      this.webhookDeliveries
        .filter((d) => d.webhookId === webhookId && this.deliverySpace.get(d.id) === scope.spaceId)
        .sort((a, b) => b.id - a.id)
        .slice(0, opts?.limit ?? 50),
    deleteDeliveriesBefore: async (before, limit) => {
      const cutoff = before.toISOString();
      let deleted = 0;
      for (let i = this.webhookDeliveries.length - 1; i >= 0 && deleted < limit; i--) {
        const record = this.webhookDeliveries[i];
        if (record && record.createdAt < cutoff) {
          this.deliverySpace.delete(record.id);
          this.webhookDeliveries.splice(i, 1);
          deleted += 1;
        }
      }
      return deleted;
    },
  };

  /**
   * Delivery's batched reads, answered by the repos each part names: the same answers the D1
   * store's single batch gives, so a use-case reads the same either way.
   */
  readonly delivery: DeliveryReadRepo = {
    read: async (scope, request) => {
      const [config, contentTypes, renditions, entry, asset, entries, assets, assetPage] =
        await Promise.all([
          request.config ? this.spaces.getConfig(scope) : undefined,
          request.contentTypes ? this.deliveredContentTypes(scope) : undefined,
          request.renditions ? this.assetRenditions.list(scope) : undefined,
          request.entryId !== undefined
            ? this.entries.getPublished(scope, request.entryId)
            : undefined,
          request.assetId !== undefined
            ? this.assets.getPublished(scope, request.assetId)
            : undefined,
          request.entryIds ? this.entries.getPublishedMany(scope, request.entryIds) : undefined,
          request.assetIds ? this.assets.getPublishedMany(scope, request.assetIds) : undefined,
          request.assetPage ? this.assets.listPublished(scope, request.assetPage) : undefined,
        ]);
      const tags = request.tags
        ? request.tags.slugs
          ? await this.taxonomy.findTagsBySlug(scope, request.tags.slugs)
          : await this.taxonomy.listTags(scope)
        : undefined;
      const concepts = request.concepts
        ? (await this.taxonomy.listConcepts(scope, request.concepts.schemeId)).filter(
            (c) => !request.concepts?.slugs || request.concepts.slugs.includes(c.slug),
          )
        : undefined;
      let termUsage: TermUsage[] | undefined;
      if (request.termUsage) {
        const q = request.termUsage;
        const narrowed = q.slugs !== undefined || (q.kind === 'concept' && q.schemeId);
        const terms: (Tag | Concept)[] =
          q.kind === 'tag'
            ? await this.taxonomy.listTags(scope)
            : await this.taxonomy.listConcepts(scope, q.schemeId);
        const ids = terms.filter((t) => !q.slugs || q.slugs.includes(t.slug)).map((t) => t.id);
        termUsage = await this.taxonomy.listUsage(scope, {
          kind: q.kind,
          ...(narrowed ? { termIds: ids } : {}),
        });
      }
      let sitemap: SitemapPage | undefined;
      if (request.sitemap) {
        const q = request.sitemap;
        const prefix = `${scopeKey(scope)}::`;
        const types = new Set(q.contentTypes);
        const all = [...this.publishedData.entries()]
          .filter(([k, p]) => k.startsWith(prefix) && types.has(p.contentTypeApiId))
          .map(([, p]) => p)
          .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
        const items = all
          .filter((p) => q.from === undefined || p.entryId >= q.from)
          .filter((p) => q.before === undefined || p.entryId < q.before)
          .slice(0, Math.max(1, q.limit))
          .map((p) => ({
            entryId: p.entryId,
            contentTypeApiId: p.contentTypeApiId,
            fields: Object.fromEntries(
              q.fields.flatMap((f) => (p.fields[f] !== undefined ? [[f, p.fields[f]]] : [])),
            ) as EntryFields,
            publishedAt: p.publishedAt,
          }));
        const size = q.pageStarts;
        sitemap =
          size === undefined
            ? { items }
            : {
                items,
                pageStarts: all.filter((_, i) => i % Math.max(1, size) === 0).map((p) => p.entryId),
              };
      }
      let menu: MenuRead | null | undefined;
      if (request.menu) {
        const found = await this.menus.getByHandle(scope, request.menu.handle);
        if (found) {
          const targets = menuTargets(found.items);
          const termIds = (kind: string) =>
            new Set(targets.terms.filter((t) => t.kind === kind).map((t) => t.id));
          const tagIds = termIds('tag');
          const conceptIds = termIds('concept');
          menu = {
            menu: found,
            entries: await this.entries.getPublishedMany(scope, targets.entryIds),
            tags: (await this.taxonomy.listTags(scope)).filter((t) => tagIds.has(t.id)),
            concepts: (await this.taxonomy.listConcepts(scope)).filter((c) => conceptIds.has(c.id)),
          };
        } else menu = null;
      }
      let singleton: SingletonRead | undefined;
      if (request.singleton) {
        const apiId = request.singleton.contentType;
        const prefix = `${scopeKey(scope)}::`;
        const [first] = [...this.publishedData.entries()]
          .filter(([k, p]) => k.startsWith(prefix) && p.contentTypeApiId === apiId)
          .map(([, p]) => p)
          .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
        const working = await this.contentTypes.get(scope, apiId);
        singleton = {
          contentType: working ? this.deliveredContentType(scope, working) : null,
          publishedSingleton:
            this.publishedSingletonData.get(`${scopeKey(scope)}::${apiId}`) === true,
          entry: first ?? null,
        };
      }
      const result: DeliveryReadResult = {
        ...(singleton ? { singleton } : {}),
        ...(sitemap ? { sitemap } : {}),
        ...(request.config ? { config: config ?? null } : {}),
        ...(contentTypes ? { contentTypes } : {}),
        ...(renditions ? { renditions } : {}),
        ...(request.entryId !== undefined ? { entry: entry ?? null } : {}),
        ...(request.assetId !== undefined ? { asset: asset ?? null } : {}),
        // As D1, where the settings ride the asset statement: present when it found anything.
        ...(request.assetLocales && (asset || assetPage?.items.length)
          ? { assetLocales: { ...(this.spaceConfigs.get(scope.spaceId)?.localeSettings ?? {}) } }
          : {}),
        ...(entries ? { entries } : {}),
        ...(assets ? { assets } : {}),
        ...(assetPage ? { assetPage } : {}),
        ...(tags ? { tags } : {}),
        ...(concepts ? { concepts } : {}),
        ...(termUsage ? { termUsage } : {}),
        ...(request.menu ? { menu: menu ?? null } : {}),
      };
      return result;
    },
  };

  /** Raw sealed-secret access (the reseal sweep's seam), mirroring the D1 store. */
  readonly storedSecrets: StoredSecretRepo = {
    scan: async (column, { excludePrefix, after, limit }) => {
      const rows: StoredSecret[] = [];
      if (column === 'plugin_settings.secrets') {
        for (const p of this.pluginSettingsData.values()) {
          for (const [key, value] of Object.entries(p.secrets)) {
            rows.push({ column, id: `${p.spaceId}/${p.pluginId}`, key, value });
          }
        }
      } else {
        for (const list of this.webhookData.values()) {
          for (const w of list) {
            if (column === 'webhooks.secret') {
              rows.push({ column, id: w.id, value: w.secret });
            } else {
              for (const [key, value] of Object.entries(w.headers ?? {})) {
                rows.push({ column, id: w.id, key, value });
              }
            }
          }
        }
      }
      // Code-unit order on (id, key) — the D1 store orders with SQLite's BINARY collation.
      const order = (x: string, y: string) => (x === y ? 0 : x < y ? -1 : 1);
      const cmp = (a: { id: string; key?: string }, b: { id: string; key?: string }) =>
        order(a.id, b.id) || order(a.key ?? '', b.key ?? '');
      return rows
        .filter((r) => !r.value.startsWith(excludePrefix))
        .filter((r) => !after || cmp(r, after) > 0)
        .sort(cmp)
        .slice(0, limit);
    },
    replace: async (ref, was, next) => {
      if (ref.column === 'plugin_settings.secrets') {
        const slash = ref.id.indexOf('/');
        const k = `${ref.id.slice(0, slash)}::${ref.id.slice(slash + 1)}`;
        const p = this.pluginSettingsData.get(k);
        const key = ref.key ?? '';
        if (!p || p.secrets[key] !== was) return false;
        // The version stays: a reseal is not an edit (see the D1 store).
        this.pluginSettingsData.set(k, { ...p, secrets: { ...p.secrets, [key]: next } });
        return true;
      }
      for (const [spaceId, list] of this.webhookData) {
        const i = list.findIndex((w) => w.id === ref.id);
        const w = list[i];
        if (!w) continue;
        if (ref.column === 'webhooks.secret') {
          if (w.secret !== was) return false;
          list[i] = { ...w, secret: next };
        } else {
          const key = ref.key ?? '';
          if (w.headers?.[key] !== was) return false;
          list[i] = { ...w, headers: { ...w.headers, [key]: next } };
        }
        this.webhookData.set(spaceId, list);
        return true;
      }
      return false;
    },
  };

  private readonly apiKeyData = new Map<string, ApiKey>();

  readonly auth: AuthRepo = {
    createApiKey: async (key) => {
      this.apiKeyData.set(key.id, key);
    },
    findByHash: async (hashedToken) =>
      [...this.apiKeyData.values()].find((k) => k.hashedToken === hashedToken && !k.revoked) ??
      null,
    list: async (spaceId) => [...this.apiKeyData.values()].filter((k) => k.spaceId === spaceId),
    revoke: async (id) => {
      const existing = this.apiKeyData.get(id);
      if (existing) this.apiKeyData.set(id, { ...existing, revoked: true });
    },
    touchLastUsed: async (id, at) => {
      const existing = this.apiKeyData.get(id);
      if (existing) {
        this.apiKeyData.set(id, { ...existing, lastUsedAt: at.toISOString() });
      }
    },
    setRole: async (id, roleId, scopes) => {
      const existing = this.apiKeyData.get(id);
      if (!existing) return;
      const { roleId: _dropped, ...rest } = existing;
      this.apiKeyData.set(id, { ...rest, ...(roleId ? { roleId } : {}), scopes: [...scopes] });
    },
  };

  private readonly roleData = new Map<string, Role>();

  readonly roles: RoleRepo = {
    save: async (role) => {
      // Mirrors the adapter's unique (space, preset) index.
      if (
        role.preset &&
        [...this.roleData.values()].some(
          (r) => r.spaceId === role.spaceId && r.preset === role.preset && r.id !== role.id,
        )
      ) {
        throw new Error(`Preset role "${role.preset}" already exists in ${role.spaceId}`);
      }
      this.roleData.set(`${role.spaceId}::${role.id}`, role);
    },
    get: async (spaceId, id) => this.roleData.get(`${spaceId}::${id}`) ?? null,
    list: async (spaceId) => [...this.roleData.values()].filter((r) => r.spaceId === spaceId),
    delete: async (spaceId, id) => {
      this.roleData.delete(`${spaceId}::${id}`);
    },
  };

  private readonly memberData = new JournaledMap<string, SpaceMember>();

  readonly members: MemberRepo = {
    save: async (member) => {
      // Mirrors the adapter's unique (space, email) index.
      if (
        [...this.memberData.values()].some(
          (m) => m.spaceId === member.spaceId && m.email === member.email && m.id !== member.id,
        )
      ) {
        throw new Error(`A member with email ${member.email} already exists in ${member.spaceId}`);
      }
      this.memberData.set(`${member.spaceId}::${member.id}`, member);
    },
    get: async (spaceId, id) => this.memberData.get(`${spaceId}::${id}`) ?? null,
    getByEmail: async (spaceId, email) =>
      [...this.memberData.values()].find((m) => m.spaceId === spaceId && m.email === email) ?? null,
    list: async (spaceId) => [...this.memberData.values()].filter((m) => m.spaceId === spaceId),
    delete: async (spaceId, id) => {
      this.memberData.delete(`${spaceId}::${id}`);
    },
  };

  private readonly inviteData = new JournaledMap<string, MemberInvite>();

  readonly invites: InviteRepo = {
    create: async (invite) => {
      if (this.inviteData.has(invite.id)) throw new Error(`Invite ${invite.id} exists`);
      this.inviteData.set(invite.id, invite);
    },
    get: async (id) => this.inviteData.get(id) ?? null,
    findByTokenHash: async (hash) =>
      [...this.inviteData.values()].find(
        (i) => i.tokenHash === hash || i.emailTokenHash === hash,
      ) ?? null,
    list: async ({ now, status, email, limit }) =>
      [...this.inviteData.values()]
        .filter((i) => status === undefined || inviteStatus(i, now) === status)
        .filter((i) => email === undefined || i.email === email)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, Math.min(Math.max(limit ?? 100, 1), 500)),
    // As the D1 store's guard: a version changed since the caller read it loses the race.
    replace: async (invite, expectedVersion) => {
      if (this.inviteData.get(invite.id)?.version !== expectedVersion) {
        throw new TransactionConflictError();
      }
      this.inviteData.set(invite.id, invite);
    },
    recordEmailToken: async (id, version, emailTokenHash, emailedAt) => {
      const current = this.inviteData.get(id);
      if (!current || current.version !== version || current.status !== 'pending') return false;
      const { emailedAt: _was, ...rest } = current;
      this.inviteData.set(id, { ...rest, emailTokenHash, ...(emailedAt ? { emailedAt } : {}) });
      return true;
    },
  };

  private readonly settingData = new Map<string, StoredSetting>();

  readonly settings: DeploymentSettingsRepo = {
    get: async (key) => this.settingData.get(key) ?? null,
    put: async (key, value, expectedVersion) => {
      const current = this.settingData.get(key);
      if (expectedVersion === null ? current !== undefined : current?.version !== expectedVersion) {
        return false;
      }
      this.settingData.set(key, { value, version: (current?.version ?? 0) + 1 });
      return true;
    },
  };

  private readonly schedulerJobData = new Map<string, SchedulerJobStatus>();

  readonly schedulerJobs: SchedulerJobRepo = {
    record: async (runs) => {
      for (const run of runs) {
        const row = this.schedulerJobData.get(run.job);
        const later = (a: string | undefined, b: string) => (a !== undefined && a >= b ? a : b);
        const next: SchedulerJobStatus = {
          job: run.job,
          lastRunAt: later(row?.lastRunAt, run.at),
          ...(row?.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt } : {}),
          ...(row?.lastErrorAt ? { lastErrorAt: row.lastErrorAt, lastError: row.lastError } : {}),
        };
        if (run.error === undefined) {
          this.schedulerJobData.set(run.job, {
            ...next,
            lastSuccessAt: later(row?.lastSuccessAt, run.at),
          });
        } else if (row?.lastErrorAt === undefined || run.at > row.lastErrorAt) {
          this.schedulerJobData.set(run.job, {
            ...next,
            lastErrorAt: run.at,
            lastError: run.error,
          });
        } else {
          this.schedulerJobData.set(run.job, next);
        }
      }
    },
    list: async () => [...this.schedulerJobData.values()].sort((a, b) => (a.job < b.job ? -1 : 1)),
  };

  private readonly agentRunData = new Map<string, AgentRunRecord[]>();

  readonly agentRuns: AgentRunRepo = {
    record: async (scope, run) => {
      const list = this.agentRunData.get(scope.spaceId) ?? [];
      list.push(run);
      this.agentRunData.set(scope.spaceId, list);
    },
    list: async (scope, query) => {
      let rows = [...(this.agentRunData.get(scope.spaceId) ?? [])];
      if (query.workflow) rows = rows.filter((r) => r.workflow === query.workflow);
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
      return rows.slice(0, query.limit ?? 100);
    },
    usage: async (scope, query) => {
      let rows = this.agentRunData.get(scope.spaceId) ?? [];
      if (query.workflow) rows = rows.filter((r) => r.workflow === query.workflow);
      if (query.since) rows = rows.filter((r) => r.createdAt >= (query.since as string));
      return rows.reduce(
        (acc, r) => ({
          runs: acc.runs + 1,
          inputTokens: acc.inputTokens + r.inputTokens,
          outputTokens: acc.outputTokens + r.outputTokens,
        }),
        { runs: 0, inputTokens: 0, outputTokens: 0 },
      );
    },
  };

  private readonly releaseData = new JournaledMap<string, Release>();
  private readonly releaseItemData = new JournaledMap<string, ReleaseItem[]>();

  private readonly promotionData = new JournaledMap<string, Promotion>();

  readonly promotions: PromotionRepo = {
    create: async (promotion) => {
      this.promotionData.set(`${promotion.spaceId}::${promotion.id}`, cloneJson(promotion));
    },
    get: async (spaceId, id) => {
      const found = this.promotionData.get(`${spaceId}::${id}`);
      return found ? cloneJson(found) : null;
    },
    list: async (spaceId, opts = {}) =>
      [...this.promotionData.values()]
        .filter((p) => p.spaceId === spaceId && (!opts.status || p.status === opts.status))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, Math.min(opts.limit ?? 50, 200))
        .map((p) => cloneJson(p)),
    transition: async (spaceId, id, from, patch) => {
      const key = `${spaceId}::${id}`;
      const found = this.promotionData.get(key);
      // As the D1 store: a compare-and-set on the status it leaves.
      if (!found || found.status !== from) return null;
      const updated: Promotion = { ...found, ...patch };
      this.promotionData.set(key, updated);
      return cloneJson(updated);
    },
  };

  readonly releases: ReleaseRepo = {
    create: async (scope, release) => {
      this.releaseData.set(`${scopeKey(scope)}::${release.id}`, release);
      this.releaseItemData.set(`${scopeKey(scope)}::${release.id}`, []);
    },
    get: async (scope, id) => this.releaseData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.releaseData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    save: async (scope, release) => {
      this.releaseData.set(`${scopeKey(scope)}::${release.id}`, release);
    },
    delete: async (scope, id) => {
      this.releaseData.delete(`${scopeKey(scope)}::${id}`);
      this.releaseItemData.delete(`${scopeKey(scope)}::${id}`);
    },
    addItem: async (scope, releaseId, item) => {
      const key = `${scopeKey(scope)}::${releaseId}`;
      const items = (this.releaseItemData.get(key) ?? []).filter(
        (i) => i.entityId !== item.entityId,
      );
      items.push(item);
      this.releaseItemData.set(key, items);
    },
    removeItem: async (scope, releaseId, entityId) => {
      const key = `${scopeKey(scope)}::${releaseId}`;
      this.releaseItemData.set(
        key,
        (this.releaseItemData.get(key) ?? []).filter((i) => i.entityId !== entityId),
      );
    },
    listItems: async (scope, releaseId) =>
      this.releaseItemData.get(`${scopeKey(scope)}::${releaseId}`) ?? [],
    countItems: async (scope, releaseIds) => {
      const counts = new Map<string, number>();
      for (const id of new Set(releaseIds)) {
        const n = this.releaseItemData.get(`${scopeKey(scope)}::${id}`)?.length ?? 0;
        if (n > 0) counts.set(id, n);
      }
      return counts;
    },
  };

  private readonly scheduledActionData = new Map<string, ScopedScheduledAction>();

  readonly scheduledActions: ScheduledActionRepo = {
    create: async (scope, action) => {
      this.scheduledActionData.set(`${scopeKey(scope)}::${action.id}`, { scope, action });
    },
    get: async (scope, id) =>
      this.scheduledActionData.get(`${scopeKey(scope)}::${id}`)?.action ?? null,
    list: async (scope, query) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.scheduledActionData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v.action)
        .filter((a) => !query?.status || a.status === query.status);
    },
    save: async (scope, action) => {
      this.scheduledActionData.set(`${scopeKey(scope)}::${action.id}`, { scope, action });
    },
    findDue: async (now, limit = 100) =>
      [...this.scheduledActionData.values()]
        .filter(
          (r) =>
            r.action.status === 'pending' &&
            r.action.scheduledFor <= now &&
            this.registered(r.scope),
        )
        .sort((a, b) => (a.action.scheduledFor < b.action.scheduledFor ? -1 : 1))
        .slice(0, limit),
  };

  private readonly agentReviewData = new Map<string, AgentReview>();

  readonly agentReviews: AgentReviewRepo = {
    create: async (scope, review) => {
      this.agentReviewData.set(`${scopeKey(scope)}::${review.id}`, review);
    },
    get: async (scope, id) => this.agentReviewData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope, query) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.agentReviewData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .filter((r) => !query?.status || r.status === query.status)
        .filter((r) => !query?.entryId || r.entryId === query.entryId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, Math.min(query?.limit ?? 100, 1000));
    },
    countPending: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      const types = [...this.agentReviewData.entries()]
        .filter(([k, r]) => k.startsWith(prefix) && r.status === 'pending')
        .map(([, r]) => this.entryData.get(`${prefix}${r.entryId}`)?.contentTypeApiId ?? null);
      return countByType(types);
    },
    decide: async (scope, id, decision) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (review?.status !== 'pending') return false;
      this.agentReviewData.set(key, {
        ...review,
        status: decision.status,
        decidedAt: decision.decidedAt,
        decidedBy: decision.decidedBy,
      });
      return true;
    },
    markAwaiting: async (scope, id) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (!review) return 'pending';
      if (review.status !== 'pending' || review.awaiting) return review.status;
      this.agentReviewData.set(key, { ...review, awaiting: true });
      return 'armed';
    },
    clearAwaiting: async (scope, id) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (review) this.agentReviewData.set(key, { ...review, awaiting: false });
    },
    markApplied: async (scope, id, at) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (!review || review.appliedAt) return false;
      this.agentReviewData.set(key, { ...review, appliedAt: at });
      return true;
    },
    clearApplied: async (scope, id) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (review) this.agentReviewData.set(key, { ...review, appliedAt: undefined });
    },
  };

  private readonly agentScheduleData = new Map<string, { scope: Scope; schedule: AgentSchedule }>();

  readonly agentSchedules: AgentScheduleRepo = {
    create: async (scope, schedule) => {
      this.agentScheduleData.set(`${scopeKey(scope)}::${schedule.id}`, { scope, schedule });
    },
    get: async (scope, id) =>
      this.agentScheduleData.get(`${scopeKey(scope)}::${id}`)?.schedule ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.agentScheduleData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v.schedule)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    save: async (scope, schedule) => {
      this.agentScheduleData.set(`${scopeKey(scope)}::${schedule.id}`, { scope, schedule });
    },
    delete: async (scope, id) => {
      this.agentScheduleData.delete(`${scopeKey(scope)}::${id}`);
    },
    findDue: async (now, limit = 100) =>
      [...this.agentScheduleData.values()]
        .filter(
          (r) => r.schedule.enabled && r.schedule.nextRunAt <= now && this.registered(r.scope),
        )
        .sort((a, b) => (a.schedule.nextRunAt < b.schedule.nextRunAt ? -1 : 1))
        .slice(0, limit),
    claimNextRun: async (scope, id, expectedNextRunAt, nextRunAt) => {
      const key = `${scopeKey(scope)}::${id}`;
      const row = this.agentScheduleData.get(key);
      if (!row || row.schedule.nextRunAt !== expectedNextRunAt) return false;
      this.agentScheduleData.set(key, { scope, schedule: { ...row.schedule, nextRunAt } });
      return true;
    },
    saveRunState: async (scope, id, state) => {
      const key = `${scopeKey(scope)}::${id}`;
      const row = this.agentScheduleData.get(key);
      if (!row) return;
      this.agentScheduleData.set(key, {
        scope,
        schedule: {
          ...row.schedule,
          lastRunAt: state.lastRunAt,
          cursorEntryId: state.cursorEntryId,
        },
      });
    },
  };

  private readonly commentData = new Map<string, Comment>();

  readonly comments: CommentRepo = {
    create: async (scope, comment) => {
      this.commentData.set(`${scopeKey(scope)}::${comment.id}`, comment);
    },
    get: async (scope, id) => this.commentData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listForEntry: async (scope, entryId) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.commentData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .filter((c) => c.entryId === entryId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    delete: async (scope, id) => {
      this.commentData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly taskData = new Map<string, Task>();

  readonly tasks: TaskRepo = {
    create: async (scope, task) => {
      this.taskData.set(`${scopeKey(scope)}::${task.id}`, task);
    },
    get: async (scope, id) => this.taskData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listForEntry: async (scope, entryId) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.taskData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .filter((t) => t.entryId === entryId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    save: async (scope, task) => {
      this.taskData.set(`${scopeKey(scope)}::${task.id}`, task);
    },
    delete: async (scope, id) => {
      this.taskData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  /**
   * One row per workflow, shared by the legacy {@link WorkflowRepo} and the
   * {@link WorkflowGraphRepo} (mirroring the single `workflow_definitions` table).
   */
  private readonly workflowData = new Map<string, Omit<WorkflowGraphRecord, 'latestVersion'>>();
  private readonly workflowStateData = new Map<string, EntryWorkflowState>();
  /** `${scope}::${workflowId}` → versions, ascending. Append-only. */
  private readonly workflowVersionData = new Map<string, WorkflowVersion[]>();

  private workflowRows(scope: Scope) {
    const prefix = `${scopeKey(scope)}::`;
    return [...this.workflowData.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }

  private toWorkflowRecord(
    scope: Scope,
    row: Omit<WorkflowGraphRecord, 'latestVersion'>,
  ): WorkflowGraphRecord {
    const versions = this.workflowVersionData.get(`${scopeKey(scope)}::${row.id}`) ?? [];
    return clone({ ...row, latestVersion: versions.at(-1)?.version ?? null });
  }

  readonly workflows: WorkflowRepo = {
    saveDefinition: async (scope, def) => {
      const key = `${scopeKey(scope)}::${def.id}`;
      const existing = this.workflowData.get(key);
      // Like the D1 store's upsert: a legacy save touches name + steps only.
      this.workflowData.set(key, {
        description: '',
        contentTypes: [],
        graph: null,
        gatesPublish: false,
        updatedAt: null,
        ...existing,
        id: def.id,
        name: def.name,
        steps: clone([...def.steps]),
      });
    },
    getDefinition: async (scope, id) => {
      const row = this.workflowData.get(`${scopeKey(scope)}::${id}`);
      return row ? toLegacyDefinition(row) : null;
    },
    listDefinitions: async (scope) => this.workflowRows(scope).map(toLegacyDefinition),
    deleteDefinition: async (scope, id) => {
      this.workflowData.delete(`${scopeKey(scope)}::${id}`);
    },
    getState: async (scope, entryId) =>
      this.workflowStateData.get(`${scopeKey(scope)}::${entryId}`) ?? null,
    saveState: async (scope, state) => {
      this.workflowStateData.set(`${scopeKey(scope)}::${state.entryId}`, state);
    },
  };

  readonly workflowGraphs: WorkflowGraphRepo = {
    get: async (scope, id) => {
      const row = this.workflowData.get(`${scopeKey(scope)}::${id}`);
      return row ? this.toWorkflowRecord(scope, row) : null;
    },
    list: async (scope) => this.workflowRows(scope).map((r) => this.toWorkflowRecord(scope, r)),
    saveDraft: async (scope, draft) => {
      this.workflowData.set(
        `${scopeKey(scope)}::${draft.id}`,
        clone({
          id: draft.id,
          name: draft.name,
          description: draft.description,
          contentTypes: [...draft.contentTypes],
          graph: draft.graph,
          gatesPublish: draft.gatesPublish ?? false,
          steps: [...draft.steps],
          updatedAt: draft.updatedAt,
        }),
      );
    },
    publishVersion: async (scope, definition, meta) => {
      const key = `${scopeKey(scope)}::${definition.id}`;
      const versions = this.workflowVersionData.get(key) ?? [];
      const version: WorkflowVersion = clone({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        contentTypes: [...definition.contentTypes],
        graph: definition.graph,
        ...(definition.gatesPublish !== undefined ? { gatesPublish: definition.gatesPublish } : {}),
        version: (versions.at(-1)?.version ?? 0) + 1,
        publishedAt: meta.publishedAt,
        ...(meta.publishedBy ? { publishedBy: meta.publishedBy } : {}),
      });
      this.workflowVersionData.set(key, [...versions, version]);
      return clone(version);
    },
    listVersions: async (scope, workflowId) =>
      clone([
        ...(this.workflowVersionData.get(`${scopeKey(scope)}::${workflowId}`) ?? []),
      ]).reverse(),
    getVersion: async (scope, workflowId, version) => {
      const found = this.workflowVersionData
        .get(`${scopeKey(scope)}::${workflowId}`)
        ?.find((v) => v.version === version);
      return found ? clone(found) : null;
    },
    getLatestVersion: async (scope, workflowId) => {
      const latest = this.workflowVersionData.get(`${scopeKey(scope)}::${workflowId}`)?.at(-1);
      return latest ? clone(latest) : null;
    },
    listLatestVersions: async (scope, workflowIds) =>
      [...new Set(workflowIds)].flatMap((id) => {
        const latest = this.workflowVersionData.get(`${scopeKey(scope)}::${id}`)?.at(-1);
        return latest ? [clone(latest)] : [];
      }),
    // As the D1 store: a deleted definition no longer gates, whatever its versions say, and
    // nor does a version no run of which could publish.
    listPublishGates: async (scope) =>
      this.workflowRows(scope).flatMap((row) => {
        const latest = this.workflowVersionData.get(`${scopeKey(scope)}::${row.id}`)?.at(-1);
        if (!latest || !versionGatesPublish(latest)) return [];
        return [
          {
            workflowId: row.id,
            name: row.name,
            version: latest.version,
            contentTypes: [...latest.contentTypes],
          },
        ];
      }),
  };

  // ---- workflow runs / tasks ------------------------------------------------

  private readonly workflowRunData = new JournaledMap<string, WorkflowRun>();
  private readonly workflowNodeRunData = new JournaledMap<string, WorkflowNodeRunRecord>();
  /** `${scope}::${runId}::${key}` → entry. */
  private readonly workflowTimelineData = new JournaledMap<string, WorkflowTimelineRecord>();
  private readonly workflowTaskData = new JournaledMap<string, WorkflowTask>();

  readonly workflowRuns: WorkflowRunRepo = {
    create: async (scope, run) => {
      const key = `${scopeKey(scope)}::${run.id}`;
      if (this.workflowRunData.has(key)) throw new ConflictError(`Workflow run ${run.id} exists`);
      this.workflowRunData.set(key, clone(run));
    },
    get: async (scope, id) => {
      const run = this.workflowRunData.get(`${scopeKey(scope)}::${id}`);
      return run ? clone(run) : null;
    },
    list: async (scope, query = {}) => {
      const prefix = `${scopeKey(scope)}::`;
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      return [...this.workflowRunData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, r]) => r)
        .filter(
          (r) =>
            (!query.entryId || r.entryId === query.entryId) &&
            (!query.workflowId || r.workflowId === query.workflowId) &&
            (!query.status || r.status === query.status),
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, limit)
        .map(clone);
    },
    save: async (scope, run, expectedRev) => {
      const key = `${scopeKey(scope)}::${run.id}`;
      const cur = this.workflowRunData.get(key);
      if (!cur || cur.rev !== expectedRev) return false;
      this.workflowRunData.set(key, clone(run));
      return true;
    },
    recordNodeRun: async (scope, r) => {
      const key = `${scopeKey(scope)}::${r.runId}::${r.generation}::${r.nodeId}::${r.run}`;
      if (!this.workflowNodeRunData.has(key)) this.workflowNodeRunData.set(key, clone(r));
    },
    listNodeRuns: async (scope, runId) => {
      const prefix = `${scopeKey(scope)}::${runId}::`;
      return [...this.workflowNodeRunData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, r]) => clone(r))
        .sort((a, b) => a.endedAt - b.endedAt);
    },
    markNodeRunRolledBack: async (scope, k) => {
      const key = `${scopeKey(scope)}::${k.runId}::${k.generation}::${k.nodeId}::${k.run}`;
      const cur = this.workflowNodeRunData.get(key);
      if (cur?.status !== 'succeeded') return false;
      this.workflowNodeRunData.set(key, { ...cur, status: 'rolled_back' });
      return true;
    },
    putTimeline: async (scope, runId, entry) => {
      this.workflowTimelineData.set(`${scopeKey(scope)}::${runId}::${entry.key}`, clone(entry));
    },
    listTimeline: async (scope, runId) => {
      const prefix = `${scopeKey(scope)}::${runId}::`;
      return [...this.workflowTimelineData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, e]) => clone(e))
        .sort((a, b) => a.seq - b.seq);
    },
    trimTimeline: async (scope, runId, upTo) => {
      const prefix = `${scopeKey(scope)}::${runId}::`;
      for (const [k, e] of this.workflowTimelineData) {
        if (k.startsWith(prefix) && e.seq <= upTo) this.workflowTimelineData.delete(k);
      }
    },
  };

  readonly workflowTasks: WorkflowTaskRepo = {
    create: async (scope, task) => {
      const prefix = `${scopeKey(scope)}::`;
      const dup = [...this.workflowTaskData.entries()].some(
        ([k, t]) =>
          k.startsWith(prefix) && t.runId === task.runId && t.eventType === task.eventType,
      );
      if (dup) return false;
      this.workflowTaskData.set(`${prefix}${task.id}`, clone(task));
      return true;
    },
    get: async (scope, id) => {
      const t = this.workflowTaskData.get(`${scopeKey(scope)}::${id}`);
      return t ? clone(t) : null;
    },
    countPending: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return countByType(
        [...this.workflowTaskData.entries()]
          .filter(([k, t]) => k.startsWith(prefix) && t.status === 'pending')
          .map(([, t]) => t.contentTypeApiId),
      );
    },
    getByEvent: async (scope, runId, eventType) => {
      const prefix = `${scopeKey(scope)}::`;
      const found = [...this.workflowTaskData.entries()].find(
        ([k, t]) => k.startsWith(prefix) && t.runId === runId && t.eventType === eventType,
      );
      return found ? clone(found[1]) : null;
    },
    list: async (scope, query = {}) => {
      const prefix = `${scopeKey(scope)}::`;
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const rows = [...this.workflowTaskData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, t]) => t)
        .filter(
          (t) =>
            (!query.status || t.status === query.status) &&
            (!query.runId || t.runId === query.runId) &&
            (!query.entryId || t.entryId === query.entryId) &&
            (!query.kind || t.kind === query.kind),
        );
      rows.sort((a, b) =>
        query.status === 'pending'
          ? a.deadline.localeCompare(b.deadline)
          : b.requestedAt.localeCompare(a.requestedAt),
      );
      return rows.slice(0, limit).map(clone);
    },
    settle: async (scope, id, outcome) => {
      const key = `${scopeKey(scope)}::${id}`;
      const cur = this.workflowTaskData.get(key);
      if (cur?.status !== 'pending') return false;
      this.workflowTaskData.set(key, { ...cur, ...outcome });
      return true;
    },
  };

  private readonly schemeData = new Map<string, ConceptScheme>();
  private readonly conceptData = new Map<string, Concept>();
  private readonly tagData = new Map<string, Tag>();
  private readonly entryMetadataData = new Map<string, EntryMetadata>();

  /** Refuses a slug another term of the namespace holds, as D1's unique index does. */
  private claimSlug(
    scope: Scope,
    kind: TermKind,
    id: string,
    slug: string,
    schemeId?: string,
  ): void {
    const prefix = `${scopeKey(scope)}::`;
    const terms: (Tag | Concept)[] =
      kind === 'tag'
        ? [...this.tagData.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)
        : [...this.conceptData.entries()]
            .filter(([k, c]) => k.startsWith(prefix) && c.schemeId === schemeId)
            .map(([, v]) => v);
    if (slug && terms.some((t) => t.id !== id && t.slug === slug)) {
      throw new ConflictError('A unique value is already taken');
    }
  }

  /**
   * Usage counts computed from the published snapshots on every read: the oracle the D1 store's
   * maintained counts are checked against.
   */
  private usageOf(scope: Scope, kind: TermKind): TermUsage[] {
    const prefix = `${scopeKey(scope)}::`;
    const counts = new Map<string, TermUsage>();
    for (const [k, p] of this.publishedData) {
      if (!k.startsWith(prefix) || !p.metadata) continue;
      const ids = kind === 'tag' ? p.metadata.tags : p.metadata.concepts;
      for (const termId of new Set(ids)) {
        const key = `${termId}::${p.contentTypeApiId}`;
        const was = counts.get(key)?.count ?? 0;
        counts.set(key, { kind, termId, contentTypeApiId: p.contentTypeApiId, count: was + 1 });
      }
    }
    return [...counts.values()];
  }

  /** `space::env::id` → redirect. */
  private readonly redirectData = new JournaledMap<string, Redirect>();
  /** `space::env` → the set's revision. */
  private readonly redirectRevisionData = new JournaledMap<string, number>();

  private redirectsOf(scope: Scope): Redirect[] {
    const prefix = `${scopeKey(scope)}::`;
    // Code-unit order, as SQLite's BINARY collation orders the D1 store's sources.
    return [...this.redirectData.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v)
      .sort((a, b) =>
        a.source < b.source ? -1 : a.source > b.source ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
  }

  readonly redirects: RedirectRepo = {
    get: async (scope, id) => this.redirectData.get(`${scopeKey(scope)}::${id}`) ?? null,
    all: async (scope, opts = {}) =>
      this.redirectsOf(scope).filter((r) => !opts.enabledOnly || r.enabled),
    list: async (scope, query = {}) => {
      const q = query.q?.trim().toLowerCase();
      const all = this.redirectsOf(scope).filter(
        (r) =>
          !q ||
          r.source.toLowerCase().includes(q) ||
          r.destination.toLowerCase().includes(q) ||
          (r.note ?? '').toLowerCase().includes(q),
      );
      let start = 0;
      if (query.cursor) {
        const [source, id] = JSON.parse(query.cursor) as [string, string];
        start = all.findIndex((r) => r.source > source || (r.source === source && r.id > id));
        if (start < 0) start = all.length;
      }
      const limit = Math.min(Math.max(1, query.limit ?? 100), 1000);
      const page = all.slice(start, start + limit);
      const last = page.at(-1);
      return {
        items: page,
        ...(all.length > start + limit && last
          ? { nextCursor: JSON.stringify([last.source, last.id]) }
          : {}),
      };
    },
    involving: async (scope, paths) =>
      this.redirectsOf(scope).filter(
        (r) => paths.includes(r.source) || paths.includes(r.destination),
      ),
    state: async (scope) => ({
      revision: this.redirectRevisionData.get(scopeKey(scope)) ?? 0,
      count: this.redirectsOf(scope).length,
    }),
    saveMany: async (scope, redirects) => {
      // As the D1 store's unique index: one redirect per source per locale.
      const held = new Map(
        this.redirectsOf(scope).map((r) => [`${r.locale ?? ''}\u0000${r.source}`, r.id]),
      );
      for (const r of redirects) {
        const key = `${r.locale ?? ''}\u0000${r.source}`;
        const other = held.get(key);
        if (other !== undefined && other !== r.id) {
          throw new ConflictError('A unique value is already taken');
        }
        for (const [k, id] of held) if (id === r.id) held.delete(k);
        held.set(key, r.id);
      }
      for (const r of redirects) this.redirectData.set(`${scopeKey(scope)}::${r.id}`, r);
    },
    removeMany: async (scope, ids) => {
      for (const id of ids) this.redirectData.delete(`${scopeKey(scope)}::${id}`);
    },
    advance: async (scope, expected) => {
      const key = scopeKey(scope);
      // As the D1 store's compare-and-set: another writer moved the set since it was read.
      const current = this.redirectRevisionData.get(key) ?? 0;
      if (expected !== undefined && current !== expected) throw new TransactionConflictError();
      this.redirectRevisionData.set(key, current + 1);
    },
  };

  /** `space::env::id` → menu. */
  private readonly menuData = new JournaledMap<string, Menu>();

  private menusOf(scope: Scope): Menu[] {
    const prefix = `${scopeKey(scope)}::`;
    return [...this.menuData.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v)
      .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  }

  readonly menus: MenuRepo = {
    all: async (scope) => this.menusOf(scope),
    get: async (scope, id) => this.menuData.get(`${scopeKey(scope)}::${id}`) ?? null,
    getByHandle: async (scope, handle) =>
      this.menusOf(scope).find((m) => m.handle === handle) ?? null,
    save: async (scope, menu, expected) => {
      const key = `${scopeKey(scope)}::${menu.id}`;
      const current = this.menuData.get(key);
      // As the D1 store: an insert collides on the id, a save on a revision moved since.
      if (expected === undefined ? current : current?.revision !== expected) {
        if (expected === undefined) throw new ConflictError('A unique value is already taken');
        throw new TransactionConflictError();
      }
      // As its unique index: one menu per handle.
      if (this.menusOf(scope).some((m) => m.handle === menu.handle && m.id !== menu.id)) {
        throw new ConflictError('A unique value is already taken');
      }
      this.menuData.set(key, menu);
    },
    delete: async (scope, id, expected) => {
      const key = `${scopeKey(scope)}::${id}`;
      if (this.menuData.get(key)?.revision !== expected) throw new TransactionConflictError();
      this.menuData.delete(key);
    },
  };

  /** `space::id` → view: saved views are the space's, whatever environment asks. */
  private readonly savedViewData = new Map<string, SavedView>();

  readonly savedViews: SavedViewRepo = {
    list: async (scope, opts = {}) =>
      [...this.savedViewData.entries()]
        .filter(([k]) => k.startsWith(`${scope.spaceId}::`))
        .map(([, v]) => v)
        .filter(
          (v) =>
            v.visibility === 'shared' || (opts.owner !== undefined && v.createdBy === opts.owner),
        )
        .sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
    get: async (scope, id) => this.savedViewData.get(`${scope.spaceId}::${id}`) ?? null,
    save: async (scope, view, expected) => {
      const key = `${scope.spaceId}::${view.id}`;
      const current = this.savedViewData.get(key);
      if (expected === undefined) {
        if (current) throw new ConflictError('A unique value is already taken');
      } else if (current?.revision !== expected) {
        throw new TransactionConflictError();
      }
      // As the D1 row: the creator and creation time never change after the insert.
      this.savedViewData.set(
        key,
        current ? { ...view, createdBy: current.createdBy, createdAt: current.createdAt } : view,
      );
    },
    delete: async (scope, id, expected) => {
      const key = `${scope.spaceId}::${id}`;
      if (this.savedViewData.get(key)?.revision !== expected) throw new TransactionConflictError();
      this.savedViewData.delete(key);
    },
  };

  readonly taxonomy: TaxonomyRepo = {
    createScheme: async (scope, scheme) => {
      this.schemeData.set(`${scopeKey(scope)}::${scheme.id}`, scheme);
    },
    listSchemes: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.schemeData.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
    getScheme: async (scope, id) => this.schemeData.get(`${scopeKey(scope)}::${id}`) ?? null,
    deleteScheme: async (scope, id) => {
      this.schemeData.delete(`${scopeKey(scope)}::${id}`);
    },
    createConcept: async (scope, concept) => {
      this.claimSlug(scope, 'concept', concept.id, concept.slug, concept.schemeId);
      this.conceptData.set(`${scopeKey(scope)}::${concept.id}`, concept);
    },
    getConcept: async (scope, id) => this.conceptData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listConcepts: async (scope, schemeId) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.conceptData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .filter((c) => !schemeId || c.schemeId === schemeId);
    },
    findConceptsBySlug: async (scope, slugs, schemeId) =>
      (await this.taxonomy.listConcepts(scope, schemeId)).filter((c) => slugs.includes(c.slug)),
    deleteConcept: async (scope, id) => {
      this.conceptData.delete(`${scopeKey(scope)}::${id}`);
    },
    createTag: async (scope, tag) => {
      this.claimSlug(scope, 'tag', tag.id, tag.slug);
      this.tagData.set(`${scopeKey(scope)}::${tag.id}`, tag);
    },
    getTag: async (scope, id) => this.tagData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listTags: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.tagData.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
    findTagsBySlug: async (scope, slugs) =>
      (await this.taxonomy.listTags(scope)).filter((t) => slugs.includes(t.slug)),
    deleteTag: async (scope, id) => {
      this.tagData.delete(`${scopeKey(scope)}::${id}`);
    },
    slugsLike: async (scope, namespace, base) => {
      const terms: (Tag | Concept)[] =
        namespace.kind === 'tag'
          ? await this.taxonomy.listTags(scope)
          : await this.taxonomy.listConcepts(scope, namespace.schemeId);
      return terms
        .map((t) => t.slug)
        .filter((slug) => slug === base || slug.startsWith(`${base}-`));
    },
    listUsage: async (scope, query) =>
      this.usageOf(scope, query.kind).filter(
        (u) => !query.termIds || query.termIds.includes(u.termId),
      ),
    // Computed on read, so there is nothing to rebuild.
    recountUsage: async () => {},
    getEntryMetadata: async (scope, entryId) =>
      this.entryMetadataData.get(`${scopeKey(scope)}::${entryId}`) ?? null,
    getEntryMetadataMany: async (scope, entryIds) =>
      [...new Set(entryIds)].flatMap((entryId) => {
        const metadata = this.entryMetadataData.get(`${scopeKey(scope)}::${entryId}`);
        return metadata ? [{ entryId, metadata }] : [];
      }),
    setEntryMetadata: async (scope, entryId, metadata) => {
      this.entryMetadataData.set(`${scopeKey(scope)}::${entryId}`, metadata);
    },
  };

  private readonly auditData: AuditEntry[] = [];

  readonly audit: AuditRepo = {
    append: async (entry) => {
      this.auditData.push(entry);
    },
    list: async (spaceId, query) => {
      const { after, from, to } = query;
      const newerThan = (a: { at: string; id: string }, b: { at: string; id: string }) =>
        Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      // What D1's `audit_log_entries` holds for a row: its entry target, and the entries it saved.
      const isAbout = (e: AuditEntry, entryId: string) =>
        (e.targetType === 'entry' && e.targetId === entryId) ||
        (e.detail?.entries.some((c) => c.entryId === entryId) ?? false);
      return this.auditData
        .filter(
          (e) =>
            e.spaceId === spaceId &&
            (!query.environmentId || e.environmentId === query.environmentId) &&
            (!query.actor || e.actor === query.actor) &&
            (!query.action || e.action === query.action) &&
            (!query.targetType || e.targetType === query.targetType) &&
            (!query.targetId || e.targetId === query.targetId) &&
            (!query.entryId || isAbout(e, query.entryId)) &&
            (!from || Date.parse(e.at) >= Date.parse(from)) &&
            (!to || Date.parse(e.at) <= Date.parse(to)) &&
            (!after || newerThan(e, after) < 0),
        )
        .sort((a, b) => newerThan(b, a))
        .slice(0, query.limit ?? 100);
    },
  };

  private readonly aiActionData = new Map<string, AIActionDefinition>();

  readonly aiActions: AIActionRepo = {
    create: async (scope, action) => {
      this.aiActionData.set(`${scopeKey(scope)}::${action.id}`, action);
    },
    get: async (scope, id) => this.aiActionData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.aiActionData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    delete: async (scope, id) => {
      this.aiActionData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly functionData = new Map<string, FunctionDefinition>();

  readonly functions: FunctionRepo = {
    create: async (scope, fn) => {
      this.functionData.set(`${scopeKey(scope)}::${fn.id}`, fn);
    },
    get: async (scope, id) => this.functionData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.functionData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    delete: async (scope, id) => {
      this.functionData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly appExtensionData = new Map<string, AppExtension>();

  readonly appExtensions: AppExtensionRepo = {
    create: async (scope, app) => {
      this.appExtensionData.set(`${scopeKey(scope)}::${app.id}`, app);
    },
    get: async (scope, id) => this.appExtensionData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.appExtensionData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    delete: async (scope, id) => {
      this.appExtensionData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly previewTokenData = new Map<string, PreviewTokenRecord>();

  readonly previewTokens: PreviewTokenRepo = {
    create: async (record) => {
      this.previewTokenData.set(record.id, record);
    },
    findByHash: async (hashedToken) =>
      [...this.previewTokenData.values()].find(
        (t) => t.hashedToken === hashedToken && !t.revoked,
      ) ?? null,
    revoke: async (id) => {
      const existing = this.previewTokenData.get(id);
      if (existing) this.previewTokenData.set(id, { ...existing, revoked: true });
    },
  };

  /** Claim key → the claim and the entry holding it (the "unique index"). */
  private readonly uniqueData = new Map<string, UniqueClaim & { entryId: string }>();

  private releaseClaims(scope: Scope, entryId: string): void {
    for (const [key, held] of this.uniqueData) {
      if (held.entryId === entryId && key.startsWith(`${scopeKey(scope)}::`)) {
        this.uniqueData.delete(key);
      }
    }
  }

  private readonly pluginData = new Map<string, InstalledPlugin>();

  readonly plugins: PluginRepo = {
    create: async (plugin) => {
      this.pluginData.set(`${plugin.spaceId}::${plugin.id}`, plugin);
    },
    get: async (spaceId, id) => this.pluginData.get(`${spaceId}::${id}`) ?? null,
    list: async (spaceId) => [...this.pluginData.values()].filter((p) => p.spaceId === spaceId),
    save: async (plugin) => {
      this.pluginData.set(`${plugin.spaceId}::${plugin.id}`, plugin);
    },
    delete: async (spaceId, id) => {
      this.pluginData.delete(`${spaceId}::${id}`);
    },
  };

  /** `space::plugin` → settings, as stored (secrets sealed when the store is decorated). */
  private readonly pluginSettingsData = new Map<string, PluginSettings>();

  readonly pluginSettings: PluginSettingsRepo = {
    get: async (spaceId, pluginId) =>
      this.pluginSettingsData.get(`${spaceId}::${pluginId}`) ?? null,
    save: async (settings, expectedVersion) => {
      const k = `${settings.spaceId}::${settings.pluginId}`;
      if ((this.pluginSettingsData.get(k)?.version ?? 0) !== expectedVersion) return false;
      this.pluginSettingsData.set(k, settings);
      return true;
    },
    delete: async (spaceId, pluginId) => {
      this.pluginSettingsData.delete(`${spaceId}::${pluginId}`);
    },
  };

  /**
   * `space::env::plugin` → key → value. Keyed under the scope so the environment purge's
   * scope-prefix sweep clears it with the environment, as `ENVIRONMENT_SCOPED_TABLES` does on D1.
   */
  private readonly pluginKvData = new Map<string, Map<string, string>>();

  readonly pluginStorage: PluginStorageRepo = {
    get: async (scope, pluginId, key) =>
      this.pluginKvData.get(`${scopeKey(scope)}::${pluginId}`)?.get(key) ?? null,
    put: async (scope, pluginId, key, value, { maxKeys }) => {
      const k = `${scopeKey(scope)}::${pluginId}`;
      const keys = this.pluginKvData.get(k) ?? new Map<string, string>();
      if (!keys.has(key) && keys.size >= maxKeys) return false;
      keys.set(key, value);
      this.pluginKvData.set(k, keys);
      return true;
    },
    delete: async (scope, pluginId, key) =>
      this.pluginKvData.get(`${scopeKey(scope)}::${pluginId}`)?.delete(key) ?? false,
    list: async (scope, pluginId, { prefix, after, limit }) => {
      const keys = [...(this.pluginKvData.get(`${scopeKey(scope)}::${pluginId}`)?.keys() ?? [])];
      // Code-unit order, as SQLite's BINARY collation orders the D1 store's keys.
      return keys
        .filter((key) => !prefix || key.startsWith(prefix))
        .filter((key) => after === undefined || key > after)
        .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
        .slice(0, limit);
    },
    deleteAll: async (spaceId, pluginId) => {
      for (const k of [...this.pluginKvData.keys()]) {
        if (k.startsWith(`${spaceId}::`) && k.endsWith(`::${pluginId}`))
          this.pluginKvData.delete(k);
      }
    },
  };

  private readonly oauthClientData = new Map<string, OAuthClient>();

  readonly oauthClients: OAuthClientRepo = {
    create: async (client) => {
      this.oauthClientData.set(client.id, client);
    },
    get: async (clientId) => this.oauthClientData.get(clientId) ?? null,
    list: async () => [...this.oauthClientData.values()],
    delete: async (clientId) => {
      this.oauthClientData.delete(clientId);
    },
  };

  private readonly oauthGrantData = new Map<string, OAuthGrantRecord>();

  readonly oauthGrants: OAuthGrantRepo = {
    create: async (record) => {
      this.oauthGrantData.set(record.id, record);
    },
    findByHash: async (kind, hashedCode) =>
      [...this.oauthGrantData.values()].find(
        (g) => g.kind === kind && g.hashedCode === hashedCode,
      ) ?? null,
    findByUserCodeHash: async (hashedUserCode) =>
      [...this.oauthGrantData.values()].find((g) => g.hashedUserCode === hashedUserCode) ?? null,
    save: async (record) => {
      this.oauthGrantData.set(record.id, record);
    },
    listByParent: async (parentId) =>
      [...this.oauthGrantData.values()].filter((g) => g.parentId === parentId || g.id === parentId),
    listByClientAndSubject: async (clientId, subject) =>
      [...this.oauthGrantData.values()].filter(
        (g) => g.clientId === clientId && g.subject === subject,
      ),
    deleteExpiredBefore: async (before) => {
      let removed = 0;
      for (const [id, grant] of this.oauthGrantData) {
        if (grant.expiresAt.getTime() < before.getTime()) {
          this.oauthGrantData.delete(id);
          removed++;
        }
      }
      return removed;
    },
  };

  private readonly bulkJobData = new JournaledMap<string, BulkJob>();
  private readonly bulkChunkData = new JournaledMap<
    string,
    BulkJobChunk & { createdAtMs: number; claimedAtMs?: number }
  >();

  readonly bulkJobs: BulkJobRepo = {
    createJob: async (scope, job) => {
      this.bulkJobData.set(`${scopeKey(scope)}::${job.id}`, job);
    },
    getJob: async (scope, id) => this.bulkJobData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listJobs: async (scope, opts) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.bulkJobData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, opts?.limit ?? 50);
    },
    createChunks: async (scope, chunks) => {
      for (const c of chunks) {
        this.bulkChunkData.set(`${scopeKey(scope)}::${c.jobId}::${c.chunkId}`, {
          ...c,
          createdAtMs: this.nowMs(),
        });
      }
    },
    listChunks: async (scope, jobId) => {
      const prefix = `${scopeKey(scope)}::${jobId}::`;
      return [...this.bulkChunkData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .sort((a, b) => a.chunkId.localeCompare(b.chunkId));
    },
    claimChunk: async (scope, jobId, chunkId, opts) => {
      const key = `${scopeKey(scope)}::${jobId}::${chunkId}`;
      const chunk = this.bulkChunkData.get(key);
      if (!chunk) return null;
      const stale =
        chunk.status === 'running' && (chunk.claimedAtMs ?? 0) < opts.staleBefore.getTime();
      if (chunk.status !== 'pending' && !stale) return null;
      const claimed = {
        ...chunk,
        status: 'running' as const,
        attempts: chunk.attempts + 1,
        claimedAtMs: opts.now.getTime(),
      };
      this.bulkChunkData.set(key, claimed);
      return claimed;
    },
    completeChunk: async (scope, jobId, chunkId, outcome) => {
      const jobKey = `${scopeKey(scope)}::${jobId}`;
      const job = this.bulkJobData.get(jobKey);
      if (!job) throw new Error(`Bulk job ${jobId} not found`);
      const chunkKey = `${scopeKey(scope)}::${jobId}::${chunkId}`;
      const chunk = this.bulkChunkData.get(chunkKey);
      // Only a running claim completes — a duplicate completion never
      // double-counts (mirrors the D1 store's status guard).
      if (chunk?.status !== 'running') return job;
      this.bulkChunkData.set(chunkKey, {
        ...chunk,
        status: outcome.status,
        failures: [...outcome.failures],
      });
      const updated: BulkJob = {
        ...job,
        completedChunks: job.completedChunks + 1,
        succeeded: job.succeeded + outcome.succeeded,
        failed: job.failed + outcome.failed,
      };
      this.bulkJobData.set(jobKey, updated);
      return updated;
    },
    mergeConfig: async (scope, id, patch) => {
      const key = `${scopeKey(scope)}::${id}`;
      const job = this.bulkJobData.get(key);
      if (job) this.bulkJobData.set(key, { ...job, config: { ...job.config, ...patch } });
    },
    finalizeJob: async (scope, id, status, at) => {
      const key = `${scopeKey(scope)}::${id}`;
      const job = this.bulkJobData.get(key);
      if (job?.status !== 'running') return null;
      const updated: BulkJob = { ...job, status, completedAt: at.toISOString() };
      this.bulkJobData.set(key, updated);
      return updated;
    },
    releaseChunk: async (scope, jobId, chunkId) => {
      const key = `${scopeKey(scope)}::${jobId}::${chunkId}`;
      const chunk = this.bulkChunkData.get(key);
      if (chunk?.status !== 'running') return;
      const { claimedAtMs: _dropped, ...rest } = chunk;
      this.bulkChunkData.set(key, { ...rest, status: 'pending' });
    },
    findStalledChunks: async (staleBefore, limit) => {
      const cutoff = staleBefore.getTime();
      const out: { scope: Scope; jobId: string; chunkId: string }[] = [];
      for (const [key, chunk] of this.bulkChunkData.entries()) {
        if (out.length >= limit) break;
        const [spaceId, environmentId] = key.split('::');
        if (!spaceId || !environmentId) continue;
        const scope = { spaceId, environmentId };
        const job = this.bulkJobData.get(`${scopeKey(scope)}::${chunk.jobId}`);
        if (job?.status !== 'running') continue;
        const stalePending = chunk.status === 'pending' && chunk.createdAtMs < cutoff;
        const staleRunning = chunk.status === 'running' && (chunk.claimedAtMs ?? 0) < cutoff;
        if (stalePending || staleRunning) {
          out.push({ scope, jobId: chunk.jobId, chunkId: chunk.chunkId });
        }
      }
      return out;
    },
    findUnfinalizedJobs: async (limit) => {
      const out: { scope: Scope; jobId: string }[] = [];
      for (const [key, job] of this.bulkJobData.entries()) {
        if (out.length >= limit) break;
        if (job.status !== 'running' || job.completedChunks < job.totalChunks) continue;
        const [spaceId, environmentId] = key.split('::');
        if (!spaceId || !environmentId) continue;
        out.push({ scope: { spaceId, environmentId }, jobId: job.id });
      }
      return out;
    },
  };

  readonly outbox: OutboxRepo = {
    append: async (event) => {
      this.outboxData.push({ event, relayed: false });
    },
    appendMany: async (events) => {
      for (const event of events) this.outboxData.push({ event, relayed: false });
    },
    readPending: async (limit) =>
      this.outboxData
        .filter((r) => !r.relayed)
        .slice(0, limit)
        .map((r) => r.event),
    markRelayed: async (eventIds) => {
      const ids = new Set(eventIds);
      for (const row of this.outboxData) {
        if (ids.has(row.event.id)) {
          row.relayed = true;
          row.relayedAt = this.nowMs();
        }
      }
    },
    get: async (scope, eventId) =>
      this.outboxData.find((r) => r.event.id === eventId && r.event.scope.spaceId === scope.spaceId)
        ?.event ?? null,
    deleteRelayedBefore: async (before, limit) => {
      const cutoff = before.getTime();
      let deleted = 0;
      for (let i = this.outboxData.length - 1; i >= 0 && deleted < limit; i--) {
        const row = this.outboxData[i];
        if (row?.relayed && (row.relayedAt ?? 0) < cutoff) {
          this.outboxData.splice(i, 1);
          deleted += 1;
        }
      }
      return deleted;
    },
  };

  /** The collections a transaction can mutate, for snapshot/rollback. */
  private txCollections(): JournaledMap<string, unknown>[] {
    return [
      this.promotionData,
      this.inviteData,
      this.memberData,
      this.contentTypeData,
      this.publishedSingletonData,
      this.publishedDefinitionData,
      this.entryData,
      this.entryTouched,
      this.versionData,
      this.publishedData,
      this.assetData,
      this.publishedAssetData,
      this.assetVersionData,
      this.assetTouched,
      this.assetFolderData,
      this.collectionData,
      this.collectionItemData,
      this.shareLinkData,
      this.zipJobData,
      this.uploadData,
      this.renditionData,
      this.referenceData,
      this.releaseData,
      this.releaseItemData,
      this.bulkJobData,
      this.bulkChunkData,
      this.workflowRunData,
      this.workflowNodeRunData,
      this.workflowTimelineData,
      this.workflowTaskData,
      this.redirectData,
      this.redirectRevisionData,
      this.menuData,
    ] as JournaledMap<string, unknown>[];
  }

  /**
   * Runs `fn` with rollback: the D1 store commits nothing when `fn` throws, so the fake journals
   * what `fn` touches in every transactional collection and puts it back if `fn` throws, giving
   * tests real all-or-nothing semantics (e.g. a release that fails mid-publish leaves nothing
   * published). The journal records only touched keys, so a transaction costs what it touches,
   * not the size of the store.
   */
  async withTransaction<T>(fn: (tx: ContentStoreTx) => Promise<T>): Promise<T> {
    const journals = this.txCollections().map((m) => [m, m.begin()] as const);
    const outboxSnapshot = [...this.outboxData];
    // Purge progress marks hold Dates, so they are copied here rather than JSON round-tripped.
    const purgeSnapshot = [...this.purgeData].map(([k, v]) => [k, { ...v }] as const);
    try {
      const result = await fn({
        spaces: this.spaces,
        contentTypes: this.contentTypes,
        entries: this.entries,
        assets: this.assets,
        assetFolders: this.assetFolders,
        assetCollections: this.assetCollections,
        assetShareLinks: this.assetShareLinks,
        assetZips: this.assetZips,
        assetUploads: this.assetUploads,
        assetRenditions: this.assetRenditions,
        references: this.references,
        releases: this.releases,
        taxonomy: this.taxonomy,
        redirects: this.redirects,
        menus: this.menus,
        bulkJobs: this.bulkJobs,
        workflowRuns: this.workflowRuns,
        workflowTasks: this.workflowTasks,
        workflowGraphs: this.workflowGraphs,
        outbox: this.outbox,
        promotions: this.promotions,
        invites: this.invites,
        members: this.members,
      });
      for (const [m, journal] of journals) m.commit(journal);
      return result;
    } catch (err) {
      for (const [m, journal] of journals) m.rollback(journal);
      this.outboxData.length = 0;
      this.outboxData.push(...outboxSnapshot);
      this.purgeData.clear();
      for (const [k, v] of purgeSnapshot) this.purgeData.set(k, v);
      throw err;
    }
  }

  /** As the D1 store's due queries: the row's environment still exists (not deleted or purging). */
  private registered(scope: Scope): boolean {
    return (this.environmentData.get(scope.spaceId) ?? []).some(
      (e) => e.id === scope.environmentId,
    );
  }

  // ---- test helpers -------------------------------------------------------

  /**
   * Seeds a space's locale configuration (name defaults to the space id) and registers its
   * environments (`main` unless named), as `createSpace` does.
   */
  seedSpace(
    config: Omit<SpaceConfig, 'name'> & { name?: string; environments?: readonly string[] },
  ): void {
    const { environments = ['main'], ...rest } = config;
    this.spaceConfigs.set(config.spaceId, { name: config.spaceId, ...rest });
    const list = this.environmentData.get(config.spaceId) ?? [];
    for (const id of environments) {
      if (!list.some((e) => e.id === id)) list.push({ id, name: id });
    }
    this.environmentData.set(config.spaceId, list);
  }

  /** Synchronously seeds an API key (avoids startup races in dev/tests). */
  seedApiKey(key: ApiKey): void {
    this.apiKeyData.set(key.id, key);
  }

  /** Returns all outbox events appended so far (relayed or not); webhook send requests aside. */
  allEvents(): DomainEvent[] {
    return this.outboxData.flatMap((r) => (isWebhookSendRequest(r.event) ? [] : [r.event]));
  }

  /** Every outbox row appended so far, in order: events and webhook send requests. */
  allOutbox(): OutboxEntry[] {
    return this.outboxData.map((r) => r.event);
  }
}

/**
 * The order distinct field values page in, as the D1 store's SQL sorts them: booleans (false
 * first), then numbers, then strings by their UTF-8 bytes (SQLite's BINARY collation).
 */
function compareFieldValues(a: string | number | boolean, b: string | number | boolean): number {
  const kind = (v: unknown) => (typeof v === 'boolean' ? 0 : typeof v === 'number' ? 1 : 2);
  if (kind(a) !== kind(b)) return kind(a) - kind(b);
  if (typeof a === 'string' && typeof b === 'string') {
    // UTF-8 byte order is code point order (UTF-16 unit order is not, past the surrogates).
    const x = [...a].map((c) => c.codePointAt(0) as number);
    const y = [...b].map((c) => c.codePointAt(0) as number);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
    }
    return x.length - y.length;
  }
  return Number(a) - Number(b);
}
