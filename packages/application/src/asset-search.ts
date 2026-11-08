import {
  type Asset,
  type AssetKind,
  type AssetStatus,
  assetKind,
  type DeliveredAsset,
  isLocaleDelivered,
  type LocaleConfig,
  type LocalizedValue,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type {
  AssetSearchCorpus,
  BlobStore,
  EmbeddingsProvider,
  PublishedAsset,
  SearchIndex,
  VectorStore,
} from '@commerceworker/ports';
import {
  type AssetProjectionContext,
  assetProjectionContext,
  projectPublishedAsset,
} from './asset-delivery';
import { assetTextKey } from './assets';
import type { AppContext } from './context';
import type { RagDeps } from './rag';

/**
 * Asset search: hybrid, as entry search is (a lexical leg and a semantic one, fused by rank), over
 * indexes of assets that ingest and publishing keep. Assets have their own lexical shards and
 * their own vector namespaces, so neither leg ever mixes them with entries. There are two corpora
 * (`AssetSearchCorpus`): the library (every asset as it is now, for Management) and the published
 * assets (their published snapshots, for Delivery), so Delivery's candidates are never drafts and
 * never rank on text only a draft has.
 */

/** The indexes asset search reads and ingest writes; each is optional, and so is its leg. */
export interface AssetSearchDeps {
  /** Embeddings and vectors for the semantic leg; absent, search is lexical only. */
  readonly embeddings?: EmbeddingsProvider;
  readonly vectors?: VectorStore;
  /** The library corpus of the FTS5 shards; absent, the lexical leg scans recent assets. */
  readonly index?: SearchIndex;
  /** The published corpus of the FTS5 shards; absent, Delivery's lexical leg scans. */
  readonly publishedIndex?: SearchIndex;
}

/**
 * The asset search indexes out of the RAG wiring. `embed: false` leaves the semantic leg out:
 * `wireEdge` passes whether EMBEDDINGS_PROVIDER is set, so a query is embedded only by the model
 * the index was written with.
 */
export function assetSearchDeps(
  rag: RagDeps | undefined,
  opts: { readonly embed?: boolean } = {},
): AssetSearchDeps {
  return {
    ...(rag && opts.embed !== false ? { embeddings: rag.embeddings, vectors: rag.vectors } : {}),
    ...(rag?.assetSearchIndex ? { index: rag.assetSearchIndex } : {}),
    ...(rag?.publishedAssetSearchIndex ? { publishedIndex: rag.publishedAssetSearchIndex } : {}),
  };
}

/** Characters of extracted text that go into an asset's embedding (the model reads ~512 tokens). */
export const ASSET_EMBED_EXCERPT_CHARS = 1_500;
/** Characters of extracted text the lexical index holds per asset. */
export const ASSET_INDEX_TEXT_CHARS = 100_000;

const localized = (value: LocalizedValue | undefined): string[] =>
  Object.values(value ?? {}).filter((v): v is string => typeof v === 'string' && v.trim() !== '');

/** What an asset is searched by, as one snapshot (the library's, or the published one). */
interface SearchSource {
  readonly id: string;
  readonly file: Asset['file'];
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly metadata: Asset['metadata'];
  /** The file version the snapshot is of: its extracted text is that version's. */
  readonly version: number;
}

/**
 * The text an asset is found by: its file name, title, caption (description), alt text and tag
 * names, and an excerpt of what ingest read out of the snapshot's own file version.
 */
async function searchText(
  ctx: AppContext,
  blob: BlobStore | undefined,
  scope: Scope,
  source: SearchSource,
  extractChars: number,
): Promise<string> {
  const tags = source.metadata.tags.length
    ? await ctx.store.taxonomy.listTags(scope)
    : ([] as { id: string; name: string }[]);
  const tagNames = new Map(tags.map((t) => [t.id, t.name]));
  const key = assetTextKey(scope, source.id, source.version);
  const extracted = key && blob ? ((await blob.get(key)) ?? '') : '';
  return [
    source.file.fileName,
    ...localized(source.title),
    ...localized(source.description),
    ...localized(source.metadata.altText),
    source.metadata.tags.map((id) => tagNames.get(id) ?? '').join(' '),
    extracted.slice(0, extractChars),
  ]
    .filter((p) => p.trim() !== '')
    .join('\n');
}

/**
 * The snapshots an asset is indexed from: the library's (`null` once the asset is gone) and the
 * published one (`null` while unpublished), each at its own file version.
 */
async function searchSources(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
): Promise<{ library: SearchSource | null; published: SearchSource | null }> {
  const [asset, published] = await Promise.all([
    ctx.store.assets.get(scope, assetId),
    ctx.store.assets.getPublished(scope, assetId),
  ]);
  if (!asset) return { library: null, published: null };
  const source = (from: Asset | PublishedAsset, version: number): SearchSource => ({
    id: assetId,
    file: from.file,
    title: from.title,
    description: from.description,
    metadata: from.metadata,
    version,
  });
  return {
    library: source(asset, asset.version ?? 1),
    published: published ? source(published, published.version ?? 1) : null,
  };
}

/**
 * Writes an asset's semantic leg: one vector over its search text per corpus, the published one
 * only while it is published (else removed). Idempotent (vectors are replaced). Returns false
 * when there is nothing to do (no embeddings, or the asset is gone).
 */
export async function embedAssetForSearch(
  ctx: AppContext,
  deps: AssetSearchDeps,
  blob: BlobStore | undefined,
  scope: Scope,
  assetId: string,
): Promise<boolean> {
  if (!deps.embeddings || !deps.vectors) return false;
  const { library, published } = await searchSources(ctx, scope, assetId);
  if (!library) return false;
  const libraryText = await searchText(ctx, blob, scope, library, ASSET_EMBED_EXCERPT_CHARS);
  const publishedText = published
    ? await searchText(ctx, blob, scope, published, ASSET_EMBED_EXCERPT_CHARS)
    : null;
  // One call; the same text (published, no draft changes) is embedded once.
  const texts =
    publishedText === null || publishedText === libraryText
      ? [libraryText]
      : [libraryText, publishedText];
  const embedded = await deps.embeddings.embed(texts, { taskType: 'document' });
  const [libraryVector] = embedded;
  if (!libraryVector) return false;
  const row = (corpus: AssetSearchCorpus, source: SearchSource, embedding: number[]) => ({
    corpus,
    assetId,
    embedding,
    assetKind: assetKind(source.file.contentType),
    version: source.version,
  });
  await deps.vectors.upsertAsset(scope, row('library', library, libraryVector));
  if (published) {
    const vector = embedded[texts.length - 1] ?? libraryVector;
    await deps.vectors.upsertAsset(scope, row('published', published, vector));
  } else {
    await deps.vectors.deleteAsset(scope, assetId, 'published');
  }
  return true;
}

/**
 * Writes an asset's lexical leg: one document per corpus, the published one only while it is
 * published (else removed). Idempotent.
 */
export async function indexAssetText(
  ctx: AppContext,
  deps: AssetSearchDeps,
  blob: BlobStore | undefined,
  scope: Scope,
  assetId: string,
): Promise<boolean> {
  if (!deps.index && !deps.publishedIndex) return false;
  const { library, published } = await searchSources(ctx, scope, assetId);
  if (!library) return false;
  const write = async (index: SearchIndex, source: SearchSource) =>
    index.index(scope, {
      entryId: assetId,
      contentTypeApiId: 'asset',
      textByLocale: { '*': await searchText(ctx, blob, scope, source, ASSET_INDEX_TEXT_CHARS) },
      entryVersion: source.version,
    });
  if (deps.index) await write(deps.index, library);
  if (deps.publishedIndex) {
    if (published) await write(deps.publishedIndex, published);
    else await deps.publishedIndex.remove(scope, assetId);
  }
  return true;
}

/** Both legs, for a publish or unpublish (whose snapshot the published corpus is). */
export async function indexAssetForSearch(
  ctx: AppContext,
  deps: AssetSearchDeps,
  blob: BlobStore | undefined,
  scope: Scope,
  assetId: string,
): Promise<void> {
  await embedAssetForSearch(ctx, deps, blob, scope, assetId);
  await indexAssetText(ctx, deps, blob, scope, assetId);
}

/** Removes an asset from both legs of both corpora. Idempotent. */
export async function removeAssetFromSearch(
  deps: AssetSearchDeps | undefined,
  scope: Scope,
  assetId: string,
): Promise<void> {
  await deps?.vectors?.deleteAsset(scope, assetId, 'library');
  await deps?.vectors?.deleteAsset(scope, assetId, 'published');
  await deps?.index?.remove(scope, assetId);
  await deps?.publishedIndex?.remove(scope, assetId);
}

/** Empties both corpora's lexical shards for a deleted environment (vectors go by id). */
export async function clearAssetSearch(
  deps: AssetSearchDeps | undefined,
  scope: Scope,
): Promise<void> {
  await deps?.index?.clear?.(scope);
  await deps?.publishedIndex?.clear?.(scope);
}

// ---- search -----------------------------------------------------------------------------------

/** Most results one search returns; also how many candidates each leg contributes. */
export const MAX_ASSET_SEARCH_RESULTS = 100;
/** Assets the lexical fallback scans when no index is bound (dev, tests): the most recent. */
export const ASSET_SCAN_LIMIT = 500;
/** Longest query accepted. */
export const MAX_ASSET_QUERY_LENGTH = 256;

export interface AssetSearchFilters {
  readonly kind?: AssetKind;
  readonly tag?: string;
  /** A folder id, or `null` for assets in no folder. */
  readonly folderId?: string | null;
  /** Omitted: everything but archived, as the library lists. Delivery ignores it. */
  readonly status?: AssetStatus | 'all';
}

export interface AssetSearchQuery {
  readonly q: string;
  /** 1..{@link MAX_ASSET_SEARCH_RESULTS}, default 20. */
  readonly limit?: number;
  readonly filters?: AssetSearchFilters;
}

/**
 * How many matches each facet value has. Each facet counts over the matches with every other
 * filter applied but not its own, so choosing a kind still shows how many of each other kind
 * there are. `folder` keys are folder ids, and `root` for assets in no folder.
 */
export interface AssetFacets {
  readonly kind: Readonly<Record<string, number>>;
  readonly tag: Readonly<Record<string, number>>;
  readonly folder: Readonly<Record<string, number>>;
}

export interface AssetSearchPage<T> {
  /** Best match first. */
  readonly items: readonly T[];
  /** Matches after the filters (of at most {@link MAX_ASSET_SEARCH_RESULTS} candidates). */
  readonly total: number;
  readonly facets: AssetFacets;
}

/** Reciprocal Rank Fusion constant, as entry search uses. */
const RRF_K = 60;

function checkQuery(query: AssetSearchQuery): { q: string; limit: number } {
  const q = query.q.trim();
  if (q === '' || q.length > MAX_ASSET_QUERY_LENGTH) {
    throw new ValidationError([
      { field: 'q', message: `q is 1 to ${MAX_ASSET_QUERY_LENGTH} characters` },
    ]);
  }
  const raw = query.limit ?? 20;
  const limit = Math.min(Math.max(1, Math.trunc(Number.isFinite(raw) ? raw : 20)), 100);
  return { q, limit };
}

const terms = (q: string) =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Whether every term of the query appears in the texts (the fallback's AND semantics). */
function matches(texts: readonly string[], queryTerms: readonly string[]): number {
  const hay = texts.join('\n').toLowerCase();
  let score = 0;
  for (const t of queryTerms) {
    if (!hay.includes(t)) return 0;
    score += 1;
  }
  return score;
}

const scanTexts = (a: {
  file: Asset['file'];
  title: LocalizedValue;
  description: LocalizedValue;
  metadata: Asset['metadata'];
}) => [
  a.file.fileName,
  ...localized(a.title),
  ...localized(a.description),
  ...localized(a.metadata.altText),
];

/**
 * The space's locale config when it turns a locale off for Delivery, else undefined (nothing to
 * hide): from a locale-flattened read's config, or an all-locale read's.
 */
function hidingConfig(pc: AssetProjectionContext): LocaleConfig | undefined {
  const config = pc.locale?.config ?? pc.delivered;
  if (!config?.localeSettings) return undefined;
  return Object.keys(config.localeSettings).some((l) => !isLocaleDelivered(config, l))
    ? config
    : undefined;
}

type AssetText = Parameters<typeof scanTexts>[0];

/** The localized text of an asset split into what Delivery serves and what it hides. */
function splitByDelivery(a: AssetText, config: LocaleConfig) {
  const pick = (v: LocalizedValue | undefined, delivered: boolean): LocalizedValue =>
    Object.fromEntries(
      Object.entries(v ?? {}).filter(([l]) => isLocaleDelivered(config, l) === delivered),
    );
  const side = (delivered: boolean): AssetText => ({
    file: a.file,
    title: pick(a.title, delivered),
    description: pick(a.description, delivered),
    metadata: { ...a.metadata, altText: pick(a.metadata.altText, delivered) },
  });
  const hidden = side(false);
  return {
    delivered: scanTexts(side(true)),
    hidden: [
      ...localized(hidden.title),
      ...localized(hidden.description),
      ...localized(hidden.metadata.altText),
    ],
  };
}

/**
 * Whether a Delivery search candidate may stand when the space hides a locale. The indexes hold
 * every locale's title, caption and alt text (one lexical document, one embedding per asset), so
 * a hit may have come from hidden text alone. A term found only in hidden text drops it; every
 * term in delivered text keeps it. Otherwise the lexical index matched on text no locale owns (the
 * file's extracted text, tag names) and the hit stands, while a hit from the vector leg alone
 * cannot say which locale drew it, and goes.
 */
function deliveredCandidate(
  a: AssetText,
  config: LocaleConfig,
  queryTerms: readonly string[],
  lexical: boolean,
): boolean {
  const { delivered, hidden } = splitByDelivery(a, config);
  if (hidden.length === 0) return true;
  const shown = delivered.join('\n').toLowerCase();
  const kept = hidden.join('\n').toLowerCase();
  if (queryTerms.some((t) => !shown.includes(t) && kept.includes(t))) return false;
  if (queryTerms.every((t) => shown.includes(t))) return true;
  return lexical;
}

/**
 * The fused candidate ids of one corpus, best first. The lexical leg is that corpus's asset
 * shards (falling back to `scan` when unbound or unreachable, as entry search falls back to its
 * store scan); the semantic leg embeds the query and asks that corpus's asset vectors. `lexicalOut`,
 * when given, collects the ids the lexical leg found.
 */
async function candidates(
  deps: AssetSearchDeps,
  scope: Scope,
  q: string,
  corpus: AssetSearchCorpus,
  scan: () => Promise<string[]>,
  lexicalOut?: Set<string>,
): Promise<string[]> {
  const index = corpus === 'library' ? deps.index : deps.publishedIndex;
  const lexical = async (): Promise<string[]> => {
    if (index) {
      try {
        const hits = await index.search(scope, q, { topK: MAX_ASSET_SEARCH_RESULTS });
        return hits.map((h) => h.entryId);
      } catch {
        return scan();
      }
    }
    return scan();
  };
  const semantic = async (): Promise<string[]> => {
    if (!deps.embeddings || !deps.vectors) return [];
    const [embedding] = await deps.embeddings.embed([q], { taskType: 'query' });
    if (!embedding) return [];
    const topK = Math.min(MAX_ASSET_SEARCH_RESULTS, deps.vectors.maxTopK ?? 50);
    // Orthogonal vectors share nothing; anything above that is a candidate the fusion ranks.
    const hits = await deps.vectors.queryAssets(scope, embedding, {
      topK,
      minScore: 1e-6,
      corpus,
    });
    return hits.map((h) => h.assetId);
  };
  const [lex, sem] = await Promise.all([lexical(), semantic()]);
  for (const id of lex) lexicalOut?.add(id);
  const fused = new Map<string, number>();
  const add = (ids: readonly string[]) =>
    ids.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  add(lex);
  add(sem);
  return [...fused.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, MAX_ASSET_SEARCH_RESULTS)
    .map(([id]) => id);
}

interface Facetable {
  readonly kind: AssetKind;
  readonly tags: readonly string[];
  readonly folder: string | null;
}

/** Applies the kind/tag/folder filters and counts the facets (each without its own filter). */
function facetAndFilter<T>(
  rows: readonly { item: T; f: Facetable }[],
  filters: AssetSearchFilters,
): { items: T[]; facets: AssetFacets } {
  const keep = (f: Facetable, skip?: 'kind' | 'tag' | 'folder') =>
    (skip === 'kind' || !filters.kind || f.kind === filters.kind) &&
    (skip === 'tag' || !filters.tag || f.tags.includes(filters.tag)) &&
    (skip === 'folder' || filters.folderId === undefined || f.folder === filters.folderId);
  const kind: Record<string, number> = {};
  const tag: Record<string, number> = {};
  const folder: Record<string, number> = {};
  for (const { f } of rows) {
    if (keep(f, 'kind')) kind[f.kind] = (kind[f.kind] ?? 0) + 1;
    if (keep(f, 'tag')) for (const t of new Set(f.tags)) tag[t] = (tag[t] ?? 0) + 1;
    if (keep(f, 'folder')) {
      const k = f.folder ?? 'root';
      folder[k] = (folder[k] ?? 0) + 1;
    }
  }
  return { items: rows.filter((r) => keep(r.f)).map((r) => r.item), facets: { kind, tag, folder } };
}

const statusMatches = (asset: Asset, status: AssetSearchFilters['status']) =>
  status === undefined ? asset.status !== 'archived' : status === 'all' || asset.status === status;

/**
 * Searches the asset library (Management): drafts and published alike, archived left out unless
 * `filters.status` asks for them, filtered by kind, tag and folder, with facet counts.
 */
export async function searchAssets(
  ctx: AppContext,
  deps: AssetSearchDeps,
  scope: Scope,
  query: AssetSearchQuery,
): Promise<AssetSearchPage<Asset>> {
  const { q, limit } = checkQuery(query);
  const filters = query.filters ?? {};
  const queryTerms = terms(q);
  const ids = await candidates(deps, scope, q, 'library', async () => {
    const page = await ctx.store.assets.list(scope, {
      limit: ASSET_SCAN_LIMIT,
      filters: { status: filters.status ?? 'all' },
    });
    return page.items
      .map((a) => ({ id: a.id, score: matches(scanTexts(a), queryTerms) }))
      .filter((h) => h.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((h) => h.id);
  });
  const byId = new Map((await ctx.store.assets.getMany(scope, ids)).map((a) => [a.id, a]));
  const rows = ids
    .map((id) => byId.get(id))
    .filter((a): a is Asset => a !== undefined && statusMatches(a, filters.status))
    .map((a) => ({
      item: a,
      f: { kind: assetKind(a.file.contentType), tags: a.metadata.tags, folder: a.folderId ?? null },
    }));
  const { items, facets } = facetAndFilter(rows, filters);
  return { items: items.slice(0, limit), total: items.length, facets };
}

/**
 * Searches what Delivery serves: published assets only, as their published snapshots project
 * (the media origin's URLs, renditions, srcset), filtered by kind, tag and folder (filing is read
 * live, as Delivery's listing reads it). The candidates come from the published corpus, so no
 * draft takes a place among them. A read: nothing is written, so it caches like any delivery
 * list.
 */
export async function searchDeliveredAssets(
  ctx: AppContext,
  deps: AssetSearchDeps,
  scope: Scope,
  query: AssetSearchQuery,
  opts: { readonly locale?: string } = {},
): Promise<AssetSearchPage<DeliveredAsset>> {
  const { q, limit } = checkQuery(query);
  const filters = query.filters ?? {};
  const queryTerms = terms(q);
  // The space's locale settings decide what the candidates may match on, so they're read
  // alongside the legs rather than after them.
  const projection = assetProjectionContext(ctx, scope, opts);
  const lexical = new Set<string>();
  const [ids, pc] = await Promise.all([
    candidates(
      deps,
      scope,
      q,
      'published',
      async () => {
        const [page, context] = await Promise.all([
          ctx.store.assets.listPublished(scope, { limit: ASSET_SCAN_LIMIT }),
          projection,
        ]);
        const config = hidingConfig(context);
        const text = (p: PublishedAsset) =>
          config ? splitByDelivery(p, config).delivered : scanTexts(p);
        return page.items
          .map((p) => ({ id: p.assetId, score: matches(text(p), queryTerms) }))
          .filter((h) => h.score > 0)
          .sort((x, y) => y.score - x.score)
          .map((h) => h.id);
      },
      lexical,
    ),
    projection,
  ]);
  const [published, rows] = await Promise.all([
    ctx.store.assets.getPublishedMany(scope, ids),
    ctx.store.assets.getMany(scope, ids),
  ]);
  const snapshot = new Map(published.map((p) => [p.assetId, p]));
  const folderOf = new Map(rows.map((a) => [a.id, a.folderId ?? null]));
  const hiding = hidingConfig(pc);
  const hits = ids
    .map((id) => snapshot.get(id))
    .filter((p): p is PublishedAsset => p !== undefined)
    .filter((p) => !hiding || deliveredCandidate(p, hiding, queryTerms, lexical.has(p.assetId)))
    .map((p) => ({
      item: p,
      f: {
        kind: assetKind(p.file.contentType),
        tags: p.metadata.tags,
        folder: folderOf.get(p.assetId) ?? null,
      },
    }));
  const { items, facets } = facetAndFilter(hits, filters);
  return {
    items: items.slice(0, limit).map((p) => projectPublishedAsset(ctx, scope, p, pc)),
    total: items.length,
    facets,
  };
}
