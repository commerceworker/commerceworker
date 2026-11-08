import type { Scope } from '@commerceworker/domain';
import type {
  AssetSearchCorpus,
  AssetVectorMatch,
  VectorMatch,
  VectorRow,
  VectorStore,
} from '@commerceworker/ports';

/** The subset of a Vectorize index binding this adapter uses. */
export interface VectorizeBinding {
  upsert(
    vectors: {
      id: string;
      values: number[];
      namespace?: string;
      metadata?: Record<string, string | number | boolean>;
    }[],
  ): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; namespace?: string; returnMetadata?: 'all' | 'indexed' | 'none' },
  ): Promise<{
    matches: { id: string; score: number; metadata?: Record<string, unknown> }[];
  }>;
}

export interface VectorizeStoreOptions {
  /** Must match the Vectorize index's configured dimension. */
  readonly dimensions: number;
  readonly modelId: string;
}

/**
 * Upper bound on vectors per entry (all locales × chunks). At 400-word chunks
 * this is ~80k words of content per entry — far beyond realistic entries.
 * `deleteByEntry` sweeps exactly this id range, so rows beyond it are not
 * indexed (dropped deterministically from the tail).
 */
export const MAX_CHUNKS_PER_ENTRY = 200;

/** Vectorize caps topK at 50 when returning full metadata (which we need). */
const MAX_TOP_K = 50;

/** Vectorize rejects deleteByIds payloads above 100 ids (VECTOR_DELETE_ERROR 40007). */
const MAX_DELETE_IDS = 100;

async function deleteInBatches(index: VectorizeBinding, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += MAX_DELETE_IDS) {
    await index.deleteByIds(ids.slice(i, i + MAX_DELETE_IDS));
  }
}

const encoder = new TextEncoder();

/** Hex SHA-256, truncated — used for ids (64-byte cap) and namespaces. */
async function hashHex(input: string, chars: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars);
}

/** Namespace per scope, space + environment (hashed: two UUIDs would exceed the 64-byte cap). */
const namespaceFor = (scope: Scope) => hashHex(`${scope.spaceId}:${scope.environmentId}`, 32);

/** The library corpus keeps the `asset:` prefix it shipped with; the published one has its own. */
const corpusPrefix = (corpus: AssetSearchCorpus) => (corpus === 'library' ? 'asset' : 'asset-pub');

/**
 * Asset vectors' namespace per scope and corpus: not the entries' one, so an entry query
 * (semantic search, related entries, RAG answers) never meets an asset's text, and the reverse;
 * and the published corpus apart from the library's, so Delivery's top K is published assets only.
 */
const assetNamespaceFor = (scope: Scope, corpus: AssetSearchCorpus) =>
  hashHex(`${corpusPrefix(corpus)}:${scope.spaceId}:${scope.environmentId}`, 32);

/** One vector per asset and corpus, under a deterministic id. */
const assetVectorId = (scope: Scope, assetId: string, corpus: AssetSearchCorpus) =>
  hashHex(`${corpusPrefix(corpus)}:${scope.spaceId}:${scope.environmentId}:${assetId}`, 48);

/** Deterministic per-entry id prefix; row ids are `<prefix>:<ordinal>`. */
const entryPrefix = (scope: Scope, entryId: string) =>
  hashHex(`${scope.spaceId}:${scope.environmentId}:${entryId}`, 48);

/**
 * Vectorize-backed VectorStore. Scope isolation via a namespace per
 * space+environment; deterministic hashed ids let `deleteByEntry` sweep an
 * entry's vectors without list-by-metadata (Vectorize has none). Mutations are
 * async-indexed by Vectorize, so search-after-publish lags by a few seconds.
 */
export function createVectorizeStore(
  index: VectorizeBinding,
  opts: VectorizeStoreOptions,
): VectorStore {
  return {
    // Declared cap: callers (semanticSearch over-fetch) clamp to it instead of
    // Vectorize silently truncating deeper requests.
    maxTopK: MAX_TOP_K,

    async upsert(rows: VectorRow[]) {
      if (rows.length === 0) return;
      // Group by entry — callers batch per entry, but stay defensive.
      const groups = new Map<string, VectorRow[]>();
      for (const row of rows) {
        const key = `${row.scope.spaceId}:${row.scope.environmentId}:${row.entryId}`;
        const group = groups.get(key);
        if (group) group.push(row);
        else groups.set(key, [row]);
      }
      for (const group of groups.values()) {
        const first = group[0];
        if (!first) continue;
        const kept = group.slice(0, MAX_CHUNKS_PER_ENTRY);
        const [prefix, namespace] = await Promise.all([
          entryPrefix(first.scope, first.entryId),
          namespaceFor(first.scope),
        ]);
        await index.upsert(
          kept.map((row, ordinal) => ({
            id: `${prefix}:${ordinal}`,
            values: row.embedding,
            namespace,
            metadata: {
              entryId: row.entryId,
              locale: row.locale,
              chunkIndex: row.chunkIndex,
              chunkText: row.chunkText,
              entryVersion: row.entryVersion,
              modelId: opts.modelId,
            },
          })),
        );
        // Clear any stale tail from a previous, larger version of this entry.
        const stale: string[] = [];
        for (let i = kept.length; i < MAX_CHUNKS_PER_ENTRY; i++) stale.push(`${prefix}:${i}`);
        await deleteInBatches(index, stale);
      }
    },

    async deleteByEntry(scope: Scope, entryId: string) {
      const prefix = await entryPrefix(scope, entryId);
      const ids: string[] = [];
      for (let i = 0; i < MAX_CHUNKS_PER_ENTRY; i++) ids.push(`${prefix}:${i}`);
      await deleteInBatches(index, ids);
    },

    async upsertAsset(scope, row) {
      const [id, namespace] = await Promise.all([
        assetVectorId(scope, row.assetId, row.corpus),
        assetNamespaceFor(scope, row.corpus),
      ]);
      await index.upsert([
        {
          id,
          values: row.embedding,
          namespace,
          metadata: {
            kind: 'asset',
            spaceId: scope.spaceId,
            environmentId: scope.environmentId,
            assetId: row.assetId,
            assetKind: row.assetKind,
            version: row.version,
            modelId: opts.modelId,
          },
        },
      ]);
    },

    async deleteAsset(scope, assetId, corpus) {
      await index.deleteByIds([await assetVectorId(scope, assetId, corpus)]);
    },

    async queryAssets(scope, embedding, q) {
      const { matches } = await index.query(embedding, {
        topK: Math.min(q.topK, MAX_TOP_K),
        namespace: await assetNamespaceFor(scope, q.corpus),
        returnMetadata: 'all',
      });
      const minScore = q.minScore ?? -1;
      return matches
        .filter((m) => m.score >= minScore && typeof m.metadata?.assetId === 'string')
        .map((m): AssetVectorMatch => ({ assetId: String(m.metadata?.assetId), score: m.score }));
    },

    async query(scope: Scope, embedding: number[], opts2: { topK: number; minScore?: number }) {
      const namespace = await namespaceFor(scope);
      const { matches } = await index.query(embedding, {
        topK: Math.min(opts2.topK, MAX_TOP_K),
        namespace,
        returnMetadata: 'all',
      });
      const minScore = opts2.minScore ?? -1;
      return matches
        .filter((m) => m.score >= minScore)
        .map(
          (m): VectorMatch => ({
            entryId: String(m.metadata?.entryId ?? ''),
            ...(typeof m.metadata?.locale === 'string' ? { locale: m.metadata.locale } : {}),
            chunkText: String(m.metadata?.chunkText ?? ''),
            score: m.score,
          }),
        );
    },
  };
}
