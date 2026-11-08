import type { Scope } from '@commerceworker/domain';
import type { AppContext } from './context';
import { getEntry } from './entries';
import { extractTextByLocale, type RagDeps, type SearchHit, semanticSearch } from './rag';

/** Picks the entry text for a locale (or the first available), for embedding. */
async function entryText(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  locale?: string,
): Promise<{ text: string; locale?: string }> {
  const { fields } = await getEntry(ctx, scope, entryId); // throws NotFoundError
  const byLocale = extractTextByLocale(fields);
  const chosen = locale ?? Object.keys(byLocale)[0];
  return { text: chosen ? (byLocale[chosen] ?? '') : '', locale: chosen };
}

/**
 * Finds entries semantically related to a given entry by embedding its text and
 * searching the vector index, excluding the entry itself. Reuses the same
 * Vectorize index that backs delivery semantic search.
 */
export async function relatedEntries(
  deps: RagDeps,
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  opts: { topK?: number; minScore?: number; locale?: string } = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 5;
  const { text } = await entryText(ctx, scope, entryId, opts.locale);
  if (!text.trim()) return [];
  const hits = await semanticSearch(deps, scope, text, {
    topK: topK + 1,
    minScore: opts.minScore,
  });
  return hits.filter((h) => h.entryId !== entryId).slice(0, topK);
}

export interface DuplicateMatch extends SearchHit {
  /** Always true: every returned match is at or above the duplicate threshold. */
  readonly isDuplicate: true;
}

/**
 * Detects near-duplicate entries: related entries whose similarity meets a high
 * threshold (default 0.9). Use to warn editors before they create a near-copy.
 */
export async function findDuplicates(
  deps: RagDeps,
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  opts: { threshold?: number; topK?: number; locale?: string } = {},
): Promise<DuplicateMatch[]> {
  const threshold = opts.threshold ?? 0.9;
  const related = await relatedEntries(deps, ctx, scope, entryId, {
    topK: opts.topK ?? 10,
    minScore: threshold,
    locale: opts.locale,
  });
  return related.map((h) => ({ ...h, isDuplicate: true as const }));
}

export interface SemanticRepresentation {
  readonly entryId: string;
  readonly locale?: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly vector: readonly number[];
}

/**
 * Exposes an entry's vector embedding — the semantic-representation API. Lets
 * callers do their own similarity math or feed the vector to other systems.
 */
export async function getEntryEmbedding(
  deps: RagDeps,
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  opts: { locale?: string } = {},
): Promise<SemanticRepresentation> {
  const { text, locale } = await entryText(ctx, scope, entryId, opts.locale);
  const base = {
    entryId,
    locale,
    modelId: deps.embeddings.modelId,
    dimensions: deps.embeddings.dimensions,
  };
  if (!text.trim()) return { ...base, vector: [] };
  const [vector] = await deps.embeddings.embed([text], { taskType: 'document' });
  return { ...base, vector: vector ?? [] };
}
