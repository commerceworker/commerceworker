/**
 * @commerceworker/sdk-management — the framework-agnostic Management (CMA) client for
 * programmatic authoring: content types, entries, assets, releases, webhooks,
 * and space administration. Zero runtime dependencies; uses the platform
 * `fetch` (injectable for SSR, edge runtimes, and tests). Talks to the
 * Management API with a CMA key or admin token — the server enforces RBAC
 * scopes per operation, so a client is only as powerful as its token.
 */

import { bookmarkTracker } from './bookmark.js';
import { type AssetLink, ManagementError } from './errors.js';
import {
  inPool,
  SINGLE_UPLOAD_MAX_BYTES,
  sizeOf,
  sliceOf,
  type UploadBody,
  type UploadOptions,
  withRetry,
} from './upload.js';

export {
  type ApiError,
  type AssetInUse,
  type AssetLink,
  type AssetRightsRefusal,
  type AssetUsage,
  type FieldIssue,
  isAssetInUse,
  isAssetRightsError,
  isConflict,
  isNotFound,
  isRateLimited,
  isValidationError,
  ManagementError,
  type ManagementErrorWith,
  type RateLimited,
  type ValidationFailed,
} from './errors.js';
export {
  SINGLE_UPLOAD_MAX_BYTES,
  type UploadBody,
  type UploadOptions,
  type UploadProgress,
} from './upload.js';

/** Locale-keyed values, e.g. `{ 'en-US': 'Hello' }`. */
export type LocalizedValue = Readonly<Record<string, unknown>>;

/** Entry field values: field apiId → locale → value. */
export type EntryFields = Readonly<Record<string, LocalizedValue>>;

export type EntryStatus = 'draft' | 'changed' | 'published' | 'archived';
/** A version of an entry: its number, or its current draft or published version. */
export type VersionRef = number | 'draft' | 'published';
export type ContentTypeStatus = 'draft' | 'published';
export type AssetStatus = 'draft' | 'published' | 'archived';
export type ReleaseStatus = 'open' | 'published' | 'archived';
export type ScheduledActionType = 'publish' | 'unpublish';
export type ScheduledEntityType = 'Entry' | 'Release';
export type ScheduledActionStatus = 'pending' | 'completed' | 'canceled' | 'failed';
export type ApiKeyKind = 'cma' | 'cda' | 'cpa';

/** An allowed value of an `in` rule: bare, or with the label an editor picks it by. */
export type FieldOption =
  | string
  | number
  | { readonly value: string | number; readonly label: string };

/** A field's validation rules. Entries store and are compared on an option's `value`. */
/** A named pattern a Symbol or Text field can use instead of writing a regular expression. */
export type PatternPreset = 'email' | 'url' | 'slug' | 'phone' | 'hexColor' | 'usZipCode';

/** How a Date field's value is written: `2026-11-03`, `2026-11-03T14:30` or `14:30`. */
export type DateFormat = 'date' | 'datetime' | 'time';

export interface FieldValidations {
  readonly in?: readonly FieldOption[];
  /** A pattern, or a named `preset` (saved with its pattern and flags filled in). */
  readonly regexp?: {
    readonly pattern?: string;
    readonly flags?: string;
    readonly preset?: PatternPreset;
  };
  readonly range?: { readonly min?: number; readonly max?: number };
  readonly size?: { readonly min?: number; readonly max?: number };
  readonly linkContentTypes?: readonly string[];
  /** A Date's inclusive bounds, written in its format. */
  readonly dateRange?: { readonly min?: string; readonly max?: string };
  /** An asset link's allowed MIME types, exact or by family (`image/*`). */
  readonly assetMimeTypes?: readonly string[];
  /** The error text a broken rule reports instead of the default, keyed by rule. */
  readonly messages?: {
    readonly in?: string;
    readonly regexp?: string;
    readonly range?: string;
    readonly size?: string;
    readonly dateRange?: string;
    readonly assetMimeTypes?: string;
  };
}

/**
 * Hide or disable a field while a sibling's value matches. A hidden field is not required; a
 * disabled one keeps its stored value, and a write that changes it is refused.
 */
export interface FieldRule {
  readonly action: 'hide' | 'disable';
  readonly when: {
    /** A sibling field's apiId, or a dot path into a sibling component (`hero.style`). */
    readonly field: string;
    readonly operator: 'eq' | 'ne' | 'in' | 'empty' | 'notEmpty' | 'gt' | 'lt';
    readonly value?: string | number | boolean | readonly (string | number)[];
  };
}

export interface FieldDefinition {
  readonly apiId: string;
  readonly name: string;
  readonly type: string;
  readonly localized?: boolean;
  readonly required?: boolean;
  /** How to fill the field: shown under the editor's input and given to a model. */
  readonly help?: string;
  /** An example shown in the empty input. */
  readonly placeholder?: string;
  /** What the field means, for agents and API readers. */
  readonly description?: string;
  readonly validations?: FieldValidations;
  readonly rules?: readonly FieldRule[];
  /** For a Date field. */
  readonly format?: DateFormat;
  readonly [key: string]: unknown;
}

export interface ContentType {
  readonly apiId: string;
  readonly name: string;
  readonly displayField: string;
  readonly fields: readonly FieldDefinition[];
  /** Where its entries live on the site, e.g. `/blog/{slug}`. */
  readonly urlPattern?: string;
  /** Holds at most one entry, read by type with the delivery client's `getSingleton`. */
  readonly singleton?: true;
  /** The admin's sidebar lists types under their group. */
  readonly group?: string;
  readonly description?: string;
  /** A kebab-case icon name the admin draws beside the type. */
  readonly icon?: string;
  /** How an agent should write this type's entries. Plain text, never delivered. */
  readonly agentInstructions?: string;
  /** Editor-only: how the admin's entry form arranges the fields. Never delivered. */
  readonly layout?: ContentTypeLayout;
  /** Editor-only: where the admin previews entries on your frontend. Never delivered. */
  readonly preview?: ContentTypePreview;
  readonly version: number;
  readonly status: ContentTypeStatus;
}

/**
 * A type's preview URL template: an https URL (http to localhost only on a local stack) with a fixed
 * host, e.g. `https://site.example/__preview?entry={id}#token={token}`. Placeholders, each filled
 * URL-encoded: `{id}`, `{token}` (required), `{locale}`, `{space}`, `{environment}` and
 * `{field:<apiId>}` (a Symbol, Slug, Integer, Number or Date field).
 */
export interface ContentTypePreview {
  readonly urlTemplate: string;
}

/** A minted preview link: the token reads one entry, drafts included, until `expiresAt`. */
export interface PreviewLink {
  /** The entry on the Preview API. */
  readonly url: string;
  /** The entry on your frontend, from its type's preview template; absent without one. */
  readonly frontendUrl?: string;
  /** Shown once. */
  readonly token: string;
  readonly expiresAt: string;
}

/** The entry form's tabs, each of named or unnamed groups of top-level field apiIds. */
export interface ContentTypeLayout {
  readonly tabs: readonly {
    readonly apiId: string;
    readonly name: string;
    readonly groups: readonly {
      readonly name?: string;
      readonly fields: readonly string[];
      readonly collapsed?: boolean;
    }[];
  }[];
}

/** What waits on a human decision in the environment (`GET …/approvals/count`). */
export interface PendingApprovalsCount {
  /** Workflow steps paused for a person (approvals, reviews, event waits). */
  readonly workflowTasks: number;
  /** Agent proposals awaiting review. */
  readonly agentReviews: number;
  readonly total: number;
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

/** One distinct value of a field and how many entries (not in the trash) hold it. */
export interface FieldValueCount {
  readonly value: string | number | boolean;
  readonly count: number;
}

/** A page of a field's distinct values; `nextCursor` is absent on the last page. */
export interface FieldValuesPage {
  readonly items: readonly FieldValueCount[];
  readonly nextCursor?: string;
}

/** What still depends on a content type (`contentTypes.dependents`). */
export interface ContentTypeDependents {
  readonly contentType: string;
  readonly entries: { readonly live: number; readonly trashed: number };
  /** Other types' fields whose links are restricted to it; `field` is a path. */
  readonly linkedFrom: readonly { readonly contentType: string; readonly field: string }[];
  readonly menus: readonly { readonly id: string; readonly handle: string }[];
  readonly redirects: readonly { readonly id: string; readonly source: string }[];
  readonly urlPattern?: string;
}

/** What `contentTypes.delete` did: the type is gone, or a job is deleting its entries first. */
export type ContentTypeDeletion =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly job: BulkJob };

export interface ContentTypeDraft {
  readonly apiId: string;
  readonly name: string;
  readonly displayField: string;
  readonly fields: readonly FieldDefinition[];
  /**
   * Where its entries live on the site: `{id}`, `{locale}` or a Slug field's apiId, e.g.
   * `/blog/{slug}`. A publish that changes that slug redirects the old path to the new one.
   * `null` clears it.
   */
  readonly urlPattern?: string | null;
  /**
   * Holds at most one entry (site settings, a home page): a second is refused, and Delivery
   * serves the one at `GET …/singletons/:apiId`. Turning it on is refused while the type has more
   * than one entry. Left out of a revision, unchanged.
   */
  readonly singleton?: boolean;
  /** Each of these: left out keeps it on a revision; `null` clears it. */
  readonly group?: string | null;
  readonly description?: string | null;
  readonly icon?: string | null;
  readonly agentInstructions?: string | null;
  readonly layout?: ContentTypeLayout | null;
  readonly preview?: ContentTypePreview | null;
}

/** A redirect: a front end (or an edge Worker) applies it; commerceworker serves no site. */
export interface Redirect {
  readonly id: string;
  /** A path: exact, or a pattern of `[param]` segments and a trailing `[...splat]`. */
  readonly source: string;
  /** A path or an https URL; `[param]`/`[...splat]` insert what the source captured. */
  readonly destination: string;
  readonly status: 301 | 302 | 307 | 308;
  readonly locale?: string;
  readonly enabled: boolean;
  readonly note?: string;
  /** Written by someone, imported, or made by a publish that changed a slug. */
  readonly origin: 'manual' | 'import' | 'slug';
  readonly entryId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RedirectInput {
  readonly source: string;
  readonly destination: string;
  /** Default 301. */
  readonly status?: 301 | 302 | 307 | 308;
  /** One locale only; `null` (or absent) for every locale. */
  readonly locale?: string | null;
  readonly enabled?: boolean;
  readonly note?: string | null;
}

/** A redirect whose destination is redirected again, and where its chain ends. */
export interface RedirectChain {
  readonly id: string;
  readonly via: readonly string[];
  readonly destination: string;
}

export interface RedirectWrite {
  readonly redirect: Redirect;
  /** Chains it takes part in: allowed, one hop slower; `collapseChains` straightens them. */
  readonly chains: readonly RedirectChain[];
}

/** Where a menu item points: an entry (by its type's URL pattern), a taxonomy term, or a URL. */
export type MenuLink =
  | { readonly type: 'entry'; readonly entryId: string }
  | { readonly type: 'term'; readonly termKind: 'tag' | 'concept'; readonly termId: string }
  | { readonly type: 'url'; readonly url: string };

export interface MenuItem {
  readonly id: string;
  /** Required for a URL link; absent, the entry's display field or the term's label. */
  readonly label?: string;
  readonly link: MenuLink;
  readonly target?: '_blank';
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children: readonly MenuItem[];
}

/** An item to write: an id given is kept (a move names it), one left out is made. */
export interface MenuItemInput {
  readonly id?: string;
  readonly label?: string | null;
  readonly link: MenuLink;
  readonly target?: '_self' | '_blank' | null;
  readonly attrs?: Readonly<Record<string, string>> | null;
  readonly children?: readonly MenuItemInput[];
}

/** A navigation menu: a named tree of links, served resolved by Delivery. */
export interface Menu {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
  readonly items: readonly MenuItem[];
  /** Send it back with a change to be refused (409) rather than overwrite a save made since. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MenuSummary {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
  readonly itemCount: number;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface MenuInput {
  readonly handle: string;
  readonly name: string;
  readonly description?: string | null;
  readonly items?: readonly MenuItemInput[];
}

/** A menu item as Delivery would resolve it now, or why it would be dropped. */
export interface MenuItemPreview {
  readonly id: string;
  readonly link: MenuLink;
  readonly label: string;
  readonly url: string | null;
  /** `hidden`: content the caller's grants don't let them read. */
  readonly status: 'live' | 'unpublished' | 'missing' | 'no_url' | 'hidden';
  readonly children: readonly MenuItemPreview[];
}

/** A menu item resolved as Delivery serves it (sdk-core's `DeliveredMenuItem`). */
export interface ResolvedMenuItem {
  readonly id: string;
  readonly label: string;
  /** null for a term link: route a term by its slug. */
  readonly url: string | null;
  readonly target?: '_blank';
  readonly attrs?: Readonly<Record<string, string>>;
  readonly entry?: { readonly id: string; readonly contentType: string };
  readonly term?: {
    readonly kind: 'tag' | 'concept';
    readonly id: string;
    readonly slug: string;
    readonly schemeId?: string;
  };
  readonly children: readonly ResolvedMenuItem[];
}

export interface ResolvedMenu {
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
  readonly locale: string;
  readonly items: readonly ResolvedMenuItem[];
}

/**
 * Who wrote an entry and when (`sys.createdBy` and the rest in a query). An actor is a person's id,
 * `admin-token`, an API key's kind, or `agent:<name>`, `workflow:<id>`, `plugin:<id>` or `system`.
 * Null when unknown: an entry from before authorship was recorded, or one never published.
 */
export interface EntryAuthorship {
  readonly createdAt: string | null;
  readonly createdBy: string | null;
  /** Who made the last change, the one `updatedAt` records. */
  readonly updatedBy: string | null;
  /** Kept through unpublish and republish. */
  readonly firstPublishedAt: string | null;
}

/** One predicate of a saved view's query, as an entries query takes it. */
export interface SavedViewFilter {
  /** A field apiId, a component path (`seo.title`) or a `sys.*` field. */
  readonly field: string;
  /** `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `between`, `exists`, `match`, … */
  readonly op: string;
  readonly value?: unknown;
}

/** AND and OR groups of predicates, nestable (at most 4 deep, 20 predicates). */
export type SavedViewWhere =
  | SavedViewFilter
  | { readonly and: readonly SavedViewWhere[] }
  | { readonly or: readonly SavedViewWhere[] };

/** A saved view's structured query: never a query string. */
export interface SavedViewQuery {
  readonly filters?: readonly SavedViewFilter[];
  readonly where?: SavedViewWhere;
  readonly order?: readonly { readonly field: string; readonly direction: 'asc' | 'desc' }[];
  readonly search?: string;
  /** Query keys kept verbatim that this server doesn't apply (a run lists them in `ignored`). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** A named entries query and the columns to show, personal or shared with the space. */
export interface SavedView {
  readonly id: string;
  readonly name: string;
  /** null: the entries of every type. */
  readonly contentTypeApiId: string | null;
  readonly visibility: 'personal' | 'shared';
  /** Who created it; left out for a key that isn't served author ids. */
  readonly createdBy?: string;
  readonly query: SavedViewQuery;
  /** Columns besides the display field; absent is `sys.status`, `sys.updatedAt`. */
  readonly columns?: readonly string[];
  /** Send it back with a change to be refused (409) rather than overwrite a save made since. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SavedViewInput {
  readonly name: string;
  readonly contentTypeApiId?: string | null;
  /** Default `personal`; `shared` needs content:manage. */
  readonly visibility?: 'personal' | 'shared';
  readonly query?: SavedViewQuery;
  readonly columns?: readonly string[] | null;
}

/** One page of a saved view's entries, run with the caller's own grants. */
export interface SavedViewRun {
  readonly view: Pick<SavedView, 'id' | 'name' | 'contentTypeApiId' | 'revision' | 'columns'>;
  readonly items: readonly PreviewEntry[];
  readonly total: number;
  readonly nextCursor?: string;
  /** `query.extra` keys this server didn't apply. */
  readonly ignored?: readonly string[];
  /** The view's content type isn't in this environment: the page is empty for that reason. */
  readonly typeMissing?: true;
}

export interface Entry extends EntryAuthorship {
  readonly id: string;
  readonly contentTypeApiId: string;
  readonly status: EntryStatus;
  readonly currentVersion: number;
  readonly publishedVersion: number | null;
}

/** An entry plus its current draft field values. */
/** Holds a publish, unpublish or version restore to the `currentVersion` the caller read. */
export interface Held {
  readonly expectedVersion?: number;
}

const held = (opts?: Held) =>
  opts?.expectedVersion === undefined ? '' : `?expectedVersion=${opts.expectedVersion}`;

export interface EntryView {
  readonly entry: Entry;
  readonly fields: EntryFields;
}

/**
 * A change to one locale of an entry's SEO metadata (its type's `Seo` field): a part left out keeps
 * its value, `null` clears it.
 */
export interface EntrySeoChange {
  /** The locale to change; the default locale when left out (only a localized Seo field takes another). */
  readonly locale?: string;
  readonly title?: string | null;
  readonly description?: string | null;
  /** Where the canonical copy lives when not here: a site path or an absolute http(s) URL. */
  readonly canonicalUrl?: string | null;
  /** Keep the page out of search results and the sitemap. */
  readonly noindex?: boolean | null;
  /** The social sharing image. */
  readonly ogImage?: { readonly id: string; readonly linkType: 'Asset' } | null;
}

/** Where a block goes: a parent block's slot (absent: the field itself) and a place in it. */
export interface BlockPlace {
  readonly parent?: { readonly key: string; readonly slot: string };
  readonly before?: string;
  readonly after?: string;
  readonly index?: number;
}

/**
 * One key-addressed op on a blocks field. `key` (and `parent.key`, `before`, `after`) is a block's
 * `_key`, or the `ref` an earlier op in the same patch gave a new block. `locale` defaults to the
 * space's default locale.
 */
export type BlockOp = { readonly field: string; readonly locale?: string } & (
  | ({
      readonly op: 'insert';
      readonly block: { readonly _type: string; readonly [field: string]: unknown };
      readonly ref?: string;
    } & BlockPlace)
  | {
      readonly op: 'update';
      readonly key: string;
      readonly set?: Readonly<Record<string, unknown>>;
      readonly unset?: readonly string[];
    }
  | { readonly op: 'move'; readonly key: string; readonly to: BlockPlace }
  | { readonly op: 'remove'; readonly key: string }
  | { readonly op: 'duplicate'; readonly key: string; readonly ref?: string }
);

/** What a block patch saved: the new draft, the key each ref was given and the ops that undo it. */
export interface BlockPatchResult extends EntryView {
  readonly keys: Readonly<Record<string, string>>;
  /** Null when a server plugin rewrote the blocks the patch wrote: no undo is offered then. */
  readonly inverse: readonly BlockOp[] | null;
}

/** A block patch's dry run (`entries.checkBlocks`): what the save would store, nothing written. */
export interface BlockPatchCheck {
  readonly valid: true;
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  /** The patch as it would apply: refs, positions and locales resolved, every key present. */
  readonly applied: readonly BlockOp[];
  /** The key each `ref` would be given, minted for this answer only. */
  readonly keys: Readonly<Record<string, string>>;
  readonly skippedHooks: readonly string[];
}

/** One block in an entry's outline (`entries.outlineBlocks`). */
export interface BlockOutline {
  readonly key: string | null;
  readonly type: string;
  readonly name: string;
  readonly label?: string;
  /** Where it sits, as validation issues name it: `body[2].items[0]`. */
  readonly path: string;
  /** Another block in the field holds the same key, so ops can't address it. */
  readonly ambiguous?: true;
  readonly children?: Readonly<Record<string, readonly BlockOutline[]>>;
}

export interface BlocksOutline {
  readonly entryId: string;
  /** The version outlined: pass it as `expectedVersion`. */
  readonly version: number;
  /** Blocks field → locale → its blocks. */
  readonly fields: Readonly<Record<string, Readonly<Record<string, readonly BlockOutline[]>>>>;
}

export interface EntryVersion {
  readonly entryId: string;
  readonly version: number;
  readonly fields: EntryFields;
  /** When this version was saved (ISO-8601). */
  readonly createdAt?: string;
}

export type AssetKind = 'image' | 'video' | 'audio' | 'document' | 'other';

/** What a reader shows while a raster image loads; ingest computes it from the pixels. */
export interface AssetPlaceholder {
  /** The image's ThumbHash, base64: decode it on the client to a blurred preview. */
  readonly thumbhash: string;
  /** The image's dominant colour, `#rrggbb`. */
  readonly dominantColor: string;
}

export type AssetVideoStatus = 'pending' | 'processing' | 'ready' | 'error';

/** A video hosted by the video service: it plays as adaptive streaming, not from `file.url`. */
export interface AssetVideo {
  /** The host that owns the bytes, e.g. `stream`. */
  readonly provider: string;
  /** The host's id for the video. */
  readonly videoId: string;
  readonly status: AssetVideoStatus;
  readonly hlsUrl?: string;
  readonly dashUrl?: string;
  /** Poster frame. */
  readonly thumbnailUrl?: string;
  readonly durationSeconds?: number;
  /** Why processing failed, while `status` is `error`. */
  readonly errorReason?: string;
}

/** The stored file. On a Management read, `url` is a short-lived signed read URL. */
export interface AssetFile {
  readonly url: string;
  readonly fileName: string;
  /** MIME type. */
  readonly contentType: string;
  readonly size?: number;
  readonly width?: number;
  readonly height?: number;
  /** Absent until ingest has computed one. */
  readonly placeholder?: AssetPlaceholder;
  /** Present on a hosted video. */
  readonly video?: AssetVideo;
}

/** 0..1 on each axis: crops are anchored here. */
export interface FocalPoint {
  readonly x: number;
  readonly y: number;
}

/** An asset's editorial metadata. */
export interface AssetMetadata {
  /** Alt text per locale. */
  readonly altText: LocalizedValue;
  /** Taxonomy tag ids. */
  readonly tags: readonly string[];
  readonly focalPoint?: FocalPoint;
  /** Free-form custom values. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** A metadata change (`assets.setMetadata`): only the keys sent change. */
export interface AssetMetadataPatch {
  /** Alt text per locale (the whole map). */
  readonly altText?: Readonly<Record<string, string>>;
  /** Tag ids (the whole set). */
  readonly tags?: readonly string[];
  readonly focalPoint?: FocalPoint;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export type AssetIngestStatus = 'pending' | 'processing' | 'ready' | 'error';

/** What ingest filled from a model that no person has saved yet. */
export interface AssetAiSuggestions {
  /** Locales whose alt text a model wrote. */
  readonly altText?: readonly string[];
  /** Tag ids a model chose. */
  readonly tags?: readonly string[];
}

export interface Asset {
  readonly id: string;
  readonly status: AssetStatus;
  readonly file: AssetFile;
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly metadata: AssetMetadata;
  /** The folder it is filed in; absent at the library root. */
  readonly folderId?: string;
  /** Starts at 1 and goes up each time the file is replaced. */
  readonly version?: number;
  readonly createdAt?: string;
  readonly createdBy?: string;
  /** Present only while `status` is `archived`. */
  readonly archivedAt?: string;
  readonly rights?: AssetRights;
  /** SHA-256 of the bytes (hex), once ingested. */
  readonly contentHash?: string;
  /** Where ingest stands on the current file; absent when it never ran. */
  readonly ingestStatus?: AssetIngestStatus;
  /** Why the last ingest failed. */
  readonly ingestError?: string;
  /** The oldest other asset here with the same bytes. */
  readonly duplicateOf?: string;
  readonly aiSuggestions?: AssetAiSuggestions;
}

/** An asset search (`assets.search`): text, and filters that narrow it. */
export interface AssetSearchQuery {
  readonly q: string;
  /** 1..100, default 20. */
  readonly limit?: number;
  readonly kind?: AssetKind;
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder. */
  readonly folder?: string;
  readonly status?: AssetStatus | 'all';
}

/** Matches per value of each facet (each counted without its own filter). */
export interface AssetFacets {
  readonly kind: Readonly<Record<string, number>>;
  readonly tag: Readonly<Record<string, number>>;
  /** By folder id; `root` for assets in no folder. */
  readonly folder: Readonly<Record<string, number>>;
}

export interface AssetSearchPage {
  /** Best match first. */
  readonly items: Asset[];
  readonly total: number;
  readonly facets: AssetFacets;
}

/** What `assets.list` keeps and how it orders them. */
export interface AssetListQuery {
  readonly limit?: number;
  /** `nextCursor` from the previous page. */
  readonly cursor?: string;
  readonly kind?: AssetKind;
  /** An exact content type (`image/png`) or a family (`image/*`). */
  readonly mime?: string;
  /** A taxonomy tag id. */
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder. */
  readonly folder?: string;
  /** Omitted hides archived assets; `all` includes them. */
  readonly status?: AssetStatus | 'all';
  readonly sort?: 'updatedAt' | 'createdAt' | 'size';
  readonly order?: 'asc' | 'desc';
}

/** What `assets.collections.assets` keeps; members come in the collection's order. */
export type CollectionAssetQuery = Omit<AssetListQuery, 'folder' | 'sort' | 'order'>;

export interface AssetPage {
  readonly items: Asset[];
  /** Present when there may be more: pass it as `cursor`. */
  readonly nextCursor?: string;
}

export interface AssetFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  /** Materialized path of folder ids, e.g. `/a/b/`. */
  readonly path: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A created draft asset plus the presigned target the bytes are PUT to. */
export interface CreatedAsset {
  readonly asset: Asset;
  readonly upload: { readonly url: string; readonly headers: Readonly<Record<string, string>> };
}

export interface CreateAssetInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly title?: LocalizedValue;
  readonly description?: LocalizedValue;
  /** File it in this folder. */
  readonly folderId?: string;
}

/** A named, ordered set of assets; an asset may be in any number of them. */
/** How many published entries carry a term: in all, and per content type. */
export interface TermUsage {
  readonly count: number;
  readonly byContentType: Readonly<Record<string, number>>;
}

/** What a tag or concept carries beside its label. */
export interface TermFields {
  /** URL slug, normalized; made from the label when omitted on create, kept when it changes. */
  readonly slug?: string;
  /** Plain text; `null` clears it. */
  readonly description?: string | null;
  /** Labels by locale (the whole set). The default locale's sets the term's own label. */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface Tag {
  readonly id: string;
  /** The default-locale label. */
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  /** Labels in the space's other locales. */
  readonly labels: Readonly<Record<string, string>>;
}

export interface ConceptScheme {
  readonly id: string;
  readonly name: string;
}

export interface Concept {
  readonly id: string;
  readonly schemeId: string;
  /** The default-locale label. */
  readonly prefLabel: string;
  readonly broaderId: string | null;
  readonly slug: string;
  readonly description: string | null;
  readonly labels: Readonly<Record<string, string>>;
}

export interface AssetCollection {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly updatedAt: string;
}

export interface AssetCollectionPage {
  readonly items: readonly AssetCollection[];
  readonly nextCursor?: string;
}

/** An expiring, revocable link to a published asset or a collection, for people without an account. */
export interface ShareLink {
  readonly id: string;
  readonly targetType: 'asset' | 'collection';
  readonly targetId: string;
  readonly expiresAt: string;
  readonly allowDownload: boolean;
  readonly hasPassword: boolean;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly revokedAt?: string;
  /** The URL to hand out, on the media origin. */
  readonly url?: string;
}

export interface CreateShareLinkInput {
  readonly targetType: 'asset' | 'collection';
  readonly targetId: string;
  /** ISO 8601, 5 minutes to 90 days from now. */
  readonly expiresAt: string;
  readonly allowDownload?: boolean;
  /** 8 to 256 characters; asked for before the page opens, never stored. */
  readonly password?: string;
}

/** A multipart upload started for a new draft asset. */
export interface MultipartUploadStarted {
  readonly asset: Asset;
  readonly upload: {
    readonly uploadId: string;
    /** Every part but the last has exactly this many bytes. */
    readonly partSize: number;
    readonly partCount: number;
  };
}

/** A multipart upload started to replace an asset's file; completing it commits `version`. */
export interface MultipartReplacementStarted extends MultipartUploadStarted {
  readonly version: number;
}

/** A signed URL for one part: PUT exactly `length` bytes; the response's ETag names the part. */
export interface SignedPart {
  readonly partNumber: number;
  readonly url: string;
  readonly length: number;
  readonly expiresAt: string;
}

/** A zip download being built; `downloadUrl` once `completed` (15 minutes; get it again for more). */
export interface AssetZip {
  readonly id: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly fileName: string;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly partsDone: number;
  readonly partCount?: number;
  readonly error?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly expiresAt: string;
  readonly downloadUrl?: string;
}

export type ImageFit = 'clip' | 'crop' | 'fill' | 'max' | 'scale';
export type ImageFormat = 'auto' | 'jpg' | 'png' | 'webp' | 'avif';

/** What a rendition preset makes of an image. */
export interface AssetRenditionSpec {
  /** 1..4096. */
  readonly width?: number;
  /** 1..4096. */
  readonly height?: number;
  readonly fit?: ImageFit;
  readonly format?: ImageFormat;
  /** 1..100. */
  readonly quality?: number;
}

/** A named image preset of the space, served for every published image at `…/r-<name>/…`. */
export interface AssetRendition extends AssetRenditionSpec {
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAssetRenditionInput extends AssetRenditionSpec {
  /** Lowercase letters, digits and dashes, up to 40; its URL segment is `r-<name>`. */
  readonly name: string;
}

/** A transform (`assets.transformUrl`); `crop` is anchored to the asset's focal point. */
export interface ImageTransform {
  /** 1..10000. */
  readonly width?: number;
  /** 1..10000. */
  readonly height?: number;
  readonly fit?: ImageFit;
  readonly format?: ImageFormat;
  /** 1..100. */
  readonly quality?: number;
}

export interface TransformedImage {
  readonly url: string;
  readonly transform: ImageTransform;
}

export interface CreateVideoAssetInput {
  readonly fileName: string;
  /** A `video/*` type. */
  readonly contentType: string;
  readonly title?: LocalizedValue;
  readonly description?: LocalizedValue;
  readonly maxDurationSeconds?: number;
}

/** A draft video asset and its one-time direct upload to the video host. */
export interface CreatedVideoAsset {
  readonly asset: Asset;
  readonly upload: {
    readonly videoId: string;
    /** POST the file here as multipart form data, in the field `fileField`. */
    readonly uploadUrl: string;
    readonly method: 'POST';
    readonly fileField: string;
  };
}

export type ModelTier = 'flagship' | 'balanced' | 'fast';

/** Token counts a model run used. */
export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface GenerateAltTextInput {
  /** Defaults to the space's default locale. */
  readonly locale?: string;
  /** Where or how the image is used, to steer the text. */
  readonly context?: string;
  /** Save it on the asset's metadata as well. */
  readonly apply?: boolean;
  /** Default `fast`. */
  readonly tier?: ModelTier;
}

export interface AltTextResult {
  readonly altText: string;
  readonly locale: string;
  readonly applied: boolean;
  readonly usage: AiUsage;
}

export interface AutoTagInput {
  /** Create the new tags and set every chosen tag on the asset. */
  readonly apply?: boolean;
  /** Default `fast`. */
  readonly tier?: ModelTier;
}

export interface AutoTagResult {
  /** Existing tag ids the model chose. */
  readonly tagIds: readonly string[];
  /** New tag names it suggested (created only with `apply`). */
  readonly newTags: readonly string[];
  readonly applied: boolean;
  readonly usage: AiUsage;
}

/** A file to upload as a new asset (`assets.upload`). */
export interface UploadAssetInput extends CreateAssetInput {
  readonly body: UploadBody;
}

/** A file replacement in progress: PUT the bytes to `upload.url`, then pass `commit` back. */
export interface AssetFileReplacement {
  readonly asset: Asset;
  readonly upload: { readonly url: string; readonly headers: Readonly<Record<string, string>> };
  readonly commit: {
    readonly version: number;
    readonly fileName: string;
    readonly contentType: string;
  };
}

/** One file an asset has had (`assets.versions`). */
export interface AssetVersion {
  readonly version: number;
  /** `file.url` is a short-lived signed read URL. */
  readonly file: AssetFile;
  readonly contentHash?: string;
  /** When this file became the asset's, and who made it so. */
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly current: boolean;
  /** The file Delivery serves now. */
  readonly published: boolean;
  /** For a restore: the earliest version with the same file. */
  readonly restoredFrom?: number;
}

/** An asset's usage rights; dates are ISO-8601 with a zone. */
export interface AssetRights {
  readonly license?: string;
  readonly credit?: string;
  /** It is unpublished then, and its media answers 410. */
  readonly expiresAt?: string;
  /** Publishing is refused before then. */
  readonly embargoUntil?: string;
}

/** A bulk action over a selection of assets (`assets.bulk`). */
export type AssetBulkInput =
  | { readonly action: 'move'; readonly ids: readonly string[]; readonly folderId: string | null }
  | {
      readonly action: 'tag';
      readonly ids: readonly string[];
      readonly addTags?: readonly string[];
      readonly removeTags?: readonly string[];
    }
  | { readonly action: 'publish' | 'unpublish' | 'archive'; readonly ids: readonly string[] };

/** A durable bulk job; poll `bulkJobs.get` until `status` is no longer `running`. */
export interface BulkJob {
  readonly id: string;
  readonly action: string;
  readonly status: 'running' | 'completed' | 'cancelled';
  readonly totalItems: number;
  readonly totalChunks: number;
  readonly completedChunks: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly createdAt: string;
  readonly completedAt?: string;
}

/** A bulk job's per-item report: every failure, per chunk (`name`: an asset's title or file). */
export interface BulkJobReport {
  readonly job: BulkJob;
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

export interface Webhook {
  readonly id: string;
  readonly url: string;
  readonly topics: readonly string[];
  readonly active: boolean;
  /** The one environment whose events it receives; `null` for every environment in the space. */
  readonly environmentId: string | null;
}

export interface CreateWebhookInput {
  readonly url: string;
  readonly topics: readonly string[];
  readonly secret: string;
  readonly active?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  /** `true`: every environment's events. Otherwise only the client's environment's. */
  readonly allEnvironments?: boolean;
}

/**
 * Omitted fields are kept. `allEnvironments: true` makes the hook space-wide, `false` scopes it to
 * the client's environment; omitted, its scope is unchanged.
 */
export type UpdateWebhookInput = Partial<CreateWebhookInput>;

/** One recorded attempt at a webhook, newest first in `webhooks.deliveries`. */
export interface WebhookDelivery {
  readonly id: number;
  readonly webhookId: string;
  readonly eventId: string;
  /** The event it carried, e.g. `entry.published` or `webhook.test` (absent on old records). */
  readonly eventType?: string;
  readonly status: 'success' | 'failed';
  readonly statusCode?: number;
  /** Which attempt this was (1 for the first). */
  readonly attempts: number;
  readonly error?: string;
  /** The delivery this one resent. */
  readonly resendOf?: number;
  readonly createdAt: string;
}

/** A test or resend, queued: its delivery shows up in `webhooks.deliveries` under `eventId`. */
export interface QueuedWebhookDelivery {
  readonly webhookId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly resendOf?: number;
}

export interface Release {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: ReleaseStatus;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

/** A release as `releases.list()` returns it: with how many members it holds. */
export interface ReleaseSummary extends Release {
  readonly itemCount: number;
}

export interface ReleaseItem {
  readonly entityId: string;
  readonly action: ScheduledActionType;
  readonly [key: string]: unknown;
}

export interface ReleaseWithItems {
  readonly release: Release;
  readonly items: readonly ReleaseItem[];
}

export interface ScheduledAction {
  readonly id: string;
  readonly action: ScheduledActionType;
  readonly entityType: ScheduledEntityType;
  readonly entityId: string;
  readonly scheduledFor: string;
  readonly status: ScheduledActionStatus;
  readonly createdAt: string;
  readonly executedAt?: string;
  readonly error?: string;
}

/** Per-item outcome of a bulk operation. */
export interface BulkItemResult {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface BulkSummary {
  readonly action: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly BulkItemResult[];
}

export interface ApiKeySummary {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly scopes: readonly string[];
  readonly revoked: boolean;
  readonly roleId?: string;
  readonly lastUsedAt?: string;
}

export interface CreateApiKeyInput {
  readonly kind: ApiKeyKind;
  readonly name?: string;
  readonly scopes?: readonly string[];
  readonly roleId?: string;
}

export interface SpaceRef {
  readonly id: string;
  readonly name: string;
}

/** Which way a locale's text runs. */
export type TextDirection = 'ltr' | 'rtl';

/** What is set for one locale; absent keys take the defaults (delivered, the language's direction). */
export interface LocaleSettings {
  /** False: editors write and preview it, Delivery never serves it. Never the default locale. */
  readonly delivered?: boolean;
  readonly direction?: TextDirection;
}

/** A space's locales, each with its settings resolved. */
export interface SpaceLocales {
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly fallbacks?: Readonly<Record<string, string | null>>;
  readonly localeSettings: Readonly<Record<string, Required<LocaleSettings>>>;
}

/**
 * `sample` installs sample content into the new space's first environment; `empty` doesn't.
 * `enterprise`, where the deployment offers it (`spaces.starters()`), installs a large demo brand
 * in the background: follow it with `spaces.starterInstall`.
 */
export type SpaceStarter = 'empty' | 'sample' | 'enterprise';

/** A starter as the deployment offers it, in the order a picker lists them. */
export interface SpaceStarterInfo {
  readonly id: SpaceStarter;
  readonly title: string;
  readonly description: string;
  /** Installs after the space is created, in the background, rather than before it returns. */
  readonly background: boolean;
}

/** Where a background starter install has got to. */
export interface StarterInstall {
  readonly install: string;
  readonly starter: string;
  /** The phase running now, or the last to run (1-based), of `steps`. */
  readonly step: number;
  readonly steps: number;
  readonly phase: string;
  readonly title: string;
  /** That phase's bulk job. */
  readonly jobId: string;
  readonly status: 'running' | 'completed' | 'failed';
  /** What failed in the phase that stopped the install. */
  readonly failures?: readonly { readonly id: string; readonly error: string }[];
}

export interface CreateSpaceInput {
  /** 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit; never `versions`,
   *  `imports`, `plugins` or `dlq` (in any case), which the media bucket keeps for its own data. */
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: string;
  readonly locales?: readonly string[];
  readonly fallbacks?: Record<string, string | null>;
  /** Environments to create; defaults to `["main"]`. */
  readonly environments?: readonly string[];
  readonly starter?: SpaceStarter;
}

export interface CreatedSpace extends SpaceRef {
  readonly starter: SpaceStarter;
  /** What the sample starter holds once installed (absent for `empty`). */
  readonly installed?: {
    readonly contentTypes: number;
    readonly entries: number;
    readonly assets: number;
    readonly tags: number;
    readonly concepts: number;
    readonly releases: number;
  };
  /** A background install that has started (the `enterprise` starter only). */
  readonly installing?: {
    readonly install: string;
    readonly jobId: string;
    readonly steps: number;
  };
}

/** The raw token is returned exactly once; only its hash is stored. */
export interface CreatedApiKey {
  readonly id: string;
  readonly kind: ApiKeyKind;
  readonly token: string;
}

export interface Principal {
  readonly spaceId: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly subject?: string;
  readonly restricted: boolean;
}

/** An entry as Preview serves it: the latest saved version, drafts included. */
export interface PreviewEntry extends EntryAuthorship {
  readonly id: string;
  readonly contentType: string;
  readonly status: EntryStatus;
  readonly version: number;
  /** When the entry last changed. */
  readonly updatedAt?: string;
  /** Keyed by locale, or plain values when the list was read with `locale`. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** The Preview list's parameters (`GET /preview/:space/:env/entries`). */
export interface EntryListQuery {
  readonly contentType?: string;
  readonly locale?: string;
  /** At most 100. */
  readonly limit?: number;
  readonly skip?: number;
  /** Sort keys, e.g. `-sys.updatedAt` or `fields.title`. */
  readonly order?: string;
  /** Full-text match over text fields. */
  readonly query?: string;
  /** Who created the entries: an actor id, or `me` for the caller (`sys.createdBy`). */
  readonly createdBy?: string;
  /** Who changed the entries last: an actor id, or `me` for the caller (`sys.updatedBy`). */
  readonly updatedBy?: string;
}

/** Maps source records onto one content type: target field apiId → source field name. */
export interface ImportMapping {
  readonly contentTypeApiId: string;
  readonly fields: Readonly<Record<string, string>>;
  /** The target field holding each record's source id; what makes a re-run update, not repeat. */
  readonly identityField?: string;
  /** Locale the values are written under; the space's default when absent. */
  readonly locale?: string;
}

export interface ImportInput {
  /** An id from `imports.sources()`: `csv`, `json` or `wxr`. */
  readonly source: string;
  /** The file's text. */
  readonly payload: string;
  readonly mapping: ImportMapping;
  /** Per source, e.g. `{ postType: 'page' }` for WXR. */
  readonly sourceOptions?: Readonly<Record<string, unknown>>;
  /** A record matching an existing entry: `skip` (the default), `update` or `fail`. */
  readonly conflicts?: 'skip' | 'update' | 'fail';
}

/** What an import would do, decided by the same planner that runs it. */
export interface ImportAnalysis {
  readonly contentTypeApiId: string;
  readonly locale: string;
  readonly records: number;
  readonly willCreate: number;
  readonly willUpdate: number;
  readonly willSkip: number;
  readonly invalid: number;
  /** Source fields nothing maps to: the data this import would drop. */
  readonly unmappedSourceFields: readonly string[];
  /** Blocking: required target fields with no source. */
  readonly missingRequiredFields: readonly string[];
  /** Blocking: target fields the content type doesn't define. */
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

export interface StartedImport {
  readonly job: BulkJob;
  readonly analysis: ImportAnalysis;
}

export interface ManagementClientOptions {
  /** Base URL of the Management API, e.g. https://cms.example.com */
  readonly baseUrl: string;
  readonly space: string;
  readonly environment: string;
  /** CMA key or admin token. */
  readonly token: string;
  /** Override fetch (SSR/edge/tests). Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Echo the api's `x-cw-bookmark` so each request reads at least as fresh as the last response,
   * a write included, even from a read replica. Default `true`.
   */
  readonly readYourWrites?: boolean;
  /** A bookmark to start from, e.g. one another client's write returned. */
  readonly bookmark?: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Query = Record<string, string | number | undefined>;

/** Creates a Management client bound to one space/environment. */
export function createManagementClient(opts: ManagementClientOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const root = opts.baseUrl.replace(/\/$/, '');
  const bookmarks = bookmarkTracker(opts.baseUrl, opts.bookmark, opts.readYourWrites !== false);
  const spaceBase = `${root}/spaces/${encodeURIComponent(opts.space)}`;
  const envBase = `${spaceBase}/environments/${encodeURIComponent(opts.environment)}`;

  async function request<T>(
    method: Method,
    url: string,
    body?: unknown,
    query?: Query,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const full = `${url}${qs.size ? `?${qs}` : ''}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      ...bookmarks.headersFor(full),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(full, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Before the status check: an error response's bookmark is as current as any other's.
    bookmarks.record(res);
    if (!res.ok) {
      const detail = await res.json().catch(() => undefined);
      throw new ManagementError(
        res.status,
        `Management request failed: ${res.status} ${method} ${full}`,
        detail,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const get = <T>(url: string, query?: Query) => request<T>('GET', url, undefined, query);
  const post = <T>(url: string, body?: unknown) => request<T>('POST', url, body);
  const put = <T>(url: string, body?: unknown) => request<T>('PUT', url, body);
  const patch = <T>(url: string, body?: unknown) => request<T>('PATCH', url, body);
  const del = <T>(url: string, query?: Query) => request<T>('DELETE', url, undefined, query);

  const items = async <T>(p: Promise<{ items: T[] }>): Promise<T[]> => (await p).items;

  /** Every item of a cursor-paged list, a page at a time as the loop asks for more. */
  async function* pages<T>(
    first: string | undefined,
    page: (cursor: string | undefined) => Promise<{ items: readonly T[]; nextCursor?: string }>,
  ): AsyncGenerator<T, void, undefined> {
    const seen = new Set<string>(first ? [first] : []);
    let cursor = first;
    for (;;) {
      const res = await page(cursor);
      yield* res.items;
      if (!res.nextCursor) return;
      // A cursor that comes back again would page forever; the server never does that.
      if (seen.has(res.nextCursor)) {
        throw new Error(`Management API returned cursor ${res.nextCursor} twice`);
      }
      seen.add(res.nextCursor);
      cursor = res.nextCursor;
    }
  }

  const e = encodeURIComponent;
  /** A signed URL may be root-relative (a deployment without MEDIA_BASE_URL): resolve it here. */
  const absolute = (url: string) => (/^https?:\/\//.test(url) ? url : `${root}${url}`);
  /** A signed URL without its query: the signature is a write capability, never for a log. */
  const unsigned = (url: string) => url.split('?')[0];

  /**
   * Sends a file to storage the way its size needs: up to {@link SINGLE_UPLOAD_MAX_BYTES} through
   * `single`'s signed PUT (then `done`), above it in the parts `parts` starts, each retried on its
   * own and signed again on each attempt, then completed. A failed or aborted multipart upload is
   * aborted on the server too. A single PUT stores once: a retry answered 412 found the bytes of
   * an earlier attempt whose answer was lost, so it counts as stored.
   */
  const transfer = async <T>(
    body: UploadBody,
    uploadOpts: UploadOptions,
    steps: {
      single: () => Promise<{
        url: string;
        headers: Readonly<Record<string, string>>;
        done: () => Promise<T>;
      }>;
      parts: (
        size: number,
      ) => Promise<{ assetId: string; uploadId: string; partSize: number; partCount: number }>;
    },
  ): Promise<T> => {
    const total = sizeOf(body);
    const sleep = uploadOpts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // A PUT to storage is always worth another try (a part's URL is signed again); the api's own
    // refusal (a 4xx but a timeout or a rate limit: a 409 lost race, a 422) won't change on its own.
    const transfers = new WeakSet<object>();
    const retry = <R>(fn: () => Promise<R>) =>
      withRetry(fn, {
        attempts: uploadOpts.attempts ?? 4,
        sleep,
        ...(uploadOpts.signal ? { signal: uploadOpts.signal } : {}),
        retryable: (err) =>
          !(err instanceof ManagementError) ||
          transfers.has(err) ||
          err.status >= 500 ||
          err.status === 408 ||
          err.status === 429,
      });
    const putBytes = async (
      url: string,
      bytes: Blob | Uint8Array,
      headers: Readonly<Record<string, string>> = {},
    ) =>
      doFetch(absolute(url), {
        method: 'PUT',
        headers,
        body: bytes as BodyInit,
        ...(uploadOpts.signal ? { signal: uploadOpts.signal } : {}),
      });
    const failed = (res: Response, url: string) => {
      const err = new ManagementError(
        res.status,
        `Upload failed: ${res.status} PUT ${unsigned(url)}`,
      );
      transfers.add(err);
      return err;
    };
    if (total <= SINGLE_UPLOAD_MAX_BYTES) {
      const target = await steps.single();
      uploadOpts.onProgress?.({ loaded: 0, total, partsDone: 0, partCount: 1 });
      let attempt = 0;
      await retry(async () => {
        // Counted before the PUT: an attempt whose answer never came (the connection dropped
        // after R2 stored the bytes) rejects here, and its retry's 412 is those bytes.
        const retried = attempt++ > 0;
        const res = await putBytes(target.url, sliceOf(body, 0, total), target.headers);
        if (res.ok || (retried && res.status === 412)) return;
        // On the first attempt, 412 means the key held bytes before this upload: no retry helps.
        if (res.status === 412)
          throw new ManagementError(
            412,
            `Upload refused: PUT ${unsigned(target.url)} already stored a file`,
          );
        throw failed(res, target.url);
      });
      uploadOpts.onProgress?.({ loaded: total, total, partsDone: 1, partCount: 1 });
      return target.done();
    }
    const { assetId, uploadId, partSize, partCount } = await steps.parts(total);
    const base = `${envBase}/assets/${e(assetId)}/uploads/${e(uploadId)}`;
    let loaded = 0;
    let partsDone = 0;
    uploadOpts.onProgress?.({ loaded, total, partsDone, partCount });
    try {
      const numbers = Array.from({ length: partCount }, (_, i) => i + 1);
      const parts = await inPool(
        numbers.map((n) => async () => {
          const etag = await retry(async () => {
            // Signed again on each attempt: a URL lives 15 minutes, a retry may outlast it.
            const [signed] = (
              await post<{ parts: SignedPart[] }>(`${base}/parts`, { partNumbers: [n] })
            ).parts;
            if (!signed) throw new Error(`part ${n} was not signed`);
            const res = await putBytes(
              signed.url,
              sliceOf(body, (n - 1) * partSize, signed.length),
            );
            // 404: the upload is gone (aborted, or completed); signing the part again can't help.
            if (res.status === 404)
              throw new ManagementError(404, `Upload gone: PUT ${unsigned(signed.url)}`);
            if (!res.ok) throw failed(res, signed.url);
            const tag = res.headers.get('etag');
            if (!tag) throw new Error(`part ${n} came back without an ETag`);
            return tag;
          });
          partsDone += 1;
          loaded += Math.min(partSize, total - (n - 1) * partSize);
          uploadOpts.onProgress?.({ loaded, total, partsDone, partCount });
          return { partNumber: n, etag };
        }),
        uploadOpts.concurrency ?? 4,
      );
      return await retry(() => post<T>(`${base}/complete`, { parts }));
    } catch (err) {
      await del<void>(base).catch(() => undefined);
      throw err;
    }
  };

  return {
    /**
     * The newest `x-cw-bookmark` this client has seen (or was given), sent with its next request.
     * Pass it on, e.g. from a server action to the browser's preview client, so that client reads
     * this client's writes. Assigning replaces it, `undefined` clears it, and a value that isn't a
     * D1 bookmark is dropped. Always `undefined` with `readYourWrites: false`.
     */
    get bookmark(): string | undefined {
      return bookmarks.current;
    },
    set bookmark(value: string | undefined) {
      bookmarks.current = value;
    },

    /** Who am I: the principal resolved from this client's token. */
    me: () => get<Principal>(`${root}/auth/me`),

    approvals: {
      /**
       * How many items wait on a decision, uncapped, counting only content types this token may
       * read.
       */
      count: () => get<PendingApprovalsCount>(`${envBase}/approvals/count`),
    },

    contentTypes: {
      list: () => items(get<{ items: ContentType[] }>(`${envBase}/content-types`)),
      get: (apiId: string) => get<ContentType>(`${envBase}/content-types/${e(apiId)}`),
      /** Creates a content type, or revises the one with this `apiId` (a new draft version). */
      create: (draft: ContentTypeDraft) => post<ContentType>(`${envBase}/content-types`, draft),
      publish: (apiId: string) =>
        post<ContentType>(`${envBase}/content-types/${e(apiId)}/published`),
      /** Entries per content type, by status, from one grouped count. */
      entryCounts: () =>
        items(get<{ items: ContentTypeEntryCounts[] }>(`${envBase}/content-types/entry-counts`)),
      /**
       * The distinct values a scalar field (or list of Symbols) holds across the type's entries,
       * each with its count: booleans, then numbers, then strings. Pass `nextCursor` back as
       * `cursor` for the next page.
       */
      fieldValues: (
        apiId: string,
        field: string,
        opts: { locale?: string; limit?: number; cursor?: string } = {},
      ) =>
        get<FieldValuesPage>(
          `${envBase}/content-types/${e(apiId)}/fields/${e(field)}/values`,
          opts,
        ),
      /** What depends on a content type: why `delete` would be refused. */
      dependents: (apiId: string) =>
        get<ContentTypeDependents>(`${envBase}/content-types/${e(apiId)}/dependents`),
      /**
       * Deletes a content type; a 409 names what still depends on it.
       * `purgeEntries` deletes its entries too, as a bulk job (`{ deleted: false, job }`): the
       * type goes when the job completes cleanly.
       */
      delete: (apiId: string, o: { readonly purgeEntries?: boolean } = {}) =>
        del<ContentTypeDeletion>(`${envBase}/content-types/${e(apiId)}`, {
          purge_entries: o.purgeEntries ? 'true' : undefined,
        }),
      /** Copies the definition under a new apiId and name, as a draft with no entries. */
      clone: (apiId: string, to: { readonly apiId: string; readonly name: string }) =>
        post<ContentType>(`${envBase}/content-types/${e(apiId)}/clone`, to),
    },

    /** Navigation menus: delivery data a front end renders (content:manage to change them). */
    menus: {
      list: async () => (await get<{ items: MenuSummary[] }>(`${envBase}/menus`)).items,
      get: (id: string) => get<Menu>(`${envBase}/menus/${e(id)}`),
      /** Each item as Delivery would resolve it now, or why it is dropped. */
      preview: (id: string, o: { readonly locale?: string } = {}) =>
        get<{ menu: Menu; locale: string; items: MenuItemPreview[] }>(
          `${envBase}/menus/${e(id)}/preview`,
          { locale: o.locale },
        ),
      /** The menu by handle as Delivery serves it now (published entries only), with your grants. */
      resolve: (handle: string, o: { readonly locale?: string } = {}) =>
        get<ResolvedMenu>(`${envBase}/menus/resolve/${e(handle)}`, { locale: o.locale }),
      /** 409 for a taken handle; 422 naming each bad item. */
      create: (input: MenuInput) => post<Menu>(`${envBase}/menus`, input),
      /** `items` replaces the whole tree; with `revision`, a save made since is a 409. */
      update: (id: string, changes: Partial<MenuInput> & { readonly revision?: number }) =>
        patch<Menu>(`${envBase}/menus/${e(id)}`, changes),
      /** Moves an item (and everything under it) to `index` under `parentId` (null: the top). */
      moveItem: (
        id: string,
        move: {
          readonly itemId: string;
          readonly parentId: string | null;
          readonly index: number;
          readonly revision?: number;
        },
      ) => post<Menu>(`${envBase}/menus/${e(id)}/move`, move),
      delete: (id: string, o: { readonly revision?: number } = {}) =>
        del<void>(`${envBase}/menus/${e(id)}`, { revision: o.revision }),
    },
    /**
     * Saved views of the entries list: yours and the space's shared ones. Another person's
     * personal view, or one your role can't see, is a 404; anything shared needs content:manage.
     */
    savedViews: {
      list: async (o: { readonly contentType?: string } = {}) =>
        (
          await get<{ items: SavedView[] }>(`${envBase}/saved-views`, {
            content_type: o.contentType,
          })
        ).items,
      get: (id: string) => get<SavedView>(`${envBase}/saved-views/${e(id)}`),
      /** One page of the view's entries, with your own grants and hidden fields applied. */
      run: (
        id: string,
        o: { readonly limit?: number; readonly cursor?: string; readonly locale?: string } = {},
      ) => get<SavedViewRun>(`${envBase}/saved-views/${e(id)}/entries`, { ...o }),
      /** 422 naming each bad part of the query; 403 for a shared view without content:manage. */
      create: (input: SavedViewInput) => post<SavedView>(`${envBase}/saved-views`, input),
      /** `query` replaces the whole query; with `revision`, a save made since is a 409. */
      update: (
        id: string,
        changes: Partial<Omit<SavedViewInput, 'contentTypeApiId'>> & { readonly revision?: number },
      ) => patch<SavedView>(`${envBase}/saved-views/${e(id)}`, changes),
      delete: (id: string, o: { readonly revision?: number } = {}) =>
        del<void>(`${envBase}/saved-views/${e(id)}`, { revision: o.revision }),
    },
    /** Redirects: delivery data a front end applies (content:manage to change them). */
    redirects: {
      /** By source; `q` searches source, destination and note. */
      list: (o: { q?: string; limit?: number; cursor?: string } = {}) =>
        get<{ items: Redirect[]; nextCursor?: string }>(`${envBase}/redirects`, { ...o }),
      get: (id: string) => get<Redirect>(`${envBase}/redirects/${e(id)}`),
      /** Refused (422) for a source already redirected, a loop, or past the cap. */
      create: (input: RedirectInput) => post<RedirectWrite>(`${envBase}/redirects`, input),
      /** Fields left out keep their value; `null` clears locale or note. */
      update: (id: string, changes: Partial<RedirectInput>) =>
        patch<RedirectWrite>(`${envBase}/redirects/${e(id)}`, changes),
      delete: (id: string) => del<void>(`${envBase}/redirects/${e(id)}`),
      /** All or nothing, up to 1,000 rows; a source already redirected is updated. */
      import: (input: {
        format: 'csv' | 'json';
        data: string | readonly RedirectInput[];
        dryRun?: boolean;
      }) =>
        post<{
          dryRun: boolean;
          created: number;
          updated: number;
          unchanged: number;
          chains: RedirectChain[];
        }>(`${envBase}/redirects/import`, input),
      /** What a path resolves to among the enabled redirects, or null. */
      resolve: async (path: string, o: { locale?: string } = {}) => {
        try {
          return await get<{ redirect: Redirect; status: number; location: string }>(
            `${envBase}/redirects/resolve`,
            { path, ...o },
          );
        } catch (err) {
          if (err instanceof ManagementError && err.status === 404) return null;
          throw err;
        }
      },
      /** Loops, chains and duplicate sources across the whole set. */
      analyze: () =>
        get<{
          loops: string[][];
          chains: RedirectChain[];
          duplicates: { key: string; ids: string[] }[];
          count: number;
          max: number;
        }>(`${envBase}/redirects/analysis`),
      /** Points every redirect that ends a chain straight at where its chain ends. */
      collapseChains: () => post<{ updated: number }>(`${envBase}/redirects/collapse-chains`),
    },

    entries: {
      /**
       * One page of entries as they are now, drafts included, from the Preview API (the same
       * origin): `total` counts this page, so page with `skip` until one comes back short.
       */
      list: (query: EntryListQuery = {}) =>
        get<{ items: PreviewEntry[]; total: number }>(
          `${root}/preview/${e(opts.space)}/${e(opts.environment)}/entries`,
          {
            content_type: query.contentType,
            locale: query.locale,
            limit: query.limit,
            skip: query.skip,
            order: query.order,
            query: query.query,
            'sys.createdBy': query.createdBy,
            'sys.updatedBy': query.updatedBy,
          },
        ),
      create: (input: { contentTypeApiId: string; fields: EntryFields }) =>
        post<EntryView>(`${envBase}/entries`, input),
      get: (id: string) => get<EntryView>(`${envBase}/entries/${e(id)}`),
      /** Saves a new draft version with these field values. */
      update: (id: string, fields: EntryFields) =>
        put<EntryView>(`${envBase}/entries/${e(id)}`, { fields }),
      /**
       * Changes one locale of the entry's SEO metadata and saves a new draft version (publish to put
       * it live). 422 when its content type has no Seo field.
       */
      setSeo: (id: string, change: EntrySeoChange) =>
        patch<EntryView>(`${envBase}/entries/${e(id)}/seo`, change),
      /**
       * Edits blocks by `_key` (insert, update, move, remove, duplicate) and saves a new draft
       * version. All ops apply or none do (a 422 naming the op that failed); a 409 when the entry
       * is no longer at `expectedVersion`. Undo with `result.inverse` at the new version.
       */
      patchBlocks: (id: string, change: { expectedVersion: number; ops: readonly BlockOp[] }) =>
        patch<BlockPatchResult>(`${envBase}/entries/${e(id)}/blocks`, change),
      /**
       * The same patch's dry run: the checks and errors `patchBlocks` would give, then the fields
       * as the save would store them and the patch as it would apply. Nothing is written.
       */
      checkBlocks: (id: string, change: { expectedVersion: number; ops: readonly BlockOp[] }) =>
        post<BlockPatchCheck>(`${envBase}/entries/blocks/validate`, { entryId: id, ...change }),
      /** The entry's blocks fields as a tree of keys, types and labels, to build a patch from. */
      outlineBlocks: (id: string, opts: { field?: string; locale?: string } = {}) =>
        get<BlocksOutline>(`${envBase}/entries/${e(id)}/blocks`, {
          field: opts.field,
          locale: opts.locale,
        }),
      /**
       * Moves an entry in its content type's manual order (`order=sys.position`): right after
       * another entry (`{ after: id }`, `null` for first) or right before one (`{ before: id }`,
       * `null` for last). Live: no new version, no publish.
       */
      move: (id: string, place: { after: string | null } | { before: string | null }) =>
        post<{ id: string; contentTypeApiId: string; position: string }>(
          `${envBase}/entries/${e(id)}/move`,
          place,
        ),
      /**
       * Mints an expiring preview link (default 72 hours). `frontendUrl` is the entry on your
       * site when its type has a preview template, filled in `locale` (the space's default).
       */
      previewLink: (
        id: string,
        opts: {
          readonly ttlHours?: number;
          readonly previewBaseUrl?: string;
          readonly locale?: string;
        } = {},
      ) => post<PreviewLink>(`${envBase}/entries/${e(id)}/preview-link`, opts),
      /**
       * Publishes the current draft. With `expectedVersion` (the `currentVersion` you read), a
       * draft saved since makes it a 409 that changes nothing.
       */
      publish: (id: string, opts?: Held) =>
        post<Entry>(`${envBase}/entries/${e(id)}/published${held(opts)}`),
      /** Withdraws it from Delivery; `expectedVersion` holds it as for `publish`. */
      unpublish: (id: string, opts?: Held) =>
        del<Entry>(`${envBase}/entries/${e(id)}/published${held(opts)}`),
      /** Entries/assets that link to this entry ("what links here"). */
      reverseReferences: (id: string) =>
        items(get<{ items: unknown[] }>(`${envBase}/entries/${e(id)}/reverse-references`)),
      bulkCreate: (batch: readonly { contentTypeApiId: string; fields: EntryFields }[]) =>
        post<BulkSummary>(`${envBase}/bulk/entries`, { items: batch }),
      bulkPublish: (ids: readonly string[]) =>
        post<BulkSummary>(`${envBase}/bulk/entries/publish`, { ids }),
      bulkUnpublish: (ids: readonly string[]) =>
        post<BulkSummary>(`${envBase}/bulk/entries/unpublish`, { ids }),
      versions: {
        list: (id: string) =>
          items(get<{ items: EntryVersion[] }>(`${envBase}/entries/${e(id)}/versions`)),
        get: (id: string, version: number) =>
          get<EntryVersion>(`${envBase}/entries/${e(id)}/versions/${version}`),
        /**
         * A readable diff between two versions, per field and locale with detail by field type.
         * Either side is a version number, `'draft'` or `'published'`.
         */
        diff: (id: string, from: VersionRef, to: VersionRef) =>
          get<unknown>(`${envBase}/entries/${e(id)}/versions/diff`, { from, to }),
        /**
         * Copies an old version's fields into a NEW draft version; `expectedVersion` (the draft
         * you read) makes a draft saved since a 409.
         */
        restore: (id: string, version: number, opts?: Held) =>
          post<EntryView>(`${envBase}/entries/${e(id)}/versions/${version}/restore${held(opts)}`),
      },
    },

    assets: {
      /** One page of the library; pass `nextCursor` back as `cursor` for the next. */
      list: (query: AssetListQuery = {}) => get<AssetPage>(`${envBase}/assets`, { ...query }),
      /**
       * Every asset the query matches, following `nextCursor` a page (`limit`) at a time as the
       * loop asks for more: `for await (const asset of cma.assets.iterate({ kind: 'image' })) …`.
       */
      iterate: (query: AssetListQuery = {}): AsyncGenerator<Asset, void, undefined> =>
        pages(query.cursor, (cursor) => get<AssetPage>(`${envBase}/assets`, { ...query, cursor })),
      get: (id: string) => get<Asset>(`${envBase}/assets/${e(id)}`),
      /** Hybrid search of the library (full text and semantic), with facet counts. */
      search: (query: AssetSearchQuery) =>
        get<AssetSearchPage>(`${envBase}/assets/search`, { ...query }),
      /** Runs ingest on the asset's current file again (a retry after `ingestStatus: error`). */
      reingest: (id: string) => post<Asset>(`${envBase}/assets/${e(id)}/reingest`),
      /**
       * Sends assets through ingest as a bulk job: those never ingested or whose ingest failed,
       * or every asset with a file (`all`). While one is running, that job comes back
       * (`running: true`). Follow `job` with `bulkJobs.get`.
       */
      reindex: (opts: { all?: boolean } = {}) =>
        post<{ assets: number; job?: { id: string; status: string }; running?: true }>(
          `${envBase}/assets/reindex`,
          opts,
        ),
      /**
       * Creates a draft asset and returns a presigned upload target. PUT the
       * bytes to `upload.url` with `upload.headers`, then publish the asset.
       */
      create: (input: CreateAssetInput) => post<CreatedAsset>(`${envBase}/assets`, input),
      /** Changes only the keys sent; publish again to carry them into Delivery. */
      setMetadata: (id: string, metadata: AssetMetadataPatch) =>
        patch<Asset>(`${envBase}/assets/${e(id)}/metadata`, metadata),
      /** The entry fields that link to this asset. */
      usage: (id: string) => items(get<{ items: AssetLink[] }>(`${envBase}/assets/${e(id)}/usage`)),
      /**
       * A URL for the image resized or re-encoded, built from its stored file URL; `fit: 'crop'`
       * is anchored to its focal point. Images only (others are a 422). For a published image,
       * prefer the delivered asset's `srcset` and `renditions`.
       */
      transformUrl: (id: string, transform: ImageTransform) =>
        get<TransformedImage>(`${envBase}/assets/${e(id)}/transform`, {
          w: transform.width,
          h: transform.height,
          fit: transform.fit,
          fm: transform.format,
          q: transform.quality,
        }),
      /**
       * Suggests alt text for an image from its file name, title, description and `context` (not
       * the pixels); `apply` saves it too. Counted against the space's AI budget.
       */
      generateAltText: (id: string, input: GenerateAltTextInput = {}) =>
        post<AltTextResult>(`${envBase}/assets/${e(id)}/alt-text`, input),
      /**
       * Picks tags for an image from the space's tags and suggests new names; `apply` creates the
       * new tags and sets them all on the asset.
       */
      autoTag: (id: string, input: AutoTagInput = {}) =>
        post<AutoTagResult>(`${envBase}/assets/${e(id)}/auto-tag`, input),
      /** A 409 (`isAssetRightsError`) under embargo or past its expiry. */
      publish: (id: string) => post<Asset>(`${envBase}/assets/${e(id)}/published`),
      unpublish: (id: string) => del<Asset>(`${envBase}/assets/${e(id)}/published`),
      /** Takes it out of Delivery and out of the default listing; `restore` brings it back. */
      archive: (id: string) => post<Asset>(`${envBase}/assets/${e(id)}/archive`),
      restore: (id: string) => post<Asset>(`${envBase}/assets/${e(id)}/restore`),
      /**
       * Deletes it for good. A 409 while entries link to it (`isAssetInUse`): `error.usage`
       * lists the first 50 links (each with the entry's `contentTypeApiId` and `entryTitle`) and
       * `error.total` counts them all.
       */
      delete: (id: string) => del<void>(`${envBase}/assets/${e(id)}`),
      /** Files assets in a folder (`null`: the root), up to 500 at once. */
      move: (ids: readonly string[], folderId: string | null) =>
        post<{ moved: number }>(`${envBase}/assets/move`, { ids, folderId }),
      /**
       * Moves, tags, publishes, unpublishes or archives many assets as a resumable bulk job.
       * Follow it with `bulkJobs.get`; `bulkJobs.report` names each asset that failed.
       */
      bulk: (input: AssetBulkInput) => post<BulkJob>(`${envBase}/assets/bulk`, input),
      /**
       * Replaces the asset's file with `body`, whatever its size: one signed PUT and the commit
       * up to 100 MiB, a multipart upload above it whose completion commits (parts retried on
       * their own, progress after each, as `upload`). Returns the asset at its new version. A
       * published asset keeps its published file until republished; a replace or restore that
       * committed first is a 409 `ManagementError`.
       */
      replaceFile: (
        id: string,
        input: { fileName: string; contentType: string; body: UploadBody },
        uploadOpts: UploadOptions = {},
      ): Promise<Asset> => {
        const { body, ...rest } = input;
        return transfer(body, uploadOpts, {
          single: async () => {
            const r = await post<AssetFileReplacement>(`${envBase}/assets/${e(id)}/file`, rest);
            return {
              ...r.upload,
              done: () => post<Asset>(`${envBase}/assets/${e(id)}/file/commit`, r.commit),
            };
          },
          parts: async (size) => {
            const r = await post<MultipartReplacementStarted>(
              `${envBase}/assets/${e(id)}/file/uploads`,
              { ...rest, size },
            );
            return { assetId: id, ...r.upload };
          },
        });
      },
      /**
       * The single-PUT replace, one step at a time (`replaceFile` runs it for you): PUT the bytes
       * to `upload.url` with `upload.headers`, then `commitFile(id, commit)`. The URL stores once:
       * a second PUT through it is 412.
       */
      startReplace: (id: string, input: { fileName: string; contentType: string }) =>
        post<AssetFileReplacement>(`${envBase}/assets/${e(id)}/file`, input),
      /** Makes an uploaded replacement current as a new version. */
      commitFile: (id: string, commit: AssetFileReplacement['commit']) =>
        post<Asset>(`${envBase}/assets/${e(id)}/file/commit`, commit),
      /** Every file the asset has had, newest first. */
      versions: (id: string) =>
        items(get<{ items: AssetVersion[] }>(`${envBase}/assets/${e(id)}/versions`)),
      /** Makes an earlier version's file current again, as a new version. */
      restoreVersion: (id: string, version: number) =>
        post<Asset>(`${envBase}/assets/${e(id)}/versions/${version}/restore`),
      /**
       * Replaces the asset's usage rights (`{}` clears them). On a published asset they apply at
       * once; needs content:publish.
       */
      setRights: (id: string, rights: AssetRights) =>
        put<Asset>(`${envBase}/assets/${e(id)}/rights`, rights),
      /**
       * Uploads a file as a new draft asset, whatever its size: one signed PUT up to 100 MiB, a
       * multipart upload above it (parts retried on their own, `concurrency` at once, progress
       * after each). A failed or aborted multipart upload is aborted on the server too. Returns
       * the asset once its bytes are stored. The signed PUT stores once: a retry answered 412
       * means an earlier attempt's bytes landed (its answer was lost), so it counts as stored; a
       * 412 on the first attempt is thrown as a `ManagementError` with status 412.
       */
      upload: (input: UploadAssetInput, uploadOpts: UploadOptions = {}): Promise<Asset> => {
        const { body, ...rest } = input;
        return transfer(body, uploadOpts, {
          single: async () => {
            const created = await post<CreatedAsset>(`${envBase}/assets`, rest);
            return { ...created.upload, done: async () => created.asset };
          },
          parts: async (size) => {
            const started = await post<MultipartUploadStarted>(`${envBase}/assets/uploads`, {
              ...rest,
              size,
            });
            return { assetId: started.asset.id, ...started.upload };
          },
        });
      },
      /** The multipart steps one at a time (`upload` runs them for you). */
      uploads: {
        start: (input: CreateAssetInput & { size: number }) =>
          post<MultipartUploadStarted>(`${envBase}/assets/uploads`, input),
        /** Starts replacing an asset's file in parts; completing the upload commits it. */
        startReplace: (
          id: string,
          input: { fileName: string; contentType: string; size: number },
        ) => post<MultipartReplacementStarted>(`${envBase}/assets/${e(id)}/file/uploads`, input),
        signParts: (assetId: string, uploadId: string, partNumbers: readonly number[]) =>
          post<{ parts: SignedPart[] }>(
            `${envBase}/assets/${e(assetId)}/uploads/${e(uploadId)}/parts`,
            { partNumbers },
          ),
        complete: (
          assetId: string,
          uploadId: string,
          parts: readonly { partNumber: number; etag: string }[],
        ) =>
          post<Asset>(`${envBase}/assets/${e(assetId)}/uploads/${e(uploadId)}/complete`, {
            parts,
          }),
        abort: (assetId: string, uploadId: string) =>
          del<void>(`${envBase}/assets/${e(assetId)}/uploads/${e(uploadId)}`),
      },
      collections: {
        /** By name; pass `nextCursor` back as `cursor` for the next page. */
        list: (o: { limit?: number; cursor?: string } = {}) =>
          get<AssetCollectionPage>(`${envBase}/asset-collections`, { ...o }),
        /** Every collection, by name, a page (`limit`) at a time. */
        iterate: (
          o: { limit?: number; cursor?: string } = {},
        ): AsyncGenerator<AssetCollection, void, undefined> =>
          pages(o.cursor, (cursor) =>
            get<AssetCollectionPage>(`${envBase}/asset-collections`, { ...o, cursor }),
          ),
        get: (id: string) => get<AssetCollection>(`${envBase}/asset-collections/${e(id)}`),
        create: (input: { name: string; description?: string }) =>
          post<AssetCollection>(`${envBase}/asset-collections`, input),
        /** `description: ''` clears it. */
        update: (id: string, changes: { name?: string; description?: string }) =>
          patch<AssetCollection>(`${envBase}/asset-collections/${e(id)}`, changes),
        /** Its assets stay in the library. */
        delete: (id: string) => del<void>(`${envBase}/asset-collections/${e(id)}`),
        /** Its assets in its order, filtered as the library is. */
        assets: (id: string, query: CollectionAssetQuery = {}) =>
          get<AssetPage>(`${envBase}/asset-collections/${e(id)}/assets`, { ...query }),
        /** Every member in its order, filtered as `assets`, a page (`limit`) at a time. */
        iterateAssets: (
          id: string,
          query: CollectionAssetQuery = {},
        ): AsyncGenerator<Asset, void, undefined> =>
          pages(query.cursor, (cursor) =>
            get<AssetPage>(`${envBase}/asset-collections/${e(id)}/assets`, { ...query, cursor }),
          ),
        /** After its last member, in the order given (up to 500 ids; 1,000 members at most). */
        add: (id: string, assetIds: readonly string[]) =>
          post<{ added: number; skipped: string[] }>(
            `${envBase}/asset-collections/${e(id)}/assets`,
            { assetIds },
          ),
        remove: (id: string, assetIds: readonly string[]) =>
          post<{ removed: number }>(`${envBase}/asset-collections/${e(id)}/assets/remove`, {
            assetIds,
          }),
        /** The named members first, in that order (up to 1,000); the rest after, as they were. */
        reorder: (id: string, assetIds: readonly string[]) =>
          put<void>(`${envBase}/asset-collections/${e(id)}/order`, { assetIds }),
      },
      /** Expiring links to a published asset or a collection (content:publish). */
      shareLinks: {
        list: (
          o: {
            targetType?: 'asset' | 'collection';
            targetId?: string;
            includeInactive?: boolean;
          } = {},
        ) =>
          items(
            get<{ items: ShareLink[] }>(`${envBase}/share-links`, {
              targetType: o.targetType,
              targetId: o.targetId,
              includeInactive: o.includeInactive ? 'true' : undefined,
            }),
          ),
        get: (id: string) => get<ShareLink>(`${envBase}/share-links/${e(id)}`),
        create: (input: CreateShareLinkInput) => post<ShareLink>(`${envBase}/share-links`, input),
        /** It stops opening within a minute. */
        revoke: (id: string) => del<ShareLink>(`${envBase}/share-links/${e(id)}`),
      },
      /** Zip downloads of a selection or a collection, built in the background. */
      zips: {
        create: (
          input:
            | { assetIds: readonly string[]; name?: string }
            | { collectionId: string; name?: string },
        ) => post<AssetZip>(`${envBase}/asset-zips`, input),
        /** `downloadUrl` once completed. */
        get: (id: string) => get<AssetZip>(`${envBase}/asset-zips/${e(id)}`),
        list: () => items(get<{ items: AssetZip[] }>(`${envBase}/asset-zips`)),
      },
      /**
       * The space's named image presets (the same in every environment). Reading needs
       * preview:read; changing them content:manage.
       */
      renditions: {
        list: () => items(get<{ items: AssetRendition[] }>(`${envBase}/asset-renditions`)),
        get: (name: string) => get<AssetRendition>(`${envBase}/asset-renditions/${e(name)}`),
        /** A taken name is a 409; a space has at most 20. */
        create: (input: CreateAssetRenditionInput) =>
          post<AssetRendition>(`${envBase}/asset-renditions`, input),
        /** Replaces the preset (omitted keys are cleared); its URLs stay, their cache is purged. */
        update: (name: string, spec: AssetRenditionSpec) =>
          put<AssetRendition>(`${envBase}/asset-renditions/${e(name)}`, spec),
        delete: (name: string) => del<void>(`${envBase}/asset-renditions/${e(name)}`),
      },
      /** Videos hosted by the video service (a 501 when the deployment has none). */
      videos: {
        /**
         * A draft video asset and a one-time upload: POST the file as multipart form data to
         * `upload.uploadUrl`, in the field `upload.fileField`.
         */
        create: (input: CreateVideoAssetInput) =>
          post<CreatedVideoAsset>(`${envBase}/assets/videos`, input),
        /** Reads the video's processing status from the host; poll until `file.video.status` is `ready`. */
        refresh: (id: string) => post<Asset>(`${envBase}/assets/${e(id)}/video/refresh`),
      },
      folders: {
        list: () => items(get<{ items: AssetFolder[] }>(`${envBase}/asset-folders`)),
        create: (input: { name: string; parentId?: string | null }) =>
          post<AssetFolder>(`${envBase}/asset-folders`, input),
        /** Renames and/or moves it (`parentId: null`: to the root), subfolders along. */
        update: (id: string, changes: { name?: string; parentId?: string | null }) =>
          patch<AssetFolder>(`${envBase}/asset-folders/${e(id)}`, changes),
        /** Only an empty folder; one with subfolders or assets is a 409. */
        delete: (id: string) => del<void>(`${envBase}/asset-folders/${e(id)}`),
      },
    },

    /**
     * The environment's controlled vocabulary: flat tags, and concept schemes holding
     * hierarchical concepts. Lists carry each term's published usage (`usage`).
     */
    taxonomy: {
      tags: {
        list: () =>
          items(get<{ items: (Tag & { usage: TermUsage })[] }>(`${envBase}/taxonomy/tags`)),
        create: (input: { name: string } & TermFields) =>
          post<Tag>(`${envBase}/taxonomy/tags`, input),
        update: (id: string, input: { name?: string } & TermFields) =>
          patch<Tag>(`${envBase}/taxonomy/tags/${e(id)}`, input),
        delete: (id: string) => del<void>(`${envBase}/taxonomy/tags/${e(id)}`),
      },
      schemes: {
        list: () => items(get<{ items: ConceptScheme[] }>(`${envBase}/taxonomy/schemes`)),
        create: (input: { name: string }) =>
          post<ConceptScheme>(`${envBase}/taxonomy/schemes`, input),
        delete: (id: string) => del<void>(`${envBase}/taxonomy/schemes/${e(id)}`),
      },
      concepts: {
        list: (o: { scheme?: string } = {}) =>
          items(
            get<{ items: (Concept & { usage: TermUsage })[] }>(`${envBase}/taxonomy/concepts`, {
              scheme: o.scheme,
            }),
          ),
        create: (
          input: { schemeId: string; prefLabel: string; broaderId?: string | null } & TermFields,
        ) => post<Concept>(`${envBase}/taxonomy/concepts`, input),
        update: (id: string, input: { prefLabel?: string } & TermFields) =>
          patch<Concept>(`${envBase}/taxonomy/concepts/${e(id)}`, input),
        setBroader: (id: string, broaderId: string | null) =>
          put<Concept>(`${envBase}/taxonomy/concepts/${e(id)}/broader`, { broaderId }),
        delete: (id: string) => del<void>(`${envBase}/taxonomy/concepts/${e(id)}`),
      },
      /**
       * Recounts published usage from the published entries and gives a slug to any term without
       * one. The counts are kept as entries publish; this is the repair, safe to repeat.
       */
      repair: () => post<{ slugsAssigned: number }>(`${envBase}/taxonomy/repair`),
    },

    /** Durable bulk jobs (asset bulk actions, entry bulk publishing, imports), newest first. */
    bulkJobs: {
      list: (o: { limit?: number } = {}) =>
        get<BulkJob[]>(`${envBase}/bulk/jobs`, { limit: o.limit }),
      get: (id: string) => get<BulkJob>(`${envBase}/bulk/jobs/${e(id)}`),
      report: (id: string) => get<BulkJobReport>(`${envBase}/bulk/jobs/${e(id)}/report`),
      /**
       * Stops the job taking new work: chunks not yet started are skipped, one already running
       * finishes, and nothing done is rolled back. Cancelling a finished job returns it unchanged.
       */
      cancel: (id: string) => post<BulkJob>(`${envBase}/bulk/jobs/${e(id)}/cancel`),
      /**
       * Sets the same values on entries of one content type, each saved as a new draft with the
       * checks an edit makes. `fields` is field apiId → locale → value; only those change, and
       * `null` clears a locale. Entries that refuse their save are named in `report`.
       */
      setFields: (input: {
        contentTypeApiId: string;
        entryIds: readonly string[];
        fields: Record<string, Record<string, unknown>>;
      }) => post<BulkJob>(`${envBase}/bulk/jobs/set-fields`, input),
    },

    /**
     * Imports from a file (CSV, JSON, WXR) into one content type. Entries arrive as drafts;
     * `analyze` writes nothing and reports exactly what `run` or `start` would do.
     */
    imports: {
      /** The formats this deployment reads. */
      sources: () =>
        items(get<{ items: { id: string; name: string }[] }>(`${envBase}/imports/sources`)),
      analyze: (input: ImportInput) => post<ImportAnalysis>(`${envBase}/imports/analyze`, input),
      /** Runs it in the request (up to 10,000 records). */
      run: (input: ImportInput) => post<ImportResult>(`${envBase}/imports`, input),
      /** Runs it as a durable job; follow `job.id` with `bulkJobs.get` and `bulkJobs.report`. */
      start: (input: ImportInput) => post<StartedImport>(`${envBase}/imports/job`, input),
    },

    webhooks: {
      list: () => items(get<{ items: Webhook[] }>(`${envBase}/webhooks`)),
      create: (input: CreateWebhookInput) => post<Webhook>(`${envBase}/webhooks`, input),
      update: (id: string, input: UpdateWebhookInput) =>
        put<Webhook>(`${envBase}/webhooks/${e(id)}`, input),
      delete: (id: string) => del<void>(`${envBase}/webhooks/${e(id)}`),
      deliveries: (id: string, o: { limit?: number } = {}) =>
        items(
          get<{ items: WebhookDelivery[] }>(`${envBase}/webhooks/${e(id)}/deliveries`, {
            limit: o.limit,
          }),
        ),
      /** Queues a signed `webhook.test` event for this webhook alone (one attempt). */
      test: (id: string) => post<QueuedWebhookDelivery>(`${envBase}/webhooks/${e(id)}/test`),
      /** Sends a stored delivery's event again, signed afresh (one attempt). */
      resend: (id: string, deliveryId: number) =>
        post<QueuedWebhookDelivery>(`${envBase}/webhooks/${e(id)}/deliveries/${deliveryId}/resend`),
    },

    releases: {
      list: () => items(get<{ items: ReleaseSummary[] }>(`${envBase}/releases`)),
      get: (id: string) => get<ReleaseWithItems>(`${envBase}/releases/${e(id)}`),
      create: (input: { title: string; description?: string }) =>
        post<Release>(`${envBase}/releases`, input),
      delete: (id: string) => del<void>(`${envBase}/releases/${e(id)}`),
      addEntry: (id: string, input: { entityId: string; action?: ScheduledActionType }) =>
        post<ReleaseWithItems>(`${envBase}/releases/${e(id)}/items`, input),
      removeEntry: (id: string, entityId: string) =>
        del<ReleaseWithItems>(`${envBase}/releases/${e(id)}/items/${e(entityId)}`),
      /** Ships the bundle: publishes/unpublishes every member atomically. */
      publish: (id: string) => post<ReleaseWithItems>(`${envBase}/releases/${e(id)}/published`),
    },

    scheduledActions: {
      list: (o: { status?: ScheduledActionStatus } = {}) =>
        items(
          get<{ items: ScheduledAction[] }>(`${envBase}/scheduled-actions`, { status: o.status }),
        ),
      create: (input: {
        action: ScheduledActionType;
        entityType: ScheduledEntityType;
        entityId: string;
        scheduledFor: string;
      }) => post<ScheduledAction>(`${envBase}/scheduled-actions`, input),
      cancel: (id: string) => del<ScheduledAction>(`${envBase}/scheduled-actions/${e(id)}`),
    },

    /** Deployment-wide: not bound to the client's space. */
    spaces: {
      /** The spaces this token can reach (all of them for a deployment admin, else its own). */
      list: () => items(get<{ items: SpaceRef[] }>(`${root}/spaces`)),
      /** Creates a space, optionally with a starter. Deployment administrators only. */
      create: (input: CreateSpaceInput) => post<CreatedSpace>(`${root}/spaces`, input),
      /** The starters `create` accepts on this deployment. Deployment administrators only. */
      starters: () => items(get<{ items: SpaceStarterInfo[] }>(`${root}/starters`)),
      /** A background starter install's progress (`create`'s `installing.install`). */
      starterInstall: (spaceId: string, environmentId: string, install: string) =>
        get<StarterInstall>(
          `${root}/spaces/${encodeURIComponent(spaceId)}/environments/${encodeURIComponent(environmentId)}/starter-installs/${encodeURIComponent(install)}`,
        ),
    },

    /** The space's locales and what is set per locale (the client's space and environment). */
    locales: {
      /** The space config, every locale's settings resolved (delivered, direction). */
      get: () => get<SpaceLocales>(`${envBase}/space-config`),
      /**
       * Changes the named locales' settings; the others keep theirs. `delivered: false` takes a
       * locale out of Delivery (404 when asked for, skipped by fallbacks and the sitemap) while
       * editors keep writing it. Needs `space:admin`.
       */
      set: (localeSettings: Readonly<Record<string, LocaleSettings>>) =>
        put<SpaceLocales>(`${envBase}/locale-settings`, { localeSettings }),
    },

    environments: {
      list: () => items(get<{ items: unknown[] }>(`${spaceBase}/environments`)),
      create: (id: string, name?: string) =>
        post<{ id: string }>(`${spaceBase}/environments`, { id, name }),
      aliases: {
        list: () => items(get<{ items: unknown[] }>(`${spaceBase}/environment-aliases`)),
        /** Creates or repoints an alias (atomic cutover). */
        set: (alias: string, targetEnvironmentId: string) =>
          put<unknown>(`${spaceBase}/environment-aliases/${e(alias)}`, { targetEnvironmentId }),
        delete: (alias: string) => del<void>(`${spaceBase}/environment-aliases/${e(alias)}`),
      },
    },

    apiKeys: {
      list: () => items(get<{ items: ApiKeySummary[] }>(`${spaceBase}/api-keys`)),
      create: (input: CreateApiKeyInput) => post<CreatedApiKey>(`${spaceBase}/api-keys`, input),
      revoke: (id: string) => del<void>(`${spaceBase}/api-keys/${e(id)}`),
    },
  };
}

export type ManagementClient = ReturnType<typeof createManagementClient>;
