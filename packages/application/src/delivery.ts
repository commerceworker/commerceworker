import { createHash } from 'node:crypto';
import type {
  AssetRendition,
  DeliveredAsset,
  DomainEvent,
  LocaleConfig,
} from '@commerceworker/domain';
import {
  canAccessContentType,
  deniedFieldsFor,
  fallbackChain,
  isLocaleDelivered,
  MAX_RICH_TEXT_DEPTH,
  maskDeniedFields,
  NotFoundError,
  type Principal,
  resolveLocalizedValue,
  type Scope,
  withoutUndeliveredLocales,
} from '@commerceworker/domain';
import type {
  EntryQuery,
  PublishedAsset,
  PublishedEntry,
  SpaceConfig,
} from '@commerceworker/ports';
import { projectionContextOf, projectPublishedAsset } from './asset-delivery';
import {
  type AppContext,
  DEFAULT_DELIVERY_CACHE_TTL_SECONDS,
  DEFAULT_DELIVERY_LIST_TTL_SECONDS,
} from './context';
import { assertDeliveredLocale, type DeliveryReads, deliveryReads } from './delivery-reads';
import { usesReferenceFilters } from './entry-query';
import { cacheTag, contentTypeTag, epochTag } from './events/dispatch';
import { hasSlugFilters, resolveSlugFilters, slugFilterSlugs } from './taxonomy-delivery';

export interface RenderOptions {
  /** When set, fields are flattened to this locale with fallback. */
  readonly locale?: string;
  /** Reference resolution depth (0 = none). Bounded by MAX_INCLUDE. */
  readonly include?: number;
  /**
   * The request's reads, when it has some already: a GraphQL request that read the space config
   * for its schema passes them, so rendering doesn't read it again (see {@link DeliveryReads}).
   */
  readonly reads?: DeliveryReads;
}

/** A delivered entry as returned to channels. Link fields may be embedded. */
export interface DeliveredEntry {
  readonly id: string;
  readonly contentType: string;
  readonly fields: Record<string, unknown>;
  readonly publishedAt: string;
  /**
   * When the entry was first published, when known. The only authorship Delivery serves: who
   * created or changed an entry names people and keys, which a public read has no business seeing.
   */
  readonly firstPublishedAt?: string;
  /** Taxonomy associations (tags + concepts), when the entry has any. */
  readonly metadata?: { readonly tags: readonly string[]; readonly concepts: readonly string[] };
}

const MAX_INCLUDE = 5;

function spaceConfig(scope: Scope, config: SpaceConfig | null | undefined): SpaceConfig {
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config;
}

/** The locales a space turns off, for a store query to skip (nothing when it delivers them all). */
const hiddenLocalesOf = (config: SpaceConfig): { hiddenLocales?: string[] } => {
  const hidden = Object.keys(config.localeSettings ?? {}).filter(
    (l) => !isLocaleDelivered(config, l),
  );
  return hidden.length > 0 ? { hiddenLocales: hidden } : {};
};

const toLocaleConfig = (s: SpaceConfig): LocaleConfig => ({
  defaultLocale: s.defaultLocale,
  locales: s.locales,
  fallbacks: s.fallbacks,
  localeSettings: s.localeSettings,
});

function isEntryLink(value: unknown): value is { id: string; linkType: 'Entry' } {
  const l = value as { id?: unknown; linkType?: unknown };
  return typeof l?.id === 'string' && l.linkType === 'Entry';
}

function isAssetLink(value: unknown): value is { id: string; linkType: 'Asset' } {
  const l = value as { id?: unknown; linkType?: unknown };
  return typeof l?.id === 'string' && l.linkType === 'Asset';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * How far the link walk descends into one field value. Links sit in arrays, in
 * Component values (at most three deep) and in rich text, where a reference
 * node's link is `data.target` and every node level costs two steps (the node,
 * its `content` array). Validation caps rich-text nesting, so this only stops
 * a pathological stored JSON value from overflowing the stack.
 */
const MAX_VALUE_DEPTH = 2 * MAX_RICH_TEXT_DEPTH + 16;

/** Everything the (pure) render pass may need, fetched up front in batches. */
interface Prefetched {
  readonly entries: Map<string, PublishedEntry>;
  readonly assets: Map<string, PublishedAsset>;
  /** Projects an embedded asset the way Delivery serves one on its own. */
  readonly projectAsset: (snapshot: PublishedAsset) => DeliveredAsset;
}

/**
 * Collects every entry/asset link id in a snapshot's fields (all locales):
 * direct links, links in arrays, in Component values and in rich-text
 * reference nodes (`data.target`). Detection is structural, like `render`'s,
 * so the prefetch covers exactly what the render can embed.
 */
function collectLinkIds(snapshot: PublishedEntry, entryIds: Set<string>, assetIds: Set<string>) {
  const scan = (value: unknown, level: number): void => {
    if (level > MAX_VALUE_DEPTH) return;
    if (Array.isArray(value)) {
      for (const v of value) scan(v, level + 1);
      return;
    }
    if (isEntryLink(value)) entryIds.add(value.id);
    else if (isAssetLink(value)) assetIds.add(value.id);
    else if (isPlainObject(value)) for (const v of Object.values(value)) scan(v, level + 1);
  };
  for (const localized of Object.values(snapshot.fields)) {
    for (const v of Object.values(localized)) scan(v, 0);
  }
}

/**
 * Breadth-first batched prefetch of everything `render` can embed from `roots`
 * within `depth` levels: ONE read per level (entries and assets together, one
 * round trip) instead of one point read per link. Fetching all locales' links
 * is a slight superset of what a locale-flattened render embeds — over-fetch,
 * never under.
 *
 * The rendition presets embedded assets are projected with ride along with the
 * first level that asks for an asset, rather than costing a round trip of their
 * own after the walk (read once per request, see {@link DeliveryReads}).
 */
async function prefetchLinked(
  ctx: AppContext,
  scope: Scope,
  roots: readonly PublishedEntry[],
  depth: number,
  opts: RenderOptions,
  reads: DeliveryReads,
  config: SpaceConfig,
): Promise<Prefetched> {
  const entries = new Map<string, PublishedEntry>(roots.map((r) => [r.entryId, r]));
  const assets = new Map<string, PublishedAsset>();
  let renditions: readonly AssetRendition[] = [];
  let frontier: readonly PublishedEntry[] = roots;
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const entryIds = new Set<string>();
    const assetIds = new Set<string>();
    for (const snapshot of frontier) collectLinkIds(snapshot, entryIds, assetIds);
    const newEntryIds = [...entryIds].filter((id) => !entries.has(id));
    const newAssetIds = [...assetIds].filter((id) => !assets.has(id));
    if (newEntryIds.length === 0 && newAssetIds.length === 0) break;
    const fetched = await reads.read(scope, {
      ...(newEntryIds.length > 0 ? { entryIds: newEntryIds } : {}),
      ...(newAssetIds.length > 0 ? { assetIds: newAssetIds, renditions: true } : {}),
    });
    for (const a of fetched.assets ?? []) assets.set(a.assetId, a);
    if (fetched.renditions) renditions = fetched.renditions;
    const fetchedEntries = fetched.entries ?? [];
    for (const e of fetchedEntries) entries.set(e.entryId, e);
    frontier = fetchedEntries;
  }
  const pc = projectionContextOf(scope, renditions, opts.locale, config, reads.everyLocale);
  return {
    entries,
    assets,
    projectAsset: (snapshot) => projectPublishedAsset(ctx, scope, snapshot, pc),
  };
}

/**
 * Renders a published snapshot for delivery: applies locale flattening and
 * recursively embeds linked entries up to `include` depth, reading only from
 * the {@link Prefetched} maps (pure — no I/O). A `seen` set guards against
 * reference cycles — a revisited link is left as a `{ id, linkType }` stub
 * rather than recursing forever.
 *
 * A link is resolved wherever it sits: a field, an array element, a Component
 * value, or a rich-text reference node, whose `data.target` becomes the
 * embedded entry or asset in the same shape a Link field gets. The node keeps
 * its `nodeType`, so a renderer still knows a block embed from an inline link.
 */
function render(
  scope: Scope,
  snapshot: PublishedEntry,
  config: SpaceConfig,
  opts: RenderOptions,
  depth: number,
  seen: Set<string>,
  collected: Set<string>,
  fetched: Prefetched,
): DeliveredEntry {
  collected.add(snapshot.entryId);
  const localeCfg = toLocaleConfig(config);
  const resolveValue = (value: unknown, level: number): unknown => {
    if (level > MAX_VALUE_DEPTH) return value;
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, level + 1));
    if (isEntryLink(value)) {
      if (seen.has(value.id)) return value; // a cycle — leave the stub
      const target = fetched.entries.get(value.id);
      if (!target) return value; // dangling/unpublished link — leave the stub
      return render(
        scope,
        target,
        config,
        opts,
        depth - 1,
        new Set([...seen, value.id]),
        collected,
        fetched,
      );
    }
    if (isAssetLink(value)) {
      const asset = fetched.assets.get(value.id);
      if (!asset) return value; // unpublished asset — leave the stub
      return fetched.projectAsset(asset);
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, resolveValue(v, level + 1)]),
      );
    }
    return value;
  };
  // At include 0 nothing embeds, so values pass through without being copied.
  const resolve = (value: unknown): unknown => (depth > 0 ? resolveValue(value, 0) : value);

  const fields: Record<string, unknown> = {};
  for (const [apiId, localized] of Object.entries(snapshot.fields)) {
    if (opts.locale) {
      const resolved = resolveLocalizedValue(localized, localeCfg, opts.locale);
      if (resolved !== undefined) fields[apiId] = resolve(resolved);
    } else {
      const perLocale: Record<string, unknown> = {};
      for (const [loc, v] of Object.entries(localized)) {
        // A locale the space doesn't deliver is edited and previewed, never served.
        if (isLocaleDelivered(localeCfg, loc)) perLocale[loc] = resolve(v);
      }
      fields[apiId] = perLocale;
    }
  }

  return {
    id: snapshot.entryId,
    contentType: snapshot.contentTypeApiId,
    fields,
    publishedAt: snapshot.publishedAt,
    ...(snapshot.firstPublishedAt ? { firstPublishedAt: snapshot.firstPublishedAt } : {}),
    ...(snapshot.metadata
      ? { metadata: { tags: snapshot.metadata.tags, concepts: snapshot.metadata.concepts } }
      : {}),
  };
}

const clampDepth = (n: number | undefined) => Math.min(Math.max(0, n ?? 0), MAX_INCLUDE);

/**
 * Read path for the Delivery API. Reads only denormalized published snapshots
 * (never version history), then renders them with locale + reference resolution.
 */
export async function getPublishedEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: RenderOptions = {},
): Promise<DeliveredEntry> {
  const depth = clampDepth(opts.include);
  // `del2`: renders embed the delivered asset shape, so ones cached before it are never read.
  const key = `commerceworker:del2:${scope.spaceId}:${scope.environmentId}:${id}:l=${opts.locale ?? ''}:i=${depth}`;

  if (ctx.cache) {
    const hit = await ctx.cache.get(key);
    if (hit) return JSON.parse(hit) as DeliveredEntry;
  }

  // The snapshot and the space config: one round trip.
  const reads = opts.reads ?? deliveryReads(ctx);
  const read = await reads.read(scope, { entryId: id, config: true });
  const config = spaceConfig(scope, read.config);
  assertDeliveredLocale(config, opts.locale);
  const snapshot = read.entry;
  if (!snapshot) throw new NotFoundError('PublishedEntry', id);
  const collected = new Set<string>();
  const fetched = await prefetchLinked(ctx, scope, [snapshot], depth, opts, reads, config);
  const result = render(scope, snapshot, config, opts, depth, new Set([id]), collected, fetched);

  if (ctx.cache) {
    // Tag the cached render with every entry it contains (root + embedded), so a
    // change to any of them evicts this render — even at include depth > 1 —
    // plus the scope epoch tag, so a bulk operation evicts the whole scope
    // with ONE version bump. The TTL is garbage collection, not correctness —
    // except for one narrow race: a render computed from pre-bulk data whose
    // set() lands after the epoch bump snapshots the NEW epoch version and
    // survives tag checks, so the TTL is the staleness ceiling for that window.
    const tags = [epochTag(scope), ...[...collected].map((eid) => cacheTag(scope, eid))];
    await ctx.cache.set(key, JSON.stringify(result), {
      tags,
      ttlSeconds: ctx.deliveryCacheTtlSeconds ?? DEFAULT_DELIVERY_CACHE_TTL_SECONDS,
    });
  }
  return result;
}

/**
 * A singleton type's published entry, rendered as `getPublishedEntry` renders one (`GET
 * …/singletons/:apiId`): the type and its entry in one round trip with the space config, then
 * linked entries per include level. Not found unless `apiId` names a type whose PUBLISHED
 * revision is a singleton (a draft turning the flag on or off changes nothing here until it is
 * published) and that has a published entry, so a client can't read an ordinary type's first
 * entry through it. While a draft that turned the flag off waits to be published, the type can
 * gain more entries (the claim is given back with the draft); Delivery then serves the published
 * one with the lowest entry id, until the turn-off is published.
 *
 * Not kept in this tag cache (`ctx.cache`), but the Delivery Worker's entrypoint caches the
 * response like every other, until the scope's next purge. Everything that changes the answer
 * purges it: the entry's publish or unpublish (trashing unpublishes), and the type's publish or a
 * published save that changes its flag (`content_type.published`), or its delete.
 */
export async function getDeliveredSingleton(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
  opts: RenderOptions = {},
): Promise<DeliveredEntry> {
  const depth = clampDepth(opts.include);
  const reads = opts.reads ?? deliveryReads(ctx);
  const read = await reads.read(scope, { singleton: { contentType: apiId }, config: true });
  const config = spaceConfig(scope, read.config);
  assertDeliveredLocale(config, opts.locale);
  if (!read.singleton?.contentType || !read.singleton.publishedSingleton) {
    throw new NotFoundError('Singleton', apiId);
  }
  const snapshot = read.singleton.entry;
  if (!snapshot) throw new NotFoundError('Published singleton entry', apiId);
  const fetched = await prefetchLinked(ctx, scope, [snapshot], depth, opts, reads, config);
  return render(
    scope,
    snapshot,
    config,
    opts,
    depth,
    new Set([snapshot.entryId]),
    new Set(),
    fetched,
  );
}

/**
 * The locale-preference chain used for query field resolution, passed to the
 * store so filtering/ordering/search resolve the same locale on every backend
 * (jsonb key order is not insertion order).
 *
 * Delegates to the domain's `fallbackChain` — the ONE implementation of this
 * rule — and drops its head, because `comparableValue` tries the requested
 * locale itself first. Sharing it with `resolveLocalizedValue` is what keeps a
 * filter from matching a locale the rendered response would never contain.
 */
export function localeFallbackChain(config: SpaceConfig, locale: string): string[] {
  const chain = fallbackChain(toLocaleConfig(config), locale);
  // The chain's head is the requested locale — except when `locale` is empty
  // (a client can send `?locale=`), where the domain walker emits only the
  // default. Slice only what is actually the head, so the default locale is
  // never dropped from the preference list.
  return chain[0] === locale ? chain.slice(1) : chain;
}

/**
 * Cache key for a list result. The query is canonicalized (keys sorted at
 * every level) before hashing so semantically identical queries from REST,
 * GraphQL and MCP share one entry regardless of property order.
 *
 * `renderLocale` is the RAW `opts.locale`, not the resolved one, and it is
 * load-bearing: `render` branches on its presence to emit either
 * locale-flattened fields or per-locale maps. Keying only on the resolved
 * locale would let a flattened render be served to a caller that asked for all
 * locales (and vice versa) — different response SHAPES sharing one entry.
 */
function listCacheKey(
  scope: Scope,
  query: EntryQuery,
  locale: string,
  depth: number,
  renderLocale: string | undefined,
): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical({ ...query, locale })))
    .digest('hex')
    .slice(0, 32);
  return `commerceworker:dlist2:${scope.spaceId}:${scope.environmentId}:${digest}:l=${renderLocale ?? ''}:i=${depth}`;
}

/**
 * Whether a list query's result is worth caching.
 *
 * Delta cursors are excluded: each distinct cursor mints a new key that is
 * unlikely to ever be read again, so caching them only churns the backend.
 *
 * Untyped queries are excluded too, and that one is about CORRECTNESS: list
 * results are invalidated by content-type tags, so a query spanning all types
 * has nothing that reliably bumps when some other type publishes. The
 * alternative — a scope-wide "any publish" tag — would be written on every
 * single publish and become a hot key (KV allows ~1 write/s/key), so typed
 * queries (the overwhelmingly common shape) get the cache and untyped ones
 * stay correct-but-uncached.
 */
function isCacheableListQuery(query: EntryQuery): boolean {
  if (!query.contentTypeApiId) return false;
  return query.since === undefined && query.after === undefined && query.afterEntryId === undefined;
}

export async function listPublishedEntries(
  ctx: AppContext,
  scope: Scope,
  requested: EntryQuery = {},
  opts: RenderOptions = {},
): Promise<DeliveredEntry[]> {
  const reads = opts.reads ?? deliveryReads(ctx);
  // A filter on a term's slug reads the terms it names alongside the config (same round trip),
  // and becomes a filter on their ids before anything else (the list cache key included) sees it.
  const slugs = hasSlugFilters(requested) ? slugFilterSlugs(requested) : null;
  // A reference filter reads the content model in the same round trip: the store answers it from
  // the links the model declares, as the reference edges do.
  const refs = usesReferenceFilters(requested);
  const first = await reads.read(scope, {
    config: true,
    ...(refs ? { contentTypes: true } : {}),
    ...(slugs?.tags.length ? { tags: { slugs: slugs.tags } } : {}),
    ...(slugs?.concepts.length ? { concepts: { slugs: slugs.concepts } } : {}),
  });
  const config = spaceConfig(scope, first.config);
  assertDeliveredLocale(config, opts.locale);
  assertDeliveredLocale(config, requested.locale);
  const query = slugs
    ? resolveSlugFilters(requested, { tags: first.tags ?? [], concepts: first.concepts ?? [] })
    : requested;
  // Filtering/ordering/search compare against a single resolved locale; default
  // to the requested locale, then the space default.
  const locale = query.locale ?? opts.locale ?? config.defaultLocale;
  const depth = clampDepth(opts.include);
  const cacheable = Boolean(ctx.cache) && isCacheableListQuery(query);
  const key = cacheable ? listCacheKey(scope, query, locale, depth, opts.locale) : '';

  if (cacheable && ctx.cache) {
    const hit = await ctx.cache.get(key);
    // Cached PRE-mask, like the single-entry path: field-level RBAC is applied
    // by the caller, so one cached list serves every principal.
    if (hit) return JSON.parse(hit) as DeliveredEntry[];
  }

  const rows = await ctx.store.entries.listPublished(scope, {
    ...query,
    ...(refs ? { contentTypes: first.contentTypes ?? [] } : {}),
    locale,
    fallbackLocales: localeFallbackChain(config, locale),
    // An undelivered locale's value never decides a filter, an order or a `query=` match.
    ...hiddenLocalesOf(config),
  });
  // One shared prefetch across all rows: N rows × M links costs one batched
  // read per depth level, not N×M point reads.
  const fetched = await prefetchLinked(ctx, scope, rows, depth, opts, reads, config);
  const result = rows.map((s) =>
    render(scope, s, config, opts, depth, new Set([s.entryId]), new Set(), fetched),
  );

  if (cacheable && ctx.cache) {
    // Tagged by CONTENT TYPE, not by member id: a newly published entry
    // changes which rows the list returns without touching any entry already
    // in it, so per-entry tags would never evict it. Every type reachable in
    // the render (queried + embedded) is tagged, so a change to an embedded
    // entry evicts the lists that display it. This over-invalidates (any
    // publish of the type drops the list) but keeps the envelope small —
    // a tag per rendered row would cost a version read per row on every hit.
    const types = new Set<string>([query.contentTypeApiId as string]);
    for (const e of fetched.entries.values()) types.add(e.contentTypeApiId);
    // Links whose target was NOT published at render time rendered as stubs
    // and contributed no ct tag — their type is unknowable from here. Tag them
    // by ENTRY id instead: publishing that entry bumps its per-entry tag and
    // evicts this list, so a stub becomes a real embed on the next read rather
    // than lingering for the whole TTL.
    const linked = new Set<string>();
    const assetIds = new Set<string>();
    for (const e of fetched.entries.values()) collectLinkIds(e, linked, assetIds);
    const unresolved = [...linked].filter((id) => !fetched.entries.has(id));
    await ctx.cache.set(key, JSON.stringify(result), {
      tags: [
        epochTag(scope),
        ...[...types].map((t) => contentTypeTag(scope, t)),
        ...unresolved.map((id) => cacheTag(scope, id)),
      ],
      ttlSeconds: ctx.deliveryListTtlSeconds ?? DEFAULT_DELIVERY_LIST_TTL_SECONDS,
    });
  }
  return result;
}

/** Entries that link to `id` — the reverse-reference graph (for invalidation). */
export async function getReverseReferences(ctx: AppContext, scope: Scope, id: string) {
  return ctx.store.references.findReverse(scope, id);
}

/** Shape test for an entry `render` embedded in place of a link stub. */
function isEmbeddedEntry(value: unknown): value is DeliveredEntry {
  const e = value as Partial<DeliveredEntry> | null;
  return (
    typeof e === 'object' &&
    e !== null &&
    !Array.isArray(e) &&
    typeof e.id === 'string' &&
    typeof e.contentType === 'string' &&
    typeof e.publishedAt === 'string' &&
    typeof e.fields === 'object' &&
    e.fields !== null
  );
}

/**
 * Shape test for an asset `render` embedded in place of an asset link: a delivered asset (`id`,
 * `file`, no `fields` or `publishedAt`, which an embedded entry has). Older cached renders
 * embedded `{ id, file, title, description }`, which this matches too.
 */
function isEmbeddedAsset(value: unknown): value is { id: string } {
  const a = value as { id?: unknown; file?: unknown; fields?: unknown; publishedAt?: unknown };
  return (
    typeof a?.id === 'string' &&
    typeof a.file === 'object' &&
    a.file !== null &&
    a.fields === undefined &&
    a.publishedAt === undefined
  );
}

/**
 * Field-level RBAC over a RENDERED entry, embedded links included: masks the
 * root's denied fields, then walks every place `render` can put an embedded
 * entry (field values, array elements, per-locale maps, Component values and
 * rich-text `data.target`s) and masks each embed by ITS content type — or
 * reverts it to the unresolved `{ id, linkType }` stub when the principal
 * holds no read grant on that type. Must run post-cache: the delivery cache is
 * shared across principals, so a masked render may never be written back.
 *
 * Detection is structural, so a user-authored JSON value shaped exactly like
 * an embedded entry is treated as one — masked or stubbed, never leaked
 * (conservative in the safe direction). No-grants principals pass through
 * untouched.
 */
export function maskDeliveredFields(
  principal: Principal,
  contentType: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (!principal.contentGrants) return fields;
  // Render embeds inside arrays and any plain object, so the walk descends as
  // far — one level past render's cap, because this walk also counts the
  // per-locale map that render's walk starts beneath.
  const walk = (value: unknown, level: number): unknown => {
    if (level > MAX_VALUE_DEPTH + 1) return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, level + 1));
    if (isEmbeddedEntry(value)) {
      if (!canAccessContentType(principal, 'read', value.contentType)) {
        return { id: value.id, linkType: 'Entry' };
      }
      return {
        ...value,
        fields: maskDeliveredFields(principal, value.contentType, value.fields),
      };
    }
    // Granular principals get NO asset access on the delivery surface (the
    // asset endpoints 403 / return null for them) — embedded assets revert
    // to the unresolved link stub for the same policy.
    if (isEmbeddedAsset(value)) {
      return { id: value.id, linkType: 'Asset' };
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, level + 1)]));
    }
    return value;
  };
  const masked = maskDeniedFields(principal, contentType, fields);
  return Object.fromEntries(Object.entries(masked).map(([k, v]) => [k, walk(v, 0)]));
}

/**
 * The search hits `principal` may see: hits on types they can read, and none on a type where they
 * have field restrictions (a hit there may exist only because the query matched a hidden field,
 * and its snippet could quote it), and, for everyone, only hits on entries published now.
 */
export async function visibleSearchHits<T extends { readonly entryId: string }>(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  hits: readonly T[],
): Promise<T[]> {
  if (hits.length === 0) return [];
  // Only entries published now, for every caller: an index (or a vector store) can still hold a
  // document whose entry was unpublished, or whose environment was deleted, and serving its
  // snippet would show content that is no longer delivered. One batched read for the page.
  const live = new Map(
    (await ctx.store.entries.getPublishedMany(scope, [...new Set(hits.map((h) => h.entryId))])).map(
      (p) => [p.entryId, p.contentTypeApiId],
    ),
  );
  return hits.filter((hit) => {
    const contentType = live.get(hit.entryId);
    if (contentType === undefined) return false;
    if (!principal.contentGrants) return true;
    return (
      canAccessContentType(principal, 'read', contentType) &&
      deniedFieldsFor(principal, contentType).length === 0
    );
  });
}

/**
 * The event types the Live Content API carries: facts about published content. Editorial and
 * internal events (workflow runs and tasks, bulk-job control, reindex requests) never reach a
 * delivery subscriber.
 */
export const LIVE_EVENT_TYPES: ReadonlySet<DomainEvent['type']> = new Set([
  'entry.published',
  'entry.unpublished',
  'entries.published_bulk',
  'asset.published',
  'asset.unpublished',
  'content_type.published',
  'content_type.deleted',
  'release.published',
  'environment_alias.changed',
]);

/**
 * An event as the live stream may carry it at all, before any subscriber's access applies: an
 * `entry.published` keeps only the locales the space delivers, as every Delivery read does. The
 * LiveHub object holds no store, so the consumer that fans the event out writes this filtered
 * copy once, reading the space's config only for an entry publish (every other live fact names
 * ids, not text). A space with every locale delivered gets the event unchanged.
 */
export async function liveEventOf(ctx: AppContext, event: DomainEvent): Promise<DomainEvent> {
  if (event.type !== 'entry.published') return event;
  const config = await ctx.store.spaces.getConfig(event.scope);
  if (!config?.localeSettings) return event;
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [apiId, localized] of Object.entries(event.fields)) {
    fields[apiId] = withoutUndeliveredLocales(localized, config);
  }
  return { ...event, fields: fields as typeof event.fields };
}

/**
 * What `principal` may see of `event` on the live stream, or null for nothing: the same rules as
 * a delivery read. An unrestricted key sees every published-content fact. A key with content
 * grants sees entries only of types it may read, with its denied fields masked; a content type's
 * publish only for those types; alias changes; and no asset, bulk or release facts (asset reads
 * are refused to it, and a bulk or release fact lists entry ids of every type).
 */
export function liveEventFor(
  principal: Pick<Principal, 'contentGrants'>,
  event: DomainEvent,
): DomainEvent | null {
  if (!LIVE_EVENT_TYPES.has(event.type)) return null;
  if (!principal.contentGrants) return event;
  const p = principal as Principal;
  switch (event.type) {
    case 'entry.published':
      if (!canAccessContentType(p, 'read', event.contentTypeApiId)) return null;
      return {
        ...event,
        fields: maskDeliveredFields(p, event.contentTypeApiId, event.fields) as typeof event.fields,
      };
    case 'entry.unpublished':
    case 'content_type.published':
    case 'content_type.deleted':
      return canAccessContentType(p, 'read', event.contentTypeApiId) ? event : null;
    case 'environment_alias.changed':
      return event;
    default:
      return null;
  }
}
