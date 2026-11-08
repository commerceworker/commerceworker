import type {
  AgentReview,
  AgentReviewStatus,
  Asset,
  AssetCollection,
  AssetFolder,
  AssetKind,
  AssetMetadata,
  AssetRights,
  AssetShareLink,
  AssetShareTargetType,
  AssetStatus,
  AssetUsage,
  AssetVersion,
  AssetZipJob,
  AuditDetail,
  BlockOp,
  BlockOutline,
  Comment,
  Concept,
  ConceptScheme,
  ContentType,
  ContentTypeDraft,
  ContentTypeGrant,
  EmbedData,
  EntryFields,
  EntryMetadata,
  EntryVersion,
  EntryWorkflowState,
  FieldDiff,
  FilterOp,
  GraphIssue,
  Menu,
  MenuItemInput,
  MenuLink,
  Redirect,
  RedirectChain,
  RedirectInput,
  RedirectMatch,
  RedirectSetReport,
  ReferenceEdge,
  Release,
  ReleaseItem,
  ReleaseWithItems,
  SavedView,
  SavedViewQuery,
  SavedViewVisibility,
  ScheduledAction,
  ScheduledActionType,
  ScheduledEntityType,
  Tag,
  Task,
  TermUsageSummary,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowGraphChanges,
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

// ---- editorial workflow (graph) shapes, as the Management API returns them ----

/** A workflow: the legacy `{id, name, steps}` plus its draft graph and version bookkeeping. */
export interface WorkflowSummary extends WorkflowGraphDefinition {
  readonly steps: readonly WorkflowStep[];
  /** The draft's flag. */
  readonly gatesPublish: boolean;
  /** Gating in force: the latest published version gates and a run of it can publish. */
  readonly publishGated: boolean;
  readonly latestVersion: number | null;
  readonly legacy: boolean;
  readonly updatedAt: string | null;
}

/** What starts a workflow: its trigger node type and the catalog's name for it. */
export interface WorkflowTrigger {
  readonly type: string;
  readonly label: string;
}

/** A workflow as the list returns it: the summary plus how its PUBLISHED version starts. */
export interface WorkflowListItem extends WorkflowSummary {
  /** The latest published version's trigger; null when never published. */
  readonly publishedTrigger: WorkflowTrigger | null;
  /** Ids of the other published workflows starting on the same trigger for overlapping types. */
  readonly startsAlongside: readonly string[] | null;
}

/** A release as the list returns it, with how many members it holds. */
export interface ReleaseSummary extends Release {
  readonly itemCount: number;
}

export interface WorkflowGraphValidation {
  readonly ok: boolean;
  readonly errors: readonly GraphIssue[];
  readonly warnings: readonly GraphIssue[];
}

export interface WorkflowDraftInput {
  readonly name?: string;
  readonly description?: string;
  readonly contentTypes?: readonly string[];
  readonly graph?: WorkflowGraph;
  readonly gatesPublish?: boolean;
}

export interface WorkflowCopilotProposal {
  readonly graph: WorkflowGraph;
  readonly explanation: string;
  readonly errors: readonly GraphIssue[];
  readonly warnings: readonly GraphIssue[];
  readonly changes: WorkflowGraphChanges;
  /** One line describing `changes`; null when nothing changed. */
  readonly summary: string | null;
  readonly provenance: {
    readonly source: string;
    readonly tier?: string;
    readonly fallback?: string;
  };
}

/** A run as the API returns it (the starter's principal stays server-side). */
export interface WorkflowRunView
  extends Omit<WorkflowRun, 'startedBy' | 'earlyEvents' | 'rev' | 'logSeq'> {
  readonly startedBy: { readonly id: string };
  readonly earlyEvents: readonly { readonly event: string; readonly at: number }[];
}

export interface WorkflowRunFilter {
  readonly entryId?: string;
  readonly workflowId?: string;
  readonly status?: WorkflowRunStatus;
  readonly limit?: number;
}

export interface WorkflowTaskFilter {
  readonly status?: WorkflowTaskStatus;
  readonly runId?: string;
  readonly entryId?: string;
  readonly kind?: WorkflowTask['kind'];
  readonly limit?: number;
}

const queryString = (q: object): string => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
};

/**
 * Which space, environment and locale the admin is working in. The browser talks to its own
 * origin: the web Worker's gateway forwards the API's paths to the api Worker with the signed-in
 * person's signed principal, so there is no base URL and no token here.
 */
export interface Connection {
  readonly space: string;
  readonly environment: string;
  /** The locale the editor and previews read and write. */
  readonly locale: string;
}

/**
 * Read-your-writes. The api answers every request with an `x-cw-bookmark` (a D1 session
 * bookmark); sending the latest one back makes the next read come from a replica at least as
 * fresh as this browser's last write. Module-level: one tab, one session, whatever client made
 * the call.
 */
export const BOOKMARK_HEADER = 'x-cw-bookmark';
let bookmark: string | null = null;

/** The newest bookmark seen (tests and diagnostics). */
export const currentBookmark = () => bookmark;

/** Forget the bookmark (tests). */
export const resetBookmark = () => {
  bookmark = null;
};

/**
 * D1 bookmarks are hex groups joined by dashes; the api ignores anything else, so do we. The
 * same shape as `packages/sdk/core/src/bookmark.ts` and `apps/api/src/index.ts`: the admin
 * doesn't depend on the published SDK, so it carries its own copy; keep the three in step.
 */
const BOOKMARK_SHAPE = /^[0-9a-f]+(?:-[0-9a-f]+){2,8}$/i;

/**
 * Notes the bookmark a response carries when it is newer than the one held. Bookmarks sort
 * oldest to newest as strings; concurrent requests can answer out of order, and an older
 * bookmark must not undo the freshness a write just bought.
 */
export function rememberBookmark(res: Response): void {
  const b = res.headers?.get?.(BOOKMARK_HEADER);
  if (b && BOOKMARK_SHAPE.test(b) && (bookmark === null || b > bookmark)) bookmark = b;
}

/** The headers every same-origin API request carries: JSON, plus the bookmark once there is one. */
export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, ...(bookmark ? { [BOOKMARK_HEADER]: bookmark } : {}) };
}

/** Resolved principal from GET /auth/me. */
export interface PrincipalInfo {
  readonly spaceId: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly subject?: string;
  readonly restricted?: boolean;
  /** In a space (`GET /spaces/:space/auth/me`): the bulk jobs over entries this role may start. */
  readonly bulkJobs?: readonly ('publish' | 'unpublish' | 'trash' | 'restore' | 'purge')[];
}

export interface ManagementClientOptions {
  /** Called when any request returns 401 — typically clears credentials and redirects. */
  readonly onUnauthorized?: () => void;
}

/**
 * Who wrote an entry and when, as the api records it (null when unknown: an entry from before it
 * was recorded). Actor ids read as words through `actorLabel`.
 */
export interface EntryAuthorship {
  readonly createdAt?: string | null;
  readonly createdBy?: string | null;
  /** Who made the last change. */
  readonly updatedBy?: string | null;
  readonly firstPublishedAt?: string | null;
}

export interface EntryAggregate extends EntryAuthorship {
  readonly id: string;
  readonly contentTypeApiId: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly publishedVersion: number | null;
}

/** Preview view of an entry (current/draft version). */
export interface PreviewEntry extends EntryAuthorship {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  readonly version: number;
  /** When the entry last changed (ISO-8601); the paged list carries it. */
  readonly updatedAt?: string;
  readonly fields: Record<string, unknown>;
}

/** An entry's blocks fields as `GET …/entries/:id/blocks` answers them (`outlineEntryBlocks`). */
export interface EntryBlocksOutline {
  readonly entryId: string;
  readonly version: number;
  /** Blocks field → locale → its blocks; a field this person may not read is left out. */
  readonly fields: Readonly<Record<string, Readonly<Record<string, readonly BlockOutline[]>>>>;
}

/** A block patch as its dry run reads it (`checkEntryBlocks`). */
export interface BlockPatchCheck {
  readonly valid: true;
  readonly contentTypeApiId: string;
  /** The fields as the save would store them, without those this person may not read. */
  readonly fields: EntryFields;
  /** The patch as it would apply: refs, positions and locales resolved, every key present. */
  readonly applied: readonly BlockOp[];
  readonly keys: Readonly<Record<string, string>>;
}

/** One page of the entries list; pass `nextCursor` back for the next. */
export interface EntryPage {
  readonly items: readonly PreviewEntry[];
  readonly nextCursor?: string;
}

export interface EntryView {
  readonly entry: EntryAggregate;
  readonly fields: EntryFields;
}

/** One field-level predicate. `field` is a content field apiId or a `sys.*`
 *  pseudo-field (e.g. `sys.status`); the client adds the `fields.` namespace. */
export interface EntryFilter {
  readonly field: string;
  readonly op: FilterOp;
  readonly value?: string | readonly string[] | boolean;
}

/** A sort key over a content field apiId or a `sys.*` pseudo-field. */
export interface EntryOrder {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** How many entries a content type holds, by status; `total` is the live ones (not the trash). */
export interface ContentTypeEntryCounts {
  readonly contentType: string;
  readonly total: number;
  readonly draft: number;
  readonly changed: number;
  readonly published: number;
  readonly archived: number;
}

/** Query options for the entries list (filters/order/search). */
/** The most entries one list request returns (the API's `MAX_PAGE_LIMIT`). */
export const ENTRY_PAGE = 100;

export interface EntryListQuery {
  readonly filters?: readonly EntryFilter[];
  readonly order?: readonly EntryOrder[];
  readonly search?: string;
  readonly limit?: number;
  /** List the trash instead of live entries. Trash is hidden by default. */
  readonly trashed?: boolean;
  /** Only the entries the signed-in person created (`sys.createdBy=me`). */
  readonly mine?: boolean;
  /**
   * AND/OR groups of predicates (the API's `where`), as a saved view or a link carries them. The
   * filter bar edits only `filters`; a tree is kept and sent as it is.
   */
  readonly where?: unknown;
  /** Only entries linking to one of these, from any field (the API's `links_to_entry`). */
  readonly linksToEntry?: readonly string[];
  /**
   * Link parameters this admin doesn't apply (from a newer client or a saved view's `extra`):
   * kept in the URL and saved with a view, never sent with the list request.
   */
  readonly extra?: Readonly<Record<string, string>>;
}

/** Namespaces a field path for the query string: `sys.*` stays, else `fields.*`. */
function fieldPath(field: string): string {
  return field.startsWith('sys.') || field.startsWith('metadata.') ? field : `fields.${field}`;
}

/** Serializes an `EntryListQuery` into field-level query params. */
export function entryQueryParams(query: EntryListQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const f of query.filters ?? []) {
    const path = fieldPath(f.field);
    const key = f.op === 'eq' ? path : `${path}[${f.op}]`;
    const value = Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '');
    // Appended: two filters on one key are two conditions, and the API reads them both.
    params.append(key, value);
  }
  if (query.order?.length) {
    params.set(
      'order',
      query.order.map((o) => `${o.direction === 'desc' ? '-' : ''}${fieldPath(o.field)}`).join(','),
    );
  }
  if (query.where !== undefined) params.set('where', JSON.stringify(query.where));
  if (query.linksToEntry?.length) params.set('links_to_entry', query.linksToEntry.join(','));
  if (query.search) params.set('query', query.search);
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.trashed) params.set('trashed', 'true');
  // `me` is whoever the api's principal is: the signed-in person, without the admin naming them.
  if (query.mine) params.set('sys.createdBy', 'me');
  return params;
}

/** A space the principal can access (id + display name). */
export interface SpaceRef {
  readonly id: string;
  readonly name: string;
}

/**
 * What a new space starts with (`POST /spaces` `starter`): the sample content, nothing, or, where
 * the deployment offers it, the enterprise demo, which installs in the background.
 */
export type SpaceStarter = 'sample' | 'empty' | 'enterprise';

/** A starter as `GET /starters` lists it, in the order a picker shows them. */
export interface SpaceStarterInfo {
  readonly id: SpaceStarter;
  readonly title: string;
  readonly description: string;
  /** Installs after the space is created, in the background, rather than before it returns. */
  readonly background: boolean;
}

/** A background starter install that has started (`POST /spaces` `installing`). */
export interface StarterInstallStarted {
  readonly install: string;
  readonly jobId: string;
  readonly steps: number;
}

/** Where a background starter install has got to (`GET …/starter-installs/:install`). */
export interface StarterInstall {
  readonly install: string;
  readonly starter: string;
  /** The phase running now, or the last to run (1-based), of `steps`. */
  readonly step: number;
  readonly steps: number;
  readonly phase: string;
  readonly title: string;
  readonly jobId: string;
  readonly status: 'running' | 'completed' | 'failed';
  /** What failed in the phase that stopped the install. */
  readonly failures?: readonly { readonly id: string; readonly error: string }[];
}

/** An environment (branch) within a space. */
export interface Environment {
  readonly id: string;
  readonly name: string;
}

/** A repointable pointer to a target environment (blue/green serving). */
export interface EnvironmentAlias {
  readonly alias: string;
  readonly targetEnvironmentId: string;
  readonly updatedAt: string;
}

/** A tag or concept with how many published entries carry it, in all and per content type. */
export type WithUsage<T> = T & { readonly usage: TermUsageSummary };

/** What a tag or concept carries beside its label. */
export interface TermFields {
  readonly slug?: string;
  /** Plain text; `null` clears it. */
  readonly description?: string | null;
  /** Labels by locale (the whole set); the default locale's sets the term's own label. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Space configuration — drives the localization tabs in the editor. */
export interface SpaceConfig {
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly fallbacks?: Readonly<Record<string, string | null>>;
  /**
   * Every locale's settings, resolved by the api: whether Delivery serves it (an undelivered one
   * is still edited and previewed) and which way its text runs, the `dir` of its inputs.
   */
  readonly localeSettings?: Readonly<
    Record<string, { readonly delivered: boolean; readonly direction: TextDirection }>
  >;
}

/** Which way a locale's text runs. */
export type TextDirection = 'ltr' | 'rtl';

/** A published entry as served by the Delivery API (locale-collapsed, links embedded). */
export interface DeliveredEntry {
  readonly id: string;
  readonly contentType: string;
  readonly fields: Record<string, unknown>;
  readonly publishedAt: string;
}

export interface AgentRun {
  readonly id: string;
  readonly workflow: string;
  readonly entryId: string;
  readonly status: string;
  readonly decisions: string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
}

export interface UsageSummary {
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

/** AI model tier — callers pick a tier, the backend maps it to a concrete model. */
export type ModelTier = 'flagship' | 'balanced' | 'fast';

/** Result of an AI draft: localized field values + token usage. */
export interface GeneratedDraft {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export type ApiKeyKind = 'cma' | 'cda' | 'cpa';

/** An API key as listed (the raw token is never returned after creation). */
export interface ApiKeySummary {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly scopes: string[];
  readonly revoked: boolean;
  readonly roleId?: string;
  readonly lastUsedAt?: string;
}

/** Built-in role presets, in order: each can do everything the one before it can. */
export type RolePreset = 'viewer' | 'approver' | 'editor' | 'manager' | 'admin';

/** A preset as the space has it seeded (an admin may have renamed or edited it). */
export interface RolePresetSummary {
  readonly preset: RolePreset;
  readonly roleId: string;
  readonly name: string;
  readonly description?: string;
  readonly scopes: readonly string[];
}

export interface TeamRole {
  readonly id: string;
  readonly name: string;
  readonly preset?: RolePreset;
}

export interface TeamPerson {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
  /** Has signed in with SSO at least once. */
  readonly linked: boolean;
  readonly disabled: boolean;
  readonly role: TeamRole | null;
  /** Their role administers the space. */
  readonly admin: boolean;
  readonly createdAt: string;
}

export interface TeamKey {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly issuance: 'key' | 'oauth' | 'pat' | 'setup';
  readonly subject?: string;
  readonly role: TeamRole | null;
  /** Counts as one of the space's administrators. */
  readonly admin: boolean;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
}

/** The team: people and long-lived keys with their roles (GET /spaces/:space/team). */
export interface TeamSummary {
  readonly people: TeamPerson[];
  readonly keys: TeamKey[];
  /** How many administrators the space has; the last one can't be demoted or revoked. */
  readonly adminCount: number;
  readonly settings: { readonly ssoOnly: boolean };
  /** Single sign-on is configured on this deployment. */
  readonly sso: boolean;
}

/** First-run setup status (GET /auth/setup, public). */
export interface SetupStatus {
  readonly needsSetup: boolean;
  readonly open: boolean;
  readonly sso: boolean;
}

/** What redeeming the setup code returns: the admin token once, or where to sign in with SSO. */
export interface SetupResult {
  readonly spaceId: string;
  readonly recovery: boolean;
  readonly member: { readonly id: string; readonly email: string };
  readonly token?: string;
  readonly signIn?: string;
}

/**
 * A request that didn't answer in time, so a form hung on it can let go. Whether a write landed is
 * unknown: the server may have finished it, or may yet. So `write` errors never say nothing was
 * saved, and a form whose request isn't idempotent makes the retry a choice.
 */
export class RequestTimeoutError extends Error {
  constructor(readonly write: boolean) {
    super(write ? UNCONFIRMED_SAVE : 'That took too long, and nothing was changed. Try again.');
  }
}

/** Said of any save with no answer to go on, whatever stopped the answer. */
export const UNCONFIRMED_SAVE =
  'The save didn’t confirm. It may still have gone through, so check before you try again.';

/** A save the admin stopped itself, before sending anything. */
export class SaveRefusedError extends Error {}

/**
 * Whether a failed save is known to have changed nothing: the server answered and said no, or it
 * never left. Anything else (a timeout, a dropped connection, a 5xx, an answer that can't be read)
 * leaves the write's outcome unknown, so nothing may say it wasn't saved.
 */
export const refusedSave = (err: unknown): boolean =>
  err instanceof SaveRefusedError ||
  (err instanceof ApiError && err.status >= 400 && err.status < 500);

/** A failed save in words: with no answer to go on, what to do, not a bare "Failed to fetch". */
export const saveFailureMessage = (err: unknown): string =>
  err instanceof TypeError || (err instanceof ApiError && err.status >= 500)
    ? UNCONFIRMED_SAVE
    : apiErrorMessage(err);

/** How long a request may take, and whether it can change anything. */
interface RequestLimit {
  readonly ms: number;
  readonly read?: boolean;
}

/*
 * The limits sit past what the server can take, so only a request that has really hung reaches
 * one: they are for a dialog waiting on an answer, not for pacing the work. GETs have none (nothing
 * holds a form on one), nor do file uploads and the live stream, which don't go through `req`:
 * those run as long as their bytes do, and an upload has its own Cancel.
 */
/** Any write not named below: one row, or a few. */
const WRITE_LIMIT: RequestLimit = { ms: 30_000 };
/** A batch in one request: a bulk change, a release, a redirect import, a plugin's bundle. */
const BATCH_LIMIT: RequestLimit = { ms: 120_000 };
/** A whole import or environment in one request, or a space installing its sample content. */
const LARGE_LIMIT: RequestLimit = { ms: 300_000 };
/** A read sent as a POST: a dry run, or fetching and checking something. */
const CHECK_LIMIT: RequestLimit = { ms: 120_000, read: true };
/** A model's write; past the 120s the AI adapter allows a single call. */
const MODEL_WRITE_LIMIT: RequestLimit = { ms: 180_000 };
const MODEL_READ_LIMIT: RequestLimit = { ms: 180_000, read: true };

/** The server's own message from an ApiError (`{ error: { message } }`), else the error's text. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const json = err.message.slice(err.message.indexOf('{'));
    try {
      // The parsed body when the request kept it; else the JSON at the end of the message.
      const body = (err.body ?? JSON.parse(json)) as {
        error?: { message?: string; issues?: { message: string }[] };
      };
      const issue = body.error?.issues?.[0]?.message;
      if (issue) return issue;
      if (body.error?.message) return body.error.message;
    } catch {
      /* not JSON */
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** True when the API refused because it would leave the space with no administrator. */
export const isLastAdminError = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 409 && err.message.includes('last_admin');

/** Custom role (granular RBAC). */
export interface RoleSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Set on the built-in presets seeded into every space. */
  readonly preset?: RolePreset;
  readonly scopes: readonly string[];
  /** Per content type; `deniedActions` withholds the delete and unpublish write and publish bring. */
  readonly contentGrants: readonly ContentTypeGrant[];
}

export interface PreviewLinkResult {
  /** The entry on the Preview API. */
  readonly url: string;
  /** The entry on the customer's frontend, from its type's preview URL template; absent without. */
  readonly frontendUrl?: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** The one-time result of minting a key — `token` is shown once, never again. */
export interface CreatedApiKey {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly token: string;
}

/**
 * An application holding OAuth access to this space, on one person's behalf.
 * Several access tokens may sit behind one connection (each refresh mints
 * another); the server folds them together.
 */
export interface ConnectedApp {
  readonly clientId: string;
  readonly clientName: string;
  readonly subject: string;
  readonly scopes: string[];
  readonly tokenCount: number;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
}

/** A personal access token as listed (the raw token is never returned again). */
export interface PersonalAccessToken {
  readonly id: string;
  readonly name?: string;
  readonly subject?: string;
  readonly scopes: string[];
  readonly revoked: boolean;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
}

/** The one-time result of minting a PAT. */
export interface CreatedPat {
  readonly id: string;
  readonly token: string;
  readonly expiresAt?: string;
}

/**
 * The permission scopes a token can carry, with the plain-language meaning
 * shown when a human is deciding what to grant. Mirrors `SCOPES` in the domain.
 */
export const PERMISSION_SCOPES = [
  { value: 'delivery:read', label: 'Read published content' },
  { value: 'preview:read', label: 'Read drafts' },
  { value: 'search:read', label: 'Search content' },
  { value: 'content:write', label: 'Create and edit content' },
  { value: 'content:publish', label: 'Publish content' },
  { value: 'content:manage', label: 'Change content types' },
  { value: 'space:admin', label: 'Administer the space' },
  { value: 'workflow:approve', label: 'Decide workflow approvals' },
] as const;

/** Event topics a webhook can subscribe to ("*" matches everything). */
export const WEBHOOK_TOPICS = [
  '*',
  'entry.published',
  'entry.unpublished',
  'content_type.published',
  'content_type.deleted',
] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

/** A menu as the list shows it: no items, their count. */
export interface MenuSummary {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
  readonly itemCount: number;
  readonly revision: number;
  readonly updatedAt: string;
}

/** Whether Delivery serves an item now, or why it drops it (its children take its place). */
export type MenuItemStatus = 'live' | 'unpublished' | 'missing' | 'no_url' | 'hidden';

export interface MenuItemPreview {
  readonly id: string;
  readonly link: MenuLink;
  readonly label: string;
  readonly url: string | null;
  readonly status: MenuItemStatus;
  readonly children: readonly MenuItemPreview[];
}

export interface MenuPreview {
  readonly menu: Menu;
  readonly locale: string;
  readonly items: readonly MenuItemPreview[];
}

/** A saved view to create: `shared` needs content:manage, personal is the person's own. */
export interface SavedViewInput {
  readonly name: string;
  readonly contentTypeApiId: string | null;
  readonly visibility: SavedViewVisibility;
  readonly query: SavedViewQuery;
  readonly columns?: readonly string[] | null;
}

/** A menu's own fields; `items` replaces the whole tree. */
export interface MenuInput {
  readonly handle: string;
  readonly name: string;
  readonly description?: string | null;
  readonly items?: readonly MenuItemInput[];
}

/** A redirect write: the redirect, and the chains it now takes part in. */
export interface RedirectWrite {
  readonly redirect: Redirect;
  readonly chains: readonly RedirectChain[];
}

export interface RedirectImportReport {
  readonly dryRun: boolean;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly chains: readonly RedirectChain[];
}

export interface WebhookSummary {
  readonly id: string;
  readonly url: string;
  readonly topics: readonly WebhookTopic[];
  readonly active: boolean;
  /** The one environment whose events it receives; `null` for every environment in the space. */
  readonly environmentId: string | null;
}

/** A recorded webhook delivery attempt. */
export interface WebhookDeliveryRecord {
  readonly id: number;
  readonly webhookId: string;
  readonly eventId: string;
  readonly status: 'success' | 'failed';
  readonly statusCode?: number;
  readonly attempts: number;
  readonly error?: string;
  /** The event it carried, e.g. `entry.published` or `webhook.test` (absent on old records). */
  readonly eventType?: string;
  /** The delivery this one resent. */
  readonly resendOf?: number;
  readonly createdAt: string;
}

/** A test or resend the engine will send: its delivery is logged under `eventId`. */
export interface QueuedWebhookDelivery {
  readonly webhookId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly resendOf?: number;
}

/** Which version a diff reads: a number, or the entry's current draft or published version. */
export type VersionRef = number | 'draft' | 'published';

/**
 * A readable diff of two entry versions (from → to): every field, per locale, with typed detail
 * (the domain's `diffEntryFields`).
 */
export interface VersionDiff {
  readonly entryId: string;
  readonly contentType: string;
  readonly from: number;
  readonly to: number;
  readonly changes: readonly FieldDiff[];
  /** How many fields changed that this person may not read; they go live all the same. */
  readonly hiddenChanges: number;
}

/** How a source-environment item relates to the target. */
export type ChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

/** A diff of two environments (what merging source→target would change). */
export interface EnvironmentComparison {
  readonly spaceId: string;
  readonly source: string;
  readonly target: string;
  readonly contentTypes: readonly { apiId: string; kind: ChangeKind }[];
  readonly entries: readonly { entryId: string; contentTypeApiId: string; kind: ChangeKind }[];
}

export interface MergeResult {
  readonly mergedContentTypes: readonly string[];
  readonly mergedEntries: readonly string[];
}

export interface AuditEntry {
  readonly id: string;
  readonly spaceId: string;
  readonly environmentId?: string;
  readonly actor: string;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly status: number;
  readonly at: string;
  /** What the action changed: paths, never values. Older rows have none. */
  readonly detail?: AuditDetail;
}

/** What the audit log can be narrowed by; `from` and `to` are exact times, both inclusive. */
export interface AuditLogFilters {
  readonly environment?: string;
  readonly actor?: string;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface AuditLogPage {
  readonly items: AuditEntry[];
  readonly nextCursor?: string;
}

/** A persisted, templated AI Action. */
export interface AIAction {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly promptTemplate: string;
  readonly variables: readonly string[];
  readonly targetField?: string;
  readonly tier: ModelTier;
  readonly createdAt: string;
}

/** A user-defined function invoked over HTTP on matching domain events. */
export interface FunctionDefinition {
  readonly id: string;
  readonly name: string;
  readonly eventPattern: string;
  readonly url: string;
  readonly active: boolean;
  readonly createdAt: string;
}

/** An admin UI extension rendered in a sandboxed iframe. */
export interface AppExtension {
  readonly id: string;
  readonly name: string;
  readonly target: 'field-editor' | 'sidebar';
  readonly entryUrl: string;
  readonly fieldTypes?: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
}

/** A plugin installed in this space, as the management API summarizes it. */
export interface InstalledPluginSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** What the manifest asked for. */
  readonly requestedCapabilities: readonly string[];
  /** What a human actually approved — never wider than the request. */
  readonly approvedCapabilities: readonly string[];
  /** What it actually runs with: requested ∩ approved. */
  readonly grantedCapabilities?: readonly string[];
  /**
   * Its manifest predates the `capabilities` field: it is treated as requesting
   * what it already holds, and cannot be switched on until someone approves.
   */
  readonly needsReapproval?: boolean;
  readonly allowedHosts: readonly string[];
  readonly hooks: readonly string[];
  readonly checksum: string;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly installedBy?: string;
}

/** One setting a plugin's manifest declares, as the settings API returns it. */
export interface PluginSettingField {
  readonly key: string;
  readonly label: string;
  readonly type: 'string' | 'number' | 'boolean' | 'select';
  readonly description?: string;
  readonly required?: boolean;
  /** Write-only: its value never reaches the browser, only whether one is set. */
  readonly secret?: boolean;
  readonly options?: readonly string[];
  readonly default?: string | number | boolean;
}

/** A plugin's settings as an operator may see them (`GET …/plugins/:id/settings`). */
export interface PluginSettingsView {
  readonly pluginId: string;
  readonly fields: readonly PluginSettingField[];
  /** Non-secret values, defaults applied. */
  readonly values: Readonly<Record<string, string | number | boolean>>;
  /** Secret fields that hold a value. */
  readonly secretsSet: readonly string[];
  /** 0 before the first save; sent back as `expectedVersion`. */
  readonly version: number;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

/** One entry, reduced to what a chooser shows. */
export interface EntrySuggestion {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  readonly title: string;
}

/** A durable job's progress, as the management API reports it. */
/** What still depends on a content type (`GET …/content-types/:apiId/dependents`). */
export interface ContentTypeDependents {
  readonly contentType: string;
  readonly entries: { readonly live: number; readonly trashed: number };
  readonly linkedFrom: readonly { readonly contentType: string; readonly field: string }[];
  readonly menus: readonly { readonly id: string; readonly handle: string }[];
  readonly redirects: readonly { readonly id: string; readonly source: string }[];
  readonly urlPattern?: string;
}

export interface BulkJobSummary {
  readonly id: string;
  readonly action:
    | 'publish'
    | 'unpublish'
    | 'trash'
    | 'restore'
    | 'purge'
    | 'import'
    | 'asset_reindex'
    | 'asset_move'
    | 'asset_tag'
    | 'asset_publish'
    | 'asset_unpublish'
    | 'asset_archive'
    | 'content_type_delete'
    | 'set_fields'
    | 'starter_install';
  readonly status: 'running' | 'completed' | 'cancelled';
  readonly totalItems: number;
  readonly totalChunks: number;
  readonly completedChunks: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly createdAt?: string;
  readonly completedAt?: string;
  /**
   * The action's own settings. A `content_type_delete` job names its type, and records what
   * became of it once that is decided (`typeDeletion`): absent until the job ends.
   */
  readonly config?: {
    readonly contentType?: string;
    readonly typeDeletion?: { readonly deleted: boolean; readonly reason?: string };
  };
}

/**
 * A job's per-item failures, chunk by chunk (`GET …/bulk/jobs/:id/report`). An asset job names
 * each failure by the asset's title or file name.
 */
export interface BulkJobReport {
  readonly job: BulkJobSummary;
  readonly chunks: readonly {
    readonly chunkId: string;
    readonly status: string;
    readonly attempts: number;
    readonly itemCount: number;
    readonly failures: readonly {
      readonly id: string;
      readonly error: string;
      readonly name?: string;
    }[];
  }[];
}

/** What a bulk job over entries does to each one (`POST …/bulk/jobs`). */
export type EntryBulkJobAction = 'publish' | 'unpublish' | 'trash' | 'restore' | 'purge';

/** The space's trash retention: days an entry stays in the trash, or null to keep it (off). */
export interface TrashSettings {
  readonly retentionDays: number | null;
}

/** What `POST …/assets/bulk` runs over a selection of assets, as a job. */
export type AssetBulkRequest =
  | { readonly action: 'move'; readonly ids: readonly string[]; readonly folderId: string | null }
  | {
      readonly action: 'tag';
      readonly ids: readonly string[];
      readonly addTags?: readonly string[];
      readonly removeTags?: readonly string[];
    }
  | { readonly action: 'publish' | 'unpublish' | 'archive'; readonly ids: readonly string[] };

/** Rights as the form sends them: a value, or null for none. */
export type AssetRightsInput = { readonly [K in keyof AssetRights]-?: string | null };

/** Largest import the synchronous route will write; past this, start a job. */
export const IMPORT_SYNC_MAX_RECORDS = 10_000;

/** The body both import phases take — the same request to two paths. */
export interface ImportRequest {
  readonly source: string;
  readonly payload: string;
  readonly mapping: {
    readonly contentTypeApiId: string;
    /** Target field apiId -> source field name. */
    readonly fields: Record<string, string>;
    readonly identityField?: string;
    readonly locale?: string;
  };
  readonly sourceOptions?: Record<string, unknown>;
  readonly conflicts?: 'skip' | 'update' | 'fail';
}

export interface ImportAnalysis {
  readonly contentTypeApiId: string;
  readonly locale: string;
  readonly records: number;
  readonly willCreate: number;
  readonly willUpdate: number;
  readonly willSkip: number;
  readonly invalid: number;
  /** Source fields nothing maps to — the data this import would throw away. */
  readonly unmappedSourceFields: readonly string[];
  readonly missingRequiredFields: readonly string[];
  readonly unknownTargetFields: readonly string[];
  readonly warnings: readonly string[];
  readonly issues: readonly { externalId: string; messages: readonly string[] }[];
  readonly executable: boolean;
}

export interface ImportResult {
  readonly analysis: ImportAnalysis;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: readonly { externalId: string; message: string }[];
}

/** The body both space export calls take: the export file, and what to do with it. */
export interface SpaceExportRequest {
  readonly payload: string;
  readonly publish?: boolean;
  /** Add the export's locales this space lacks (space admins only). */
  readonly addLocales?: boolean;
}

/** What importing a space export would do (and, once started, what it is doing). */
export interface SpaceExportReport {
  readonly dryRun: boolean;
  readonly executable: boolean;
  /** What stops the import as a whole. */
  readonly problems: readonly string[];
  readonly locales: {
    readonly default: string;
    readonly declared: readonly { readonly code: string; readonly fallback: string | null }[];
    readonly toAdd: readonly string[];
  };
  readonly contentTypes: number;
  readonly tags: number;
  readonly entries: {
    readonly read: number;
    readonly imported: number;
    readonly published: number;
    readonly invalid: number;
  };
  readonly assets: { readonly read: number; readonly imported: number; readonly published: number };
  readonly unmappedFields: readonly string[];
  readonly unmappedValidations: readonly string[];
  readonly warnings: readonly string[];
  readonly missingLinks: readonly {
    readonly entry: string;
    readonly field: string;
    readonly linkType: 'Entry' | 'Asset';
    readonly target: string;
  }[];
  readonly missingLinkCount: number;
  readonly invalidEntries: readonly {
    readonly entry: string;
    readonly messages: readonly string[];
  }[];
}

/** What a package at a URL turns out to be, once the server verified it. */
export interface InspectedPluginPackage {
  readonly manifest: PluginManifestInput;
  /** Checksum of the bytes the server actually fetched. Pin this on install. */
  readonly checksum: string;
  readonly publishedAt?: string;
  readonly bundleBytes: number;
}

/** The manifest half of a plugin package, as authored. */
export interface PluginManifestInput {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly capabilities: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly hooks: readonly string[];
  readonly entrypoint: string;
}

/**
 * What each capability lets a plugin do, in the words of the person deciding.
 *
 * Consent is only consent if the grant is legible: `content:write` is not a
 * sentence an editor can weigh, and this screen is where authority is handed
 * over. Anything not listed falls back to the raw string rather than being
 * hidden — an unknown capability the operator cannot read is exactly the one
 * they should see verbatim.
 */
export const PLUGIN_CAPABILITIES: readonly {
  value: string;
  label: string;
  detail: string;
}[] = [
  { value: 'content:read', label: 'Read content', detail: 'Drafts and published entries.' },
  { value: 'content:write', label: 'Create and edit content', detail: 'Write entries as itself.' },
  { value: 'content:publish', label: 'Publish content', detail: 'Make entries live.' },
  { value: 'assets:read', label: 'Read assets', detail: 'Media library metadata.' },
  { value: 'assets:write', label: 'Create and edit assets', detail: 'Add or change media.' },
  { value: 'taxonomy:read', label: 'Read taxonomy', detail: 'Tags and concept schemes.' },
  { value: 'taxonomy:write', label: 'Edit taxonomy', detail: 'Change tags and schemes.' },
  { value: 'search:read', label: 'Search content', detail: 'Lexical and semantic search.' },
  { value: 'ai:generate', label: 'Use AI generation', detail: 'Spends the space’s AI budget.' },
  {
    value: 'network:request',
    label: 'Call external services',
    detail: 'Reads from the hosts listed below, and nowhere else. It cannot write to them.',
  },
  {
    value: 'kv:storage',
    label: 'Store its own data',
    detail: 'A namespace only it can see, per environment.',
  },
];

/**
 * Capabilities no runtime here can enforce, so they are never offered.
 *
 * Empty today. `network:request` used to be listed: the isolate's own outbound
 * cannot be filtered per plugin, so it is severed entirely and network access
 * is handed in as a capability method checked against the allowlist host-side
 * — which is enforceable, and is what the consent screen now grants.
 *
 * Kept as a list rather than deleted because the next capability that cannot be
 * enforced should be refused here rather than quietly offered.
 */
export const UNENFORCEABLE_PLUGIN_CAPABILITIES: readonly string[] = [];

/**
 * Capabilities a manifest may declare and a human may approve, but which no
 * host method backs yet. The sandbox refuses calls to them as "not provided",
 * so approving one grants nothing today — said on the consent screen rather
 * than left for a plugin author to discover.
 */
export const UNPROVIDED_PLUGIN_CAPABILITIES: readonly string[] = [
  'assets:write',
  'search:read',
  'ai:generate',
];

/**
 * A requested image transformation. `auto` format lets the image service
 * negotiate AVIF/WebP per browser (Cloudflare Images on the edge deployment).
 */
export interface ImageTransform {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: 'clip' | 'crop' | 'fill' | 'max' | 'scale';
  readonly format?: 'auto' | 'jpg' | 'png' | 'webp' | 'avif';
  readonly quality?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The response's JSON body, when it had one: `{ error: { code, message, … } }`. */
    readonly body?: unknown,
  ) {
    super(message);
  }

  /** The API's stable error code (`asset_in_use`, `conflict`, …), when the body carried one. */
  get code(): string | undefined {
    return (this.body as { error?: { code?: string } } | undefined)?.error?.code;
  }
}

/**
 * The fields a 422 named (`error.issues[].field`, e.g. `rights.expiresAt`), each with its first
 * message, so a form can say what is wrong beside the field. Empty for any other failure.
 */
export function apiFieldIssues(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 422) return {};
  const issues = (err.body as { error?: { issues?: unknown } } | undefined)?.error?.issues;
  const out: Record<string, string> = {};
  if (!Array.isArray(issues)) return out;
  for (const issue of issues as { field?: unknown; message?: unknown }[]) {
    if (typeof issue.field === 'string' && typeof issue.message === 'string') {
      out[issue.field] ??= issue.message;
    }
  }
  return out;
}

/** True when the API refused because the caller's role lacks the scope (403). */
export const isForbidden = (err: unknown): boolean => err instanceof ApiError && err.status === 403;

/** The links that hold an asset, as a refused delete reports them: the first few, and how many. */
export interface AssetInUse {
  /** The first links (the API sends at most 50), each with its entry's type and title. */
  readonly usage: readonly AssetUsage[];
  /** Every link, counted, so the screen can say how many it isn't showing. */
  readonly total: number;
}

/**
 * Why an asset couldn't be deleted: the entries that still link to it (409 `asset_in_use`), so the
 * screen can show where it is used without fetching each entry. Null for any other failure.
 */
export function assetUsageOf(err: unknown): AssetInUse | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'asset_in_use') return null;
  const body = (err.body as { error?: { usage?: unknown; total?: unknown } }).error;
  const usage = Array.isArray(body?.usage) ? (body.usage as AssetUsage[]) : [];
  const total = typeof body?.total === 'number' ? body.total : usage.length;
  return { usage, total };
}

/** What the asset library can be narrowed and ordered by (the API's `GET …/assets` query). */
export interface AssetListQuery {
  readonly kind?: AssetKind;
  /** Exact (`image/png`) or a family (`image/*`). */
  readonly mime?: string;
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder; absent: every folder. */
  readonly folder?: string;
  /** Absent hides archived assets. */
  readonly status?: AssetStatus | 'all';
  readonly sort?: 'updatedAt' | 'createdAt' | 'size';
  readonly order?: 'asc' | 'desc';
  readonly limit?: number;
  readonly cursor?: string;
}

/** One page of assets; pass `nextCursor` back as `cursor` for the next. */
export interface AssetPage {
  readonly items: Asset[];
  readonly nextCursor?: string;
}

/** An asset search (`GET …/assets/search`): text, and the filters that narrow it. */
export interface AssetSearchQuery {
  readonly q: string;
  readonly kind?: AssetKind;
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder; absent: every folder. */
  readonly folder?: string;
  /** Absent hides archived assets. */
  readonly status?: AssetStatus | 'all';
  /** 1..100; the API's default is 20. */
  readonly limit?: number;
}

/**
 * How many matches each facet value has, each counted with the other filters but not its own:
 * `kind` by asset kind, `tag` by tag id, `folder` by folder id (`root` for assets in no folder).
 */
export interface AssetFacets {
  readonly kind: Readonly<Record<string, number>>;
  readonly tag: Readonly<Record<string, number>>;
  readonly folder: Readonly<Record<string, number>>;
}

/** An asset search's results: best match first, with facet counts. */
export interface AssetSearchPage {
  readonly items: Asset[];
  readonly total: number;
  readonly facets: AssetFacets;
}

/** One page of collections, by name; pass `nextCursor` back as `cursor` for the next. */
export interface AssetCollectionPage {
  readonly items: AssetCollection[];
  readonly nextCursor?: string;
}

/** What a collection's assets can be narrowed by: the library's filters, in its own order. */
export type AssetCollectionAssetsQuery = Omit<AssetListQuery, 'folder' | 'sort' | 'order'>;

/** A share link to make: what it opens, until when, and how. */
export interface ShareLinkInput {
  readonly targetType: AssetShareTargetType;
  readonly targetId: string;
  /** An ISO instant 5 minutes to 90 days out (the API checks it). */
  readonly expiresAt: string;
  readonly allowDownload?: boolean;
  /** 8 to 256 characters; asked for before the page opens. */
  readonly password?: string;
}

/** A multipart upload started for a new draft asset (`POST …/assets/uploads`). */
export interface MultipartUploadStarted {
  readonly asset: Asset;
  readonly upload: {
    readonly uploadId: string;
    /** Every part but the last has exactly this many bytes. */
    readonly partSize: number;
    readonly partCount: number;
  };
}

/** A signed URL for one part: PUT exactly `length` bytes to it; its ETag names the part. */
export interface SignedUploadPart {
  readonly partNumber: number;
  readonly url: string;
  readonly length: number;
  readonly expiresAt: string;
}

/** A zip download being built, or built, with a short-lived download URL once it is. */
export type AssetZip = AssetZipJob;

/** What a zip is made of: a selection of assets or a collection, and its name (without .zip). */
export type AssetZipInput = (
  | { readonly assetIds: readonly string[] }
  | { readonly collectionId: string }
) & { readonly name?: string };

/**
 * A part's PUT to storage that failed. Always worth another attempt (signed again): an expired
 * URL is a 403 from storage, not a refusal by the API.
 */
export class UploadPartError extends ApiError {}

/**
 * A signed upload URL as the admin PUTs it: a `/media/…` URL (absolute on the api's host in a
 * deployment, `MEDIA_BASE_URL`) becomes its same-origin path, which the web Worker's gateway
 * forwards to the api. The api sends no CORS headers, so a cross-origin PUT's ETag couldn't be
 * read; the signature covers the path and query, not the host, so the two are the same request.
 * Any other URL (a video host's) is left alone.
 */
export function sameOriginUpload(url: string): string {
  const u = new URL(url, 'http://same-origin.invalid');
  return u.pathname.startsWith('/media/') ? `${u.pathname}${u.search}` : url;
}

/** The query string for an {@link AssetListQuery}, without the empty parts. */
export function assetQueryParams(query: AssetListQuery | AssetSearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  return params;
}

/**
 * Typed client for the Management + Preview APIs. The admin uses one CMA/admin
 * token (CMA keys carry preview:read, so the same token lists drafts and writes
 * content). Management routes author/publish; Preview routes list drafts.
 */
export function createManagementClient(
  conn: Connection,
  fetchImpl: typeof fetch = fetch,
  options: ManagementClientOptions = {},
) {
  // Same origin: the web Worker's gateway forwards these paths to the api Worker.
  const root = '';
  const spaceBase = `${root}/spaces/${conn.space}`;
  const mgmt = `${root}/spaces/${conn.space}/environments/${conn.environment}`;
  const preview = `${root}/preview/${conn.space}/${conn.environment}`;
  const delivery = `${root}/delivery/${conn.space}/${conn.environment}`;
  async function send<T>(
    method: string,
    url: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const res = await fetchImpl(url, {
      method,
      headers: apiHeaders({ 'content-type': 'application/json' }),
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    rememberBookmark(res);
    if (!res.ok) {
      if (res.status === 401) options.onUnauthorized?.();
      const text = await res.text().catch(() => '');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      throw new ApiError(res.status, `${method} ${url} → ${res.status} ${text}`, body);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  async function req<T>(
    method: string,
    url: string,
    body?: unknown,
    signal?: AbortSignal,
    limit: RequestLimit = WRITE_LIMIT,
  ): Promise<T> {
    if (method === 'GET') return send<T>(method, url, body, signal);
    // Its own controller, so that running out of time is told apart from the caller's abort.
    const expiry = new AbortController();
    const abort = () => expiry.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new RequestTimeoutError(!limit.read));
        abort();
      }, limit.ms);
    });
    try {
      return await Promise.race([send<T>(method, url, body, expiry.signal), timedOut]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  // The bytes go on the signed URL the API handed out, to the api's /media/ route through the web
  // Worker (same origin), not through the JSON API.
  async function putFile(upload: { url: string; headers: Record<string, string> }, file: File) {
    const put = await fetchImpl(sameOriginUpload(upload.url), {
      method: 'PUT',
      headers: upload.headers,
      body: file,
    });
    if (!put.ok) throw new ApiError(put.status, `upload failed: ${put.status}`);
  }

  /** One page of draft/current entries (Preview API), with optional field filters, ordering and
   *  full-text search applied server-side. `cursor` is the last page's `nextCursor`. */
  async function listEntryPage(
    contentType?: string,
    query: EntryListQuery = {},
    cursor?: string,
  ): Promise<EntryPage> {
    const params = entryQueryParams(query);
    if (contentType) params.set('content_type', contentType);
    if (cursor) params.set('cursor', cursor);
    const qs = params.toString();
    return req<EntryPage>('GET', `${preview}/entries${qs ? `?${qs}` : ''}`);
  }

  return {
    getSpaceConfig(): Promise<SpaceConfig> {
      return req('GET', `${mgmt}/space-config`);
    },
    /**
     * Sets locales' settings (`delivered`, `direction`); a locale left out keeps its own. Answers
     * the space config with every locale resolved. Needs `space:admin`.
     */
    setLocaleSettings(
      localeSettings: Readonly<
        Record<string, { readonly delivered?: boolean; readonly direction?: TextDirection }>
      >,
    ): Promise<SpaceConfig> {
      return req('PUT', `${mgmt}/locale-settings`, { localeSettings });
    },
    /** Spaces the current token can reach (admin → all; a scoped key → its own). */
    async listSpaces(): Promise<SpaceRef[]> {
      const r = await req<{ items: SpaceRef[] }>('GET', `${root}/spaces`);
      return r.items;
    },
    /**
     * Provision a new space, optionally with a starter (deployment admins only). A background
     * starter answers at once with `installing`: follow it with {@link getStarterInstall}.
     */
    createSpace(input: {
      spaceId: string;
      name: string;
      defaultLocale: string;
      locales?: string[];
      starter?: SpaceStarter;
    }): Promise<SpaceRef & { starter: SpaceStarter; installing?: StarterInstallStarted }> {
      return req('POST', `${root}/spaces`, input, undefined, LARGE_LIMIT);
    },
    /** The starters a new space can use on this deployment (deployment admins only). */
    async listStarters(): Promise<SpaceStarterInfo[]> {
      const r = await req<{ items: SpaceStarterInfo[] }>('GET', `${root}/starters`);
      return r.items;
    },
    /**
     * A background starter install's progress, in the space it installs into (named here, not
     * the current scope's, since the install is followed while the scope moves to it).
     */
    getStarterInstall(
      spaceId: string,
      environmentId: string,
      install: string,
    ): Promise<StarterInstall> {
      return req(
        'GET',
        `${root}/spaces/${encodeURIComponent(spaceId)}/environments/${encodeURIComponent(environmentId)}/starter-installs/${encodeURIComponent(install)}`,
      );
    },
    /** Environments (branches) in the current space. */
    async listEnvironments(): Promise<Environment[]> {
      const r = await req<{ items: Environment[] }>('GET', `${spaceBase}/environments`);
      return r.items;
    },
    createEnvironment(input: { id: string; name?: string }): Promise<{ id: string }> {
      return req('POST', `${spaceBase}/environments`, input);
    },
    /** Environment aliases (repointable blue/green pointers) in the current space. */
    async listEnvironmentAliases(): Promise<EnvironmentAlias[]> {
      const r = await req<{ items: EnvironmentAlias[] }>('GET', `${spaceBase}/environment-aliases`);
      return r.items;
    },
    /** Creates or atomically repoints an alias at a target environment. */
    setEnvironmentAlias(alias: string, targetEnvironmentId: string): Promise<EnvironmentAlias> {
      return req('PUT', `${spaceBase}/environment-aliases/${encodeURIComponent(alias)}`, {
        targetEnvironmentId,
      });
    },
    deleteEnvironmentAlias(alias: string): Promise<void> {
      return req('DELETE', `${spaceBase}/environment-aliases/${encodeURIComponent(alias)}`);
    },
    /** Diffs two environments (content types + entries that differ). */
    compareEnvironments(source: string, target: string): Promise<EnvironmentComparison> {
      return req(
        'GET',
        `${spaceBase}/compare?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
      );
    },
    /** Applies selected content types/entries from source→target (additive). */
    mergeEnvironments(input: {
      source: string;
      target: string;
      contentTypes?: string[];
      entries?: string[];
    }): Promise<MergeResult> {
      return req('POST', `${spaceBase}/merge`, input, undefined, LARGE_LIMIT);
    },
    /** A page of the space's append-only audit trail, newest first (requires space:admin). */
    listAuditLog(
      query: AuditLogFilters & { limit?: number; cursor?: string } = {},
    ): Promise<AuditLogPage> {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value) params.set(key, String(value));
      }
      const qs = params.toString();
      return req('GET', `${spaceBase}/audit-log${qs ? `?${qs}` : ''}`);
    },
    /**
     * A page of one entry's activity, newest first: the audit rows that target it or saved it
     * (requires space:admin, as the audit log does).
     */
    listEntryActivity(
      entryId: string,
      query: { limit?: number; cursor?: string } = {},
    ): Promise<AuditLogPage> {
      const params = new URLSearchParams();
      if (query.limit) params.set('limit', String(query.limit));
      if (query.cursor) params.set('cursor', query.cursor);
      const qs = params.toString();
      return req(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/activity${qs ? `?${qs}` : ''}`,
      );
    },
    async listContentTypes(): Promise<ContentType[]> {
      const r = await req<{ items: ContentType[] }>('GET', `${mgmt}/content-types`);
      return r.items;
    },
    getContentType(apiId: string): Promise<ContentType> {
      return req('GET', `${mgmt}/content-types/${apiId}`);
    },
    /** Create or update a content type (the route is idempotent on apiId). */
    saveContentType(draft: ContentTypeDraft): Promise<ContentType> {
      return req('POST', `${mgmt}/content-types`, draft);
    },
    publishContentType(apiId: string): Promise<ContentType> {
      return req('POST', `${mgmt}/content-types/${apiId}/published`);
    },
    /** What depends on a content type: why deleting it would be refused. */
    contentTypeDependents(apiId: string): Promise<ContentTypeDependents> {
      return req('GET', `${mgmt}/content-types/${encodeURIComponent(apiId)}/dependents`);
    },
    /**
     * Deletes a content type nothing depends on; with `purgeEntries`, its entries first, as a job
     * (follow it with {@link getBulkJob}): the type goes when the job completes cleanly.
     */
    deleteContentType(
      apiId: string,
      opts: { readonly purgeEntries?: boolean } = {},
    ): Promise<{ deleted: true } | { deleted: false; job: BulkJobSummary }> {
      const q = opts.purgeEntries ? '?purge_entries=true' : '';
      return req('DELETE', `${mgmt}/content-types/${encodeURIComponent(apiId)}${q}`);
    },
    /** Copies a type's definition under a new apiId and name, as a draft with no entries. */
    cloneContentType(apiId: string, to: { apiId: string; name: string }): Promise<ContentType> {
      return req('POST', `${mgmt}/content-types/${encodeURIComponent(apiId)}/clone`, to);
    },
    /** Entries per content type by status, from one grouped count (the content overview). */
    async contentTypeEntryCounts(): Promise<ContentTypeEntryCounts[]> {
      const r = await req<{ items: ContentTypeEntryCounts[] }>(
        'GET',
        `${mgmt}/content-types/entry-counts`,
      );
      return r.items;
    },
    listEntryPage,
    /** Lists draft/current entries (Preview API). The API returns at most `ENTRY_PAGE` a
     *  request, so a larger `limit` is read page by page, following the cursor. */
    async listEntries(contentType?: string, query: EntryListQuery = {}): Promise<PreviewEntry[]> {
      const want = query.limit;
      if (want === undefined) return [...(await listEntryPage(contentType, query)).items];
      const items: PreviewEntry[] = [];
      let cursor: string | undefined;
      do {
        const size = Math.min(ENTRY_PAGE, want - items.length);
        const page = await listEntryPage(contentType, { ...query, limit: size }, cursor);
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && items.length < want);
      return items;
    },
    /**
     * Entries matching what someone is typing, resolved server-side.
     *
     * A chooser cannot filter a fetched list: `listEntries` is capped, so an
     * entry past the cap is unreachable rather than merely slow to find.
     */
    async suggestEntries(input: {
      q?: string;
      contentType?: string;
      limit?: number;
    }): Promise<EntrySuggestion[]> {
      const params = new URLSearchParams();
      if (input.q) params.set('q', input.q);
      if (input.contentType) params.set('content_type', input.contentType);
      if (input.limit) params.set('limit', String(input.limit));
      if (conn.locale) params.set('locale', conn.locale);
      const qs = params.toString();
      const r = await req<{ items: EntrySuggestion[] }>(
        'GET',
        `${preview}/suggest${qs ? `?${qs}` : ''}`,
      );
      return r.items;
    },
    /**
     * One entry's current (draft) version. Read through the list route filtered by `sys.id`:
     * the single-entry preview route (`/preview/:space/:env/entries/:id`) authenticates only a
     * bearer or a shareable preview token, not the web app's signed principal.
     */
    async getEntry(id: string): Promise<PreviewEntry> {
      const r = await req<{ items: PreviewEntry[] }>(
        'GET',
        `${preview}/entries?sys.id=${encodeURIComponent(id)}&limit=1`,
      );
      const entry = r.items.find((e) => e.id === id);
      if (!entry) throw new ApiError(404, `Entry ${id} was not found`);
      return entry;
    },

    /**
     * A singleton type's one entry as it is now, or null when it has none outside the trash (or
     * the type is not a singleton): what the sidebar opens for the type.
     */
    async getSingletonEntry(contentType: string): Promise<PreviewEntry | null> {
      try {
        return await req<PreviewEntry>(
          'GET',
          `${preview}/singletons/${encodeURIComponent(contentType)}`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },

    // --- trash lifecycle -------------------------------------------------
    /** Moves an entry to the trash, unpublishing it first when it is live. */
    trashEntry(id: string): Promise<EntryAggregate> {
      return req('DELETE', `${mgmt}/entries/${encodeURIComponent(id)}`);
    },
    restoreEntry(id: string): Promise<EntryAggregate> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/restore`);
    },
    /** Irreversible. `force` deletes even when published entries still link to it. */
    purgeEntry(id: string, force = false): Promise<void> {
      return req(
        'DELETE',
        `${mgmt}/entries/${encodeURIComponent(id)}/permanent${force ? '?force=true' : ''}`,
      );
    },
    duplicateEntry(id: string): Promise<{ entry: EntryAggregate }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/duplicate`);
    },
    /**
     * The entry's blocks fields as a tree of keys, types and labels (`GET …/entries/:id/blocks`).
     * Only the fields this person may read are in it, which is how a card tells a hidden field from
     * an empty one.
     */
    getBlocksOutline(id: string): Promise<EntryBlocksOutline> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(id)}/blocks`);
    },
    /**
     * A block patch's dry run (`POST …/entries/blocks/validate`): the fields the save would store
     * and the patch as it would apply, or the error the save would answer. Writes nothing.
     */
    checkBlockPatch(
      entryId: string,
      patch: { readonly expectedVersion: number; readonly ops: readonly unknown[] },
    ): Promise<BlockPatchCheck> {
      return req('POST', `${mgmt}/entries/blocks/validate`, { entryId, ...patch });
    },
    /** Entries/assets that reference this entry ("what links here"). */
    async reverseReferences(id: string): Promise<ReferenceEdge[]> {
      const r = await req<{ items: ReferenceEdge[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(id)}/reverse-references`,
      );
      return r.items;
    },
    /** Reads the published (delivery) version of an entry, rendered for the connection locale. */
    getPublished(id: string): Promise<DeliveredEntry> {
      return req(
        'GET',
        `${delivery}/entries/${encodeURIComponent(id)}?locale=${encodeURIComponent(conn.locale)}`,
      );
    },
    /** `fields` is the localized shape: `{ field: { locale: value } }`. */
    createEntry(contentTypeApiId: string, fields: EntryFields): Promise<EntryView> {
      return req('POST', `${mgmt}/entries`, { contentTypeApiId, fields });
    },
    updateEntry(id: string, fields: EntryFields): Promise<EntryView> {
      return req('PUT', `${mgmt}/entries/${encodeURIComponent(id)}`, { fields });
    },
    publishEntry(id: string): Promise<EntryAggregate> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/published`);
    },
    unpublishEntry(id: string): Promise<EntryAggregate> {
      return req('DELETE', `${mgmt}/entries/${encodeURIComponent(id)}/published`);
    },
    /** AI-draft field values for a content type from a natural-language prompt. */
    generateEntry(
      input: { contentTypeApiId: string; prompt: string; tier?: ModelTier },
      signal?: AbortSignal,
    ): Promise<GeneratedDraft> {
      return req('POST', `${mgmt}/entries/generate`, input, signal, MODEL_READ_LIMIT);
    },
    /** Map free-form prose into a content type's structured fields (Canvas authoring). */
    canvasEntry(
      input: { contentTypeApiId: string; prose: string; tier?: ModelTier },
      signal?: AbortSignal,
    ): Promise<GeneratedDraft> {
      return req('POST', `${mgmt}/entries/canvas`, input, signal, MODEL_READ_LIMIT);
    },

    // --- assets ----------------------------------------------------------
    /** One page of the asset library, filtered and sorted server-side. */
    listAssets(query: AssetListQuery = {}): Promise<AssetPage> {
      const qs = assetQueryParams(query).toString();
      return req('GET', `${mgmt}/assets${qs ? `?${qs}` : ''}`);
    },
    /** Searches the library (full text and semantic), with facet counts. */
    searchAssets(query: AssetSearchQuery): Promise<AssetSearchPage> {
      const qs = assetQueryParams(query).toString();
      return req('GET', `${mgmt}/assets/search?${qs}`);
    },
    getAsset(id: string): Promise<Asset> {
      return req('GET', `${mgmt}/assets/${encodeURIComponent(id)}`);
    },
    /** Runs ingest on the asset's file again (after it failed); comes back pending. */
    reingestAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/reingest`);
    },
    /**
     * Sends the library through ingest as a bulk job: the assets never ingested or whose ingest
     * failed, or every asset with a file (`all`).
     */
    reindexAssets(opts: { all?: boolean } = {}): Promise<{
      assets: number;
      job?: BulkJobSummary;
    }> {
      return req('POST', `${mgmt}/assets/reindex`, opts, undefined, BATCH_LIMIT);
    },
    createAsset(input: {
      fileName: string;
      contentType: string;
      title?: string;
      folderId?: string;
    }): Promise<{
      asset: Asset;
      upload: { url: string; headers: Record<string, string> };
    }> {
      const title = input.title ? { [conn.locale]: input.title } : undefined;
      return req('POST', `${mgmt}/assets`, {
        fileName: input.fileName,
        contentType: input.contentType,
        title,
        ...(input.folderId ? { folderId: input.folderId } : {}),
      });
    },
    /**
     * Acts on a selection of assets as a resumable job: follow it with {@link getBulkJob}, and
     * read what failed, by asset name, with {@link getBulkJobReport}.
     */
    startAssetBulkJob(input: AssetBulkRequest): Promise<BulkJobSummary> {
      return req('POST', `${mgmt}/assets/bulk`, input, undefined, BATCH_LIMIT);
    },
    /** Starts replacing an asset's file: a signed PUT for the next version, and what to commit. */
    startAssetFileReplacement(
      id: string,
      input: { fileName: string; contentType: string },
    ): Promise<{
      asset: Asset;
      upload: { url: string; headers: Record<string, string> };
      commit: { version: number; fileName: string; contentType: string };
    }> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/file`, input);
    },
    /** Makes the uploaded replacement current as a new version. */
    commitAssetFile(
      id: string,
      commit: { version: number; fileName: string; contentType: string },
    ): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/file/commit`, commit);
    },
    /** Every file the asset has had, newest first, with which is current and which is delivered. */
    async listAssetVersions(id: string): Promise<AssetVersion[]> {
      const r = await req<{ items: AssetVersion[] }>(
        'GET',
        `${mgmt}/assets/${encodeURIComponent(id)}/versions`,
      );
      return r.items;
    },
    /** Makes an earlier version's file current again, as a new version. */
    restoreAssetVersion(id: string, version: number): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/versions/${version}/restore`);
    },
    /** Replaces an asset's usage rights (content:publish); null clears a field. */
    setAssetRights(id: string, rights: AssetRightsInput): Promise<Asset> {
      return req('PUT', `${mgmt}/assets/${encodeURIComponent(id)}/rights`, rights);
    },
    /** Files assets in a folder; `null` takes them back to the root. */
    moveAssets(ids: readonly string[], folderId: string | null): Promise<{ moved: number }> {
      return req('POST', `${mgmt}/assets/move`, { ids, folderId }, undefined, BATCH_LIMIT);
    },
    /** Takes an asset out of Delivery and out of the library's default view. */
    archiveAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/archive`);
    },
    /** Brings an archived asset back as a draft. */
    restoreAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/restore`);
    },
    /**
     * Deletes an asset and its files. Refused (409 `asset_in_use`, read with
     * {@link assetUsageOf}) while an entry links to it.
     */
    deleteAsset(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/assets/${encodeURIComponent(id)}`);
    },
    async listAssetFolders(): Promise<AssetFolder[]> {
      const r = await req<{ items: AssetFolder[] }>('GET', `${mgmt}/asset-folders`);
      return r.items;
    },
    createAssetFolder(input: { name: string; parentId?: string }): Promise<AssetFolder> {
      return req('POST', `${mgmt}/asset-folders`, input);
    },
    updateAssetFolder(
      id: string,
      patch: { name?: string; parentId?: string | null },
    ): Promise<AssetFolder> {
      return req('PATCH', `${mgmt}/asset-folders/${encodeURIComponent(id)}`, patch);
    },
    /** Deletes an empty folder (409 while anything is in it). */
    deleteAssetFolder(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/asset-folders/${encodeURIComponent(id)}`);
    },
    // --- asset collections -------------------------------------------------
    /** One page of the collections, by name. */
    listAssetCollections(
      query: { readonly limit?: number; readonly cursor?: string } = {},
    ): Promise<AssetCollectionPage> {
      const qs = assetQueryParams(query).toString();
      return req('GET', `${mgmt}/asset-collections${qs ? `?${qs}` : ''}`);
    },
    getAssetCollection(id: string): Promise<AssetCollection> {
      return req('GET', `${mgmt}/asset-collections/${encodeURIComponent(id)}`);
    },
    createAssetCollection(input: { name: string; description?: string }): Promise<AssetCollection> {
      return req('POST', `${mgmt}/asset-collections`, input);
    },
    /** Renames it or changes its description; `description: ''` clears it. */
    updateAssetCollection(
      id: string,
      patch: { name?: string; description?: string },
    ): Promise<AssetCollection> {
      return req('PATCH', `${mgmt}/asset-collections/${encodeURIComponent(id)}`, patch);
    },
    /** Deletes the collection; its assets stay in the library, and links to it stop opening. */
    deleteAssetCollection(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/asset-collections/${encodeURIComponent(id)}`);
    },
    /** A page of the collection's assets, in its order. */
    listAssetCollectionAssets(
      id: string,
      query: AssetCollectionAssetsQuery = {},
    ): Promise<AssetPage> {
      const qs = assetQueryParams(query).toString();
      return req(
        'GET',
        `${mgmt}/asset-collections/${encodeURIComponent(id)}/assets${qs ? `?${qs}` : ''}`,
      );
    },
    /**
     * Adds assets after its last member (up to 500 ids a call). Members already in it stay put;
     * `skipped` names the ids that aren't assets here. 409 past 1,000 members.
     */
    addToAssetCollection(
      id: string,
      assetIds: readonly string[],
    ): Promise<{ added: number; skipped: string[] }> {
      return req('POST', `${mgmt}/asset-collections/${encodeURIComponent(id)}/assets`, {
        assetIds,
      });
    },
    /** Takes assets out of the collection (never out of the library). */
    removeFromAssetCollection(
      id: string,
      assetIds: readonly string[],
    ): Promise<{ removed: number }> {
      return req('POST', `${mgmt}/asset-collections/${encodeURIComponent(id)}/assets/remove`, {
        assetIds,
      });
    },
    /** The named members go first, in this order; the rest keep theirs after them. */
    reorderAssetCollection(id: string, assetIds: readonly string[]): Promise<void> {
      return req('PUT', `${mgmt}/asset-collections/${encodeURIComponent(id)}/order`, {
        assetIds,
      });
    },

    // --- share links (content:publish, listing included) ----------------------
    /** The links to one asset or collection, newest first; active ones unless asked. */
    async listShareLinks(target: {
      targetType: AssetShareTargetType;
      targetId: string;
      includeInactive?: boolean;
    }): Promise<AssetShareLink[]> {
      const params = new URLSearchParams({
        targetType: target.targetType,
        targetId: target.targetId,
      });
      if (target.includeInactive) params.set('includeInactive', 'true');
      const r = await req<{ items: AssetShareLink[] }>('GET', `${mgmt}/share-links?${params}`);
      return r.items;
    },
    /** Makes a link; an asset must be published (409 otherwise). */
    createShareLink(input: ShareLinkInput): Promise<AssetShareLink> {
      return req('POST', `${mgmt}/share-links`, input);
    },
    /** Revokes a link; it stops opening within a minute. Revoking it again changes nothing. */
    revokeShareLink(id: string): Promise<AssetShareLink> {
      return req('DELETE', `${mgmt}/share-links/${encodeURIComponent(id)}`);
    },

    // --- multipart uploads (files past one signed PUT) -----------------------------
    /** Creates the draft asset and its multipart upload: the part size and how many parts. */
    startAssetUpload(input: {
      fileName: string;
      contentType: string;
      size: number;
      title?: string;
      folderId?: string;
    }): Promise<MultipartUploadStarted> {
      const { title, folderId, ...rest } = input;
      return req('POST', `${mgmt}/assets/uploads`, {
        ...rest,
        ...(title ? { title: { [conn.locale]: title } } : {}),
        ...(folderId ? { folderId } : {}),
      });
    },
    /** Signs part URLs (up to 100 a call); sign a part again to retry it. */
    signAssetUploadParts(
      assetId: string,
      uploadId: string,
      partNumbers: readonly number[],
    ): Promise<{ parts: SignedUploadPart[] }> {
      return req(
        'POST',
        `${mgmt}/assets/${encodeURIComponent(assetId)}/uploads/${encodeURIComponent(uploadId)}/parts`,
        { partNumbers },
      );
    },
    /**
     * PUTs one part's bytes straight to storage on its signed URL and returns the ETag that names
     * it. A failure is an {@link UploadPartError}.
     */
    async putUploadPart(url: string, bytes: Blob, signal?: AbortSignal): Promise<string> {
      const res = await fetchImpl(sameOriginUpload(url), {
        method: 'PUT',
        body: bytes,
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new UploadPartError(res.status, `part upload failed: ${res.status}`);
      const etag = res.headers.get('etag');
      if (!etag) throw new UploadPartError(0, 'part upload came back without an ETag');
      return etag;
    },
    /** Names every part 1..n with its ETag; the asset then has its file, and ingest starts. */
    completeAssetUpload(
      assetId: string,
      uploadId: string,
      parts: readonly { partNumber: number; etag: string }[],
    ): Promise<Asset> {
      return req(
        'POST',
        `${mgmt}/assets/${encodeURIComponent(assetId)}/uploads/${encodeURIComponent(uploadId)}/complete`,
        { parts },
        undefined,
        BATCH_LIMIT,
      );
    },
    /**
     * Starts replacing an asset's file in parts (past one signed PUT): the next version's
     * multipart upload. Sign, PUT and complete it as a new asset's; completing commits it.
     */
    startAssetFileUpload(
      id: string,
      input: { fileName: string; contentType: string; size: number },
    ): Promise<MultipartUploadStarted & { version: number }> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/file/uploads`, input);
    },
    /**
     * Gives the upload up: its parts are discarded, and a new asset's empty draft deleted (a
     * replacement's asset keeps its file).
     */
    abortAssetUpload(assetId: string, uploadId: string): Promise<void> {
      return req(
        'DELETE',
        `${mgmt}/assets/${encodeURIComponent(assetId)}/uploads/${encodeURIComponent(uploadId)}`,
      );
    },

    // --- zip downloads -----------------------------------------------------------
    /** Starts building a zip of a selection or a collection (202); follow it with getAssetZip. */
    startAssetZip(input: AssetZipInput): Promise<AssetZip> {
      return req('POST', `${mgmt}/asset-zips`, input);
    },
    /** A zip's progress, with a 15-minute download URL once it is built. */
    getAssetZip(id: string): Promise<AssetZip> {
      return req('GET', `${mgmt}/asset-zips/${encodeURIComponent(id)}`);
    },
    async listAssetZips(): Promise<AssetZip[]> {
      const r = await req<{ items: AssetZip[] }>('GET', `${mgmt}/asset-zips`);
      return r.items;
    },

    /** Creates a draft video asset with a one-time direct upload to the video host. */
    createVideoAsset(input: { fileName: string; contentType: string; title?: string }): Promise<{
      asset: Asset;
      upload: { videoId: string; uploadUrl: string; method: 'POST'; fileField: string };
    }> {
      const title = input.title ? { [conn.locale]: input.title } : undefined;
      return req('POST', `${mgmt}/assets/videos`, {
        fileName: input.fileName,
        contentType: input.contentType,
        title,
      });
    },
    /** Re-reads a video asset's processing status, playback URLs and poster. */
    refreshVideoAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/video/refresh`);
    },
    publishAsset(id: string): Promise<Asset> {
      return req('POST', `${mgmt}/assets/${encodeURIComponent(id)}/published`);
    },
    unpublishAsset(id: string): Promise<Asset> {
      return req('DELETE', `${mgmt}/assets/${encodeURIComponent(id)}/published`);
    },
    /** Updates an asset's editorial metadata (alt text, focal point, tags, custom fields). */
    setAssetMetadata(id: string, patch: Partial<AssetMetadata>): Promise<Asset> {
      return req('PATCH', `${mgmt}/assets/${encodeURIComponent(id)}/metadata`, patch);
    },
    /** Lists the entries that reference an asset (where it is used). */
    async assetUsage(id: string): Promise<ReferenceEdge[]> {
      const r = await req<{ items: ReferenceEdge[] }>(
        'GET',
        `${mgmt}/assets/${encodeURIComponent(id)}/usage`,
      );
      return r.items;
    },
    // --- content semantics (vector-backed) -------------------------------
    /** Entries semantically related to a given entry. */
    async relatedEntries(id: string, topK?: number): Promise<SearchHit[]> {
      const qs = topK ? `?top_k=${topK}` : '';
      const r = await req<{ items: SearchHit[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(id)}/related${qs}`,
      );
      return r.items;
    },
    /** Near-duplicate entries for a given entry (high similarity). */
    async findDuplicates(id: string, threshold?: number): Promise<SearchHit[]> {
      const qs = threshold ? `?threshold=${threshold}` : '';
      const r = await req<{ items: SearchHit[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(id)}/duplicates${qs}`,
      );
      return r.items;
    },

    // --- AI Actions (templated, governed) --------------------------------
    async listAIActions(): Promise<AIAction[]> {
      const r = await req<{ items: AIAction[] }>('GET', `${mgmt}/ai-actions`);
      return r.items;
    },
    createAIAction(input: {
      name: string;
      promptTemplate: string;
      description?: string;
      targetField?: string;
      tier?: ModelTier;
    }): Promise<AIAction> {
      return req('POST', `${mgmt}/ai-actions`, input);
    },
    deleteAIAction(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/ai-actions/${encodeURIComponent(id)}`);
    },
    runAIAction(
      id: string,
      input: {
        entryId?: string;
        variables?: Record<string, string>;
        locale?: string;
        apply?: boolean;
      } = {},
      signal?: AbortSignal,
    ): Promise<{ actionId: string; output: string; applied: boolean }> {
      return req(
        'POST',
        `${mgmt}/ai-actions/${encodeURIComponent(id)}/run`,
        input,
        signal,
        input.apply ? MODEL_WRITE_LIMIT : MODEL_READ_LIMIT,
      );
    },

    // --- functions (event-triggered) -------------------------------------
    async listFunctions(): Promise<FunctionDefinition[]> {
      const r = await req<{ items: FunctionDefinition[] }>('GET', `${mgmt}/functions`);
      return r.items;
    },
    createFunction(input: {
      name: string;
      eventPattern: string;
      url: string;
      active?: boolean;
    }): Promise<FunctionDefinition> {
      return req('POST', `${mgmt}/functions`, input);
    },
    deleteFunction(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/functions/${encodeURIComponent(id)}`);
    },

    // --- importing content from elsewhere ---------------------------------
    async listImportSources(): Promise<{ id: string; name: string }[]> {
      const r = await req<{ items: { id: string; name: string }[] }>(
        'GET',
        `${mgmt}/imports/sources`,
      );
      return r.items;
    },
    /** Reports what an import would do. Writes nothing. */
    analyzeImport(input: ImportRequest): Promise<ImportAnalysis> {
      return req('POST', `${mgmt}/imports/analyze`, input, undefined, CHECK_LIMIT);
    },
    runImport(input: ImportRequest): Promise<ImportResult> {
      return req('POST', `${mgmt}/imports`, input, undefined, LARGE_LIMIT);
    },
    /** Starts the same import as a resumable job, for files too big for one request. */
    startImportJob(input: ImportRequest): Promise<{ job: BulkJobSummary }> {
      return req('POST', `${mgmt}/imports/job`, input, undefined, LARGE_LIMIT);
    },
    /** Reports what importing a space export into this environment would do. Writes nothing. */
    analyzeSpaceExport(input: SpaceExportRequest): Promise<SpaceExportReport> {
      return req('POST', `${mgmt}/imports/space-export/analyze`, input, undefined, CHECK_LIMIT);
    },
    /** Writes the model and starts the jobs that create and then publish everything else. */
    startSpaceExportImport(input: SpaceExportRequest): Promise<{
      report: SpaceExportReport;
      job: BulkJobSummary | null;
      publishJobId: string | null;
    }> {
      return req('POST', `${mgmt}/imports/space-export`, input, undefined, LARGE_LIMIT);
    },
    /**
     * Who the session is in this space: its scopes, and the bulk jobs over entries its role may
     * start (`bulkJobs`, the api's own rule). A person's role is per space, so the admin asks
     * before offering an action only some roles may take.
     */
    getSpaceAccess(): Promise<PrincipalInfo> {
      return req('GET', `${spaceBase}/auth/me`);
    },
    /**
     * Acts on many entries as a resumable job on the server (an unrestricted content:publish
     * role): follow it with {@link getBulkJob}, and read what failed with {@link getBulkJobReport}.
     * Purging takes only entries already in the trash, and refuses one published entries link to.
     */
    startEntryBulkJob(action: EntryBulkJobAction, entryIds: string[]): Promise<BulkJobSummary> {
      return req('POST', `${mgmt}/bulk/jobs`, { action, entryIds });
    },
    getBulkJob(id: string): Promise<BulkJobSummary> {
      return req('GET', `${mgmt}/bulk/jobs/${encodeURIComponent(id)}`);
    },
    /** A job's failures by item; 403 for a role limited to some content types. */
    getBulkJobReport(id: string): Promise<BulkJobReport> {
      return req('GET', `${mgmt}/bulk/jobs/${encodeURIComponent(id)}/report`);
    },
    /**
     * Stops a running job (content:publish): batches already done stay done, the rest never run.
     * The job as it ended; a job already over comes back as it is.
     */
    cancelBulkJob(id: string): Promise<BulkJobSummary> {
      return req('POST', `${mgmt}/bulk/jobs/${encodeURIComponent(id)}/cancel`);
    },

    // --- plugins (sandboxed code on the write path) ----------------------
    // Space-scoped, not environment-scoped: a plugin is installed once for a
    // space and runs in every environment in it. Pointing these at `mgmt`
    // silently 404s, which reads as "no plugins installed".
    async listPlugins(): Promise<InstalledPluginSummary[]> {
      const r = await req<{ items: InstalledPluginSummary[] }>('GET', `${spaceBase}/plugins`);
      return r.items;
    },
    /** Installs disabled: approving a capability list and running code are two decisions. */
    installPlugin(input: {
      manifest: PluginManifestInput;
      bundle: string;
      approvedCapabilities: string[];
    }): Promise<InstalledPluginSummary> {
      return req('POST', `${spaceBase}/plugins`, input, undefined, BATCH_LIMIT);
    },
    /**
     * Fetches a package over HTTPS and installs it, disabled.
     *
     * `expectedChecksum` pins the release: the server refuses bytes that
     * changed since the operator wrote that checksum down, which is the whole
     * reason to install from a URL rather than a file someone already has.
     */
    /**
     * Fetches and verifies a package without installing it, so the consent
     * screen has a manifest to show. Install with `expectedChecksum` set to
     * what this returned.
     */
    inspectPluginPackage(
      input: { packageUrl: string; expectedChecksum?: string },
      signal?: AbortSignal,
    ): Promise<InspectedPluginPackage> {
      return req('POST', `${spaceBase}/plugins/from-url/inspect`, input, signal, CHECK_LIMIT);
    },
    installPluginFromUrl(input: {
      packageUrl: string;
      approvedCapabilities: string[];
      expectedChecksum?: string;
      expectedId?: string;
      expectedVersion?: string;
    }): Promise<InstalledPluginSummary> {
      return req('POST', `${spaceBase}/plugins/from-url`, input, undefined, BATCH_LIMIT);
    },
    /**
     * Replaces the manifest and bundle. Omit `approvedCapabilities` to carry the
     * existing grant forward; a version asking for more requires it, and lands
     * disabled so a human sees what changed before it runs again.
     */
    upgradePlugin(
      id: string,
      input: {
        manifest: PluginManifestInput;
        bundle: string;
        approvedCapabilities?: string[];
      },
    ): Promise<InstalledPluginSummary> {
      return req(
        'PUT',
        `${spaceBase}/plugins/${encodeURIComponent(id)}`,
        input,
        undefined,
        BATCH_LIMIT,
      );
    },
    /**
     * Records a fresh capability decision without changing the code. Never
     * wider than the manifest; a grant that grows disables the plugin.
     */
    approvePluginCapabilities(
      id: string,
      approvedCapabilities: readonly string[],
    ): Promise<InstalledPluginSummary> {
      return req('POST', `${spaceBase}/plugins/${encodeURIComponent(id)}/capabilities`, {
        approvedCapabilities,
      });
    },
    setPluginEnabled(id: string, enabled: boolean): Promise<InstalledPluginSummary> {
      return req('POST', `${spaceBase}/plugins/${encodeURIComponent(id)}/enabled`, { enabled });
    },
    getPluginSettings(id: string): Promise<PluginSettingsView> {
      return req('GET', `${spaceBase}/plugins/${encodeURIComponent(id)}/settings`);
    },
    /** A patch: each key set (null clears it), keys left out kept, so a secret is never resent. */
    setPluginSettings(
      id: string,
      input: {
        values: Record<string, string | number | boolean | null>;
        expectedVersion: number;
      },
    ): Promise<PluginSettingsView> {
      return req('PATCH', `${spaceBase}/plugins/${encodeURIComponent(id)}/settings`, input);
    },
    uninstallPlugin(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/plugins/${encodeURIComponent(id)}`);
    },

    // --- app extensions (UI extensions) ----------------------------------
    async listAppExtensions(): Promise<AppExtension[]> {
      const r = await req<{ items: AppExtension[] }>('GET', `${mgmt}/app-extensions`);
      return r.items;
    },
    createAppExtension(input: {
      name: string;
      target: 'field-editor' | 'sidebar';
      entryUrl: string;
      fieldTypes?: string[];
      active?: boolean;
    }): Promise<AppExtension> {
      return req('POST', `${mgmt}/app-extensions`, input);
    },
    deleteAppExtension(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/app-extensions/${encodeURIComponent(id)}`);
    },

    // --- Live Content API (SSE) ------------------------------------------
    /**
     * Subscribes to the Live Content API, invoking `onEvent` per published-content
     * change until `signal` aborts. Uses fetch streaming (EventSource can't send
     * the bearer token); keepalive `ping` frames are filtered out.
     */
    async subscribeLive(
      onEvent: (e: { type: string; data: unknown }) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const res = await fetchImpl(`${delivery}/live`, {
        headers: apiHeaders(),
        credentials: 'same-origin',
        signal,
      });
      rememberBookmark(res);
      if (!res.ok || !res.body) throw new ApiError(res.status, `live failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          let type = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (type === 'ping' || !data) continue;
          try {
            onEvent({ type, data: JSON.parse(data) });
          } catch {
            onEvent({ type, data });
          }
        }
      }
    },

    // --- bulk operations -------------------------------------------------
    /** Publishes or unpublishes many entries in one call; failures are per-item. */
    bulkEntryAction(
      action: 'publish' | 'unpublish',
      ids: string[],
    ): Promise<{
      total: number;
      succeeded: number;
      failed: number;
      results: { id: string; ok: boolean; error?: string }[];
    }> {
      return req('POST', `${mgmt}/bulk/entries/${action}`, { ids }, undefined, BATCH_LIMIT);
    },

    // --- agent actions (audit → work packages) ---------------------------
    auditEntry(
      id: string,
      input: {
        createTasks?: boolean;
        taskSeverity?: 'info' | 'warning' | 'error';
        assignee?: string;
      } = {},
    ): Promise<{
      findings: {
        field?: string;
        severity: 'info' | 'warning' | 'error';
        message: string;
        suggestedAction: string;
      }[];
      taskIds: string[];
    }> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(id)}/audit`,
        input,
        undefined,
        MODEL_WRITE_LIMIT,
      );
    },

    // --- AI content operations over an entry -----------------------------
    /** Translates an entry's localized text fields; `apply` saves a draft. */
    translateEntry(
      id: string,
      input: { targetLocale: string; sourceLocale?: string; apply?: boolean },
    ): Promise<{ fields: EntryFields; translatedFields: string[]; applied: boolean }> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(id)}/translate`,
        input,
        undefined,
        MODEL_WRITE_LIMIT,
      );
    },
    /** Summarizes an entry; `apply` writes the summary into `targetField`. */
    summarizeEntry(
      id: string,
      input: { locale?: string; maxWords?: number; targetField?: string; apply?: boolean } = {},
    ): Promise<{ summary: string; applied: boolean }> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(id)}/summarize`,
        input,
        undefined,
        MODEL_READ_LIMIT,
      );
    },
    /** Generates a value for one scalar field; `apply` saves it. */
    autofillField(
      id: string,
      input: { field: string; locale?: string; instructions?: string; apply?: boolean },
    ): Promise<{ field: string; value: unknown; applied: boolean }> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(id)}/autofill`,
        input,
        undefined,
        MODEL_WRITE_LIMIT,
      );
    },
    /** Suggests taxonomy tags for an entry; `apply` creates + assigns them. */
    suggestEntryTags(
      id: string,
      input: { apply?: boolean } = {},
    ): Promise<{ tagIds: string[]; newTags: string[]; applied: boolean }> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(id)}/suggest-tags`,
        input,
        undefined,
        MODEL_READ_LIMIT,
      );
    },
    /** Persists a reviewed tag suggestion exactly as approved (no model re-run). */
    applyEntryTags(
      id: string,
      input: { tagIds?: string[]; newTags?: string[] },
    ): Promise<{ tagIds: string[]; createdTags: { id: string; name: string }[] }> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(id)}/apply-tags`, input);
    },
    /**
     * The structured metadata (title, author, thumbnail, size) of an external media URL on an
     * allowed provider, from its oEmbed answer; `resolved` is false when the provider didn't
     * answer and the embed holds what its URL says. A URL that may not be embedded is a 422.
     */
    resolveEmbed(url: string): Promise<{ embed: EmbedData; resolved: boolean }> {
      return req('POST', `${mgmt}/embeds/resolve`, { url }, undefined, CHECK_LIMIT);
    },
    /** Suggests alt text for an image; `apply` writes it to the asset metadata. */
    generateAltText(
      id: string,
      input: { locale?: string; context?: string; apply?: boolean } = {},
    ): Promise<{ altText: string; locale: string; applied: boolean }> {
      return req(
        'POST',
        `${mgmt}/assets/${encodeURIComponent(id)}/alt-text`,
        input,
        undefined,
        MODEL_READ_LIMIT,
      );
    },
    /** Suggests taxonomy tags for an image; `apply` creates + assigns them. */
    autoTagAsset(
      id: string,
      input: { apply?: boolean } = {},
    ): Promise<{ tagIds: string[]; newTags: string[]; applied: boolean }> {
      return req(
        'POST',
        `${mgmt}/assets/${encodeURIComponent(id)}/auto-tag`,
        input,
        undefined,
        MODEL_WRITE_LIMIT,
      );
    },
    /** Resolves a transformed-image URL for an asset (focal-point-aware). */
    transformAsset(
      id: string,
      transform: ImageTransform,
    ): Promise<{ url: string; transform: ImageTransform }> {
      const params = new URLSearchParams();
      if (transform.width) params.set('w', String(transform.width));
      if (transform.height) params.set('h', String(transform.height));
      if (transform.fit) params.set('fit', transform.fit);
      if (transform.format) params.set('fm', transform.format);
      if (transform.quality != null) params.set('q', String(transform.quality));
      const qs = params.toString();
      return req('GET', `${mgmt}/assets/${encodeURIComponent(id)}/transform${qs ? `?${qs}` : ''}`);
    },
    /**
     * Full upload: create the draft asset (gets a presigned PUT), upload the
     * bytes directly to storage, then publish. Returns the published asset.
     */
    async uploadAsset(file: File, opts: { folderId?: string } = {}): Promise<Asset> {
      const { asset, upload } = await this.createAsset({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        title: file.name,
        ...(opts.folderId ? { folderId: opts.folderId } : {}),
      });
      await putFile(upload, file);
      return this.publishAsset(asset.id);
    },
    /**
     * Replaces an asset's file the way Upload creates one: the signed PUT for the next version,
     * then the commit that makes it current. A published asset keeps delivering its published
     * file until it is published again. Returns the asset at its new version.
     */
    async replaceAssetFile(id: string, file: File): Promise<Asset> {
      // Straight through `req`, not `this`: the method still works passed around on its own.
      const base = `${mgmt}/assets/${encodeURIComponent(id)}/file`;
      const { upload, commit } = await req<{
        upload: { url: string; headers: Record<string, string> };
        commit: { version: number; fileName: string; contentType: string };
      }>('POST', base, {
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
      });
      await putFile(upload, file);
      return req<Asset>('POST', `${base}/commit`, commit, undefined, BATCH_LIMIT);
    },
    /**
     * Video upload: create the draft video asset, POST the bytes straight to
     * the video host, then refresh its status. Stays a draft — publish once
     * the host reports it ready, so the delivered snapshot carries playback.
     */
    async uploadVideo(file: File): Promise<Asset> {
      const { asset, upload } = await this.createVideoAsset({
        fileName: file.name,
        contentType: file.type || 'video/mp4',
        title: file.name,
      });
      const form = new FormData();
      form.append(upload.fileField, file, file.name);
      const res = await fetchImpl(upload.uploadUrl, { method: upload.method, body: form });
      if (!res.ok) throw new ApiError(res.status, `video upload failed: ${res.status}`);
      return this.refreshVideoAsset(asset.id);
    },

    // --- dashboards ------------------------------------------------------
    async listAgentRuns(): Promise<AgentRun[]> {
      const r = await req<{ items: AgentRun[] }>('GET', `${mgmt}/agent-runs`);
      return r.items;
    },
    agentUsage(): Promise<UsageSummary> {
      return req('GET', `${mgmt}/agent-runs/usage`);
    },
    async search(query: string): Promise<SearchHit[]> {
      const r = await req<{ hits: SearchHit[] }>(
        'GET',
        `${delivery}/search?q=${encodeURIComponent(query)}`,
      );
      return r.hits;
    },

    // --- settings: API keys (space-scoped) -------------------------------
    async listApiKeys(): Promise<ApiKeySummary[]> {
      const r = await req<{ items: ApiKeySummary[] }>('GET', `${spaceBase}/api-keys`);
      return r.items;
    },
    /** Mints a key; the returned `token` is shown once and never retrievable again. */
    createApiKey(input: {
      kind: ApiKeyKind;
      name?: string;
      roleId?: string;
    }): Promise<CreatedApiKey> {
      return req('POST', `${spaceBase}/api-keys`, input);
    },
    revokeApiKey(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/api-keys/${encodeURIComponent(id)}`);
    },

    // --- settings: OAuth connections + personal access tokens -------------
    async listConnectedApps(): Promise<ConnectedApp[]> {
      const r = await req<{ items: ConnectedApp[] }>('GET', `${spaceBase}/oauth/connections`);
      return r.items;
    },
    /** Revokes the app's tokens AND the grants behind them, so it can't refresh back in. */
    revokeConnectedApp(clientId: string, subject: string): Promise<{ revokedTokens: number }> {
      return req('POST', `${spaceBase}/oauth/connections/revoke`, { clientId, subject });
    },
    async listPersonalAccessTokens(): Promise<PersonalAccessToken[]> {
      const r = await req<{ items: PersonalAccessToken[] }>(
        'GET',
        `${spaceBase}/personal-access-tokens`,
      );
      return r.items;
    },
    /** Mints a PAT; the returned `token` is shown once and never retrievable again. */
    createPersonalAccessToken(input: {
      name: string;
      scopes: string[];
      expiresInDays?: number;
    }): Promise<CreatedPat> {
      return req('POST', `${spaceBase}/personal-access-tokens`, input);
    },
    /** PATs are API keys, so revocation goes through the same route. */
    revokePersonalAccessToken(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/api-keys/${encodeURIComponent(id)}`);
    },

    // --- settings: roles (space-scoped) ----------------------------------
    async listRoles(): Promise<RoleSummary[]> {
      const r = await req<{ items: RoleSummary[] }>('GET', `${spaceBase}/roles`);
      return r.items;
    },
    getRole(id: string): Promise<RoleSummary> {
      return req('GET', `${spaceBase}/roles/${encodeURIComponent(id)}`);
    },
    createRole(input: Omit<RoleSummary, 'id'> & { name: string }): Promise<RoleSummary> {
      return req('POST', `${spaceBase}/roles`, input);
    },
    updateRole(id: string, input: Partial<RoleSummary>): Promise<RoleSummary> {
      return req('PUT', `${spaceBase}/roles/${encodeURIComponent(id)}`, input);
    },
    deleteRole(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/roles/${encodeURIComponent(id)}`);
    },
    cloneRole(id: string, name?: string): Promise<RoleSummary> {
      return req('POST', `${spaceBase}/roles/${encodeURIComponent(id)}/clone`, { name });
    },

    // --- settings: team + role presets (space-scoped) --------------------
    getTeam(): Promise<TeamSummary> {
      return req('GET', `${spaceBase}/team`);
    },
    async listRolePresets(): Promise<RolePresetSummary[]> {
      const r = await req<{ items: RolePresetSummary[] }>('GET', `${spaceBase}/role-presets`);
      return r.items;
    },
    /** `role` is a role id or a preset name. */
    addMember(input: { email: string; name?: string; role: string }): Promise<TeamPerson> {
      return req('POST', `${spaceBase}/members`, input);
    },
    updateMember(
      id: string,
      input: { role?: string; disabled?: boolean; name?: string },
    ): Promise<TeamPerson> {
      return req('PATCH', `${spaceBase}/members/${encodeURIComponent(id)}`, input);
    },
    removeMember(id: string): Promise<void> {
      return req('DELETE', `${spaceBase}/members/${encodeURIComponent(id)}`);
    },
    /** Rebinds a key to a role id or preset name; `null` unbinds it. */
    setApiKeyRole(id: string, role: string | null): Promise<{ id: string; roleId: string | null }> {
      return req('PUT', `${spaceBase}/api-keys/${encodeURIComponent(id)}/role`, { role });
    },
    setAccessSettings(input: { ssoOnly: boolean }): Promise<{ ssoOnly: boolean }> {
      return req('PUT', `${spaceBase}/access-settings`, input);
    },

    /** Expiring shareable preview URL for an entry. */
    createPreviewLink(
      entryId: string,
      input?: { ttlHours?: number; previewBaseUrl?: string; locale?: string },
    ): Promise<PreviewLinkResult> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/preview-link`,
        input ?? {},
      );
    },

    // --- settings: redirects (environment-scoped) ------------------------
    /** One page by source; `q` searches source, destination and note. */
    listRedirects(
      query: { q?: string; cursor?: string; limit?: number } = {},
    ): Promise<{ items: Redirect[]; nextCursor?: string }> {
      const qs = new URLSearchParams();
      if (query.q) qs.set('q', query.q);
      if (query.cursor) qs.set('cursor', query.cursor);
      if (query.limit) qs.set('limit', String(query.limit));
      return req('GET', `${mgmt}/redirects${qs.size ? `?${qs}` : ''}`);
    },
    createRedirect(input: RedirectInput): Promise<RedirectWrite> {
      return req('POST', `${mgmt}/redirects`, input);
    },
    /** Partial: fields left out keep their value; `null` clears locale or note. */
    updateRedirect(id: string, changes: Partial<RedirectInput>): Promise<RedirectWrite> {
      return req('PATCH', `${mgmt}/redirects/${encodeURIComponent(id)}`, changes);
    },
    deleteRedirect(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/redirects/${encodeURIComponent(id)}`);
    },
    /** All or nothing; `dryRun` reports what it would do. */
    importRedirects(
      input: { format: 'csv' | 'json'; data: string; dryRun?: boolean },
      signal?: AbortSignal,
    ): Promise<RedirectImportReport> {
      return req(
        'POST',
        `${mgmt}/redirects/import`,
        input,
        signal,
        input.dryRun ? CHECK_LIMIT : BATCH_LIMIT,
      );
    },
    analyzeRedirects(): Promise<RedirectSetReport & { count: number; max: number }> {
      return req('GET', `${mgmt}/redirects/analysis`);
    },
    collapseRedirectChains(): Promise<{ updated: number }> {
      return req('POST', `${mgmt}/redirects/collapse-chains`, undefined, undefined, BATCH_LIMIT);
    },
    /** What a path resolves to among the enabled redirects, or null. */
    async resolveRedirect(path: string, locale?: string): Promise<RedirectMatch | null> {
      const qs = new URLSearchParams({ path, ...(locale ? { locale } : {}) });
      try {
        return await req<RedirectMatch>('GET', `${mgmt}/redirects/resolve?${qs}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },

    // --- saved views (the space's: every environment shows the same) -----
    /** The views this person can pick for a type: their own, and the space's shared ones. */
    async listSavedViews(contentType: string): Promise<SavedView[]> {
      const qs = `?content_type=${encodeURIComponent(contentType)}`;
      return (await req<{ items: SavedView[] }>('GET', `${mgmt}/saved-views${qs}`)).items;
    },
    /** 422 naming each bad part of the query; 403 for a shared view without content:manage. */
    createSavedView(input: SavedViewInput): Promise<SavedView> {
      return req('POST', `${mgmt}/saved-views`, input);
    },
    /** With `revision`, a view saved since is a 409 rather than an overwrite. */
    updateSavedView(
      id: string,
      changes: Partial<Omit<SavedViewInput, 'contentTypeApiId'>> & { readonly revision?: number },
    ): Promise<SavedView> {
      return req('PATCH', `${mgmt}/saved-views/${encodeURIComponent(id)}`, changes);
    },
    deleteSavedView(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/saved-views/${encodeURIComponent(id)}`);
    },
    // --- settings: menus (environment-scoped) ----------------------------
    async listMenus(): Promise<MenuSummary[]> {
      return (await req<{ items: MenuSummary[] }>('GET', `${mgmt}/menus`)).items;
    },
    getMenu(id: string): Promise<Menu> {
      return req('GET', `${mgmt}/menus/${encodeURIComponent(id)}`);
    },
    /** Each item as Delivery would resolve it now, or why it is dropped. */
    previewMenu(id: string, locale?: string): Promise<MenuPreview> {
      const qs = locale ? `?${new URLSearchParams({ locale })}` : '';
      return req('GET', `${mgmt}/menus/${encodeURIComponent(id)}/preview${qs}`);
    },
    /** 409 when another menu has the handle; 422 naming each bad item. */
    createMenu(input: MenuInput): Promise<Menu> {
      return req('POST', `${mgmt}/menus`, input);
    },
    /** With `revision`, a menu saved since is a 409 rather than an overwrite. */
    updateMenu(
      id: string,
      changes: Partial<MenuInput> & { readonly revision?: number },
    ): Promise<Menu> {
      return req('PATCH', `${mgmt}/menus/${encodeURIComponent(id)}`, changes);
    },
    /** Moves an item, with everything under it, to `index` under `parentId` (null: the top). */
    moveMenuItem(
      id: string,
      move: { itemId: string; parentId: string | null; index: number; revision?: number },
    ): Promise<Menu> {
      return req('POST', `${mgmt}/menus/${encodeURIComponent(id)}/move`, move);
    },
    deleteMenu(id: string, revision?: number): Promise<void> {
      const qs = revision !== undefined ? `?revision=${revision}` : '';
      return req('DELETE', `${mgmt}/menus/${encodeURIComponent(id)}${qs}`);
    },

    // --- settings: webhooks (environment-scoped) -------------------------
    async listWebhooks(): Promise<WebhookSummary[]> {
      const r = await req<{ items: WebhookSummary[] }>('GET', `${mgmt}/webhooks`);
      return r.items;
    },
    createWebhook(input: {
      url: string;
      topics: readonly WebhookTopic[];
      secret: string;
      active?: boolean;
      /** `true`: every environment's events. Omitted: the current environment's only. */
      allEnvironments?: boolean;
    }): Promise<WebhookSummary> {
      return req('POST', `${mgmt}/webhooks`, input);
    },
    /** Partial update; omitted fields are left untouched (e.g. just toggle `active`). */
    updateWebhook(
      id: string,
      changes: {
        url?: string;
        topics?: readonly WebhookTopic[];
        secret?: string;
        active?: boolean;
        /** `true`: space-wide; `false`: scoped to the current environment; omitted: unchanged. */
        allEnvironments?: boolean;
      },
    ): Promise<WebhookSummary> {
      return req('PUT', `${mgmt}/webhooks/${encodeURIComponent(id)}`, changes);
    },
    deleteWebhook(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/webhooks/${encodeURIComponent(id)}`);
    },
    /** Recent delivery attempts for a webhook, newest first. */
    async webhookDeliveries(id: string, limit?: number): Promise<WebhookDeliveryRecord[]> {
      const qs = limit ? `?limit=${limit}` : '';
      const r = await req<{ items: WebhookDeliveryRecord[] }>(
        'GET',
        `${mgmt}/webhooks/${encodeURIComponent(id)}/deliveries${qs}`,
      );
      return r.items;
    },
    /** Queues a signed `webhook.test` event for this webhook alone. */
    sendWebhookTest(id: string): Promise<QueuedWebhookDelivery> {
      return req('POST', `${mgmt}/webhooks/${encodeURIComponent(id)}/test`);
    },
    /** Sends a stored delivery's event again, signed afresh. */
    resendWebhookDelivery(id: string, deliveryId: number): Promise<QueuedWebhookDelivery> {
      return req(
        'POST',
        `${mgmt}/webhooks/${encodeURIComponent(id)}/deliveries/${deliveryId}/resend`,
      );
    },

    // --- releases (bundled atomic publish) -------------------------------
    async listReleases(): Promise<ReleaseSummary[]> {
      const r = await req<{ items: ReleaseSummary[] }>('GET', `${mgmt}/releases`);
      return r.items;
    },
    createRelease(input: { title: string; description?: string }): Promise<Release> {
      return req('POST', `${mgmt}/releases`, input);
    },
    getRelease(id: string): Promise<ReleaseWithItems> {
      return req('GET', `${mgmt}/releases/${encodeURIComponent(id)}`);
    },
    deleteRelease(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/releases/${encodeURIComponent(id)}`);
    },
    addEntryToRelease(
      id: string,
      input: { entityId: string; action?: ReleaseItem['action'] },
    ): Promise<ReleaseWithItems> {
      return req('POST', `${mgmt}/releases/${encodeURIComponent(id)}/items`, input);
    },
    removeEntryFromRelease(id: string, entityId: string): Promise<ReleaseWithItems> {
      return req(
        'DELETE',
        `${mgmt}/releases/${encodeURIComponent(id)}/items/${encodeURIComponent(entityId)}`,
      );
    },
    /** Ships the bundle — every member publishes/unpublishes in one transaction. */
    publishRelease(id: string): Promise<ReleaseWithItems> {
      return req(
        'POST',
        `${mgmt}/releases/${encodeURIComponent(id)}/published`,
        undefined,
        undefined,
        BATCH_LIMIT,
      );
    },

    // --- scheduled actions -----------------------------------------------
    async listScheduledActions(status?: string): Promise<ScheduledAction[]> {
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      const r = await req<{ items: ScheduledAction[] }>('GET', `${mgmt}/scheduled-actions${qs}`);
      return r.items;
    },
    /** Schedules a publish/unpublish of an entry or release at a future instant. */
    scheduleAction(input: {
      action: ScheduledActionType;
      entityType: ScheduledEntityType;
      entityId: string;
      scheduledFor: string;
    }): Promise<ScheduledAction> {
      return req('POST', `${mgmt}/scheduled-actions`, input);
    },
    cancelScheduledAction(id: string): Promise<ScheduledAction> {
      return req('DELETE', `${mgmt}/scheduled-actions/${encodeURIComponent(id)}`);
    },

    // --- comments (threaded, on entries) ---------------------------------
    async listComments(entryId: string): Promise<Comment[]> {
      const r = await req<{ items: Comment[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/comments`,
      );
      return r.items;
    },
    addComment(
      entryId: string,
      input: { body: string; parentId?: string | null; author?: string },
    ): Promise<Comment> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(entryId)}/comments`, input);
    },
    deleteComment(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/comments/${encodeURIComponent(id)}`);
    },

    // --- tasks (on entries) ----------------------------------------------
    async listTasks(entryId: string): Promise<Task[]> {
      const r = await req<{ items: Task[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/tasks`,
      );
      return r.items;
    },
    createTask(entryId: string, input: { body: string; assignee?: string }): Promise<Task> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(entryId)}/tasks`, input);
    },
    /** One change per call: status ('resolved'|'open') or reassignment. */
    updateTask(
      id: string,
      change: { status: 'resolved' | 'open' } | { assignee: string | null },
    ): Promise<Task> {
      return req('PUT', `${mgmt}/tasks/${encodeURIComponent(id)}`, change);
    },
    deleteTask(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/tasks/${encodeURIComponent(id)}`);
    },

    // --- workflows (configurable editorial steps) ------------------------
    async listWorkflows(): Promise<WorkflowDefinition[]> {
      const r = await req<{ items: WorkflowDefinition[] }>('GET', `${mgmt}/workflows`);
      return r.items;
    },
    defineWorkflow(input: { name: string; steps: WorkflowStep[] }): Promise<WorkflowDefinition> {
      return req('POST', `${mgmt}/workflows`, input);
    },
    deleteWorkflow(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/workflows/${encodeURIComponent(id)}`);
    },
    /** The same list as `listWorkflows`, typed as the graph summaries the route returns. */
    async listWorkflowGraphs(): Promise<WorkflowListItem[]> {
      const r = await req<{ items: WorkflowListItem[] }>('GET', `${mgmt}/workflows`);
      return r.items;
    },
    /** Creates an unpublished graph workflow; drafts may be incomplete (see `validation`). */
    createWorkflowDraft(
      input: WorkflowDraftInput & { name: string },
    ): Promise<{ workflow: WorkflowSummary; validation: WorkflowGraphValidation }> {
      return req('POST', `${mgmt}/workflows`, input);
    },
    getWorkflow(id: string): Promise<WorkflowSummary> {
      return req('GET', `${mgmt}/workflows/${encodeURIComponent(id)}`);
    },
    /** Saves the draft; omitted fields keep their value. Never touches published versions. */
    saveWorkflowDraft(
      id: string,
      input: WorkflowDraftInput,
    ): Promise<{ workflow: WorkflowSummary; validation: WorkflowGraphValidation }> {
      return req('PUT', `${mgmt}/workflows/${encodeURIComponent(id)}/draft`, input);
    },
    /** Publishes the draft as the next immutable version (refused while it has errors). */
    publishWorkflowVersion(id: string): Promise<WorkflowVersion> {
      return req('POST', `${mgmt}/workflows/${encodeURIComponent(id)}/versions`);
    },
    async listWorkflowVersions(id: string): Promise<WorkflowVersion[]> {
      const r = await req<{ items: WorkflowVersion[] }>(
        'GET',
        `${mgmt}/workflows/${encodeURIComponent(id)}/versions`,
      );
      return r.items;
    },
    getWorkflowVersion(id: string, version: number): Promise<WorkflowVersion> {
      return req('GET', `${mgmt}/workflows/${encodeURIComponent(id)}/versions/${version}`);
    },
    validateWorkflowGraph(graph: WorkflowGraph): Promise<WorkflowGraphValidation> {
      return req('POST', `${mgmt}/workflows/validate`, { graph }, undefined, CHECK_LIMIT);
    },
    /** Proposes a graph from a prompt (editing `graph` when given). Never saves. */
    workflowCopilot(
      input: { prompt: string; graph?: WorkflowGraph; contentTypes?: readonly string[] },
      signal?: AbortSignal,
    ): Promise<WorkflowCopilotProposal> {
      return req('POST', `${mgmt}/workflows/copilot`, input, signal, MODEL_READ_LIMIT);
    },

    // --- workflow runs and tasks -------------------------------------------
    startWorkflowRun(
      entryId: string,
      input: {
        workflowId: string;
        version?: number;
        input?: Record<string, unknown>;
        vars?: Record<string, unknown>;
      },
    ): Promise<WorkflowRunView> {
      return req('POST', `${mgmt}/entries/${encodeURIComponent(entryId)}/workflow-runs`, input);
    },
    async listWorkflowRuns(filter: WorkflowRunFilter = {}): Promise<WorkflowRunView[]> {
      const r = await req<{ items: WorkflowRunView[] }>(
        'GET',
        `${mgmt}/workflow-runs${queryString(filter)}`,
      );
      return r.items;
    },
    getWorkflowRun(id: string): Promise<WorkflowRunView> {
      return req('GET', `${mgmt}/workflow-runs/${encodeURIComponent(id)}`);
    },
    async getWorkflowRunTimeline(id: string): Promise<WorkflowTimelineRecord[]> {
      const r = await req<{ items: WorkflowTimelineRecord[] }>(
        'GET',
        `${mgmt}/workflow-runs/${encodeURIComponent(id)}/timeline`,
      );
      return r.items;
    },
    async listWorkflowNodeRuns(id: string): Promise<WorkflowNodeRunRecord[]> {
      const r = await req<{ items: WorkflowNodeRunRecord[] }>(
        'GET',
        `${mgmt}/workflow-runs/${encodeURIComponent(id)}/node-runs`,
      );
      return r.items;
    },
    cancelWorkflowRun(
      id: string,
      reason?: string,
    ): Promise<{ ok: boolean; undone: readonly string[] }> {
      return req(
        'POST',
        `${mgmt}/workflow-runs/${encodeURIComponent(id)}/cancel`,
        reason ? { reason } : {},
      );
    },
    deliverWorkflowEvent(
      runId: string,
      event: string,
      payload?: Record<string, unknown>,
    ): Promise<{ delivered: boolean; buffered?: boolean; nodeId?: string }> {
      return req('POST', `${mgmt}/workflow-runs/${encodeURIComponent(runId)}/events`, {
        event,
        ...(payload ? { payload } : {}),
      });
    },
    async listWorkflowTasks(filter: WorkflowTaskFilter = {}): Promise<WorkflowTask[]> {
      const r = await req<{ items: WorkflowTask[] }>(
        'GET',
        `${mgmt}/workflow-tasks${queryString(filter)}`,
      );
      return r.items;
    },
    getWorkflowTask(id: string): Promise<WorkflowTask> {
      return req('GET', `${mgmt}/workflow-tasks/${encodeURIComponent(id)}`);
    },
    decideWorkflowTask(
      id: string,
      input: { decision: 'approved' | 'rejected'; note?: string },
    ): Promise<{ taskId: string; runId: string; decision: 'approved' | 'rejected'; by: string }> {
      return req('POST', `${mgmt}/workflow-tasks/${encodeURIComponent(id)}/decide`, input);
    },
    /** What waits in Approvals, uncapped and limited to what this caller may read. */
    countPendingApprovals(): Promise<{
      workflowTasks: number;
      agentReviews: number;
      total: number;
    }> {
      return req('GET', `${mgmt}/approvals/count`);
    },
    // --- agent reviews (human-in-the-loop decisions on agent proposals) ----
    /** Agent proposals, oldest first as the API returns them; `status` narrows. */
    async listAgentReviews(
      filter: { status?: AgentReviewStatus; entryId?: string } = {},
    ): Promise<AgentReview[]> {
      const r = await req<{ items: AgentReview[] }>(
        'GET',
        `${mgmt}/agent-reviews${queryString(filter)}`,
      );
      return r.items;
    },
    /** Applies the proposal as a new draft version. */
    approveAgentReview(id: string): Promise<AgentReview> {
      return req('POST', `${mgmt}/agent-reviews/${encodeURIComponent(id)}/approve`);
    },
    rejectAgentReview(id: string): Promise<AgentReview> {
      return req('POST', `${mgmt}/agent-reviews/${encodeURIComponent(id)}/reject`);
    },
    getWorkflowSettings(): Promise<{ separateDuties: boolean }> {
      return req('GET', `${mgmt}/workflow-settings`);
    },
    setWorkflowSettings(input: { separateDuties: boolean }): Promise<{ separateDuties: boolean }> {
      return req('PUT', `${mgmt}/workflow-settings`, input);
    },
    getTrashSettings(): Promise<TrashSettings> {
      return req('GET', `${mgmt}/trash-settings`);
    },
    /** Sets how long trashed entries are kept before the hourly sweep deletes them (space:admin). */
    setTrashSettings(input: TrashSettings): Promise<TrashSettings> {
      return req('PUT', `${mgmt}/trash-settings`, input);
    },

    /** The entry's current workflow step, or null if it hasn't entered one. */
    getEntryWorkflowState(entryId: string): Promise<EntryWorkflowState | null> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(entryId)}/workflow`);
    },
    /** Moves the entry into a step; the backend enforces the step's required scope. */
    transitionEntry(
      entryId: string,
      input: { workflowId: string; toStepId: string },
    ): Promise<EntryWorkflowState> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/workflow/transition`,
        input,
      );
    },

    // --- taxonomy: concept schemes ---------------------------------------
    async listSchemes(): Promise<ConceptScheme[]> {
      const r = await req<{ items: ConceptScheme[] }>('GET', `${mgmt}/taxonomy/schemes`);
      return r.items;
    },
    createScheme(input: { name: string }): Promise<ConceptScheme> {
      return req('POST', `${mgmt}/taxonomy/schemes`, input);
    },
    deleteScheme(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/taxonomy/schemes/${encodeURIComponent(id)}`);
    },

    // --- taxonomy: concepts (hierarchical) -------------------------------
    /** Concepts with their published usage (how many published entries carry each). */
    async listConcepts(schemeId?: string): Promise<WithUsage<Concept>[]> {
      const qs = schemeId ? `?scheme=${encodeURIComponent(schemeId)}` : '';
      const r = await req<{ items: WithUsage<Concept>[] }>('GET', `${mgmt}/taxonomy/concepts${qs}`);
      return r.items;
    },
    createConcept(
      input: { schemeId: string; prefLabel: string; broaderId?: string | null } & TermFields,
    ): Promise<Concept> {
      return req('POST', `${mgmt}/taxonomy/concepts`, input);
    },
    /** Only the keys sent change; the slug stays when the label changes. */
    updateConcept(id: string, input: { prefLabel?: string } & TermFields): Promise<Concept> {
      return req('PATCH', `${mgmt}/taxonomy/concepts/${encodeURIComponent(id)}`, input);
    },
    setConceptBroader(id: string, broaderId: string | null): Promise<Concept> {
      return req('PUT', `${mgmt}/taxonomy/concepts/${encodeURIComponent(id)}/broader`, {
        broaderId,
      });
    },
    deleteConcept(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/taxonomy/concepts/${encodeURIComponent(id)}`);
    },

    // --- taxonomy: tags --------------------------------------------------
    /** Tags with their published usage (how many published entries carry each). */
    async listTags(): Promise<WithUsage<Tag>[]> {
      const r = await req<{ items: WithUsage<Tag>[] }>('GET', `${mgmt}/taxonomy/tags`);
      return r.items;
    },
    createTag(input: { name: string } & TermFields): Promise<Tag> {
      return req('POST', `${mgmt}/taxonomy/tags`, input);
    },
    /** Only the keys sent change; the slug stays when the name changes. */
    updateTag(id: string, input: { name?: string } & TermFields): Promise<Tag> {
      return req('PATCH', `${mgmt}/taxonomy/tags/${encodeURIComponent(id)}`, input);
    },
    deleteTag(id: string): Promise<void> {
      return req('DELETE', `${mgmt}/taxonomy/tags/${encodeURIComponent(id)}`);
    },

    // --- entry taxonomy associations -------------------------------------
    getEntryMetadata(entryId: string): Promise<EntryMetadata> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(entryId)}/metadata`);
    },
    setEntryMetadata(
      entryId: string,
      input: { tags?: readonly string[]; concepts?: readonly string[] },
    ): Promise<EntryMetadata> {
      return req('PUT', `${mgmt}/entries/${encodeURIComponent(entryId)}/metadata`, input);
    },

    // --- entry version history -------------------------------------------
    async listVersions(entryId: string): Promise<EntryVersion[]> {
      const r = await req<{ items: EntryVersion[] }>(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/versions`,
      );
      return r.items;
    },
    getVersion(entryId: string, version: number): Promise<EntryVersion> {
      return req('GET', `${mgmt}/entries/${encodeURIComponent(entryId)}/versions/${version}`);
    },
    diffVersions(entryId: string, from: VersionRef, to: VersionRef): Promise<VersionDiff> {
      return req(
        'GET',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/versions/diff?from=${from}&to=${to}`,
      );
    },
    /** Copies an older version's fields into a new draft version. */
    restoreVersion(entryId: string, version: number): Promise<EntryView> {
      return req(
        'POST',
        `${mgmt}/entries/${encodeURIComponent(entryId)}/versions/${version}/restore`,
      );
    },
  };
}

export type ManagementClient = ReturnType<typeof createManagementClient>;
