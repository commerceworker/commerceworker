import type { Scope } from '@commerceworker/domain';
import type { SearchIndex } from '@commerceworker/ports';
import type { AppContext } from './context';

/**
 * What an operator can learn about the lexical index without querying it.
 *
 * The question this answers is "is search returning everything it should?",
 * which until now had no answer short of searching for something known to exist
 * and seeing whether it came back.
 */
export interface SearchIndexHealth {
  /** False when the SearchShard index is not bound: the lexical leg runs on the store's built-in term matching. */
  readonly bound: boolean;
  /** Engine identifier, when the adapter reports one. */
  readonly engine?: string;
  /** Documents held for this scope, or undefined when the engine cannot count. */
  readonly documents?: number;
  /** Entries published in this scope — one document each, when in sync. */
  readonly publishedEntries: number;
  /**
   * `documents - publishedEntries`. Negative means published entries are
   * missing from the index and searches will not find them; positive means the
   * index holds documents for entries that are no longer published, which show
   * up as hits that resolve to nothing.
   */
  readonly drift?: number;
  /**
   * True only when the counts match exactly.
   *
   * Matching counts do not prove each document corresponds to a published
   * entry — one missing and one stale cancel out — so this is a cheap negative
   * signal, not a guarantee. It is worth having because the failure it does
   * catch, an index that silently stopped being written to, is the common one.
   */
  readonly inSync?: boolean;
}

/**
 * Compares what the lexical index holds against what is published.
 *
 * Read-only and cheap — two counts — so it is safe to poll from a monitor. The
 * remedy for drift is the existing reindex, which rewrites both the vector and
 * lexical legs.
 */
export async function searchIndexHealth(
  ctx: AppContext,
  scope: Scope,
  searchIndex?: SearchIndex,
  opts: { contentType?: string } = {},
): Promise<SearchIndexHealth> {
  const publishedEntries = await ctx.store.entries.countPublished(scope, {
    contentType: opts.contentType,
  });
  if (!searchIndex) return { bound: false, publishedEntries };
  if (!searchIndex.stats) {
    // Reporting drift against a count we do not have would invent a number; an
    // engine that cannot count says so.
    return { bound: true, publishedEntries };
  }
  const stats = await searchIndex.stats(scope);
  // Only comparable when counting the same population: a content-type filter
  // narrows the entries but not the index-wide document count.
  if (opts.contentType) {
    return {
      bound: true,
      engine: stats.engine,
      documents: stats.documents,
      publishedEntries,
    };
  }
  const drift = stats.documents - publishedEntries;
  return {
    bound: true,
    engine: stats.engine,
    documents: stats.documents,
    publishedEntries,
    drift,
    inSync: drift === 0,
  };
}
