import { DurableObject } from 'cloudflare:workers';
import type { Scope } from '@commerceworker/domain';
import type {
  LexicalSearchHit,
  SearchDoc,
  SearchIndex,
  SearchIndexStats,
} from '@commerceworker/ports';

/**
 * The lexical leg of hybrid search: FTS5 inside Durable Objects, sharded per space:environment.
 *
 * Why not D1: an FTS index is written on every publish, and D1 has one writer per database, so
 * keeping it there would put search maintenance in line with every content write; D1 also cannot
 * export a database holding a virtual table. Here each shard is its own SQLite with its own
 * writer, fed asynchronously from the `index` work of the event consumer, so search writes scale
 * out with the number of shards and never touch the system of record.
 *
 * One object per `${spaceId}:${environmentId}:${n}`, n in [0, shards). An entry always lives on
 * the shard its id hashes to; a query asks every shard of the scope in parallel for its best
 * `topK` and merges by score, so a search costs one round of `shards` small queries. BM25 is
 * computed per shard, so scores are only approximately comparable across shards; hybrid search
 * fuses ranks (RRF), not raw scores, which is what makes that acceptable.
 */
export class SearchShardDO extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    // Accents fold ("creme" finds "crème"); 2- and 3-char prefix indexes keep the last term's
    // prefix match fast. `docs` holds one row per (entry, locale); `versions` makes indexing
    // idempotent and order-independent (an older version arriving late is ignored).
    this.sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        text, entry_id UNINDEXED, locale UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
      CREATE TABLE IF NOT EXISTS versions (entry_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
    `);
  }

  /** Indexes (or replaces) one entry's text; ignored when an equal or newer version is held. */
  index(doc: SearchDoc): void {
    this.ctx.storage.transactionSync(() => {
      const held = this.sql
        .exec<{ version: number }>('SELECT version FROM versions WHERE entry_id = ?', doc.entryId)
        .toArray()[0];
      if (held && held.version > doc.entryVersion) return;
      this.sql.exec('DELETE FROM docs WHERE entry_id = ?', doc.entryId);
      for (const [locale, text] of Object.entries(doc.textByLocale)) {
        if (text.trim()) {
          this.sql.exec(
            'INSERT INTO docs (text, entry_id, locale) VALUES (?, ?, ?)',
            text,
            doc.entryId,
            locale,
          );
        }
      }
      this.sql.exec(
        'INSERT OR REPLACE INTO versions (entry_id, version) VALUES (?, ?)',
        doc.entryId,
        doc.entryVersion,
      );
    });
  }

  remove(entryId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM docs WHERE entry_id = ?', entryId);
      this.sql.exec('DELETE FROM versions WHERE entry_id = ?', entryId);
    });
  }

  /** This shard's best `topK` entries for an FTS5 MATCH expression, best first. */
  search(match: string, topK: number): LexicalSearchHit[] {
    if (!match) return [];
    // FTS5's `rank` is bm25 (lower is better). bm25 can't sit under an aggregate, so rows come
    // back per (entry, locale), over-fetched, and an entry matching in several locales keeps its
    // best row here.
    const rows = this.sql
      .exec<{ entry_id: string; rank: number }>(
        'SELECT entry_id, rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?',
        match,
        topK * 4,
      )
      .toArray();
    const best = new Map<string, number>();
    for (const r of rows) if (!best.has(r.entry_id)) best.set(r.entry_id, -r.rank);
    return [...best].slice(0, topK).map(([entryId, score]) => ({ entryId, score }));
  }

  count(): number {
    return this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM versions').one().n;
  }

  /** Empties the shard (its scope's environment was deleted). */
  clear(): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM docs');
      this.sql.exec('DELETE FROM versions');
    });
  }
}

/**
 * Turns free text into a safe FTS5 expression: every term must match (implicit AND), each is a
 * quoted string (so operators and punctuation in user input are inert), and the last term matches
 * as a prefix so search-as-you-type works. Empty input yields ''.
 */
export function ftsMatch(query: string): string {
  const terms = query
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 16);
  if (terms.length === 0) return '';
  return terms
    .map((t, i) => `"${t.replace(/"/g, '""')}"${i === terms.length - 1 ? '*' : ''}`)
    .join(' ');
}

/** FNV-1a: a stable, cheap shard key (not security-relevant). */
export function shardOf(entryId: string, shards: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < entryId.length; i++) {
    h ^= entryId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % shards;
}

/** Shards per space:environment unless SEARCH_SHARDS says otherwise. */
export const DEFAULT_SEARCH_SHARDS = 8;

type ShardStub = Pick<SearchShardDO, 'index' | 'remove' | 'search' | 'count' | 'clear'>;

/**
 * Which documents a sharded index holds. Assets live in shards of their own (`…:assets:<n>`, and
 * `…:pubassets:<n>` for the published ones Delivery searches):
 * the same class, so no new Durable Object or migration tag, but separate objects, so entry
 * search never returns an asset id and the entry index's drift count stays a count of entries.
 */
export type SearchCorpus = 'entries' | 'assets' | 'published-assets';

/** Each corpus's infix in a shard's name; entries keep the bare name they always had. */
const CORPUS_INFIX: Record<SearchCorpus, string> = {
  entries: '',
  assets: 'assets:',
  'published-assets': 'pubassets:',
};

/** The SearchIndex port over the shard namespace. */
export function createShardedSearchIndex(
  ns: DurableObjectNamespace<SearchShardDO>,
  shards = DEFAULT_SEARCH_SHARDS,
  corpus: SearchCorpus = 'entries',
): SearchIndex {
  const infix = CORPUS_INFIX[corpus];
  const stub = (scope: Scope, n: number) =>
    ns.getByName(`${scope.spaceId}:${scope.environmentId}:${infix}${n}`) as unknown as ShardStub;
  const all = (scope: Scope) => Array.from({ length: shards }, (_, n) => stub(scope, n));
  return {
    async index(scope, doc) {
      await stub(scope, shardOf(doc.entryId, shards)).index(doc);
    },
    async remove(scope, entryId) {
      await stub(scope, shardOf(entryId, shards)).remove(entryId);
    },
    async search(scope, query, { topK }) {
      const match = ftsMatch(query);
      if (!match) return [];
      const perShard = await Promise.all(all(scope).map((s) => s.search(match, topK)));
      return perShard
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
    async clear(scope) {
      await Promise.all(all(scope).map((s) => s.clear()));
    },
    async stats(scope): Promise<SearchIndexStats> {
      const counts = await Promise.all(all(scope).map((s) => s.count()));
      return { documents: counts.reduce((a, b) => a + b, 0), engine: 'fts5-shards' };
    },
  };
}
