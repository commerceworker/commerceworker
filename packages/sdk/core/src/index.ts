/**
 * @commerceworker/sdk-core — the framework-agnostic Delivery client every channel SDK builds
 * on. Zero runtime dependencies; uses the platform `fetch` (injectable for SSR,
 * edge runtimes, and tests). Talks to the read-only Delivery API with a CDA token.
 */

/** Locale-keyed field values, or flattened values when a locale is requested. */
import { bookmarkTracker } from './bookmark.js';
import { CONTENT_REF_ATTRIBUTE, formatContentRef } from './content-ref.js';
import { imageProps } from './image.js';
import type { DeliveredRedirect, RedirectMatch } from './redirects.js';

export type Fields = Record<string, unknown>;

/** A delivered entry. Generic `F` lets codegen supply a typed field shape. */
export interface DeliveredEntry<F extends Fields = Fields> {
  readonly id: string;
  readonly contentType: string;
  readonly fields: F;
  readonly publishedAt: string;
  /** When the entry was first published (sort with `-sys.firstPublishedAt`); absent when unknown.
   *  Delivery serves no other authorship. */
  readonly firstPublishedAt?: string;
}

/**
 * A delivered asset. Its URLs are on the media origin and immutable: `url` is the original (a
 * hosted video's HLS manifest), `renditions` the space's named presets, `srcset` the width ladder
 * up to the image's own width. Title, description and alt text are one locale's value when a
 * `locale` was asked for, else keyed by locale. From Preview, every URL is short-lived and signed.
 */
export interface DeliveredAsset {
  readonly id: string;
  readonly title: string | Record<string, unknown> | null;
  readonly description: string | Record<string, unknown> | null;
  readonly altText: string | Record<string, unknown> | null;
  readonly focalPoint: { readonly x: number; readonly y: number } | null;
  readonly contentType: string;
  readonly size: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  readonly url: string;
  readonly renditions: Readonly<Record<string, string>>;
  readonly srcset: readonly { readonly width: number; readonly url: string }[];
  /**
   * What to show while a raster image loads, once ingest has computed it (else `null`): its
   * ThumbHash (base64; decode with the `thumbhash` package) and dominant colour (`#rrggbb`).
   */
  readonly placeholder: { readonly thumbhash: string; readonly dominantColor: string } | null;
  readonly video?: {
    readonly status: string;
    readonly hlsUrl?: string;
    readonly dashUrl?: string;
    readonly thumbnailUrl?: string;
    readonly durationSeconds?: number;
  };
  readonly rights?: { readonly credit?: string; readonly license?: string };
  /** The stored file description, kept for older readers; `file.url` is `url`. */
  readonly file: Readonly<Record<string, unknown>>;
}

/** A page of delivered assets; pass `nextCursor` back as `cursor` for the next. */
export interface AssetPage {
  readonly items: DeliveredAsset[];
  readonly total: number;
  readonly nextCursor?: string;
}

/** An asset search: published assets, best match first, with facet counts. */
export interface AssetSearchPage {
  readonly items: DeliveredAsset[];
  readonly total: number;
  readonly facets: {
    readonly kind: Readonly<Record<string, number>>;
    readonly tag: Readonly<Record<string, number>>;
    /** By folder id; `root` for assets in no folder. */
    readonly folder: Readonly<Record<string, number>>;
  };
}

export interface AssetSearchQuery {
  /** 1..100, default 20. */
  readonly limit?: number;
  readonly kind?: DeliveredAsset['kind'];
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder. */
  readonly folder?: string;
  readonly locale?: string;
}

/** A collection as Delivery serves it: its published members, in its order. */
export interface DeliveredCollection {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly items: DeliveredAsset[];
  readonly nextCursor?: string;
}

export interface AssetQuery {
  readonly limit?: number;
  /** `nextCursor` from the previous page. */
  readonly cursor?: string;
  /** Offset paging, without a cursor. */
  readonly skip?: number;
  readonly kind?: DeliveredAsset['kind'];
  /** A taxonomy tag id. */
  readonly tag?: string;
  /** A folder id, or `root` for assets in no folder. */
  readonly folder?: string;
  readonly locale?: string;
}

/**
 * One URL of an asset: the named `rendition` (undefined when the space has none by that name,
 * or the asset isn't a resizable image), the width step at or above `width` (the largest past it;
 * the original when there is no ladder), or the original.
 */
export function assetUrl(
  asset: Pick<DeliveredAsset, 'url' | 'renditions' | 'srcset'>,
  opts: { readonly rendition?: string; readonly width?: number } = {},
): string | undefined {
  if (opts.rendition !== undefined) {
    return Object.hasOwn(asset.renditions, opts.rendition)
      ? asset.renditions[opts.rendition]
      : undefined;
  }
  if (opts.width !== undefined) {
    const width = opts.width;
    const step =
      asset.srcset.find((s) => s.width >= width) ?? asset.srcset[asset.srcset.length - 1];
    return step?.url ?? asset.url;
  }
  return asset.url;
}

/** The asset's width ladder as an `<img srcset>` value (`"… 320w, … 640w"`); empty without one. */
export function srcset(asset: Pick<DeliveredAsset, 'srcset'>): string {
  return asset.srcset.map((s) => `${s.url} ${s.width}w`).join(', ');
}

export interface SearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

export interface ClientOptions {
  /** Base URL of the Delivery API, e.g. https://cms.example.com */
  readonly baseUrl: string;
  readonly space: string;
  readonly environment: string;
  /** Content Delivery API (CDA) token. */
  readonly token: string;
  /** Override fetch (SSR/edge/tests). Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** In-memory response cache TTL (ms). 0 disables. Default 0. */
  readonly cacheTtlMs?: number;
  /**
   * Read from the Preview API (CPA) instead of Delivery, serving drafts as the
   * editor sees them. Also what turns `editable()` on: inline-edit markup is
   * emitted only here, so the same components can ship to production without
   * disclosing entry ids, field names, or that a CMS is behind the page.
   */
  readonly preview?: boolean;
  /** Locale stamped onto refs from `editable()`. Defaults to `'*'`. */
  readonly locale?: string;
  /**
   * Preview only: echo the api's `x-cw-bookmark` so each read is at least as fresh as the last
   * response, or as `bookmark`. Default `true`. Delivery is cached and reads replicas by design,
   * so a Delivery client never sends or keeps a bookmark.
   */
  readonly readYourWrites?: boolean;
  /**
   * Preview only: a bookmark to start from, e.g. the one a server action's write returned
   * (`managementClient.bookmark`), so this client's first read already sees that write.
   */
  readonly bookmark?: string;
}

/**
 * Comparison operators for a field-level filter. `match` is a case-insensitive substring and
 * `startsWith` a case-insensitive prefix; `between` takes `[low, high]` (both inclusive); `ref`
 * (one entry id) and `refIn` (several) match a link field that links to one of those entries.
 */
export type FilterOp =
  | 'eq'
  | 'ne'
  | 'in'
  | 'nin'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'exists'
  | 'match'
  | 'startsWith'
  | 'ref'
  | 'refIn';

/**
 * A single field predicate. `field` is a field apiId, a path into a component (`seo.title`), a
 * `sys.*` pseudo-field, or a taxonomy association: `metadata.tags` / `metadata.concepts` (ids) or
 * `metadata.tags.slug` / `metadata.concepts.slug` (slugs; `eq`, `ne`, `in`, `nin`).
 */
export interface EntryFilter {
  readonly field: string;
  readonly op?: FilterOp;
  readonly value?: unknown;
}

/**
 * A condition of a `where` tree: a field predicate, or an AND or OR group of conditions. At most
 * 4 groups deep and 20 predicates; slug filters stay top-level `filters`.
 */
export type EntryWhere =
  | EntryFilter
  | { readonly and: readonly EntryWhere[] }
  | { readonly or: readonly EntryWhere[] };

export interface EntryQuery {
  readonly contentType?: string;
  readonly locale?: string;
  /** Reference resolution depth (embeds linked entries). */
  readonly include?: number;
  readonly limit?: number;
  /** Delivery's offset. Preview pages by `cursor` instead, and refuses it (422). */
  readonly skip?: number;
  /**
   * Preview only: the `nextCursor` of the previous page, with the same filters and order. It walks
   * the list's own order; in the default order an entry edited between two pages is never skipped.
   */
  readonly cursor?: string;
  /** Delta cursor — only entries published after this ISO timestamp. */
  readonly since?: string;
  /** Field-level predicates (all must match). */
  readonly filters?: readonly EntryFilter[];
  /** AND/OR groups of predicates, ANDed with `filters` (sent as the `where` parameter). */
  readonly where?: EntryWhere;
  /** Only entries with a link to one of these entry ids, from any field. */
  readonly linksToEntry?: readonly string[];
  /** Sort keys, e.g. `['fields.title', '-sys.publishedAt']`. */
  readonly order?: readonly string[];
  /** Projection — return only these field apiIds. */
  readonly select?: readonly string[];
  /** Full-text search over string fields. */
  readonly search?: string;
  /** Only entries carrying a tag with one of these slugs (an archive page). */
  readonly tags?: readonly string[];
}

/** A tag as Delivery serves it, for archive pages. */
export interface DeliveredTag {
  readonly id: string;
  readonly slug: string;
  /** In the requested locale (with the space's fallbacks), or the default locale's. */
  readonly label: string;
  /** Every locale's label, the default's included; only when no locale was requested. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly description: string | null;
  /** Published entries carrying it (of `contentType` only, when one was asked for). */
  readonly count: number;
  readonly countsByContentType: Readonly<Record<string, number>>;
}

/** A concept as Delivery serves it: a tag's shape, plus its scheme and parent. */
export interface DeliveredConcept extends DeliveredTag {
  readonly schemeId: string;
  readonly broaderId: string | null;
}

/** A navigation menu item as Delivery serves it: resolved for one locale, ready to render. */
export interface DeliveredMenuItem {
  readonly id: string;
  readonly label: string;
  /** Where it goes; null for a term link (route a term by its slug). */
  readonly url: string | null;
  readonly target?: '_blank';
  /** `rel`, `title`, `class`, `aria-label` or `data-*`, to set on the link. */
  readonly attrs?: Readonly<Record<string, string>>;
  /** The published entry an entry link resolved to. */
  readonly entry?: { readonly id: string; readonly contentType: string };
  /** The taxonomy term a term link resolved to. */
  readonly term?: {
    readonly kind: 'tag' | 'concept';
    readonly id: string;
    readonly slug: string;
    readonly schemeId?: string;
  };
  readonly children: readonly DeliveredMenuItem[];
}

/** A navigation menu, resolved: published entries only, dangling items dropped. */
export interface DeliveredMenu {
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
  readonly locale: string;
  readonly items: readonly DeliveredMenuItem[];
}

export interface DeliveredMenuSummary {
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
}

/** A published content type's place on the site, as Delivery serves it. */
export interface DeliveredRoute {
  /** The content type's apiId. */
  readonly contentType: string;
  /** e.g. `/blog/{slug}`: placeholders are `{id}`, `{locale}` or one of the type's Slug fields. */
  readonly urlPattern: string;
}

/** A published entry in the sitemap: where it lives, in each locale it lives at. */
export interface DeliveredSitemapEntry {
  readonly entryId: string;
  /** The content type's apiId. */
  readonly contentType: string;
  /** When its live version was published (ISO-8601). */
  readonly lastmod: string;
  /** One per locale; alternates of each other (`hreflang`) when more than one. */
  readonly urls: readonly { readonly path: string; readonly locale: string }[];
}

export interface SitemapPage {
  readonly items: DeliveredSitemapEntry[];
  /** Pass as `from` for the next page; null on the last. */
  readonly next: string | null;
}

export interface SitemapQuery {
  /** `next` from the previous page. */
  readonly from?: string;
  /** Entries per page, 1..5000 (default 1000). */
  readonly limit?: number;
  /**
   * The site's URL: an entry whose absolute canonical URL is elsewhere (another site, or outside
   * its path) is left out.
   */
  readonly base?: string;
}

export interface TermQuery {
  /** Resolve labels for one locale. */
  readonly locale?: string;
  /** Count published entries of this content type only. */
  readonly contentType?: string;
}

/**
 * A failed request. `message` and `body` hold the server's text: render them as text, never HTML.
 * `code` is the API's machine-readable error code (`not_found`,
 * `validation_failed`, …) when the body names one, and `body` the parsed JSON body (`undefined`
 * when it wasn't JSON). The delivery gateway's own refusals (`401`, `429`) carry no code.
 */
export class DeliveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** `{ error: { code, message } }` from the api, `{ error: 'message' }` from the gateway. */
async function deliveryError(res: Response, url: string): Promise<DeliveryError> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  const error = (body as { error?: unknown } | undefined)?.error;
  const detail =
    typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown } | undefined)?.message === 'string'
        ? (error as { message: string }).message
        : undefined;
  const code = (error as { code?: unknown } | undefined)?.code;
  return new DeliveryError(
    res.status,
    `Delivery request failed: ${res.status} ${url}${detail ? ` (${detail.slice(0, 200)})` : ''}`,
    typeof code === 'string' ? code : undefined,
    body,
  );
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

/** Creates a Delivery client bound to one space/environment. */
export function createDeliveryClient(opts: ClientOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const ttl = opts.cacheTtlMs ?? 0;
  const cache = new Map<string, CacheEntry>();
  const surface = opts.preview ? 'preview' : 'delivery';
  const base = `${opts.baseUrl.replace(/\/$/, '')}/${surface}/${opts.space}/${opts.environment}`;
  const bookmarks = bookmarkTracker(
    opts.baseUrl,
    opts.bookmark,
    opts.preview === true && opts.readYourWrites !== false,
  );

  async function get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const url = `${base}${path}${qs.toString() ? `?${qs}` : ''}`;

    if (ttl > 0) {
      const hit = cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value as T;
    }

    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${opts.token}`, ...bookmarks.headersFor(url) },
    });
    bookmarks.record(res);
    if (!res.ok) throw await deliveryError(res, url);
    const value = (await res.json()) as T;
    if (ttl > 0) cache.set(url, { expires: Date.now() + ttl, value });
    return value;
  }

  async function* pages(
    first: string | undefined,
    page: (cursor: string | undefined) => Promise<{ items: DeliveredAsset[]; nextCursor?: string }>,
  ): AsyncGenerator<DeliveredAsset, void, undefined> {
    const seen = new Set<string>(first ? [first] : []);
    let cursor = first;
    for (;;) {
      const res = await page(cursor);
      yield* res.items;
      if (!res.nextCursor) return;
      // A cursor that comes back again would page forever; the server never does that.
      if (seen.has(res.nextCursor)) {
        throw new Error(`Delivery returned cursor ${res.nextCursor} twice`);
      }
      seen.add(res.nextCursor);
      cursor = res.nextCursor;
    }
  }

  const getCollection = (
    id: string,
    o: { limit?: number; cursor?: string; locale?: string } = {},
  ): Promise<DeliveredCollection> =>
    get<DeliveredCollection>(`/collections/${encodeURIComponent(id)}`, {
      limit: o.limit,
      cursor: o.cursor,
      locale: o.locale,
    });

  const listAssets = (q: AssetQuery = {}): Promise<AssetPage> =>
    get<AssetPage>('/assets', {
      limit: q.limit,
      cursor: q.cursor,
      skip: q.cursor ? undefined : q.skip,
      kind: q.kind,
      tag: q.tag,
      folder: q.folder,
      locale: q.locale,
    });

  return {
    /**
     * The newest `x-cw-bookmark` this preview client has seen (or was given), sent with its next
     * request; hand it to another client to carry read-your-writes across. Assigning replaces it,
     * `undefined` clears it, and a value that isn't a D1 bookmark is dropped. Always `undefined`
     * on a Delivery client or with `readYourWrites: false`.
     */
    get bookmark(): string | undefined {
      return bookmarks.current;
    },
    set bookmark(value: string | undefined) {
      bookmarks.current = value;
    },

    /** Fetch a single published entry by id. */
    async getEntry<F extends Fields = Fields>(
      id: string,
      o: Pick<EntryQuery, 'locale' | 'include'> = {},
    ): Promise<DeliveredEntry<F>> {
      return get<DeliveredEntry<F>>(`/entries/${encodeURIComponent(id)}`, {
        locale: o.locale,
        include: o.include,
      });
    },

    /**
     * The one entry of a singleton content type (site settings, a home page) by the type's apiId:
     * published, or from Preview as it is now. A 404 `DeliveryError` when the type is not a
     * singleton or has no such entry. Preview ignores `include`.
     */
    async getSingleton<F extends Fields = Fields>(
      contentType: string,
      o: Pick<EntryQuery, 'locale' | 'include'> = {},
    ): Promise<DeliveredEntry<F>> {
      return get<DeliveredEntry<F>>(`/singletons/${encodeURIComponent(contentType)}`, {
        locale: o.locale,
        include: o.include,
      });
    },

    /**
     * List published entries (from Preview: as they are now, drafts included), optionally
     * filtered/paginated. Preview answers `nextCursor` while another page follows.
     */
    async listEntries<F extends Fields = Fields>(
      q: EntryQuery = {},
    ): Promise<{ items: DeliveredEntry<F>[]; total: number; nextCursor?: string }> {
      return get('/entries', toParams(q));
    },

    /** Every tag, by slug, with its label, description and published-entry counts (Delivery). */
    async listTags(q: TermQuery = {}): Promise<DeliveredTag[]> {
      const res = await get<{ items: DeliveredTag[] }>('/taxonomy/tags', termParams(q));
      return res.items;
    },

    /** One tag by slug, for an archive page's heading (a 404 `DeliveryError` when none has it). */
    async getTag(slug: string, q: TermQuery = {}): Promise<DeliveredTag> {
      return get<DeliveredTag>(`/taxonomy/tags/${encodeURIComponent(slug)}`, termParams(q));
    },

    /** Every concept (of one scheme, with `scheme`), by slug, with its counts (Delivery). */
    async listConcepts(q: TermQuery & { scheme?: string } = {}): Promise<DeliveredConcept[]> {
      const res = await get<{ items: DeliveredConcept[] }>('/taxonomy/concepts', {
        ...termParams(q),
        scheme: q.scheme,
      });
      return res.items;
    },

    /** One concept by slug; pass `scheme` when two schemes share the slug (a 409 otherwise). */
    async getConcept(
      slug: string,
      q: TermQuery & { scheme?: string } = {},
    ): Promise<DeliveredConcept> {
      return get<DeliveredConcept>(`/taxonomy/concepts/${encodeURIComponent(slug)}`, {
        ...termParams(q),
        scheme: q.scheme,
      });
    },

    /** Fetch a single published asset by id (from Preview: as it is now, drafts included). */
    async getAsset(id: string, o: { locale?: string } = {}): Promise<DeliveredAsset> {
      return get<DeliveredAsset>(`/assets/${encodeURIComponent(id)}`, { locale: o.locale });
    },

    /**
     * A collection's published assets in its order (drafts and archived members left out), a
     * page at a time. Delivery only.
     */
    getCollection,

    /**
     * Every published member of a collection, in its order, fetching a page (`limit`) at a time
     * as the loop asks for more: `for await (const asset of client.iterateCollection(id)) …`.
     */
    iterateCollection(
      id: string,
      o: { limit?: number; cursor?: string; locale?: string } = {},
    ): AsyncGenerator<DeliveredAsset, void, undefined> {
      return pages(o.cursor, (cursor) => getCollection(id, { ...o, cursor }));
    },

    /** List published assets, a page at a time (pass `nextCursor` back as `cursor`). */
    listAssets,

    /**
     * Every published asset the query matches, following `nextCursor` a page (`limit`) at a
     * time as the loop asks for more: `for await (const asset of client.iterateAssets({ kind:
     * 'image' })) …`. A `skip` applies to the first page only.
     */
    iterateAssets(q: AssetQuery = {}): AsyncGenerator<DeliveredAsset, void, undefined> {
      return pages(q.cursor, (cursor) =>
        listAssets(cursor ? { ...q, cursor, skip: undefined } : q),
      );
    },

    /**
     * Searches published assets (file name, title, caption, alt text, tags, document text; full
     * text and semantic, fused by rank). Delivery only: Preview has no asset search.
     */
    async searchAssets(query: string, q: AssetSearchQuery = {}): Promise<AssetSearchPage> {
      return get<AssetSearchPage>('/assets', {
        q: query,
        limit: q.limit,
        kind: q.kind,
        tag: q.tag,
        folder: q.folder,
        locale: q.locale,
      });
    },

    /** {@link assetUrl}, for convenience. */
    assetUrl,

    /** {@link srcset}, for convenience. */
    srcset,

    /** {@link imageProps}, for convenience. */
    imageProps,

    /** Semantic search over published content. */
    async search(query: string, o: { topK?: number } = {}): Promise<SearchHit[]> {
      const res = await get<{ hits: SearchHit[] }>('/search', { q: query, top_k: o.topK });
      return res.hits;
    },

    /**
     * Every enabled redirect, by source: the set a front end applies (commerceworker serves no
     * site). Match requests with `createRedirectHandler` or `createRedirectMatcher` from
     * `@commerceworker/sdk-core/redirects`. Delivery only.
     */
    async redirects(): Promise<DeliveredRedirect[]> {
      return (await get<{ items: DeliveredRedirect[] }>('/redirects', {})).items;
    },

    /**
     * Where each published content type's entries live on the site (its `urlPattern`, e.g.
     * `/blog/{slug}`), by content type: route pages from the content model instead of
     * hard-coding them. A key limited to some content types gets only theirs. Delivery only.
     */
    async routes(): Promise<DeliveredRoute[]> {
      return (await get<{ items: DeliveredRoute[] }>('/routes', {})).items;
    },

    /** Every navigation menu's handle and name: which ones to ask for. Delivery only. */
    async menus(): Promise<DeliveredMenuSummary[]> {
      return (await get<{ items: DeliveredMenuSummary[] }>('/menus', {})).items;
    },

    /**
     * One navigation menu by handle (`main`, `footer`), resolved for a locale: entry links carry
     * the published entry's URL (its type's `urlPattern`) and an item whose entry isn't published
     * is dropped, its children lifted into its place. Throws a 404 `DeliveryError` for a handle
     * no menu has. Delivery only.
     */
    async menu(handle: string, o: { readonly locale?: string } = {}): Promise<DeliveredMenu> {
      return get<DeliveredMenu>(`/menus/${encodeURIComponent(handle)}`, { locale: o.locale });
    },

    /**
     * A page of the sitemap: published entries of every routable content type, each with its
     * paths per locale and `lastmod`; noindex pages and pages canonical elsewhere are left out.
     * Page with `next`. For crawlers, proxy `/sitemap.xml?base=<your site>` instead. Delivery only.
     */
    async sitemap(query: SitemapQuery = {}): Promise<SitemapPage> {
      return get<SitemapPage>('/sitemap', {
        from: query.from,
        limit: query.limit,
        base: query.base,
      });
    },

    /**
     * Where a path is redirected (the request path, with or without its query), or null when
     * nothing redirects it. One request per path: to apply redirects to every request, fetch the
     * set once with `redirects()` instead. Delivery only.
     */
    async resolveRedirect(
      path: string,
      o: { readonly locale?: string } = {},
    ): Promise<RedirectMatch | null> {
      try {
        return await get<RedirectMatch>('/redirects/resolve', { path, locale: o.locale });
      } catch (err) {
        if (err instanceof DeliveryError && err.status === 404) return null;
        throw err;
      }
    },

    /** Chainable query builder for entries. */
    query: () => new EntryQueryBuilder<Fields>((q) => get('/entries', toParams(q))),

    /**
     * Attributes marking a rendered value as the field it came from, to be
     * spread onto the element that renders it:
     *
     * ```tsx
     * <h1 {...client.editable(entry, 'title')}>{entry.fields.title}</h1>
     * ```
     *
     * Outside preview this is an empty object, so the call is inert in
     * production rather than something to strip before deploying.
     */
    editable(
      entry: Pick<DeliveredEntry, 'id' | 'contentType'>,
      field: string,
      o: { locale?: string } = {},
    ): Record<string, string> {
      if (!opts.preview) return {};
      return {
        [CONTENT_REF_ATTRIBUTE]: formatContentRef({
          space: opts.space,
          environment: opts.environment,
          entryId: entry.id,
          contentType: entry.contentType,
          field,
          locale: o.locale ?? opts.locale ?? '*',
        }),
      };
    },

    /** Clears the in-memory response cache. */
    clearCache: () => cache.clear(),
  };
}

const termParams = (q: TermQuery) => ({ locale: q.locale, content_type: q.contentType });

function toParams(q: EntryQuery): Record<string, string | number | undefined> {
  const params: Record<string, string | number | undefined> = {
    content_type: q.contentType,
    locale: q.locale,
    include: q.include,
    limit: q.limit,
    skip: q.skip,
    cursor: q.cursor,
    since: q.since,
  };
  for (const f of q.filters ?? []) {
    const path =
      f.field.startsWith('sys.') || f.field.startsWith('metadata.') ? f.field : `fields.${f.field}`;
    const op = f.op ?? 'eq';
    const key = op === 'eq' ? path : `${path}[${op}]`;
    const value = Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '');
    params[key] = value;
  }
  if (q.where) params.where = JSON.stringify(q.where);
  if (q.linksToEntry?.length) params.links_to_entry = q.linksToEntry.join(',');
  if (q.tags?.length) params['metadata.tags.slug[in]'] = q.tags.join(',');
  if (q.order?.length) params.order = q.order.join(',');
  if (q.select?.length) params.select = q.select.join(',');
  if (q.search) params.query = q.search;
  return params;
}

/** Fluent entry query: `client.query().contentType('article').locale('en-US').limit(10).fetch()`. */
export class EntryQueryBuilder<F extends Fields> {
  private q: EntryQuery = {};
  constructor(
    private readonly run: (q: EntryQuery) => Promise<{ items: DeliveredEntry<F>[]; total: number }>,
  ) {}
  contentType(apiId: string): this {
    this.q = { ...this.q, contentType: apiId };
    return this;
  }
  locale(code: string): this {
    this.q = { ...this.q, locale: code };
    return this;
  }
  include(depth: number): this {
    this.q = { ...this.q, include: depth };
    return this;
  }
  limit(n: number): this {
    this.q = { ...this.q, limit: n };
    return this;
  }
  skip(n: number): this {
    this.q = { ...this.q, skip: n };
    return this;
  }
  /** Add a field predicate, e.g. `.where('views', 'gt', 100)`. Defaults to `eq`. */
  where(field: string, op: FilterOp, value?: unknown): this;
  where(field: string, value: unknown): this;
  where(field: string, ...rest: unknown[]): this {
    const filter: EntryFilter =
      rest.length >= 2
        ? { field, op: rest[0] as FilterOp, value: rest[1] }
        : { field, op: 'eq', value: rest[0] };
    this.q = { ...this.q, filters: [...(this.q.filters ?? []), filter] };
    return this;
  }
  /**
   * Only entries whose link field links to one of these entries:
   * `.references('author', authorId)`. Throws without an id.
   */
  references(field: string, ...ids: string[]): this {
    // No ids would send an empty filter the API refuses: say so here, where the mistake is.
    if (ids.length === 0) throw new TypeError(`references('${field}') needs at least one entry id`);
    return ids.length === 1 ? this.where(field, 'ref', ids[0]) : this.where(field, 'refIn', ids);
  }
  /** Only entries linking to one of these entries from any field: `.linksTo(entryId)`. */
  linksTo(...ids: string[]): this {
    this.q = { ...this.q, linksToEntry: [...(this.q.linksToEntry ?? []), ...ids] };
    return this;
  }
  /**
   * Adds a group that matches when any of its conditions does, ANDed with the rest:
   * `.or({ field: 'title', op: 'startsWith', value: 'A' }, { field: 'views', op: 'gt', value: 9 })`.
   */
  or(...conditions: EntryWhere[]): this {
    const group: EntryWhere = { or: conditions };
    const where = this.q.where;
    // Each call joins one root AND rather than nesting another, so chaining `.or()` never
    // deepens the tree past what the API accepts.
    const root =
      where && 'and' in where && Object.keys(where).length === 1
        ? { and: [...where.and, group] }
        : where
          ? { and: [where, group] }
          : group;
    this.q = { ...this.q, where: root };
    return this;
  }
  /** Only entries carrying a tag with one of these slugs: `.tagged('news')`. */
  tagged(...slugs: string[]): this {
    this.q = { ...this.q, tags: [...(this.q.tags ?? []), ...slugs] };
    return this;
  }
  /** Set sort keys, e.g. `.order('fields.title', '-sys.publishedAt')`. */
  order(...keys: string[]): this {
    this.q = { ...this.q, order: keys };
    return this;
  }
  /** Project to a subset of field apiIds. */
  select(...fields: string[]): this {
    this.q = { ...this.q, select: fields };
    return this;
  }
  /** Full-text search over string fields. */
  search(text: string): this {
    this.q = { ...this.q, search: text };
    return this;
  }
  fetch(): Promise<{ items: DeliveredEntry<F>[]; total: number }> {
    return this.run(this.q);
  }
}

export type DeliveryClient = ReturnType<typeof createDeliveryClient>;

export {
  adminEditUrl,
  CONTENT_REF_ATTRIBUTE,
  type ContentRef,
  formatContentRef,
  parseContentRef,
} from './content-ref.js';
export { type EmbedCard, type EmbedData, type EmbedKind, embedCard } from './embed.js';
export {
  type ImageProps,
  type ImagePropsOptions,
  imageProps,
  localizedText,
} from './image.js';
export type { DeliveredRedirect, RedirectMatch } from './redirects.js';
