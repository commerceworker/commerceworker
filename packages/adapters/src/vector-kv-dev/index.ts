import type { Scope } from '@commerceworker/domain';
import type {
  AssetSearchCorpus,
  AssetVectorMatch,
  AssetVectorRow,
  VectorMatch,
  VectorRow,
  VectorStore,
} from '@commerceworker/ports';

/** The subset of a KV namespace binding this store uses. */
export interface KvVectorBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/**
 * A vector store for local development only, selected by `VECTOR_STORE=kv`.
 *
 * Vectorize has no local emulator, and an in-memory store lives in one isolate: the engine would
 * embed into its own memory while the api searched an empty one. Local KV is shared by every
 * Worker in a dev session, so this store keeps one key per entry (all its locales and chunks) and
 * answers a query by brute-force cosine over the scope's keys. That is fine for a seeded dev
 * dataset and wrong for anything larger, which is why wiring reports it as a fake adapter: a
 * persistent deployment refuses it unless ALLOW_FAKE_ADAPTERS names `vectors`.
 */
export function createKvDevVectorStore(kv: KvVectorBinding): VectorStore {
  const prefix = (scope: Scope) => `vec:${scope.spaceId}:${scope.environmentId}:`;
  const entryKey = (scope: Scope, entryId: string) => `${prefix(scope)}${entryId}`;
  const identity = (r: Pick<VectorRow, 'locale' | 'chunkIndex'>) =>
    `${r.locale}\u0000${r.chunkIndex}`;

  const read = async (key: string): Promise<VectorRow[]> => {
    const raw = await kv.get(key);
    return raw ? (JSON.parse(raw) as VectorRow[]) : [];
  };

  // Assets under a prefix of their own per corpus, so an entry query's scan never reads one.
  const assetPrefix = (scope: Scope, corpus: AssetSearchCorpus) =>
    `${corpus === 'library' ? 'vecasset' : 'vecpubasset'}:${scope.spaceId}:${scope.environmentId}:`;
  return {
    async upsertAsset(scope, row) {
      await kv.put(`${assetPrefix(scope, row.corpus)}${row.assetId}`, JSON.stringify(row));
    },

    async deleteAsset(scope, assetId, corpus) {
      await kv.delete(`${assetPrefix(scope, corpus)}${assetId}`);
    },

    async queryAssets(scope, embedding, opts) {
      const matches: AssetVectorMatch[] = [];
      let cursor: string | undefined;
      do {
        const page = await kv.list({
          prefix: assetPrefix(scope, opts.corpus),
          cursor,
          limit: 1000,
        });
        for (const { name } of page.keys) {
          const raw = await kv.get(name);
          if (!raw) continue;
          const row = JSON.parse(raw) as AssetVectorRow;
          const score = cosine(embedding, row.embedding);
          if (score >= (opts.minScore ?? 0)) matches.push({ assetId: row.assetId, score });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return matches.sort((a, b) => b.score - a.score).slice(0, opts.topK);
    },

    async upsert(rows) {
      const byEntry = new Map<string, VectorRow[]>();
      for (const row of rows) {
        const key = entryKey(row.scope, row.entryId);
        byEntry.set(key, [...(byEntry.get(key) ?? []), row]);
      }
      for (const [key, incoming] of byEntry) {
        // Replace rows with the same (locale, chunk) identity; keep the rest.
        const replaced = new Set(incoming.map(identity));
        const kept = (await read(key)).filter((r) => !replaced.has(identity(r)));
        await kv.put(key, JSON.stringify([...kept, ...incoming]));
      }
    },

    async deleteByEntry(scope, entryId) {
      await kv.delete(entryKey(scope, entryId));
    },

    async query(scope, embedding, opts) {
      const matches: VectorMatch[] = [];
      let cursor: string | undefined;
      do {
        const page = await kv.list({ prefix: prefix(scope), cursor, limit: 1000 });
        for (const { name } of page.keys) {
          for (const row of await read(name)) {
            const score = cosine(embedding, row.embedding);
            if (score >= (opts.minScore ?? 0)) {
              matches.push({
                entryId: row.entryId,
                locale: row.locale,
                chunkText: row.chunkText,
                score,
              });
            }
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return matches.sort((a, b) => b.score - a.score).slice(0, opts.topK);
    },
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
