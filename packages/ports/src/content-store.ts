import type {
  AgentReview,
  AgentSchedule,
  ApiKey,
  Asset,
  AssetCollection,
  AssetFolder,
  AssetIngestStatus,
  AssetKind,
  AssetPlaceholder,
  AssetRendition,
  AssetRights,
  AssetShareTargetType,
  AssetStatus,
  AssetZipJob,
  AuditDetail,
  Comment,
  Concept,
  ConceptScheme,
  ContentType,
  DeliveredContentType,
  DomainEvent,
  Entry,
  EntryFields,
  EntryKeyset,
  EntryMetadata,
  EntryStatus,
  EntryVersion,
  EntryWorkflowState,
  EventType,
  InstalledPlugin,
  InviteStatus,
  LocaleCode,
  LocaleSettings,
  LocalizedValue,
  MemberInvite,
  Menu,
  OAuthClient,
  OAuthGrantKind,
  OAuthGrantStatus,
  OutboxEntry,
  PluginSettings,
  Promotion,
  PromotionStatus,
  PublishedContentTypeDefinition,
  PublishGate,
  QueryFilter,
  QueryNode,
  QueryOrder,
  Redirect,
  ReferenceEdge,
  Release,
  ReleaseItem,
  Role,
  SavedView,
  ScheduledAction,
  Scope,
  SpaceMember,
  StoredAssetShareLink,
  Tag,
  Task,
  TermKind,
  TermUsage,
  UniqueClaim,
  Webhook,
  WebhookDelivery,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowGraphDefinition,
  WorkflowNodeRunRecord,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowTask,
  WorkflowTaskStatus,
  WorkflowTimelineRecord,
  WorkflowVersion,
} from '@commerceworker/domain';
import { ConflictError } from '@commerceworker/domain';

/**
 * Thrown by `withTransaction` when an optimistic precondition inside the unit of work no longer
 * held at commit (a compare-and-set write that another writer beat). Nothing was written; the
 * caller re-reads and retries, or treats the lost race as a no-op.
 */
export class TransactionConflictError extends ConflictError {
  constructor(message = 'A concurrent write won; nothing was committed') {
    super(message);
  }
}

/**
 * The single database seam. The domain and application layers depend only on
 * this interface; the D1 adapter (and the in-memory test adapter) are the only
 * implementations. No SQL, ORM, or driver type ever crosses this boundary.
 */
export interface ContentStore {
  /**
   * Runs `fn` as one unit of work: everything it writes through `tx` commits atomically or not
   * at all, and an exception thrown by `fn` writes nothing.
   *
   * The contract is a unit of work, not an interactive transaction (D1 commits a batch):
   * - Reads see committed state only. A read on `tx` does not see a write made earlier in the
   *   same `fn`; read everything you need first, then write.
   * - Writes return nothing meaningful until commit. A compare-and-set write on `tx` (e.g.
   *   `workflowRuns.save`, `bulkJobs.finalizeJob`) reports the outcome its precondition implies;
   *   if the precondition fails at commit, the whole unit is discarded and `withTransaction`
   *   throws {@link TransactionConflictError}.
   * - A unique-constraint violation at commit discards the unit and throws `ConflictError`.
   */
  withTransaction<T>(fn: (tx: ContentStoreTx) => Promise<T>): Promise<T>;

  readonly spaces: SpaceRepo;
  readonly contentTypes: ContentTypeRepo;
  readonly entries: EntryRepo;
  readonly assets: AssetRepo;
  readonly assetFolders: AssetFolderRepo;
  readonly assetCollections: AssetCollectionRepo;
  readonly assetShareLinks: AssetShareLinkRepo;
  readonly assetZips: AssetZipJobRepo;
  readonly assetUploads: AssetUploadRepo;
  readonly assetRenditions: AssetRenditionRepo;
  readonly references: ReferenceRepo;
  readonly webhooks: WebhookRepo;
  readonly auth: AuthRepo;
  readonly roles: RoleRepo;
  readonly members: MemberRepo;
  /** Invitations to the admin (deployment-wide: they grant roles in any number of spaces). */
  readonly invites: InviteRepo;
  readonly settings: DeploymentSettingsRepo;
  /** The engine cron's heartbeat (deployment-wide). */
  readonly schedulerJobs: SchedulerJobRepo;
  readonly agentRuns: AgentRunRepo;
  readonly releases: ReleaseRepo;
  readonly promotions: PromotionRepo;
  readonly scheduledActions: ScheduledActionRepo;
  readonly agentSchedules: AgentScheduleRepo;
  readonly agentReviews: AgentReviewRepo;
  readonly comments: CommentRepo;
  readonly tasks: TaskRepo;
  readonly workflows: WorkflowRepo;
  readonly workflowGraphs: WorkflowGraphRepo;
  readonly workflowRuns: WorkflowRunRepo;
  readonly workflowTasks: WorkflowTaskRepo;
  readonly taxonomy: TaxonomyRepo;
  readonly redirects: RedirectRepo;
  readonly menus: MenuRepo;
  readonly savedViews: SavedViewRepo;
  readonly audit: AuditRepo;
  readonly aiActions: AIActionRepo;
  readonly functions: FunctionRepo;
  readonly appExtensions: AppExtensionRepo;
  readonly previewTokens: PreviewTokenRepo;
  readonly plugins: PluginRepo;
  readonly pluginSettings: PluginSettingsRepo;
  readonly pluginStorage: PluginStorageRepo;
  readonly oauthClients: OAuthClientRepo;
  readonly oauthGrants: OAuthGrantRepo;
  readonly bulkJobs: BulkJobRepo;
  readonly outbox: OutboxRepo;
  /** Raw access to sealed secret columns, for the reseal sweep only. */
  readonly storedSecrets: StoredSecretRepo;
  /** Delivery's independent reads, sent together (one D1 round trip). */
  readonly delivery: DeliveryReadRepo;
}

/**
 * A user-defined function invoked on matching domain events. `eventPattern` is a
 * glob on the event type (`*`, prefix like `entry.*`, or an exact type); the
 * handler is hosted externally and invoked over HTTP. Env-scoped like content.
 */
export interface FunctionDefinition {
  readonly id: string;
  readonly name: string;
  readonly eventPattern: string;
  /** External HTTP endpoint invoked with the event payload. */
  readonly url: string;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface FunctionRepo {
  create(scope: Scope, fn: FunctionDefinition): Promise<void>;
  get(scope: Scope, id: string): Promise<FunctionDefinition | null>;
  list(scope: Scope): Promise<FunctionDefinition[]>;
  delete(scope: Scope, id: string): Promise<void>;
}

/**
 * A UI extension that the admin renders inside a sandboxed iframe. `target`
 * decides where it mounts — a custom `field-editor` (replacing the built-in
 * editor for matching `fieldTypes`) or a `sidebar` widget on the entry editor.
 * The host posts the editing context to the iframe and receives value updates
 * back over `postMessage`. Env-scoped like content.
 */
export interface AppExtension {
  readonly id: string;
  readonly name: string;
  readonly target: 'field-editor' | 'sidebar';
  /** External page rendered in the iframe. */
  readonly entryUrl: string;
  /** For `field-editor`: field types it handles (e.g. `JSON`); empty = any. */
  readonly fieldTypes?: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
}

export interface AppExtensionRepo {
  create(scope: Scope, app: AppExtension): Promise<void>;
  get(scope: Scope, id: string): Promise<AppExtension | null>;
  list(scope: Scope): Promise<AppExtension[]>;
  delete(scope: Scope, id: string): Promise<void>;
}

/**
 * A persisted, templated, governed AI operation ("AI Action"). The
 * prompt template interpolates `{{variables}}`; an optional `targetField` says
 * which entry field a run writes into. Scoped per environment like content.
 */
export interface AIActionDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Prompt template with `{{variable}}` placeholders. */
  readonly promptTemplate: string;
  /** Declared variable names the template expects. */
  readonly variables: readonly string[];
  /** Optional entry field the run writes its output into. */
  readonly targetField?: string;
  readonly tier: 'flagship' | 'balanced' | 'fast';
  readonly createdAt: string;
}

export interface AIActionRepo {
  create(scope: Scope, action: AIActionDefinition): Promise<void>;
  get(scope: Scope, id: string): Promise<AIActionDefinition | null>;
  list(scope: Scope): Promise<AIActionDefinition[]>;
  delete(scope: Scope, id: string): Promise<void>;
}

export interface TaxonomyRepo {
  // Concept schemes (vocabularies).
  createScheme(scope: Scope, scheme: ConceptScheme): Promise<void>;
  listSchemes(scope: Scope): Promise<ConceptScheme[]>;
  getScheme(scope: Scope, id: string): Promise<ConceptScheme | null>;
  deleteScheme(scope: Scope, id: string): Promise<void>;
  // Concepts (hierarchical terms within a scheme).
  /**
   * Creates or replaces a concept. A slug another concept of the scheme holds is refused with
   * `ConflictError` (at commit, inside a unit of work).
   */
  createConcept(scope: Scope, concept: Concept): Promise<void>;
  getConcept(scope: Scope, id: string): Promise<Concept | null>;
  /** All concepts, or just those in `schemeId` when given. */
  listConcepts(scope: Scope, schemeId?: string): Promise<Concept[]>;
  /** The concepts holding any of `slugs` (in `schemeId`, or in any scheme). */
  findConceptsBySlug(scope: Scope, slugs: readonly string[], schemeId?: string): Promise<Concept[]>;
  /** Deletes a concept and its usage counts. */
  deleteConcept(scope: Scope, id: string): Promise<void>;
  // Tags (flat labels).
  /** Creates or replaces a tag. A slug another tag holds is refused with `ConflictError`. */
  createTag(scope: Scope, tag: Tag): Promise<void>;
  getTag(scope: Scope, id: string): Promise<Tag | null>;
  listTags(scope: Scope): Promise<Tag[]>;
  /** The tags holding any of `slugs`. */
  findTagsBySlug(scope: Scope, slugs: readonly string[]): Promise<Tag[]>;
  /** Deletes a tag and its usage counts. */
  deleteTag(scope: Scope, id: string): Promise<void>;
  /**
   * The slugs in a namespace (the environment's tags, or one scheme's concepts) that are `base`
   * or `base-<anything>`: what a generated slug must step around.
   */
  slugsLike(
    scope: Scope,
    namespace: { readonly kind: 'tag' } | { readonly kind: 'concept'; readonly schemeId: string },
    base: string,
  ): Promise<string[]>;
  // Published usage counts.
  /**
   * How many published entries carry each term, per content type (rows above zero only). The
   * store keeps these as it writes published snapshots (`entries.putPublishedMany`,
   * `removePublishedMany`), in the same unit of work, so a read never computes them.
   */
  listUsage(
    scope: Scope,
    query: { readonly kind: TermKind; readonly termIds?: readonly string[] },
  ): Promise<TermUsage[]>;
  /** Rebuilds the scope's usage counts from its published snapshots (the repair sweep). */
  recountUsage(scope: Scope): Promise<void>;
  // Per-entry associations.
  getEntryMetadata(scope: Scope, entryId: string): Promise<EntryMetadata | null>;
  /** Batch read of entry associations; entries without metadata are absent. */
  getEntryMetadataMany(
    scope: Scope,
    entryIds: readonly string[],
  ): Promise<{ entryId: string; metadata: EntryMetadata }[]>;
  setEntryMetadata(scope: Scope, entryId: string, metadata: EntryMetadata): Promise<void>;
}

/** A page of an environment's redirects, by source. */
export interface RedirectPage {
  readonly items: Redirect[];
  readonly nextCursor?: string;
}

export interface RedirectQuery {
  /** Matches the source, destination or note (case-insensitive substring). */
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Where an environment's redirect set stands: what a write checks it still holds at commit. */
export interface RedirectSetState {
  /** Bumped by every write to the set; 0 before the first. */
  readonly revision: number;
  readonly count: number;
}

/**
 * An environment's redirects. Every write to the set rides with {@link RedirectRepo.advance} in
 * one unit, so two writers that each checked the set (for loops, the cap) can't both commit: the
 * second fails at commit with `TransactionConflictError` and checks again.
 */
export interface RedirectRepo {
  get(scope: Scope, id: string): Promise<Redirect | null>;
  /** The whole set (at most `MAX_REDIRECTS`), by source then id; `enabledOnly` for Delivery. */
  all(scope: Scope, opts?: { readonly enabledOnly?: boolean }): Promise<Redirect[]>;
  list(scope: Scope, query?: RedirectQuery): Promise<RedirectPage>;
  /** Redirects whose source or destination is one of `paths` (a slug change's two paths). */
  involving(scope: Scope, paths: readonly string[]): Promise<Redirect[]>;
  state(scope: Scope): Promise<RedirectSetState>;
  /** Inserts or replaces each by id. A source held by another redirect is a `ConflictError`. */
  saveMany(scope: Scope, redirects: readonly Redirect[]): Promise<void>;
  removeMany(scope: Scope, ids: readonly string[]): Promise<void>;
  /**
   * Moves the set from revision `expected` to the next. Inside a unit a set written since
   * `expected` was read fails the commit (`TransactionConflictError`); outside one it throws.
   * Without `expected` it moves on unconditionally: a publish's slug change, which must not fail
   * over a concurrent edit to the set, still makes that edit check the set again.
   */
  advance(scope: Scope, expected?: number): Promise<void>;
}

/**
 * An environment's navigation menus. A menu is one row (its items a JSON tree), written whole
 * with its revision as the compare-and-set: two people saving the same menu can't both win.
 */
export interface MenuRepo {
  /** Every menu (at most `MAX_MENUS`), by handle. */
  all(scope: Scope): Promise<Menu[]>;
  get(scope: Scope, id: string): Promise<Menu | null>;
  getByHandle(scope: Scope, handle: string): Promise<Menu | null>;
  /**
   * Writes `menu` (at its own `revision`). Without `expected` it is inserted: an id or a handle
   * another menu holds is a `ConflictError` (at commit, inside a unit). With `expected` it
   * replaces the menu only while that is still at revision `expected`: inside a unit a menu saved
   * since fails the commit with `TransactionConflictError`; outside one it throws it.
   */
  save(scope: Scope, menu: Menu, expected?: number): Promise<void>;
  /** Deletes a menu still at revision `expected`, as `save` checks it. */
  delete(scope: Scope, id: string, expected: number): Promise<void>;
}

/**
 * Saved views of the entries list. A view belongs to a space, not an environment: the repo reads
 * and writes by `scope.spaceId`, so every environment of the space sees the same views. A save is
 * a compare-and-set on the view's revision, as a menu's is.
 */
export interface SavedViewRepo {
  /**
   * The space's shared views and, with `owner`, that person's personal views: everything one
   * person can be shown, at most `MAX_SHARED_VIEWS + MAX_PERSONAL_VIEWS` rows, by name.
   */
  list(scope: Scope, opts?: { readonly owner?: string }): Promise<SavedView[]>;
  get(scope: Scope, id: string): Promise<SavedView | null>;
  /**
   * Writes `view` (at its own `revision`). Without `expected` it is inserted: an id another view
   * holds is a `ConflictError`. With `expected` it replaces the view only while that is still at
   * revision `expected`, else `TransactionConflictError`.
   */
  save(scope: Scope, view: SavedView, expected?: number): Promise<void>;
  /** Deletes a view still at revision `expected`, as `save` checks it. */
  delete(scope: Scope, id: string, expected: number): Promise<void>;
}

export interface CommentRepo {
  create(scope: Scope, comment: Comment): Promise<void>;
  get(scope: Scope, id: string): Promise<Comment | null>;
  /** Comments on an entry, oldest first. */
  listForEntry(scope: Scope, entryId: string): Promise<Comment[]>;
  delete(scope: Scope, id: string): Promise<void>;
}

export interface TaskRepo {
  create(scope: Scope, task: Task): Promise<void>;
  get(scope: Scope, id: string): Promise<Task | null>;
  /** Tasks on an entry, oldest first. */
  listForEntry(scope: Scope, entryId: string): Promise<Task[]>;
  save(scope: Scope, task: Task): Promise<void>;
  delete(scope: Scope, id: string): Promise<void>;
}

export interface WorkflowRepo {
  saveDefinition(scope: Scope, def: WorkflowDefinition): Promise<void>;
  getDefinition(scope: Scope, id: string): Promise<WorkflowDefinition | null>;
  listDefinitions(scope: Scope): Promise<WorkflowDefinition[]>;
  deleteDefinition(scope: Scope, id: string): Promise<void>;
  /** The workflow position of an entry (null if it has not entered one). */
  getState(scope: Scope, entryId: string): Promise<EntryWorkflowState | null>;
  saveState(scope: Scope, state: EntryWorkflowState): Promise<void>;
}

/**
 * A workflow definition row as stored, during the steps → graph expand/contract migration.
 * It is the same row {@link WorkflowRepo} reads; `graph` is the editable draft and is null for
 * a legacy row that was only ever stored as ordered `steps` (the application converts those with
 * `legacyStepsToGraph`). `steps` stays populated — derived from the graph's `content.stage`
 * nodes on every draft save — until the contract PR drops it.
 */
export interface WorkflowGraphRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly contentTypes: readonly string[];
  readonly graph: WorkflowGraph | null;
  readonly gatesPublish: boolean;
  readonly steps: readonly WorkflowStep[];
  /** ISO-8601; null for a legacy row never saved as a graph. */
  readonly updatedAt: string | null;
  /** The highest published version number, or null if none has been published. */
  readonly latestVersion: number | null;
}

/** What a draft save writes. `latestVersion` is derived from `workflow_versions`, never written. */
export interface WorkflowDraftWrite extends WorkflowGraphDefinition {
  readonly steps: readonly WorkflowStep[];
  /** ISO-8601. */
  readonly updatedAt: string;
}

/**
 * Versioned workflow graphs: the editable draft on the definition row, plus immutable, numbered
 * published versions. Versions are append-only — there is no update or delete — so a run that
 * pins `(workflowId, version)` always loads exactly what was published, even after the
 * definition is edited or deleted.
 */
export interface WorkflowGraphRepo {
  get(scope: Scope, id: string): Promise<WorkflowGraphRecord | null>;
  list(scope: Scope): Promise<WorkflowGraphRecord[]>;
  /** Creates or replaces the definition row (name, description, content types, graph, steps). */
  saveDraft(scope: Scope, draft: WorkflowDraftWrite): Promise<void>;
  /**
   * Appends the next version (`max(version) + 1`, starting at 1) atomically and returns it.
   * Concurrent publishes of the same workflow get distinct, gap-free numbers.
   */
  publishVersion(
    scope: Scope,
    definition: WorkflowGraphDefinition,
    meta: { readonly publishedAt: string; readonly publishedBy?: string },
  ): Promise<WorkflowVersion>;
  /** Published versions of a workflow, newest first. */
  listVersions(scope: Scope, workflowId: string): Promise<WorkflowVersion[]>;
  getVersion(scope: Scope, workflowId: string, version: number): Promise<WorkflowVersion | null>;
  /** The highest-numbered version, or null if none has been published. */
  getLatestVersion(scope: Scope, workflowId: string): Promise<WorkflowVersion | null>;
  /**
   * The highest-numbered version of each of `workflowIds` that has one, in one round of queries
   * (however many ids). Order is unspecified; a workflow never published is absent.
   */
  listLatestVersions(scope: Scope, workflowIds: readonly string[]): Promise<WorkflowVersion[]>;
  /**
   * Every workflow (whose definition still exists) whose latest published version gates
   * publishing and `canPublishThroughRun`, with that version's content types. One query for the
   * scope, whatever the number of entries a publish touches: every publish path reads it once.
   */
  listPublishGates(scope: Scope): Promise<PublishGate[]>;
}

export interface WorkflowRunQuery {
  readonly entryId?: string;
  readonly workflowId?: string;
  readonly status?: WorkflowRunStatus;
  /** Default 50, at most 200. */
  readonly limit?: number;
}

/**
 * Workflow runs (live state plus the fields run lists filter on), their finished node runs and
 * their timeline. The run row is written with optimistic concurrency:
 * {@link WorkflowRunRepo.save} only replaces a row still at `expectedRev`, so concurrent writers
 * to one run never interleave.
 */
export interface WorkflowRunRepo {
  create(scope: Scope, run: WorkflowRun): Promise<void>;
  get(scope: Scope, id: string): Promise<WorkflowRun | null>;
  /** Newest first. */
  list(scope: Scope, query?: WorkflowRunQuery): Promise<WorkflowRun[]>;
  /**
   * Replaces the run iff its stored `rev` is `expectedRev`; the stored row gets `run.rev`
   * (callers pass `expectedRev + 1`). False when another writer moved it first.
   */
  save(scope: Scope, run: WorkflowRun, expectedRev: number): Promise<boolean>;
  /** Inserts a finished node run; a repeat of `(runId, generation, nodeId, run)` is a no-op. */
  recordNodeRun(scope: Scope, record: WorkflowNodeRunRecord): Promise<void>;
  /** Oldest first (by end time). */
  listNodeRuns(scope: Scope, runId: string): Promise<WorkflowNodeRunRecord[]>;
  /** Marks a succeeded node run rolled back. False when it was not `succeeded` (already undone). */
  markNodeRunRolledBack(
    scope: Scope,
    key: { runId: string; generation: number; nodeId: string; run: number },
  ): Promise<boolean>;
  /** Upserts by `(runId, key)`: a keyed entry replaces its earlier copy and takes the new `seq`. */
  putTimeline(scope: Scope, runId: string, entry: WorkflowTimelineRecord): Promise<void>;
  /** Oldest first. */
  listTimeline(scope: Scope, runId: string): Promise<WorkflowTimelineRecord[]>;
  /** Drops entries with `seq <= upTo`. */
  trimTimeline(scope: Scope, runId: string, upTo: number): Promise<void>;
}

export interface WorkflowTaskQuery {
  readonly status?: WorkflowTaskStatus;
  readonly runId?: string;
  readonly entryId?: string;
  readonly kind?: WorkflowTask['kind'];
  /** Default 50, at most 200. */
  readonly limit?: number;
}

/**
 * How many pending items one content type holds, for the Approvals count. `contentTypeApiId` is
 * null for an agent review whose entry no longer exists.
 */
export interface PendingCount {
  readonly contentTypeApiId: string | null;
  readonly count: number;
}

/** Approvals, event waits and agent reviews a run holds open. */
export interface WorkflowTaskRepo {
  /** False (and nothing written) when the run already has a task for `eventType`. */
  create(scope: Scope, task: WorkflowTask): Promise<boolean>;
  get(scope: Scope, id: string): Promise<WorkflowTask | null>;
  getByEvent(scope: Scope, runId: string, eventType: string): Promise<WorkflowTask | null>;
  /** Pending tasks soonest deadline first; anything else newest first. */
  list(scope: Scope, query?: WorkflowTaskQuery): Promise<WorkflowTask[]>;
  /** Pending tasks, counted per content type (uncapped, unlike `list`). */
  countPending(scope: Scope): Promise<PendingCount[]>;
  /** Settles a pending task. False when it was no longer pending (someone settled it first). */
  settle(
    scope: Scope,
    id: string,
    outcome: {
      readonly status: WorkflowTaskStatus;
      readonly decidedAt: string;
      readonly decidedBy: string | null;
      readonly note: string | null;
    },
  ): Promise<boolean>;
}

/** An audit record of one agent workflow execution, including token usage. */
export interface AgentRunRecord {
  readonly id: string;
  readonly workflow: string;
  readonly entryId: string;
  readonly status: string;
  readonly decisions: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
}

/** Aggregated token usage — the cost ledger view. */
export interface AgentUsageSummary {
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AgentRunRepo {
  record(scope: Scope, run: AgentRunRecord): Promise<void>;
  list(scope: Scope, query: { workflow?: string; limit?: number }): Promise<AgentRunRecord[]>;
  usage(scope: Scope, query: { workflow?: string; since?: string }): Promise<AgentUsageSummary>;
}

/** An append-only governance record of a mutating action. */
export interface AuditEntry {
  readonly id: string;
  readonly spaceId: string;
  /** The environment the action targeted, when it was scoped to one. */
  readonly environmentId?: string;
  /** Who acted — the principal kind / api-key id (no user model yet). */
  readonly actor: string;
  /** What happened, e.g. `POST /spaces/:space/environments/:env/entries/:id/published`. */
  readonly action: string;
  /** The kind of entity affected (e.g. `entry`, `release`, `environment_alias`). */
  readonly targetType?: string;
  readonly targetId?: string;
  /** Result status code of the action. */
  readonly status: number;
  readonly at: string;
  /** What the action changed, in paths and never values. Absent on rows that don't say. */
  readonly detail?: AuditDetail;
}

/** What an audit listing keeps. Every filter narrows; omitted ones don't apply. */
export interface AuditQuery {
  readonly environmentId?: string;
  readonly actor?: string;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  /**
   * Only rows about this entry: those that target it, and those whose `detail` names it (an
   * approved review, a duplicate's new entry). With `environmentId`, as an entry's id is only
   * unique within its environment.
   */
  readonly entryId?: string;
  /** The earliest `at` kept, inclusive. */
  readonly from?: string;
  /** The latest `at` kept, inclusive. */
  readonly to?: string;
  /** Keyset: only entries older than this one in the listing's (`at`, `id`) order. */
  readonly after?: { readonly at: string; readonly id: string };
  readonly limit?: number;
}

/** Append-only audit trail. Entries are never updated or deleted. */
export interface AuditRepo {
  append(entry: AuditEntry): Promise<void>;
  /** Lists a space's audit entries, newest first: by `at`, then `id`, both descending. */
  list(spaceId: string, query: AuditQuery): Promise<AuditEntry[]>;
}

/**
 * What an asset listing keeps. Every filter narrows; omitted ones don't apply. `status` omitted
 * hides archived assets, as the entry trash is hidden: a picker or a library never shows them
 * unless asked. `all` is every status, for exports and comparisons.
 */
export interface AssetFilters {
  readonly kind?: AssetKind;
  /** An exact content type (`image/png`) or a whole family (`image/*`). */
  readonly mime?: string;
  /** A taxonomy tag id in the asset's metadata. */
  readonly tag?: string;
  /** Assets filed directly in this folder; `null` for those at the root (in no folder). */
  readonly folderId?: string | null;
  readonly status?: AssetStatus | 'all';
  /** Assets whose bytes hash to this (hex SHA-256): duplicate detection. */
  readonly contentHash?: string;
}

export type AssetSortField = 'updatedAt' | 'createdAt' | 'size';

export interface AssetSort {
  readonly field: AssetSortField;
  readonly direction: 'asc' | 'desc';
}

/** The default order: most recently changed first. */
export const DEFAULT_ASSET_SORT: AssetSort = { field: 'updatedAt', direction: 'desc' };

export interface AssetListQuery {
  /** Page size; the store caps it (100 on D1 by default). */
  readonly limit?: number;
  /**
   * Keyset cursor from a previous page's `nextCursor`. Opaque, and only valid with the same
   * filters and sort; paging with it is stable while assets are added or changed.
   */
  readonly cursor?: string;
  readonly filters?: AssetFilters;
  readonly sort?: AssetSort;
}

export interface AssetPage {
  readonly items: Asset[];
  /** Present when there may be more: pass it back as `cursor` for the next page. */
  readonly nextCursor?: string;
}

/** The denormalized published snapshot of an asset, served by the Delivery API. */
export interface PublishedAsset {
  readonly assetId: string;
  readonly file: Asset['file'];
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly metadata: Asset['metadata'];
  readonly publishedAt: string;
  /** The file version this snapshot delivers; its media URLs carry it. Absent reads as 1. */
  readonly version?: number;
  /** Where the published file's bytes are; absent for a hosted video. */
  readonly r2Key?: string;
  readonly rights?: AssetRights;
}

/**
 * A file an asset had before its current one. `replacedAt`/`replacedBy`: when, and by whom, it
 * stopped being current (the upload or restore that took its place).
 */
export interface AssetVersionRecord {
  readonly version: number;
  readonly file: Asset['file'];
  readonly r2Key?: string;
  readonly contentHash?: string;
  readonly replacedAt: string;
  readonly replacedBy?: string;
}

/** A published asset whose rights have expired, as the expiry sweep finds it. */
export interface ExpiredPublishedAsset {
  readonly scope: Scope;
  readonly assetId: string;
  readonly expiresAt: string;
}

/** What a delivery asset listing keeps; every filter narrows. */
export interface PublishedAssetFilters {
  readonly kind?: AssetKind;
  /** A taxonomy tag id in the published metadata. */
  readonly tag?: string;
  /** Assets filed directly in this folder (the library's filing, read live); `null`: the root. */
  readonly folderId?: string | null;
}

export interface PublishedAssetQuery {
  /** Page size; the store caps it. */
  readonly limit?: number;
  /** Offset paging, kept for existing callers; prefer `cursor`. Ignored with a cursor. */
  readonly skip?: number;
  /** `nextCursor` from the previous page (stable while assets are published meanwhile). */
  readonly cursor?: string;
  readonly filters?: PublishedAssetFilters;
}

export interface PublishedAssetPage {
  readonly items: PublishedAsset[];
  readonly nextCursor?: string;
}

export interface AssetRepo {
  get(scope: Scope, id: string): Promise<Asset | null>;
  /** Batch point-read of assets (draft or published); missing ids are absent. */
  getMany(scope: Scope, ids: readonly string[]): Promise<Asset[]>;
  /** One page of the asset library, filtered and sorted (see {@link AssetListQuery}). */
  list(scope: Scope, query: AssetListQuery): Promise<AssetPage>;
  /**
   * Filing it in a folder that is gone by commit throws {@link TransactionConflictError} (in a
   * unit of work; directly, the create is refused the same way).
   */
  create(scope: Scope, asset: Asset): Promise<void>;
  save(scope: Scope, asset: Asset): Promise<void>;
  /**
   * Files the given assets in `folderId` (`null`: the root), in one statement whatever the
   * count: the ids travel as one JSON parameter. Ids that aren't assets in the scope are
   * skipped. Moving into a folder that is gone by commit throws {@link TransactionConflictError}
   * (in a unit of work; directly, the move is refused the same way).
   */
  moveToFolder(scope: Scope, ids: readonly string[], folderId: string | null): Promise<void>;
  /**
   * Deletes the asset row, its published snapshot, its version history and its collection
   * memberships. Refused while any
   * entry links to it: if a link exists at commit, the unit throws
   * {@link TransactionConflictError} and nothing is deleted.
   */
  delete(scope: Scope, id: string): Promise<void>;
  /**
   * Records what ingest learned about the asset's file, only while the asset is still on
   * `version` (a replaced file's findings are dropped). Touches only the columns ingest owns and
   * the file's measurements, never what an editor edits, and doesn't move `updatedAt`; `save`
   * in turn leaves the ingest columns alone, so neither clobbers the other.
   */
  recordIngest(scope: Scope, id: string, version: number, patch: AssetIngestPatch): Promise<void>;
  /**
   * Drafts created for a presigned upload whose bytes never showed up (nothing measured, never
   * ingested), created before `createdBefore`, across every space and environment, oldest first:
   * the abandoned-upload sweep's candidates. At most `limit`. A row whose creation time is
   * unknown (written before it was recorded) is never one.
   */
  listAwaitingUpload(
    createdBefore: Date,
    limit: number,
  ): Promise<{ readonly scope: Scope; readonly asset: Asset }[]>;
  /**
   * Writes the file's measurements into the published snapshot, only while it delivers `version`
   * (an asset published before ingest measured it), so Delivery reports what ingest found.
   */
  recordPublishedFile(
    scope: Scope,
    id: string,
    version: number,
    file: {
      readonly size?: number;
      readonly width?: number;
      readonly height?: number;
      readonly placeholder?: AssetPlaceholder;
    },
  ): Promise<void>;
  /**
   * Makes `next` the asset's file and keeps `previous` (the file it had) in its history, only
   * while the asset is still on `previous.version`: replaced since the caller read it, the unit
   * throws {@link TransactionConflictError} at commit and nothing is written. `next` is written
   * whole, the columns ingest owns included (what ingest found about the old file says nothing
   * about the new one).
   */
  replaceFile(scope: Scope, next: Asset, previous: AssetVersionRecord): Promise<void>;
  /** The files the asset had before its current one, newest first. */
  listVersions(scope: Scope, id: string): Promise<AssetVersionRecord[]>;
  getVersion(scope: Scope, id: string, version: number): Promise<AssetVersionRecord | null>;
  putPublished(scope: Scope, snapshot: PublishedAsset): Promise<void>;
  removePublished(scope: Scope, id: string): Promise<void>;
  /**
   * Published assets in every scope whose rights expired by `at`, soonest first (an index read:
   * the expiry sweep runs it every minute).
   */
  findExpiredPublished(at: Date, limit: number): Promise<ExpiredPublishedAsset[]>;
  /**
   * Removes the published snapshot while its rights still expire by `at`: one republished or
   * given a later expiry since the caller read it throws {@link TransactionConflictError} at
   * commit (in a unit of work), and stays published.
   */
  removeExpiredPublished(scope: Scope, id: string, at: Date): Promise<void>;
  getPublished(scope: Scope, id: string): Promise<PublishedAsset | null>;
  /** Batch point-read of published assets; missing ids are absent, order unspecified. */
  getPublishedMany(scope: Scope, ids: readonly string[]): Promise<PublishedAsset[]>;
  /** Published assets in publish order (oldest first), filtered and paged. */
  listPublished(scope: Scope, query: PublishedAssetQuery): Promise<PublishedAssetPage>;
}

/** What one ingest step writes. `null` clears a value; an omitted key is left as it is. */
export interface AssetIngestPatch {
  readonly status?: AssetIngestStatus;
  readonly error?: string | null;
  readonly contentHash?: string;
  readonly duplicateOf?: string | null;
  /** Measured from the bytes: written into the file record and its columns. */
  readonly size?: number;
  readonly width?: number;
  readonly height?: number;
  /** A raster image's ThumbHash and dominant colour, into the file record. */
  readonly placeholder?: AssetPlaceholder;
  /** The real content type, when the upload declared none worth keeping. */
  readonly contentType?: string;
  /**
   * Applies the patch only while the asset's ingest status is one of these (`null`: never
   * ingested), so a write that would move a run backwards (pending over processing) is dropped.
   */
  readonly onlyFrom?: readonly (AssetIngestStatus | null)[];
}

/**
 * The space's rendition presets. Presets belong to the space (`scope.spaceId`); the environment
 * in the scope is where the call came from and doesn't narrow anything.
 */
export interface AssetRenditionRepo {
  /** Every preset, by name. */
  list(scope: Scope): Promise<AssetRendition[]>;
  get(scope: Scope, name: string): Promise<AssetRendition | null>;
  /** Creates or replaces the preset with this name. */
  put(scope: Scope, rendition: AssetRendition): Promise<void>;
  delete(scope: Scope, name: string): Promise<void>;
}

/** The asset library's folders, environment-scoped like the assets filed in them. */
export interface AssetFolderRepo {
  get(scope: Scope, id: string): Promise<AssetFolder | null>;
  /** Every folder in the scope, in path order (a parent before its children). */
  list(scope: Scope): Promise<AssetFolder[]>;
  /**
   * A sibling with the same name under the same parent is a `ConflictError`; a parent that is gone
   * by commit throws {@link TransactionConflictError}.
   */
  create(scope: Scope, folder: AssetFolder): Promise<void>;
  /**
   * Renames and/or moves `folder` (the updated record). When its `path` changed, every
   * descendant's path is rewritten from `previousPath` in the same statement batch.
   */
  save(scope: Scope, folder: AssetFolder, previousPath: string): Promise<void>;
  /**
   * Deletes an empty folder. If a subfolder or an asset is in it at commit, the unit throws
   * {@link TransactionConflictError} and nothing is deleted.
   */
  delete(scope: Scope, id: string): Promise<void>;
}

/** One page of the collections in a scope, by name. */
export interface AssetCollectionPage {
  readonly items: AssetCollection[];
  readonly nextCursor?: string;
}

/** A collection and its members' ids in order, as a snapshot carries it. */
export interface AssetCollectionWithItems {
  readonly collection: AssetCollection;
  readonly assetIds: readonly string[];
}

/**
 * Collections: named, ordered sets of assets (many-to-many with assets), environment-scoped. Every
 * id list rides as one JSON parameter (`json_each`), so a change of any size is one statement
 * under D1's parameter cap, and only assets of the same scope ever become members.
 */
export interface AssetCollectionRepo {
  get(scope: Scope, id: string): Promise<AssetCollection | null>;
  /** By name, then id; `cursor` is a previous page's `nextCursor`. */
  list(
    scope: Scope,
    query?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<AssetCollectionPage>;
  create(scope: Scope, collection: AssetCollection): Promise<void>;
  /**
   * Writes the name, description and `updatedAt`. A collection gone by commit throws
   * {@link TransactionConflictError}.
   */
  save(scope: Scope, collection: AssetCollection): Promise<void>;
  /** Deletes the collection and its memberships (never the assets). */
  delete(scope: Scope, id: string): Promise<void>;
  /**
   * Appends `assetIds` after the last member, in the order given. Ids already in it, and ids that
   * aren't assets of the scope, are skipped. If the collection is gone, or would hold more than
   * `maxItems`, at commit, the unit throws {@link TransactionConflictError} and nothing is added.
   */
  addItems(
    scope: Scope,
    id: string,
    assetIds: readonly string[],
    at: Date,
    maxItems: number,
  ): Promise<void>;
  removeItems(scope: Scope, id: string, assetIds: readonly string[]): Promise<void>;
  /**
   * Puts `assetIds` first, in that order; the other members follow in the order they had. Ids
   * that aren't members are ignored. A collection gone by commit throws
   * {@link TransactionConflictError}.
   */
  reorder(scope: Scope, id: string, assetIds: readonly string[]): Promise<void>;
  /**
   * The members as assets, in the collection's order, filtered as the library is (archived
   * members hidden unless asked for; `query.sort` is ignored). Keyset-paged like the library.
   */
  listItems(scope: Scope, id: string, query: AssetListQuery): Promise<AssetPage>;
  /** Every member id in order (at most the collection's cap): for a reorder or a zip. */
  listItemIds(scope: Scope, id: string): Promise<string[]>;
  /** The published members, in the collection's order, paged: what Delivery lists. */
  listPublishedItems(
    scope: Scope,
    id: string,
    query: { readonly limit?: number; readonly cursor?: string },
  ): Promise<PublishedAssetPage>;
  /**
   * Writes a collection and its members in the order given, as a snapshot import has them: the
   * members are written whether or not their assets exist yet (the import creates them after;
   * every read joins the assets, so a member whose asset never arrives is never seen). A
   * collection already there (a retried import) is left as it is.
   */
  restore(scope: Scope, collection: AssetCollection, assetIds: readonly string[]): Promise<void>;
  /** Whether the asset is a member of the collection (a primary-key read). */
  hasItem(scope: Scope, id: string, assetId: string): Promise<boolean>;
  /** The collections an asset is in (at most `limit`), for purging what lists them. */
  collectionsOf(scope: Scope, assetId: string, limit: number): Promise<string[]>;
}

/** What a share link listing keeps. */
export interface AssetShareLinkQuery {
  readonly targetType?: AssetShareTargetType;
  readonly targetId?: string;
  /** Expired and revoked links too (default: active ones only, as of `now`). */
  readonly includeInactive?: boolean;
  readonly now: Date;
  readonly limit?: number;
}

/** Share links: revocable, expiring links to an asset or a collection (environment-scoped). */
export interface AssetShareLinkRepo {
  get(scope: Scope, id: string): Promise<StoredAssetShareLink | null>;
  /** Newest first. */
  list(scope: Scope, query: AssetShareLinkQuery): Promise<StoredAssetShareLink[]>;
  /**
   * Creates the link. If its target (the asset, or the collection) is gone at commit, the unit
   * throws {@link TransactionConflictError} and nothing is written.
   */
  create(scope: Scope, link: StoredAssetShareLink): Promise<void>;
  /**
   * Marks the link revoked at `at`, only while it isn't already: one revoked meanwhile throws
   * {@link TransactionConflictError} at commit (in a unit of work).
   */
  revoke(scope: Scope, id: string, at: Date): Promise<void>;
}

/** What a zip job's progress writes; an omitted key is left as it is. */
export interface AssetZipJobPatch {
  readonly status?: AssetZipJob['status'];
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly partsDone?: number;
  readonly partCount?: number;
  readonly error?: string;
  readonly completedAt?: string;
}

/** Zip download jobs. Written by the api (create) and the engine's Workflow (progress). */
export interface AssetZipJobRepo {
  get(scope: Scope, id: string): Promise<AssetZipJob | null>;
  /** Newest first, at most `limit`. */
  list(scope: Scope, limit: number): Promise<AssetZipJob[]>;
  create(scope: Scope, job: AssetZipJob): Promise<void>;
  update(scope: Scope, id: string, patch: AssetZipJobPatch): Promise<void>;
  /** Jobs whose archive expired by `at`, in every scope, oldest first: the sweep's work. */
  listExpired(at: Date, limit: number): Promise<{ readonly scope: Scope; readonly id: string }[]>;
  delete(scope: Scope, id: string): Promise<void>;
}

/**
 * A multipart upload in progress: the asset whose file it writes, the object key, the size it was
 * started for and the part size every part but the last has (R2 needs them equal).
 */
export interface AssetUpload {
  readonly assetId: string;
  readonly uploadId: string;
  readonly r2Key: string;
  readonly size: number;
  readonly partSize: number;
  readonly contentType: string;
  readonly createdAt: string;
}

/**
 * Multipart uploads in progress, so completing one checks what it was started for and the sweep
 * aborts the ones left behind (R2 keeps their parts, billed, until aborted).
 */
export interface AssetUploadRepo {
  get(scope: Scope, assetId: string, uploadId: string): Promise<AssetUpload | null>;
  create(scope: Scope, upload: AssetUpload): Promise<void>;
  delete(scope: Scope, assetId: string, uploadId: string): Promise<void>;
  /** One asset's uploads in progress (a file replacement's among them), oldest first. */
  listForAsset(scope: Scope, assetId: string): Promise<AssetUpload[]>;
  /** Uploads started before `before`, in every scope, oldest first, at most `limit`. */
  listStartedBefore(
    before: Date,
    limit: number,
  ): Promise<{ readonly scope: Scope; readonly upload: AssetUpload }[]>;
}

export interface AuthRepo {
  createApiKey(key: ApiKey): Promise<void>;
  /** Resolve an API key by the hash of its presented token. */
  findByHash(hashedToken: string): Promise<ApiKey | null>;
  list(spaceId: string): Promise<ApiKey[]>;
  revoke(id: string): Promise<void>;
  /** Best-effort stamp of last successful use (does not fail auth). */
  touchLastUsed(id: string, at: Date): Promise<void>;
  /**
   * Rebinds a key to a role (or to none, with `roleId` undefined), refreshing its display
   * snapshot of `scopes`. The key keeps its token, kind and issuance.
   */
  setRole(id: string, roleId: string | undefined, scopes: readonly string[]): Promise<void>;
}

/** Expiring, entry-scoped tokens for shareable preview links. */
export interface PreviewTokenRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId: string;
  readonly hashedToken: string;
  readonly expiresAt: Date;
  readonly revoked: boolean;
}

export interface PreviewTokenRepo {
  create(record: PreviewTokenRecord): Promise<void>;
  findByHash(hashedToken: string): Promise<PreviewTokenRecord | null>;
  revoke(id: string): Promise<void>;
}

/**
 * Installed plugins. Space-scoped: a plugin is approved for a space by someone
 * who administers that space, and its grant does not travel to another.
 */
export interface PluginRepo {
  create(plugin: InstalledPlugin): Promise<void>;
  get(spaceId: string, id: string): Promise<InstalledPlugin | null>;
  list(spaceId: string): Promise<InstalledPlugin[]>;
  save(plugin: InstalledPlugin): Promise<void>;
  delete(spaceId: string, id: string): Promise<void>;
}

/**
 * An installed plugin's settings, one record per plugin per space. Secret
 * values arrive and leave in plaintext here; the store seam (`withSealedSecrets`)
 * seals each one at rest, so an adapter only ever persists opaque strings.
 */
export interface PluginSettingsRepo {
  get(spaceId: string, pluginId: string): Promise<PluginSettings | null>;
  /**
   * Compare-and-set on `version`: writes only when the stored record is still at
   * `expectedVersion` (0: none exists yet). Returns whether it wrote; a lost race
   * leaves the stored record untouched.
   */
  save(settings: PluginSettings, expectedVersion: number): Promise<boolean>;
  delete(spaceId: string, pluginId: string): Promise<void>;
}

/**
 * The `kv:storage` capability's backing store: a key/value space per plugin per
 * environment. Values are opaque strings (the application stores JSON).
 *
 * Every method takes the plugin id from the host, never from the plugin, and
 * every implementation MUST filter on (scope, pluginId) in each statement: that
 * is the whole of the isolation between plugins.
 */
export interface PluginStorageRepo {
  get(scope: Scope, pluginId: string, key: string): Promise<string | null>;
  /**
   * Writes `value` under `key`. A new key is refused (returns false, writes
   * nothing) when the plugin already holds `maxKeys` keys in the scope;
   * overwriting an existing key always succeeds. The check and the write are
   * one statement, so concurrent puts cannot overshoot the cap.
   */
  put(
    scope: Scope,
    pluginId: string,
    key: string,
    value: string,
    opts: { readonly maxKeys: number; readonly at: Date },
  ): Promise<boolean>;
  /** Returns whether a key was removed. */
  delete(scope: Scope, pluginId: string, key: string): Promise<boolean>;
  /** Keys in byte order, starting with `prefix`, strictly after `after`. */
  list(
    scope: Scope,
    pluginId: string,
    opts: { readonly prefix?: string; readonly after?: string; readonly limit: number },
  ): Promise<string[]>;
  /** Removes the plugin's keys in every environment of the space (an uninstall). */
  deleteAll(spaceId: string, pluginId: string): Promise<void>;
}

/** Registered OAuth clients (RFC 7591 dynamic registration). Not space-scoped. */
export interface OAuthClientRepo {
  create(client: OAuthClient): Promise<void>;
  get(clientId: string): Promise<OAuthClient | null>;
  list(): Promise<OAuthClient[]>;
  delete(clientId: string): Promise<void>;
}

/**
 * A pending or issued OAuth grant: an authorization code, a device
 * authorization, or a refresh token. One record type covers all three because
 * they share a lifecycle (created → approved/denied → consumed/revoked) and
 * differ only in which lookup key finds them.
 *
 * Raw codes are never stored — `hashedCode` and `hashedUserCode` hold digests,
 * exactly as API keys and preview tokens do.
 */
export interface OAuthGrantRecord {
  readonly id: string;
  readonly kind: OAuthGrantKind;
  readonly clientId: string;
  readonly hashedCode: string;
  /** Device flow only: digest of the short code the human types in. */
  readonly hashedUserCode?: string;
  readonly status: OAuthGrantStatus;
  readonly scopes: readonly string[];
  /** Set once a human approves; the space the resulting token acts in. */
  readonly spaceId?: string;
  readonly subject?: string;
  readonly roleId?: string;
  /** Authorization-code flow: the URI the code must be redeemed against. */
  readonly redirectUri?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: string;
  /** RFC 8707 resource indicator the token is being requested for. */
  readonly resource?: string;
  /**
   * The grant this one descends from — a refresh token points at the
   * authorization code that produced it. OAuth 2.1 requires that replaying a
   * consumed code revoke everything issued from it, which needs this link.
   */
  readonly parentId?: string;
  /** Access-token key ids issued from this grant, revoked alongside it. */
  readonly issuedKeyIds?: readonly string[];
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface OAuthGrantRepo {
  create(record: OAuthGrantRecord): Promise<void>;
  /** Looks up by digest within a kind, so a code cannot be replayed as a refresh token. */
  findByHash(kind: OAuthGrantKind, hashedCode: string): Promise<OAuthGrantRecord | null>;
  /** Device flow: resolve the code the human typed. */
  findByUserCodeHash(hashedUserCode: string): Promise<OAuthGrantRecord | null>;
  save(record: OAuthGrantRecord): Promise<void>;
  /** Every grant descending from `parentId` (refresh tokens of a code). */
  listByParent(parentId: string): Promise<OAuthGrantRecord[]>;
  /**
   * Every grant a client holds on one human's behalf. Disconnecting an
   * application has to reach these: revoking only its access token leaves the
   * refresh token alive, and the client simply mints a new one.
   */
  listByClientAndSubject(clientId: string, subject: string): Promise<OAuthGrantRecord[]>;
  /** Retention: drop grants that expired before `before`. */
  deleteExpiredBefore(before: Date): Promise<number>;
}

/** Custom roles (granular RBAC) — space-scoped, referenced by API keys. */
export interface RoleRepo {
  /**
   * Creates or replaces (by id) a role. A second role with the same `preset` in a space is
   * refused (the adapter's unique index), so racing seeds can't duplicate a preset.
   */
  save(role: Role): Promise<void>;
  get(spaceId: string, id: string): Promise<Role | null>;
  list(spaceId: string): Promise<Role[]>;
  delete(spaceId: string, id: string): Promise<void>;
}

/** The people on a space's team (see `SpaceMember`). Email is unique within a space. */
export interface MemberRepo {
  /** Creates or replaces (by id). A second member with the same email in a space is refused. */
  save(member: SpaceMember): Promise<void>;
  get(spaceId: string, id: string): Promise<SpaceMember | null>;
  getByEmail(spaceId: string, email: string): Promise<SpaceMember | null>;
  list(spaceId: string): Promise<SpaceMember[]>;
  delete(spaceId: string, id: string): Promise<void>;
}

/**
 * Invitations to the admin. Deployment-wide like the people they make: no `Scope`, because one
 * invitation grants roles in any number of spaces (each grant names its own). Only token hashes
 * are ever stored.
 */
export interface InviteRepo {
  create(invite: MemberInvite): Promise<void>;
  get(id: string): Promise<MemberInvite | null>;
  /** The invitation whose link token, or emailed link token, hashes to `tokenHash`. */
  findByTokenHash(tokenHash: string): Promise<MemberInvite | null>;
  /**
   * Newest first. `status` filters on what is stored, read as of `now` (`pending` leaves out the
   * expired; `expired` is the pending ones past their expiry); `email` on the address.
   */
  list(opts: {
    readonly now: Date;
    readonly status?: InviteStatus;
    readonly email?: string;
    readonly limit?: number;
  }): Promise<MemberInvite[]>;
  /**
   * Replaces the invitation if it is still at `expectedVersion` (the caller bumps `version`).
   * Another change since the caller read it (a resend, a revoke, another accept) throws
   * {@link TransactionConflictError}: at commit inside a unit of work, at once outside one.
   */
  replace(invite: MemberInvite, expectedVersion: number): Promise<void>;
  /**
   * Records the token hash of the link the engine is emailing, and (after the send, with
   * `emailedAt`) that it went, if the invitation is still pending at `version`; false (nothing
   * written) when it is not. Doesn't bump `version`. Not in a unit of work: the engine records,
   * sends, then records again.
   */
  recordEmailToken(
    id: string,
    version: number,
    emailTokenHash: string,
    emailedAt: string | null,
  ): Promise<boolean>;
}

/** A deployment-wide setting as stored, with the version its compare-and-set checks. */
export interface StoredSetting {
  readonly value: unknown;
  readonly version: number;
}

/**
 * Deployment-wide settings (first-run setup state, per-space access settings), keyed by name.
 * Not space-scoped: the setup code belongs to the deployment, not to any one space.
 */
export interface DeploymentSettingsRepo {
  get(key: string): Promise<StoredSetting | null>;
  /**
   * Compare-and-set. `expectedVersion: null` writes only when the key is absent; a number writes
   * only when the stored version still equals it (the new version is that plus one). Returns
   * whether the write happened, so two racing writers can't both win.
   */
  put(key: string, value: unknown, expectedVersion: number | null): Promise<boolean>;
}

/** One cron job's outcome on one tick, as the engine records it. */
export interface SchedulerJobRun {
  /** The sweep's name (`outbox-relay`, `scheduled-actions`, …); `tick` is the cron tick itself. */
  readonly job: string;
  /** When the job finished (ISO 8601). */
  readonly at: string;
  /** Why it failed, already redacted and bounded; absent when it succeeded. */
  readonly error?: string;
}

/** What the store keeps about one cron job: when it last ran, last succeeded and last failed. */
export interface SchedulerJobStatus {
  readonly job: string;
  readonly lastRunAt: string;
  readonly lastSuccessAt?: string;
  readonly lastErrorAt?: string;
  readonly lastError?: string;
}

/**
 * The engine cron's heartbeat, one row per job. Deployment-wide, not space-scoped: the cron
 * sweeps every space at once. Written once a tick by the cron only (one batch a minute, never on a
 * request path) and read by the health probe and the admin's scheduler status.
 */
export interface SchedulerJobRepo {
  /**
   * Merges each run into its job's row. A success keeps the job's last error (and a failure its
   * last success), and a run older than what the row holds never moves a timestamp back, so a
   * slow tick finishing after the next one, or a retried write, leaves the newer outcome.
   */
  record(runs: readonly SchedulerJobRun[]): Promise<void>;
  /** Every job's row, by name. */
  list(): Promise<SchedulerJobStatus[]>;
}

/** The transactional view of the store handed to `withTransaction`. */
export interface ContentStoreTx {
  /** Only the purge's progress mark, which commits with the event that continues the purge. */
  readonly spaces: Pick<SpaceRepo, 'markEnvironmentPurgeProgress' | 'setLocaleSettings'>;
  readonly contentTypes: ContentTypeRepo;
  readonly entries: EntryRepo;
  readonly assets: AssetRepo;
  readonly assetFolders: AssetFolderRepo;
  readonly assetCollections: AssetCollectionRepo;
  readonly assetShareLinks: AssetShareLinkRepo;
  readonly assetZips: AssetZipJobRepo;
  readonly assetUploads: AssetUploadRepo;
  readonly assetRenditions: AssetRenditionRepo;
  readonly references: ReferenceRepo;
  readonly releases: ReleaseRepo;
  readonly taxonomy: TaxonomyRepo;
  /** A publish's slug change writes redirects with the publish. */
  readonly redirects: RedirectRepo;
  /** A menu is written with its revision's compare-and-set and the event that announces it. */
  readonly menus: MenuRepo;
  readonly bulkJobs: BulkJobRepo;
  /** Run and task rows change in the same transaction as the outbox events they announce. */
  readonly workflowRuns: WorkflowRunRepo;
  readonly workflowTasks: WorkflowTaskRepo;
  /** Read-only: a publish inside the unit checks the workflows gating it. */
  readonly workflowGraphs: Pick<WorkflowGraphRepo, 'listPublishGates'>;
  readonly outbox: OutboxRepo;
  /** A promotion's record is created in the same unit as the event that announces it. */
  readonly promotions: PromotionRepo;
  /**
   * An invitation is created, resent, revoked or used in the same unit as the event that emails
   * it, or as the team places it grants (`members.save`).
   */
  readonly invites: Pick<InviteRepo, 'create' | 'replace'>;
  readonly members: Pick<MemberRepo, 'save'>;
}

/** Promotion fields a status change may set. */
export type PromotionPatch = Partial<
  Pick<Promotion, 'status' | 'decidedBy' | 'decidedAt' | 'result' | 'error' | 'completedAt'>
>;

export interface PromotionRepo {
  create(promotion: Promotion): Promise<void>;
  get(spaceId: string, id: string): Promise<Promotion | null>;
  /** Newest first; optionally only one status. */
  list(
    spaceId: string,
    opts?: { readonly status?: PromotionStatus; readonly limit?: number },
  ): Promise<Promotion[]>;
  /**
   * Moves a promotion out of `from`, applying `patch`: a compare-and-set, so exactly one caller
   * wins. Returns the promotion as it now is, or null when it was not in `from` (or not there).
   */
  transition(
    spaceId: string,
    id: string,
    from: PromotionStatus,
    patch: PromotionPatch,
  ): Promise<Promotion | null>;
}

export interface ReleaseRepo {
  create(scope: Scope, release: Release): Promise<void>;
  get(scope: Scope, id: string): Promise<Release | null>;
  list(scope: Scope): Promise<Release[]>;
  /** Persists the updated release aggregate (status/publishedAt). */
  save(scope: Scope, release: Release): Promise<void>;
  delete(scope: Scope, id: string): Promise<void>;
  /** Adds (or replaces, by entityId) a member. */
  addItem(scope: Scope, releaseId: string, item: ReleaseItem): Promise<void>;
  removeItem(scope: Scope, releaseId: string, entityId: string): Promise<void>;
  listItems(scope: Scope, releaseId: string): Promise<ReleaseItem[]>;
  /**
   * How many members each of `releaseIds` holds, from one grouped count (however many ids). A
   * release with no members is absent.
   */
  countItems(scope: Scope, releaseIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

/** A due scheduled action paired with the scope it belongs to (the worker polls
 *  across all scopes, so `findDue` carries scope with each record). */
export interface ScopedScheduledAction {
  readonly scope: Scope;
  readonly action: ScheduledAction;
}

export interface ScheduledActionRepo {
  create(scope: Scope, action: ScheduledAction): Promise<void>;
  get(scope: Scope, id: string): Promise<ScheduledAction | null>;
  list(scope: Scope, query?: { status?: string }): Promise<ScheduledAction[]>;
  save(scope: Scope, action: ScheduledAction): Promise<void>;
  /** Pending actions due at/ before `now`, across every scope, oldest first. */
  findDue(now: string, limit?: number): Promise<ScopedScheduledAction[]>;
}

/** A due agent schedule paired with its scope (cross-scope worker poll). */
export interface ScopedAgentSchedule {
  readonly scope: Scope;
  readonly schedule: AgentSchedule;
}

export interface AgentReviewRepo {
  create(scope: Scope, review: AgentReview): Promise<void>;
  get(scope: Scope, id: string): Promise<AgentReview | null>;
  list(
    scope: Scope,
    query?: { status?: AgentReview['status']; entryId?: string; limit?: number },
  ): Promise<AgentReview[]>;
  /**
   * Pending reviews, counted per content type of the entry each proposes changes to (uncapped,
   * unlike `list`); a review whose entry is gone counts under null.
   */
  countPending(scope: Scope): Promise<PendingCount[]>;
  /**
   * CAS pending → decided. Returns false when the review was already decided
   * (a concurrent reviewer won) — the caller must not act on a lost race.
   */
  decide(
    scope: Scope,
    id: string,
    decision: { status: 'approved' | 'rejected'; decidedAt: string; decidedBy?: string },
  ): Promise<boolean>;
  /**
   * CAS arming of the durable watcher: pending + !awaiting → awaiting. Returns
   * the review's current status when the arm was NOT taken (already decided —
   * the watcher then observes instead of waiting), or 'armed'.
   */
  markAwaiting(scope: Scope, id: string): Promise<'armed' | AgentReview['status']>;
  /** Clears `awaiting` (watcher timed out/completed without a decision). */
  clearAwaiting(scope: Scope, id: string): Promise<void>;
  /**
   * CAS exactly-once apply marker. Returns true for the single caller that
   * owns applying the proposal; every later caller gets false and skips.
   */
  markApplied(scope: Scope, id: string, at: string): Promise<boolean>;
  /** Compensation: rolls the apply marker back when the apply itself threw,
   *  so the proposal stays re-drivable instead of falsely recorded applied. */
  clearApplied(scope: Scope, id: string): Promise<void>;
}

export interface AgentScheduleRepo {
  create(scope: Scope, schedule: AgentSchedule): Promise<void>;
  get(scope: Scope, id: string): Promise<AgentSchedule | null>;
  list(scope: Scope): Promise<AgentSchedule[]>;
  save(scope: Scope, schedule: AgentSchedule): Promise<void>;
  delete(scope: Scope, id: string): Promise<void>;
  /** Enabled schedules due at/before `now`, across every scope, oldest first. */
  findDue(now: string, limit?: number): Promise<ScopedAgentSchedule[]>;
  /**
   * Optimistic claim of one due firing: advances `nextRunAt` from
   * `expectedNextRunAt` to `nextRunAt` iff it still holds that value. Returns
   * false when another runner won the race — concurrent workers (replicas,
   * rolling updates, worker + edge cron) then never double-run a firing.
   */
  claimNextRun(
    scope: Scope,
    id: string,
    expectedNextRunAt: string,
    nextRunAt: string,
  ): Promise<boolean>;
  /** Persists only a run's window cursor — never the user-editable fields, so
   *  a concurrent PATCH can't be clobbered by a completing run. */
  saveRunState(
    scope: Scope,
    id: string,
    state: { lastRunAt: string; cursorEntryId?: string },
  ): Promise<void>;
}

/** Space-level configuration needed for validation and locale fallback. */
export interface SpaceConfig {
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: LocaleCode;
  readonly locales: readonly LocaleCode[];
  /** locale -> fallback locale (null = none). Defaults to the default locale. */
  readonly fallbacks?: Readonly<Record<LocaleCode, LocaleCode | null>>;
  /** Per-locale settings (delivered, direction); a locale absent takes the defaults. */
  readonly localeSettings?: Readonly<Record<LocaleCode, LocaleSettings>>;
  /**
   * The space's default for workflow approvals whose node leaves `separateDuties` unset: when
   * true, whoever started a run can't decide its approvals. Absent means false.
   */
  readonly workflowSeparateDuties?: boolean;
  /**
   * Days a trashed entry is kept before the engine's retention sweep deletes it permanently.
   * Absent means off: trashed entries stay until someone deletes them.
   */
  readonly trashRetentionDays?: number;
}

/** An environment (branch) within a space. */
export interface Environment {
  readonly id: string;
  readonly name: string;
}

/**
 * The reads one step of a Delivery request needs, none depending on another's answer: asked for
 * together so the D1 store sends them as one `batch()` (one round trip) instead of one statement
 * at a time. Every part is optional; ask only for what the step needs.
 */
export interface DeliveryReadRequest {
  /** The space's configuration (locales, fallbacks). */
  readonly config?: boolean;
  /**
   * With `assetId` or `assetPage`: the space's per-locale settings, read on that statement rather
   * than one of their own, as `assetLocales` (what an all-locale asset read needs to leave out the
   * locales the space doesn't deliver). Present when the asset or page holds anything.
   */
  readonly assetLocales?: boolean;
  /**
   * Every content type in the scope, as Delivery sees it: `singleton` is the flag as last
   * published (what `…/singletons/:apiId` serves by), so GraphQL's singleton roots agree with it.
   */
  readonly contentTypes?: boolean;
  /** The space's rendition presets. */
  readonly renditions?: boolean;
  /** One published entry. */
  readonly entryId?: string;
  /** One published asset. */
  readonly assetId?: string;
  /** Published entries by id (any number: split under the parameter cap). */
  readonly entryIds?: readonly string[];
  /** Published assets by id (any number: split under the parameter cap). */
  readonly assetIds?: readonly string[];
  /** A page of published assets. */
  readonly assetPage?: PublishedAssetQuery;
  /** The scope's tags; with `slugs`, only those holding one. */
  readonly tags?: { readonly slugs?: readonly string[] };
  /** The scope's concepts, narrowed to a scheme and/or to the ones holding one of `slugs`. */
  readonly concepts?: { readonly schemeId?: string; readonly slugs?: readonly string[] };
  /** Published usage counts of one kind of term, narrowed as `tags` / `concepts` are. */
  readonly termUsage?: {
    readonly kind: TermKind;
    readonly schemeId?: string;
    readonly slugs?: readonly string[];
  };
  /**
   * One menu by handle, with what its links resolve against: the published entries and the
   * terms it links to, read in the same batch (the menu's own row names them).
   */
  readonly menu?: { readonly handle: string };
  /** A page of the sitemap's published entries. */
  readonly sitemap?: SitemapQuery;
  /**
   * One content type and its published entry: what `GET …/singletons/:apiId` serves, in the same
   * batch. The entry is the type's first published one by id (a singleton has at most one).
   */
  readonly singleton?: { readonly contentType: string };
}

/** A content type and its published entry, as {@link DeliveryReadRequest.singleton} reads them. */
export interface SingletonRead {
  /** As Delivery serves it (`deliveredContentType`). Null when no content type has the apiId. */
  readonly contentType: DeliveredContentType | null;
  /**
   * Whether the type's published revision is a singleton: what Delivery serves by, so a draft
   * revision turning the flag on or off changes nothing there until the type is published.
   */
  readonly publishedSingleton: boolean;
  /** Null when none of its entries is published. */
  readonly entry: PublishedEntry | null;
}

/**
 * A page of published entries for the sitemap: those of `contentTypes`, by entry id, each carrying
 * only `fields` of its body (the slugs a URL pattern names and the Seo field), so a page of
 * thousands never reads a rich-text body.
 */
export interface SitemapQuery {
  /** At least one; a JSON parameter, so any number. */
  readonly contentTypes: readonly string[];
  /** Field apiIds to read from each body; a JSON parameter, so any number. */
  readonly fields: readonly string[];
  /** The first entry id of the page (inclusive); from the start when absent. */
  readonly from?: string;
  /** The first entry id past the page (exclusive): the next page's first. To the end when absent. */
  readonly before?: string;
  readonly limit: number;
  /** Also answer the first entry id of every page of this many entries: the sitemap index. */
  readonly pageStarts?: number;
}

/** A published entry as the sitemap reads it. */
export interface SitemapEntryRow {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  /** Only the fields the query named; one the entry has no value for is absent. */
  readonly fields: EntryFields;
  /** When the live version was published (ISO-8601): the sitemap's `lastmod`. */
  readonly publishedAt: string;
}

export interface SitemapPage {
  /** By entry id, at most `limit`. */
  readonly items: SitemapEntryRow[];
  /** When `pageStarts` was asked: each page's first entry id, in order (empty when none). */
  readonly pageStarts?: string[];
}

/** A menu and the published entries and terms its items link to (those that exist). */
export interface MenuRead {
  readonly menu: Menu;
  readonly entries: PublishedEntry[];
  readonly tags: Tag[];
  readonly concepts: Concept[];
}

/**
 * What a {@link DeliveryReadRequest} read: each part is present exactly when it was asked for,
 * with the same answer its own repo method gives (`spaces.getConfig`, `entries.getPublished`,
 * `assets.getPublishedMany`, …).
 */
export interface DeliveryReadResult {
  readonly config?: SpaceConfig | null;
  /** The space's per-locale settings (`{}` for none), when asked and the asset read found rows. */
  readonly assetLocales?: Readonly<Record<LocaleCode, LocaleSettings>>;
  /**
   * The published view of every type (`deliveredContentType`), not the working definitions
   * `ContentTypeRepo` reads: a live type with a draft revision is here as last published, and a
   * draft with no published definition as it stands, status `draft`. Never the admin-only
   * details (`DeliveredContentType`).
   */
  readonly contentTypes?: DeliveredContentType[];
  readonly renditions?: AssetRendition[];
  readonly entry?: PublishedEntry | null;
  readonly asset?: PublishedAsset | null;
  /** Missing ids are absent, order unspecified. */
  readonly entries?: PublishedEntry[];
  /** Missing ids are absent, order unspecified. */
  readonly assets?: PublishedAsset[];
  readonly assetPage?: PublishedAssetPage;
  readonly tags?: Tag[];
  readonly concepts?: Concept[];
  readonly termUsage?: TermUsage[];
  readonly sitemap?: SitemapPage;
  /** Null when no menu has the handle. */
  readonly menu?: MenuRead | null;
  readonly singleton?: SingletonRead;
}

/** Delivery's reads, batched. Read-only: it never writes, so it is safe on a replica session. */
export interface DeliveryReadRepo {
  read(scope: Scope, request: DeliveryReadRequest): Promise<DeliveryReadResult>;
}

/** A repointable pointer to a target environment, used for blue/green serving. */
export interface EnvironmentAlias {
  readonly alias: string;
  readonly targetEnvironmentId: string;
  /** When the alias was last (re)pointed (ISO-8601). */
  readonly updatedAt: string;
}

export interface SpaceRepo {
  getConfig(scope: Scope): Promise<SpaceConfig | null>;
  /** All spaces (admin/provisioning view). */
  list(): Promise<SpaceConfig[]>;
  /** Creates (or replaces) a space's configuration. */
  create(config: SpaceConfig): Promise<void>;
  /** Sets the space's default separation of duties for workflow approvals. */
  setWorkflowSeparateDuties(spaceId: string, value: boolean): Promise<void>;
  /** Sets how many days the space keeps trashed entries; null turns retention off. */
  setTrashRetentionDays(spaceId: string, days: number | null): Promise<void>;
  /**
   * Replaces the space's per-locale settings (an empty object: the defaults for every locale),
   * provided they are still `expected` (what the caller read; undefined: none set). Another change
   * in between is a lost race: `TransactionConflictError`, at commit inside a unit.
   */
  setLocaleSettings(
    spaceId: string,
    settings: Readonly<Record<LocaleCode, LocaleSettings>>,
    expected: Readonly<Record<LocaleCode, LocaleSettings>> | undefined,
  ): Promise<void>;
  /** Where the trash retention sweep resumes in this environment; null is from the oldest. */
  getTrashSweepCursor(scope: Scope): Promise<ExpiredTrashEntry | null>;
  setTrashSweepCursor(scope: Scope, cursor: ExpiredTrashEntry | null): Promise<void>;
  /**
   * Registers an environment (branch) within a space. Refused with `TransactionConflictError`
   * while a deleted environment of that id is still being purged, so it can't inherit leftovers.
   */
  createEnvironment(spaceId: string, environmentId: string, name: string): Promise<void>;
  /** Lists a space's environments (branches). */
  listEnvironments(spaceId: string): Promise<Environment[]>;
  /** Creates or repoints an environment alias (atomic blue/green pointer). */
  setAlias(spaceId: string, alias: string, targetEnvironmentId: string, at: string): Promise<void>;
  /** Resolves one alias, or null if the name isn't an alias. */
  getAlias(spaceId: string, alias: string): Promise<EnvironmentAlias | null>;
  /**
   * What an `:env` name means, in one read: the alias target if it is an alias, and whether it
   * names a deleted environment whose rows are still being purged (which must not be read).
   */
  resolveName(
    spaceId: string,
    name: string,
  ): Promise<{ readonly targetEnvironmentId: string | null; readonly purging: boolean }>;
  /** Lists a space's environment aliases. */
  listAliases(spaceId: string): Promise<EnvironmentAlias[]>;
  /** Removes an alias (the target environment is untouched). */
  deleteAlias(spaceId: string, alias: string): Promise<void>;
  /**
   * Deletes an environment: removes its registry row and records it as purging, appending
   * `events` to the outbox and `audit` to the audit log, in one atomic write (a deletion never
   * commits unrecorded). Refused with `TransactionConflictError` if an alias points at it when
   * the write runs. Its rows are removed afterwards by {@link purgeEnvironmentStep}.
   */
  deleteEnvironment(
    spaceId: string,
    environmentId: string,
    events: readonly DomainEvent[],
    audit: AuditEntry,
  ): Promise<void>;
  /**
   * Deletes up to `rowsPerTable` rows from each table scoped to a purging environment (the
   * content model, entries and their versions, assets, references, releases, schedules,
   * workflows and runs, taxonomy, comments, tasks, jobs; never its audit history), and marks the
   * purge as progressing at `at`. Returns how many rows it deleted: 0 means none are left.
   */
  purgeEnvironmentStep(
    spaceId: string,
    environmentId: string,
    rowsPerTable: number,
    at: Date,
  ): Promise<number>;
  /**
   * Marks a purge as progressing at `at` without deleting anything (a step spent elsewhere, on
   * the environment's search entries), so the stall sweep doesn't restart it. Works in a unit of
   * work, so the mark and the event that continues the purge commit together.
   */
  markEnvironmentPurgeProgress(spaceId: string, environmentId: string, at: Date): Promise<void>;
  /** Clears a finished purge, so the environment's id can be used again. */
  finishEnvironmentPurge(spaceId: string, environmentId: string): Promise<void>;
  /**
   * Purges that haven't progressed since `staleBefore` (their step event was lost), marked as
   * progressing at `at` so a concurrent sweep doesn't take them too. At most `limit`.
   */
  claimStalledPurges(staleBefore: Date, at: Date, limit: number): Promise<Scope[]>;
}

export interface ContentTypeRepo {
  get(scope: Scope, apiId: string): Promise<ContentType | null>;
  list(scope: Scope): Promise<ContentType[]>;
  /**
   * The definitions kept for types with a draft revision over a published one, by apiId: what
   * Delivery serves for them. Types with nothing kept aren't in it. The store keeps these itself: a
   * save that takes a published type to draft keeps what it was, and a publish drops it.
   */
  publishedDefinitions(scope: Scope): Promise<ReadonlyMap<string, PublishedContentTypeDefinition>>;
  /** Upserts the definition at its version. */
  save(scope: Scope, contentType: ContentType): Promise<void>;
  /**
   * Inserts a new definition, never over another: a type of the same apiId already there (one
   * written after the caller looked) is a `TransactionConflictError` (at commit, inside a unit).
   */
  create(scope: Scope, contentType: ContentType): Promise<void>;
  /**
   * Writes nothing: a unit of work's guard that the type still exists with this `singleton` flag
   * and, with `entries`, holds no entry outside the trash but those. A type deleted or flipped
   * since the caller read it, or an entry created meanwhile, is a `TransactionConflictError` (at
   * commit, inside a unit).
   */
  guard(
    scope: Scope,
    apiId: string,
    expected: { readonly singleton: boolean; readonly entries?: readonly string[] },
  ): Promise<void>;
  /**
   * Deletes the definition while it is still at `version` and no entry of the type exists (the
   * trash included), both judged by the delete itself: a type revised since (or gone), or an
   * entry written in the meantime, is a `TransactionConflictError` (at commit, inside a unit).
   */
  delete(scope: Scope, apiId: string, version: number): Promise<void>;
}

/** A superseded entry version whose body can move to object storage. */
export interface ArchivableVersion {
  readonly scope: Scope;
  readonly entryId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly fields: EntryFields;
}

/** A draft entry together with the field values of its current version. */
export interface EntryWithFields {
  readonly entry: Entry;
  readonly fields: EntryFields;
  /** When the entry last changed (ISO-8601), as the store stamps it. Set by `list`. */
  readonly updatedAt?: string;
}

/**
 * Where a page of distinct field values starts: after this value in the values' order (booleans,
 * then numbers, then strings, each ascending). Taken from the last row of the previous page.
 */
export interface FieldValueKey {
  readonly value: string | number | boolean;
}

/** A content type's field whose distinct values to list ({@link EntryRepo.distinctFieldValues}). */
export interface FieldValuesQuery {
  readonly contentTypeApiId: string;
  /** A top-level field apiId: a scalar field, or a list of them. */
  readonly field: string;
  /** Only this locale's values; every locale's when absent. */
  readonly locale?: LocaleCode;
  /** The page size. */
  readonly limit: number;
  readonly after?: FieldValueKey;
}

/** One distinct value of a field and how many entries hold it. */
export interface FieldValueCount {
  readonly value: string | number | boolean;
  /** Entries (not in the trash) whose current version holds the value, in any locale. */
  readonly count: number;
}

/** How many entries of one content type are in one status (a row of {@link EntryRepo.countByStatus}). */
export interface EntryStatusCount {
  readonly contentType: string;
  readonly status: EntryStatus;
  readonly count: number;
}

/** The denormalized published snapshot served by the Delivery API. */
export interface PublishedEntry {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly version: number;
  readonly fields: EntryFields;
  readonly publishedAt: string;
  /** When the entry was first published (kept through unpublish and republish); absent when
   *  unknown, for an entry first published before it was recorded. */
  readonly firstPublishedAt?: string;
  /** Taxonomy associations captured at publish time (tags + concepts). */
  readonly metadata?: EntryMetadata;
  /** The entry's place in its type's manual order, copied from the entry; absent when it was
   *  never moved (it sorts by `entryId`). Live, not part of the published snapshot. */
  readonly position?: string;
}

/** A unique value already taken, and by whom. */
export interface UniqueConflict {
  readonly fieldApiId: string;
  readonly locale: string;
  readonly value: string;
  readonly entryId: string;
}

export interface EntryQuery {
  readonly contentTypeApiId?: string;
  readonly limit?: number;
  readonly skip?: number;
  /** Delta cursor — only entries published strictly after this ISO timestamp. */
  readonly since?: string;
  /**
   * Keyset cursor — only entries with `entryId` strictly greater, ordered by
   * `entryId` (`''` = from the start, still entryId-ordered). IDs are UUIDv7
   * (time-ordered), so paging with this cursor is stable under concurrent
   * publishes/unpublishes, unlike `skip` (used by the resumable reindex job).
   * Honoured by both `list` and `listPublished`; on `list` it is stable under
   * concurrent edits, which reorder the default `updatedAt` order.
   */
  readonly afterEntryId?: string;
  /**
   * Compound keyset cursor in publish order: only entries strictly after
   * `(publishedAt, entryId)` — i.e. published later, or published at the same
   * instant with a greater entry id. Matches the default
   * `publishedAt, entryId` ordering, so paging is exact across
   * same-transaction publishes that share a publish instant (used by agent
   * schedules' delta windows).
   */
  readonly after?: { readonly publishedAt: string; readonly entryId: string };
  /**
   * Keyset cursor in the list's own order (`order`, or `sys.updatedAt` ascending without one),
   * ties broken by entry id: only entries strictly after this row. `'start'` reads the first
   * page in that same total order. Honoured by `list` (the draft path), where `sys.updatedAt`
   * is the entry's `updatedAt`; build it with `entryKeysetOf`.
   */
  readonly afterRow?: EntryKeyset | 'start';
  /** Field-level predicates (all must match). `field` is a field apiId or `sys.*`. */
  readonly filters?: readonly QueryFilter[];
  /**
   * AND and OR groups of predicates, ANDed with `filters`. Build it with `parseQueryWhere`, which
   * bounds its depth and size; a store trusts it as given.
   */
  readonly where?: QueryNode;
  /**
   * The content model, for `ref`/`refIn`: the engine then reads each row's links as the reference
   * edges record them (the link-bearing fields its type declares). The use-cases pass it whenever
   * a query has a reference filter.
   */
  readonly contentTypes?: readonly ContentType[];
  /** Sort keys, applied in order. */
  readonly order?: readonly QueryOrder[];
  /** Projection — return only these field apiIds. */
  readonly select?: readonly string[];
  /**
   * Archived ("trashed") entries. Omitted or `false` excludes them — the safe
   * default, so every existing list hides trash without each caller having to
   * remember. `true` returns *only* archived entries, which is the trash view.
   */
  readonly archived?: boolean;
  /** Full-text search across string field values (case-insensitive). */
  readonly search?: string;
  /** Locale used to resolve field values for filtering/ordering/search. */
  readonly locale?: LocaleCode;
  /**
   * Ordered fallback locales tried when `locale` has no value for a field —
   * normally the space's default-locale chain. Without it, fallback resolution
   * depends on the backend's key ordering, so the same query could resolve a
   * different locale per store. Populated by the delivery/preview use-cases from SpaceConfig.
   */
  readonly fallbackLocales?: readonly LocaleCode[];
  /**
   * Locales filtering, ordering and search never read. Delivery names the ones the space doesn't
   * deliver, so a value in a locale it doesn't serve never decides a match or an order.
   */
  readonly hiddenLocales?: readonly LocaleCode[];
}

/** One ranked full-text match from the published read model. */
export interface TextSearchHit {
  readonly entryId: string;
  /** Engine-relative relevance — meaningful only for ordering within one result set. */
  readonly score: number;
}

/** A trashed entry as the retention sweep reads it, and its keyset cursor. */
export interface ExpiredTrashEntry {
  readonly id: string;
  /** When it was trashed (ISO). */
  readonly trashedAt: string;
}

/** An entry's place in its type's manual order: its effective key (its own, or its id). */
export interface EntryPlaceKey {
  readonly id: string;
  readonly position: string;
}

/** One key a move writes: only if the entry's effective key is still `expected`. */
export interface PositionWrite {
  readonly id: string;
  readonly position: string;
  readonly expected: string;
}

/**
 * What else must still hold when a move's keys are written. No entry of the type other than the
 * ones written may sit strictly between `lo` and `hi` (null for no bound), so two moves into one
 * gap can't both land; and the `anchor` the caller placed the entry beside must still have the key
 * it read.
 */
export interface PositionGuard {
  readonly lo: string | null;
  readonly hi: string | null;
  readonly anchor?: EntryPlaceKey;
}

export interface EntryRepo {
  get(scope: Scope, id: string): Promise<EntryWithFields | null>;
  /**
   * Batch point-read of draft/current entries — one backend round-trip for
   * the whole id set (bulk publish). Missing ids are absent; order unspecified.
   */
  getMany(scope: Scope, ids: readonly string[]): Promise<EntryWithFields[]>;
  /**
   * Up to `limit` entries of a type next to a place in its manual order, nearest first: those
   * after `key` ascending, or before it descending (a null `key` starts at the first or the last).
   * Trashed entries count, so a key never lands on one and a restored entry finds its place free.
   */
  positionNeighbors(
    scope: Scope,
    contentTypeApiId: string,
    key: string | null,
    side: 'after' | 'before',
    limit: number,
    excludeId?: string,
  ): Promise<EntryPlaceKey[]>;
  /**
   * Writes manual-order keys, all or none: each only if its entry still has the key it was read
   * at, and only while `guard` holds. A lost race throws {@link TransactionConflictError} (inside a
   * unit of work, at commit). The published rows follow (0034's triggers on D1).
   */
  setPositions(
    scope: Scope,
    contentTypeApiId: string,
    writes: readonly PositionWrite[],
    guard: PositionGuard,
  ): Promise<void>;
  /**
   * Each existing entry's content type, by id: one narrow read with no fields or bodies (it
   * never touches R2), for callers that only need to know what type an entry is. Missing ids
   * are absent.
   */
  contentTypesOf(scope: Scope, ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * Ids of up to `limit` entries, the trash included, whose current version has `text` anywhere in
   * its fields. A scan of the environment's current versions, for rare checks that must see what
   * the reference graph doesn't (it holds published links only). A match is a candidate, not a
   * link: read the entry to find out what the text is.
   */
  idsMentioning(scope: Scope, text: string, limit: number): Promise<string[]>;
  /** Lists draft/current entries (the Preview read path), newest-affected first. */
  list(scope: Scope, query: EntryQuery): Promise<EntryWithFields[]>;
  /**
   * A page of one content type's entry ids, the trash included, by id after `after`: an id-only
   * keyset read (no fields, no bodies) for callers that enumerate a whole type.
   */
  idsOfType(
    scope: Scope,
    contentTypeApiId: string,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<string[]>;
  /**
   * How many entries this scope holds, per content type and status (trash included, as
   * `archived`): one grouped count, never a page of rows measured. Groups with no entries are
   * absent; order unspecified.
   */
  countByStatus(scope: Scope): Promise<EntryStatusCount[]>;
  /**
   * The distinct scalar values one field holds across a content type's entries (current versions,
   * trash excluded), each with how many entries hold it, in the order {@link FieldValueKey}
   * describes. A list field contributes each of its elements; null, object and list values are
   * skipped. At most `limit` rows, after `after`. Throws `QueryTooBroadError` when the type
   * holds more entries than the store's query scan cap: every page groups the whole type.
   */
  distinctFieldValues(scope: Scope, query: FieldValuesQuery): Promise<FieldValueCount[]>;
  /** Persists a new entry and its first version. */
  create(scope: Scope, entry: Entry, version: EntryVersion): Promise<void>;
  /** Persists the updated aggregate plus a new version snapshot. */
  saveVersion(scope: Scope, entry: Entry, version: EntryVersion): Promise<void>;
  /** Updates only the aggregate (status/pointers) — no new version. */
  saveAggregate(scope: Scope, entry: Entry): Promise<void>;
  /** Batch {@link saveAggregate} — one statement for the whole set. */
  saveAggregateMany(scope: Scope, entries: readonly Entry[]): Promise<void>;
  /**
   * Permanently removes an entry and every version snapshot of it. Irreversible
   * — the trash lifecycle (archive → restore) is the recoverable path, and this
   * is what empties it.
   */
  delete(scope: Scope, id: string): Promise<void>;

  /**
   * Replaces the set of values this entry claims exclusively (its `unique`
   * fields), atomically.
   *
   * Backed by a real uniqueness constraint, so a colliding write fails rather
   * than racing past a read-then-write check: two concurrent creates of the
   * same slug cannot both win. Implementations MUST surface a collision as a
   * `ConflictError` naming the offending claims.
   */
  replaceUniqueClaims(scope: Scope, entryId: string, claims: readonly UniqueClaim[]): Promise<void>;
  /**
   * Claims already held by a *different* entry — used to fail early with a
   * message naming the field and the conflicting entry, rather than surfacing a
   * bare constraint violation. The constraint remains the actual guarantee.
   */
  findUniqueConflicts(
    scope: Scope,
    claims: readonly UniqueClaim[],
    excludeEntryId?: string,
  ): Promise<UniqueConflict[]>;
  /** Drops every claim held by an entry, freeing its values for reuse. */
  releaseUniqueClaims(scope: Scope, entryId: string): Promise<void>;
  /**
   * Up to `limit` trashed entries trashed before `before` (an archived entry's last change is its
   * trashing), oldest first by `(trashedAt, id)` and strictly after `after` when given (a keyset
   * cursor), leaving out any entry a published entry links to: those can't be purged without
   * forcing, and the retention sweep never forces, so returning them would only stall it behind
   * entries it can never delete.
   */
  listExpiredTrash(
    scope: Scope,
    before: Date,
    limit: number,
    after?: ExpiredTrashEntry,
  ): Promise<ExpiredTrashEntry[]>;

  /**
   * Lists every saved version of an entry, newest first. Versions whose body has moved to
   * object storage ({@link markVersionsArchived}) are read back from there.
   */
  listVersions(scope: Scope, entryId: string): Promise<EntryVersion[]>;
  /** Reads one specific version snapshot, or null if it doesn't exist (from object storage if
   *  its body has moved there). */
  getVersion(scope: Scope, entryId: string, version: number): Promise<EntryVersion | null>;
  /**
   * Superseded versions due to have their body moved to object storage, across every space and
   * environment, with their bodies, for the archive sweep: at most `limit` from the archive queue
   * (versions are queued when a newer one is saved, and due a day later). A due version that is
   * not archivable now — still its entry's current or published version — is put back a day; one
   * that no longer needs it (gone, already moved, its environment being purged) leaves the queue.
   */
  claimArchivableVersions(limit: number, now: Date): Promise<ArchivableVersion[]>;
  /**
   * Records that each version's body now lives in object storage under `bodyKey`, and drops it
   * from the store, re-checking in the same write that the version is still superseded and not
   * published (and is the same row, by `createdAt`). Returns how many it marked; a version that
   * fails the check keeps its body.
   */
  markVersionsArchived(
    versions: readonly {
      readonly scope: Scope;
      readonly entryId: string;
      readonly version: number;
      readonly createdAt: string;
      readonly bodyKey: string;
    }[],
  ): Promise<number>;

  /** Writes the published read model for an entry. */
  putPublished(scope: Scope, snapshot: PublishedEntry): Promise<void>;
  /** Batch {@link putPublished} — one upsert statement for the whole set. */
  putPublishedMany(scope: Scope, snapshots: readonly PublishedEntry[]): Promise<void>;
  removePublished(scope: Scope, entryId: string): Promise<void>;
  /** Batch {@link removePublished} — one delete statement for the whole set. */
  removePublishedMany(scope: Scope, entryIds: readonly string[]): Promise<void>;
  getPublished(scope: Scope, id: string): Promise<PublishedEntry | null>;
  /**
   * Batch point-read of published snapshots — one backend query for the whole
   * id set (link-resolution frontiers, bulk dispatch). Missing/unpublished ids
   * are simply absent from the result; order is not guaranteed.
   */
  getPublishedMany(scope: Scope, ids: readonly string[]): Promise<PublishedEntry[]>;
  listPublished(scope: Scope, query: EntryQuery): Promise<PublishedEntry[]>;
  /**
   * How many entries are published in this scope — the count itself, not a page
   * of rows measured. Used to tell whether an external search index holds a
   * document for each of them.
   */
  countPublished(scope: Scope, query?: { contentType?: string }): Promise<number>;
  /**
   * Ranked full-text search over published string field values (all locales).
   * The lexical leg of hybrid search — every query term must match.
   */
  searchPublished(scope: Scope, query: string, opts: { topK: number }): Promise<TextSearchHit[]>;
}

export interface ReferenceRepo {
  /** Replaces all outgoing edges for an entry (called on publish). */
  replaceForEntry(
    scope: Scope,
    fromEntryId: string,
    edges: readonly ReferenceEdge[],
  ): Promise<void>;
  /**
   * Batch {@link replaceForEntry}: one delete for the whole from-set plus one
   * bulk edge insert. An entry listed with no edges simply has its edges
   * cleared (which is how a batch unpublish drops them too).
   */
  replaceForEntries(
    scope: Scope,
    replacements: readonly { fromEntryId: string; edges: readonly ReferenceEdge[] }[],
  ): Promise<void>;
  /** Removes all outgoing edges for an entry (called on unpublish/delete). */
  removeForEntry(scope: Scope, fromEntryId: string): Promise<void>;
  /** Edges pointing AT `toId` — i.e. entries that embed it (for invalidation). */
  findReverse(scope: Scope, toId: string): Promise<ReferenceEdge[]>;
  /**
   * Transitive reverse closure: ids of every entry that directly or
   * indirectly embeds any of `toIds`, bounded by depth and count, excluding
   * the seeds themselves. One backend query (recursive CTE) instead of a
   * breadth-first walk of round-trips.
   */
  findReverseClosure(
    scope: Scope,
    toIds: readonly string[],
    opts: { maxDepth: number; maxEntries: number },
  ): Promise<string[]>;
  /** Outgoing edges from `fromEntryId`. */
  findForward(scope: Scope, fromEntryId: string): Promise<ReferenceEdge[]>;
}

/** A recorded delivery attempt (a stored WebhookDelivery + id and timestamp). */
export interface WebhookDeliveryRecord extends WebhookDelivery {
  readonly id: number;
  readonly createdAt: string;
}

/**
 * Webhooks belong to a space; each is scoped to one environment (`environmentId`) or to every
 * environment (`null`). Every read, update and delete sees only the hooks the scope's environment
 * covers: its own and the space-wide ones.
 */
export interface WebhookRepo {
  create(scope: Scope, webhook: Webhook): Promise<void>;
  get(scope: Scope, id: string): Promise<Webhook | null>;
  list(scope: Scope): Promise<Webhook[]>;
  /** Active webhooks subscribed to a given event type, in the scope's environment. */
  listByTopic(scope: Scope, type: EventType): Promise<Webhook[]>;
  /** Persists the full updated webhook (the use-case merges changes first). */
  update(scope: Scope, webhook: Webhook): Promise<void>;
  delete(scope: Scope, id: string): Promise<void>;
  recordDelivery(scope: Scope, delivery: WebhookDelivery): Promise<void>;
  /** One recorded attempt at `webhookId`, in the scope's space, or null. */
  getDelivery(scope: Scope, webhookId: string, id: number): Promise<WebhookDeliveryRecord | null>;
  /** Recent delivery attempts for a webhook, newest first. */
  listDeliveries(
    scope: Scope,
    webhookId: string,
    opts?: { limit?: number },
  ): Promise<WebhookDeliveryRecord[]>;
  /**
   * Deletes up to `limit` delivery records older than `before`, across ALL
   * spaces (platform retention sweep, not a per-space operation). Returns the
   * number deleted.
   */
  deleteDeliveriesBefore(before: Date, limit: number): Promise<number>;
}

// ---- Secrets at rest ------------------------------------------------------

/**
 * Columns holding secrets sealed at rest. `webhooks.headers` is map-valued:
 * each header VALUE is sealed on its own (the names stay readable), so its
 * refs carry the header name as `key`.
 */
export type StoredSecretColumn = 'webhooks.secret' | 'webhooks.headers' | 'plugin_settings.secrets';

export interface StoredSecretRef {
  readonly column: StoredSecretColumn;
  /**
   * The owning row's id. For `plugin_settings.secrets`, whose rows are keyed by
   * space and plugin, `<spaceId>/<pluginId>` (neither id can hold a `/`).
   */
  readonly id: string;
  /** The entry within a map-valued column (a header name); absent otherwise. */
  readonly key?: string;
}

/** A secret exactly as stored (sealed). */
export interface StoredSecret extends StoredSecretRef {
  readonly value: string;
}

/**
 * Raw (still-sealed) access to every stored secret, across ALL spaces — the
 * platform reseal sweep's seam, never a per-space operation. Use-cases read and
 * write secrets through their own repos, which seal and open transparently.
 */
export interface StoredSecretRepo {
  /**
   * Up to `limit` stored values in `column` that do NOT start with
   * `excludePrefix` (i.e. not sealed under the current key), ordered by
   * (id, key) and strictly after `after` when given.
   */
  scan(
    column: StoredSecretColumn,
    opts: {
      readonly excludePrefix: string;
      readonly after?: { readonly id: string; readonly key?: string };
      readonly limit: number;
    },
  ): Promise<StoredSecret[]>;
  /**
   * Compare-and-set: writes `next` only when the stored value is still `was`,
   * so a secret rotated (or resealed by another sweep) since it was read is
   * never overwritten with a stale value. Returns whether it wrote.
   */
  replace(ref: StoredSecretRef, was: string, next: string): Promise<boolean>;
}

// ---- Bulk jobs ------------------------------------------------------------

/**
 * `asset_reindex`: the chunk's ids are assets, each sent through ingest again. The other `asset_*`
 * actions are the asset library's bulk actions ({@link ASSET_BULK_ACTIONS}), over asset ids;
 * `trash`, `restore` and `purge` are the entry trash's ({@link ENTRY_TRASH_BULK_ACTIONS}).
 */
export type BulkJobAction =
  | 'publish'
  | 'unpublish'
  | 'import'
  | 'asset_reindex'
  | EntryTrashBulkJobAction
  | AssetBulkJobAction
  /**
   * Deletes a content type's entries (each trashed, then purged), then the type: `config` names
   * it as `{ contentType }`.
   */
  | 'content_type_delete'
  /**
   * Sets the same field values on entries of one content type, each saved as a new draft:
   * `config` names them as `{ contentTypeApiId, fields }` (`entry-fields-bulk.ts`).
   */
  | 'set_fields'
  /**
   * One phase of a starter's background install (`@commerceworker/seed`): `config` names the
   * starter, the install and the phase, and the next phase's job as `next`.
   */
  | 'starter_install';

/** What an entry trash bulk job does to each entry: each through its single-entry use-case. */
export type EntryTrashBulkJobAction = 'trash' | 'restore' | 'purge';

export const ENTRY_TRASH_BULK_ACTIONS: readonly EntryTrashBulkJobAction[] = [
  'trash',
  'restore',
  'purge',
];

/** What an asset bulk job does to each asset of the selection. */
export type AssetBulkJobAction =
  | 'asset_move'
  | 'asset_tag'
  | 'asset_publish'
  | 'asset_unpublish'
  | 'asset_archive';

export const ASSET_BULK_ACTIONS: readonly AssetBulkJobAction[] = [
  'asset_move',
  'asset_tag',
  'asset_publish',
  'asset_unpublish',
  'asset_archive',
];

/** One item a chunk could not process. `name` is how a person knows it (an asset's file name). */
export interface BulkItemFailure {
  readonly id: string;
  readonly error: string;
  readonly name?: string;
}
export type BulkJobStatus = 'running' | 'completed' | 'cancelled';
export type BulkChunkStatus = 'pending' | 'running' | 'completed' | 'failed';

/** A durable bulk operation: N entry ids processed as CAS-claimed chunks. */
export interface BulkJob {
  readonly id: string;
  readonly action: BulkJobAction;
  readonly status: BulkJobStatus;
  readonly totalItems: number;
  readonly totalChunks: number;
  readonly completedChunks: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly createdAt: string;
  readonly completedAt?: string;
  /**
   * Action-specific configuration, opaque to the job machinery.
   *
   * An import needs to know what it is importing into long after the request
   * that started it has gone; publish and unpublish need nothing, and carry
   * nothing.
   */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** One chunk of a bulk job — the unit of claiming, retry, and reporting. */
export interface BulkJobChunk {
  readonly jobId: string;
  readonly chunkId: string;
  /** Entry ids, for publish/unpublish. Empty for an import chunk. */
  readonly entryIds: readonly string[];
  /**
   * Blob key holding this chunk's work, when it is too big to be a list of ids.
   *
   * An import chunk carries planned records, which are entries-to-be rather
   * than entries — there is nothing to name them by yet. Staging them once at
   * plan time is what stops every chunk re-reading and re-parsing the whole
   * source file, which would make a 40,000-row import quadratic.
   */
  readonly payloadKey?: string;
  readonly status: BulkChunkStatus;
  readonly attempts: number;
  /** Per-item failures recorded when the chunk completed. */
  readonly failures: readonly BulkItemFailure[];
}

/** A stalled/pending chunk paired with its scope (the sweep polls all scopes). */
export interface ScopedBulkChunkRef {
  readonly scope: Scope;
  readonly jobId: string;
  readonly chunkId: string;
}

export interface BulkJobRepo {
  createJob(scope: Scope, job: BulkJob): Promise<void>;
  getJob(scope: Scope, id: string): Promise<BulkJob | null>;
  /** Jobs newest-first. */
  listJobs(scope: Scope, opts?: { limit?: number }): Promise<BulkJob[]>;
  /** Batch-inserts pending chunks (multi-row). */
  createChunks(scope: Scope, chunks: readonly BulkJobChunk[]): Promise<void>;
  /** Chunks of a job, in chunkId order (for the compliance report). */
  listChunks(scope: Scope, jobId: string): Promise<BulkJobChunk[]>;
  /**
   * CAS-claims a chunk for processing: `pending`, or `running` with a claim
   * older than `staleBefore` (crashed worker), atomically becomes `running`
   * with `claimedAt = now` and `attempts + 1`. Returns the claimed chunk, or
   * null when it was already claimed/completed — the caller must treat null
   * as "someone else owns it" and do nothing.
   */
  claimChunk(
    scope: Scope,
    jobId: string,
    chunkId: string,
    opts: { now: Date; staleBefore: Date },
  ): Promise<BulkJobChunk | null>;
  /**
   * Marks a claimed chunk terminal (`completed`/`failed`), records its
   * per-item failures, and atomically folds its counts into the job
   * (`completedChunks`, `succeeded`, `failed`). Returns the updated job so
   * the caller can detect the final chunk and finalize.
   */
  completeChunk(
    scope: Scope,
    jobId: string,
    chunkId: string,
    outcome: {
      status: Extract<BulkChunkStatus, 'completed' | 'failed'>;
      succeeded: number;
      failed: number;
      failures: readonly BulkItemFailure[];
    },
  ): Promise<BulkJob>;
  /**
   * Merges `patch` into the job's `config` (top-level keys replaced): what an action records about
   * its own outcome after the job ends, for its readers. No-op for an unknown job.
   */
  mergeConfig(scope: Scope, id: string, patch: Readonly<Record<string, unknown>>): Promise<void>;
  /** Transitions a running job terminal; no-ops (returns null) otherwise. */
  finalizeJob(scope: Scope, id: string, status: BulkJobStatus, at: Date): Promise<BulkJob | null>;
  /**
   * Reverts a `running` claim to `pending` (a chunk transaction failed and
   * the claimer wants queue retries to do real work instead of losing the
   * CAS until the stale window passes). No-ops unless currently `running`.
   */
  releaseChunk(scope: Scope, jobId: string, chunkId: string): Promise<void>;
  /**
   * Chunks needing a nudge across ALL scopes: `pending` or stale-`running`
   * ones belonging to `running` jobs, created/claimed before `staleBefore`.
   * The crash-recovery sweep re-enqueues their chunk_due events.
   */
  findStalledChunks(staleBefore: Date, limit: number): Promise<ScopedBulkChunkRef[]>;
  /**
   * Jobs still `running` whose chunks are ALL terminal (a crash between the
   * last completeChunk and finalize) across all scopes — the sweep finalizes
   * them so `bulk.job_completed` is never permanently lost.
   */
  findUnfinalizedJobs(limit: number): Promise<{ scope: Scope; jobId: string }[]>;
}

/** A row in the transactional outbox awaiting relay to the event bus/queue. */
export interface OutboxRecord {
  readonly event: DomainEvent;
}

export interface OutboxRepo {
  /**
   * Appends an event (or a webhook send request); must be called within the same tx as the state
   * change, when there is one.
   */
  append(event: OutboxEntry): Promise<void>;
  /** Batch {@link append}; the whole set commits atomically (as few statements as the backend's parameter cap allows). */
  appendMany(events: readonly OutboxEntry[]): Promise<void>;
  /**
   * Claims up to `limit` un-relayed events, oldest first. A claim is a lease: concurrent relayers
   * never receive the same event, and an event whose relayer died (never marked relayed) becomes
   * claimable again once the lease lapses. Runs immediately, even inside `withTransaction`.
   */
  readPending(limit: number): Promise<OutboxEntry[]>;
  /** Marks events as relayed so they are not re-published. */
  markRelayed(eventIds: readonly string[]): Promise<void>;
  /**
   * One row of the scope's space by id (any of its environments: a space-wide webhook's
   * deliveries span them), relayed or not, while the retention sweep keeps it; null otherwise.
   */
  get(scope: Scope, id: string): Promise<OutboxEntry | null>;
  /**
   * Deletes up to `limit` RELAYED rows older than `before` (retention sweep —
   * without it the outbox grows one row per event forever). Never touches
   * un-relayed rows. Returns the number deleted so callers can loop until dry.
   */
  deleteRelayedBefore(before: Date, limit: number): Promise<number>;
}
