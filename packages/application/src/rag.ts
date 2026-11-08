import type {
  EntryFields,
  LocaleConfig,
  Scope,
  SearchReindexRequestedEvent,
} from '@commerceworker/domain';
import {
  BLOCK_KEY,
  BLOCK_TYPE_KEY,
  isLocaleDelivered,
  isRichTextDocument,
  RateLimitedError,
  richTextToPlainText,
} from '@commerceworker/domain';
import type {
  EmbeddingsProvider,
  SearchIndex,
  VectorRow,
  VectorStore,
} from '@commerceworker/ports';
import type { AppContext } from './context';
import { type DeliveryReads, deliveryReads } from './delivery-reads';

export interface RagDeps {
  readonly embeddings: EmbeddingsProvider;
  readonly vectors: VectorStore;
  /**
   * Optional lexical index (the FTS5 SearchShard Durable Objects). When present,
   * hybrid search reads its ranking and the reindex job refreshes it; absent,
   * the lexical leg stays on the store's built-in term matching.
   */
  readonly searchIndex?: SearchIndex;
  /**
   * The asset corpus of the same shards (`…:assets:<n>`): asset search's lexical leg, written by
   * ingest and by asset publishes. Separate objects, so entry search never meets an asset.
   */
  readonly assetSearchIndex?: SearchIndex;
  /** The published assets' corpus of the same shards (`…:pubassets:<n>`): Delivery's search. */
  readonly publishedAssetSearchIndex?: SearchIndex;
}

/** Largest `topK` a search may request; bounds vector/FTS over-fetch work. */
export const MAX_SEARCH_TOP_K = 100;

/** Clamps a caller-supplied `topK` to `[1, MAX_SEARCH_TOP_K]` (default 10). */
function clampTopK(topK: number | undefined): number {
  if (topK === undefined || !Number.isFinite(topK)) return 10;
  return Math.min(Math.max(Math.trunc(topK), 1), MAX_SEARCH_TOP_K);
}

/** How deep the walk goes. Components cap at 3; this covers JSON too. */
const MAX_TEXT_DEPTH = 8;

/**
 * Collects the human-readable string values of an entry, grouped by locale.
 *
 * Walks into arrays and objects, so text living inside a component — or inside
 * the fourth item of a repeater — is embedded and indexed like any other. It
 * has no content type to consult, so it decides by shape: strings count, rich
 * text is flattened, and **links are skipped**, since an entry id is not
 * something anyone searches for and putting UUIDs in an embedding only adds
 * noise.
 */
export function extractTextByLocale(fields: EntryFields): Record<string, string> {
  const byLocale: Record<string, string[]> = {};
  for (const localized of Object.values(fields)) {
    for (const [locale, value] of Object.entries(localized)) {
      for (const text of textIn(value, 0)) {
        if (!text.trim()) continue;
        const bucket = byLocale[locale] ?? [];
        bucket.push(text);
        byLocale[locale] = bucket;
      }
    }
  }
  const out: Record<string, string> = {};
  for (const [locale, parts] of Object.entries(byLocale)) out[locale] = parts.join('\n\n');
  return out;
}

function textIn(value: unknown, depth: number): string[] {
  if (typeof value === 'string') return [value];
  if (isRichTextDocument(value)) return [richTextToPlainText(value)];
  if (depth >= MAX_TEXT_DEPTH || typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => textIn(item, depth + 1));
  const obj = value as Record<string, unknown>;
  // A link is a pointer, not prose. What it points at gets embedded on its own.
  if (typeof obj.id === 'string' && typeof obj.linkType === 'string') return [];
  // A block's `_type` and `_key` are identifiers, not prose: embedding them
  // would only teach search that every hero block mentions "hero".
  return Object.entries(obj)
    .filter(([k]) => k !== BLOCK_TYPE_KEY && k !== BLOCK_KEY)
    .flatMap(([, v]) => textIn(v, depth + 1));
}

/** Splits text into word-bounded chunks of at most `maxWords` words. */
export function chunk(text: string, maxWords = 400): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  return chunks;
}

export interface IndexEntryInput {
  readonly entryId: string;
  readonly fields: EntryFields;
  readonly entryVersion: number;
}

/**
 * Embeds an entry's text (per locale, chunked) and upserts the vectors. Existing
 * vectors for the entry are deleted first so a republish replaces stale chunks.
 * Idempotent: re-running with the same input yields the same stored rows.
 */
export async function indexEntryEmbeddings(
  deps: RagDeps,
  scope: Scope,
  input: IndexEntryInput,
): Promise<number> {
  await deps.vectors.deleteByEntry(scope, input.entryId);

  const rows: VectorRow[] = [];
  for (const [locale, text] of Object.entries(extractTextByLocale(input.fields))) {
    const chunks = chunk(text);
    if (chunks.length === 0) continue;
    const embeddings = await deps.embeddings.embed(chunks, { taskType: 'document' });
    chunks.forEach((chunkText, chunkIndex) => {
      rows.push({
        scope,
        entryId: input.entryId,
        locale,
        chunkIndex,
        chunkText,
        embedding: embeddings[chunkIndex] ?? [],
        entryVersion: input.entryVersion,
      });
    });
  }
  if (rows.length > 0) await deps.vectors.upsert(rows);
  return rows.length;
}

export interface ReindexResult {
  /** Published entries re-embedded. */
  readonly entries: number;
  /** Vector rows written (an entry with no extractable text yields none). */
  readonly chunks: number;
  /** True if the entry budget was hit and some entries were not reindexed. */
  readonly truncated: boolean;
  /** Keyset cursor to resume from (last processed entryId); unset if none. */
  readonly nextCursor?: string;
}

/** Max published entries a whole reindex job will process across all slices. */
export const MAX_REINDEX_ENTRIES = 50_000;
/**
 * Max entries one consumer invocation processes before re-enqueuing the rest
 * as a continuation event. Sized for the most constrained host (a Cloudflare
 * queue consumer: each entry costs an embeddings call plus vector writes, all
 * inside one invocation's CPU/subrequest limits); in-process callers simply get
 * finer-grained, resumable slices.
 */
export const REINDEX_ENTRIES_PER_RUN = 200;
/** Minimum seconds between reindex runs for the same scope (when a cache exists). */
export const REINDEX_COOLDOWN_SECONDS = 60;

function reindexCooldownKey(scope: Scope, contentTypeApiId?: string): string {
  return `commerceworker:reindex:cooldown:${scope.spaceId}:${scope.environmentId}:${contentTypeApiId ?? '*'}`;
}

export interface RequestReindexResult {
  /** Always true when accepted — the reindex runs on the queue consumer. */
  readonly enqueued: true;
}

/**
 * Enqueues a background reindex (via the outbox) instead of running the expensive
 * embed loop on the triggering request. Owns the per-scope cooldown so repeated
 * triggers can't flood the queue: a retrigger within the window is rejected with
 * RateLimitedError (429). The worker/queue consumer runs {@link reindexEmbeddings}.
 */
export async function requestReindex(
  ctx: AppContext,
  scope: Scope,
  opts: { contentTypeApiId?: string } = {},
): Promise<RequestReindexResult> {
  const cooldownKey = reindexCooldownKey(scope, opts.contentTypeApiId);
  if (ctx.cache && (await ctx.cache.get(cooldownKey))) {
    throw new RateLimitedError(
      'A reindex for this scope ran recently; retry after the cooldown.',
      REINDEX_COOLDOWN_SECONDS,
    );
  }
  await ctx.cache?.set(cooldownKey, ctx.clock.now().toISOString(), {
    ttlSeconds: REINDEX_COOLDOWN_SECONDS,
  });
  await ctx.store.outbox.append({
    id: ctx.ids.newId(),
    type: 'search.reindex_requested',
    scope,
    occurredAt: ctx.clock.now().toISOString(),
    contentTypeApiId: opts.contentTypeApiId,
  });
  return { enqueued: true };
}

/**
 * Re-embeds every published entry in the scope (optionally one content type),
 * paging through the read model. Runs on the queue consumer (see
 * {@link requestReindex}); each entry reindex is idempotent (stale vectors are
 * replaced). The per-run entry cap and batch clamp bound a single run.
 */
export async function reindexEmbeddings(
  deps: RagDeps | undefined,
  ctx: AppContext,
  scope: Scope,
  opts: {
    contentTypeApiId?: string;
    batchSize?: number;
    /** Keyset cursor to resume from (continuation of an earlier slice). */
    afterEntryId?: string;
    /** Entry budget for this call; defaults to the whole-job cap. */
    maxEntries?: number;
    /** Lexical index to refresh (overrides deps.searchIndex; enables
     *  lexical-only reindex when embeddings are not configured). */
    searchIndex?: SearchIndex;
  } = {},
): Promise<ReindexResult> {
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 100), 500);
  const maxEntries = opts.maxEntries ?? MAX_REINDEX_ENTRIES;
  // Keyset paging (entryId is UUIDv7, time-ordered and unique): the cursor
  // stays valid even when entries before it are unpublished or republished
  // between slices, which would shift an offset cursor and skip entries.
  let cursor = opts.afterEntryId;
  let entries = 0;
  let chunks = 0;
  let truncated = false;
  for (;;) {
    const page = await ctx.store.entries.listPublished(scope, {
      contentTypeApiId: opts.contentTypeApiId,
      limit: batchSize,
      afterEntryId: cursor ?? '',
    });
    const searchIndex = opts.searchIndex ?? deps?.searchIndex;
    for (const published of page) {
      if (entries >= maxEntries) {
        truncated = true;
        break;
      }
      if (deps) {
        chunks += await indexEntryEmbeddings(deps, scope, {
          entryId: published.entryId,
          fields: published.fields,
          entryVersion: published.version,
        });
      }
      // Refresh the external lexical index in the same pass, when bound.
      // refresh: false — bulk writes ride the engine's own refresh cycle.
      await searchIndex?.index(
        scope,
        {
          entryId: published.entryId,
          contentTypeApiId: published.contentTypeApiId,
          textByLocale: extractTextByLocale(published.fields),
          entryVersion: published.version,
        },
        { refresh: false },
      );
      entries += 1;
      cursor = published.entryId;
    }
    if (truncated || page.length < batchSize) break;
  }
  return { entries, chunks, truncated, nextCursor: cursor };
}

/**
 * Runs one bounded slice of a reindex job (the `search.reindex_requested`
 * consumer body) and, when more entries remain, re-enqueues a continuation
 * event carrying the keyset cursor — via the outbox, so the follow-up flows
 * through the same relay → queue → consumer path on every host. A slice is
 * capped at {@link REINDEX_ENTRIES_PER_RUN} entries and the whole job (across
 * slices) at {@link MAX_REINDEX_ENTRIES}.
 *
 * At-least-once redelivery: each slice is idempotent (stale vectors are
 * replaced), and a per-event cache marker dedupes re-runs so a redelivered
 * slice doesn't fork the continuation chain. The marker is best-effort (the
 * cache is optional and may be eventually consistent); a fork that slips
 * through re-embeds duplicate slices — wasted work, never wrong data.
 */
export async function runReindexJob(
  deps: RagDeps | undefined,
  ctx: AppContext,
  event: SearchReindexRequestedEvent,
  opts: { entriesPerRun?: number; searchIndex?: SearchIndex } = {},
): Promise<ReindexResult> {
  const entriesSoFar = event.entriesSoFar ?? 0;
  const perRun = Math.max(1, opts.entriesPerRun ?? REINDEX_ENTRIES_PER_RUN);
  const budget = Math.min(perRun, MAX_REINDEX_ENTRIES - entriesSoFar);
  if (budget <= 0) {
    return { entries: 0, chunks: 0, truncated: true, nextCursor: event.afterEntryId };
  }

  const sliceMarker = `commerceworker:reindex:slice:${event.id}`;
  if (ctx.cache && (await ctx.cache.get(sliceMarker))) {
    // This slice already ran (queue redelivery) — don't re-run or re-enqueue.
    return { entries: 0, chunks: 0, truncated: false, nextCursor: event.afterEntryId };
  }

  const result = await reindexEmbeddings(deps, ctx, event.scope, {
    contentTypeApiId: event.contentTypeApiId,
    afterEntryId: event.afterEntryId,
    maxEntries: budget,
    searchIndex: opts.searchIndex,
  });
  const totalAfter = entriesSoFar + result.entries;
  if (result.truncated && totalAfter < MAX_REINDEX_ENTRIES) {
    await ctx.store.outbox.append({
      id: ctx.ids.newId(),
      type: 'search.reindex_requested',
      scope: event.scope,
      occurredAt: ctx.clock.now().toISOString(),
      contentTypeApiId: event.contentTypeApiId,
      afterEntryId: result.nextCursor,
      entriesSoFar: totalAfter,
    });
    // Keep the scope on cooldown while slices are in flight, so a re-trigger
    // can't start a second concurrent chain the moment the request-time
    // cooldown (60s) lapses mid-job.
    await ctx.cache?.set(
      reindexCooldownKey(event.scope, event.contentTypeApiId),
      ctx.clock.now().toISOString(),
      { ttlSeconds: REINDEX_COOLDOWN_SECONDS },
    );
  }
  await ctx.cache?.set(sliceMarker, ctx.clock.now().toISOString(), { ttlSeconds: 3600 });
  return result;
}

export async function removeEntryEmbeddings(
  deps: RagDeps,
  scope: Scope,
  entryId: string,
): Promise<void> {
  await deps.vectors.deleteByEntry(scope, entryId);
}

export interface SearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

/**
 * What a search may quote and match on. Delivery passes the space's config (`delivered`), so a
 * locale the space doesn't serve neither matches nor appears in a snippet; Management searches
 * every locale.
 */
export interface SearchLocales {
  readonly delivered?: LocaleConfig;
}

/** Whether `config` turns any locale off, so a search must look past the indexes' own answers. */
const hidesALocale = (config: LocaleConfig | undefined): config is LocaleConfig =>
  !!config?.localeSettings &&
  Object.values(config.localeSettings).some((s) => s.delivered === false);

/** An entry's text in the locales a search may see, per locale. */
function searchableText(fields: EntryFields, delivered: LocaleConfig | undefined): string {
  return Object.entries(extractTextByLocale(fields))
    .filter(([locale]) => !delivered || isLocaleDelivered(delivered, locale))
    .map(([, text]) => text)
    .join('\n\n');
}

/**
 * Semantic search: embeds the query and returns the best-matching entries,
 * deduplicated to the highest-scoring chunk per entry. With `delivered`, a chunk in a locale the
 * space doesn't deliver is no match (its entry can still match on another locale's chunk).
 */
export async function semanticSearch(
  deps: RagDeps,
  scope: Scope,
  query: string,
  opts: { topK?: number; minScore?: number } & SearchLocales = {},
): Promise<SearchHit[]> {
  const topK = clampTopK(opts.topK);
  // Exclude zero/negative-similarity (orthogonal) matches by default.
  const minScore = opts.minScore ?? 1e-6;
  const [embedding] = await deps.embeddings.embed([query], { taskType: 'query' });
  if (!embedding) return [];
  // Over-fetch chunks, then collapse to best chunk per entry — clamped to the
  // backend's declared per-query cap (e.g. Vectorize: 50) so a store limit is
  // an explicit contract instead of a silent truncation.
  const overFetch = Math.min(topK * 4, deps.vectors.maxTopK ?? topK * 4);
  const matches = await deps.vectors.query(scope, embedding, { topK: overFetch, minScore });
  const best = new Map<string, SearchHit>();
  for (const m of matches) {
    if (opts.delivered && m.locale && !isLocaleDelivered(opts.delivered, m.locale)) continue;
    const existing = best.get(m.entryId);
    if (!existing || m.score > existing.score) {
      best.set(m.entryId, { entryId: m.entryId, score: m.score, snippet: m.chunkText });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

/** Reciprocal Rank Fusion constant — the standard default from the RRF paper. */
const RRF_K = 60;

/**
 * Hybrid search: fuses semantic search (vector ANN) with ranked full-text
 * search over the published read model via Reciprocal Rank Fusion. RRF works
 * on ranks, so the legs' incomparable scores (cosine similarity vs. ts_rank)
 * never need calibrating. Pass `deps: undefined` for a lexical-only search
 * (no embeddings configured).
 */
export async function hybridSearch(
  deps: RagDeps | undefined,
  ctx: AppContext,
  scope: Scope,
  query: string,
  opts: { topK?: number; lexicalOnly?: boolean } & SearchLocales = {},
): Promise<SearchHit[]> {
  const topK = clampTopK(opts.topK);
  const { delivered } = opts;
  // Over-fetch per leg so a hit ranked just outside topK in both legs can
  // still fuse into the final topK.
  const fetchK = topK * 2;
  // The external index (when bound) serves the lexical leg in every mode —
  // including lexicalOnly — with graceful degradation to the built-in FTS:
  // a briefly unreachable index should cost freshness, not fail delivery reads.
  const lexicalLeg = async () => {
    if (deps?.searchIndex) {
      try {
        return await deps.searchIndex.search(scope, query, { topK: fetchK });
      } catch {
        return ctx.store.entries.searchPublished(scope, query, { topK: fetchK });
      }
    }
    return ctx.store.entries.searchPublished(scope, query, { topK: fetchK });
  };
  const [semantic, lexical] = await Promise.all([
    deps && !opts.lexicalOnly
      ? semanticSearch(deps, scope, query, { topK: fetchK, ...(delivered ? { delivered } : {}) })
      : Promise.resolve([]),
    lexicalLeg(),
  ]);
  // The lexical indexes hold every locale's text. When the space turns one off, each lexical hit
  // is checked and re-ranked against its delivered text alone, so an entry that matched only in
  // an undelivered locale drops out and one that matched mostly there ranks on what's served.
  const published = new Map<string, EntryFields>();
  let lexicalHits: readonly { entryId: string }[] = lexical;
  if (hidesALocale(delivered) && lexical.length > 0) {
    const rows = await ctx.store.entries.getPublishedMany(
      scope,
      lexical.map((h) => h.entryId),
    );
    for (const row of rows) published.set(row.entryId, row.fields);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    lexicalHits = lexical
      .map((h) => {
        const fields = published.get(h.entryId);
        const text = fields ? searchableText(fields, delivered).toLowerCase() : '';
        return { entryId: h.entryId, score: termFrequency(text, terms) };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId));
  }

  const fused = new Map<string, { score: number; snippet?: string }>();
  const add = (entryId: string, rank: number, snippet?: string) => {
    const hit = fused.get(entryId) ?? { score: 0 };
    hit.score += 1 / (RRF_K + rank + 1);
    if (!hit.snippet && snippet) hit.snippet = snippet;
    fused.set(entryId, hit);
  };
  semantic.forEach((hit, rank) => {
    add(hit.entryId, rank, hit.snippet);
  });
  lexicalHits.forEach((hit, rank) => {
    add(hit.entryId, rank);
  });

  const ranked = [...fused.entries()]
    .sort(([aId, a], [bId, b]) => b.score - a.score || aId.localeCompare(bId))
    .slice(0, topK);

  // Lexical-only hits carry no chunk text — derive a snippet from the fields.
  return Promise.all(
    ranked.map(async ([entryId, hit]) => ({
      entryId,
      score: hit.score,
      snippet:
        hit.snippet ??
        (await snippetFor(ctx, scope, entryId, query, delivered, published.get(entryId))),
    })),
  );
}

/**
 * Every term's occurrences in `text` added up, or 0 when any term is missing (all must match, as
 * in the lexical indexes).
 */
function termFrequency(text: string, terms: readonly string[]): number {
  let score = 0;
  for (const term of terms) {
    let n = 0;
    for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) n += 1;
    if (n === 0) return 0;
    score += n;
  }
  return score;
}

/**
 * Delivery's search (REST `/search`, GraphQL `search`): hybrid, or one leg by `mode`, over the
 * locales the space delivers only. Its config comes from the request's reads, so a GraphQL query
 * that already read it doesn't again.
 */
export async function deliveredSearch(
  deps: RagDeps | undefined,
  ctx: AppContext,
  scope: Scope,
  query: string,
  opts: {
    readonly topK?: number;
    readonly mode?: 'hybrid' | 'semantic' | 'lexical';
    readonly reads?: DeliveryReads;
  } = {},
): Promise<SearchHit[]> {
  const { config } = await (opts.reads ?? deliveryReads(ctx)).read(scope, { config: true });
  const locales: SearchLocales = config ? { delivered: config } : {};
  const topK = opts.topK !== undefined ? { topK: opts.topK } : {};
  if (opts.mode === 'semantic' && deps) {
    return semanticSearch(deps, scope, query, { ...topK, ...locales });
  }
  return hybridSearch(deps, ctx, scope, query, {
    ...topK,
    ...locales,
    lexicalOnly: opts.mode === 'lexical',
  });
}

/** A short excerpt around the first query-term match in the published text a search may see. */
async function snippetFor(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  query: string,
  delivered: LocaleConfig | undefined,
  known: EntryFields | undefined,
): Promise<string> {
  const fields = known ?? (await ctx.store.entries.getPublished(scope, entryId))?.fields;
  if (!fields) return '';
  const text = searchableText(fields, delivered);
  const lower = text.toLowerCase();
  const term = query
    .toLowerCase()
    .split(/\s+/)
    .find((t) => t && lower.includes(t));
  const at = term ? lower.indexOf(term) : 0;
  const start = Math.max(0, at - 60);
  const slice = text.slice(start, start + 180).trim();
  if (!slice) return '';
  const prefix = start > 0 ? '…' : '';
  const suffix = start + 180 < text.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}
