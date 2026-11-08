/**
 * The catalog an `ai.extract` step shows the model, and the product index behind it.
 *
 * `extractCatalog` fetches a pool from `products` for one document (the SKUs it names, the names
 * that share its words, and, with the index bound, the SKUs whose embedding is close to one of its
 * lines) and ranks it with core's `rankExtractCandidates`, so the prompt stays within the model's
 * context however large the catalog. A catalog that fits whole is shown whole.
 *
 * The index (Vectorize, PRODUCT_VECTORS) holds one vector per SKU, its id the SKU, embedded from
 * the SKU and name. `products` has several writers outside the engine (the catalog's listing
 * changes, seeds, the demo reset), so rather than hook each one, `reindexProducts` diffs
 * `products` against `product_vectors` (what the index holds) on the hourly cron: new and renamed
 * SKUs are embedded and upserted, SKUs that are gone are deleted. Every write is keyed by SKU, so
 * a run cut short repeats harmlessly. Until a SKU is indexed it is still found by its words. An
 * admin can run it now too (`EngineRpc.reindexProducts`, the Commerce page); a run holds a lease
 * (`product_index_lease`), so the cron and that never overlap.
 *
 * The binding is optional: without it (tests, local dev, a demo, a deployment not yet
 * provisioned), or in mock AI mode, extraction ranks by words alone and the reindex does nothing.
 */

import {
  documentPhrases,
  documentSkus,
  documentTerms,
  EXTRACT_CANDIDATES,
  type ProductReindex,
  rankExtractCandidates,
  type SemanticMatch,
} from '@commerceworker/core';
import { gatewayOptions, NO_LOG_PAYLOAD, withTimeout } from './ai';
import { productIndexStore } from './wire';

/** 768 dimensions, cosine: the index is created with these (scripts/provision.sh). */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
/** Texts per embedding call (the model's batch limit) and per Vectorize write. */
const EMBED_BATCH = 100;
/**
 * SKUs a reindex run embeds. Its calls share the AI Gateway's rate limit (120 a minute) with
 * order steps, so a run takes 30 and a large catalog's first backfill spreads over hours.
 */
export const REINDEX_PER_RUN = 30 * EMBED_BATCH;
/** Matches per document line from the index. */
const MATCHES_PER_LINE = 10;
/** Pool rows from the name search. */
const NAME_POOL = 500;
/** Bound parameters per D1 query stay under its limit of 100. */
const IN_CHUNK = 90;

const chunks = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The index, when it is bound and models are live. */
function productIndex(env: Env): VectorizeIndex | undefined {
  if (String(env.AI_MODE) === 'mock') return undefined;
  return (env as { PRODUCT_VECTORS?: VectorizeIndex }).PRODUCT_VECTORS;
}

async function embed(env: Env, text: string[]): Promise<number[][]> {
  const res = (await withTimeout(
    env.AI.run(
      EMBEDDING_MODEL,
      // cls pooling: more accurate than the default mean, and not comparable with it, so every
      // vector in the index and every query must use it.
      { text, pooling: 'cls' } as never,
      gatewayOptions(env)
        ? { gateway: gatewayOptions(env), extraHeaders: NO_LOG_PAYLOAD }
        : undefined,
    ),
    20_000,
  )) as { data?: number[][] };
  if (!Array.isArray(res.data) || res.data.length !== text.length)
    throw new Error('embedding response has the wrong shape');
  return res.data;
}

const log = (line: Record<string, unknown>) =>
  console.log(JSON.stringify({ type: 'product_index', ...line }));

/** SKUs whose embedding is close to one of the document's lines; none without the index. */
export async function semanticMatches(env: Env, text: string): Promise<SemanticMatch[]> {
  const index = productIndex(env);
  const phrases = documentPhrases(text);
  if (!index || !phrases.length) return [];
  try {
    const vectors = await embed(env, phrases);
    const results = await Promise.all(
      vectors.map((v) => index.query(v, { topK: MATCHES_PER_LINE })),
    );
    const best = new Map<string, number>();
    for (const r of results)
      for (const m of r.matches) best.set(m.id, Math.max(m.score, best.get(m.id) ?? -1));
    return [...best].map(([sku, score]) => ({ sku, score }));
  } catch (err) {
    // The words still find what the document names; the index only adds what it means.
    console.warn(
      JSON.stringify({
        type: 'product_index',
        op: 'query',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }
}

/**
 * The catalog entries to show the model for `text`: the whole catalog when it fits, otherwise the
 * best of what the document's SKUs, words and (with the index) lines find.
 */
export async function extractCatalog(env: Env, text: string) {
  const store = productIndexStore(env);
  const head = await store.first(EXTRACT_CANDIDATES + 1);
  if (head.length <= EXTRACT_CANDIDATES) return rankExtractCandidates(text, head);

  const semantic = await semanticMatches(env, text);
  const skus = [...new Set([...documentSkus(text), ...semantic.map((s) => s.sku)])];
  const bySku = await store.bySku(skus);
  // Names sharing the most of the document's words: one scan, the top rows back.
  const byName = await store.byNameTerms(documentTerms(text), NAME_POOL);
  // An index hit for a SKU no longer in `products` finds no row here, so it drops out.
  const pool = [...bySku, ...byName];
  const candidates = rankExtractCandidates(text, pool, { semantic });
  log({
    op: 'extract',
    pool: pool.length,
    semantic: semantic.length,
    candidates: candidates.length,
  });
  return candidates;
}

/**
 * How long a run's lease lasts: a cron invocation's whole wall time, so a run that is still going
 * keeps it, and one that died frees it by the next hour's.
 */
const LEASE_MS = 15 * 60_000;

/**
 * Takes the reindex lease for `holder`, or answers false while another run's is unexpired. One
 * statement, so two runs starting together can't both take it.
 */
function takeLease(env: Env, holder: string, now: number) {
  return productIndexStore(env).takeLease(holder, now, now + LEASE_MS);
}

/**
 * Brings the index up to date with `products`, at most `max` SKUs embedded a run: new and renamed
 * ones are upserted (id = SKU), and the vectors of SKUs no longer in `products` deleted. The
 * vector is written before `product_vectors` records it, so a run that stops between the two
 * writes it again next time. `more` says there was more to embed than one run takes.
 *
 * Only one run at a time (`busy` otherwise): two would each embed the same SKUs against the
 * gateway's rate limit, and a run that read a name before a rename could write its vector after
 * one that read it after, leaving the old name's vector recorded as the new one's.
 */
export async function reindexProducts(env: Env, max = REINDEX_PER_RUN): Promise<ProductReindex> {
  const index = productIndex(env);
  if (!index) return { status: 'no_index' };
  const holder = crypto.randomUUID();
  if (!(await takeLease(env, holder, Date.now()))) {
    log({ op: 'reindex', busy: true });
    return { status: 'busy' };
  }
  try {
    const result = await reindex(env, index, max);
    log({ op: 'reindex', ...result });
    return { status: 'done', ...result };
  } finally {
    await productIndexStore(env).releaseLease(holder);
  }
}

async function reindex(env: Env, index: VectorizeIndex, max: number) {
  const store = productIndexStore(env);
  const changed = await store.changed(max);
  for (const batch of chunks(changed, EMBED_BATCH)) {
    const values = await embed(
      env,
      batch.map((p) => `${p.sku} ${p.name}`),
    );
    await index.upsert(
      batch.map((p, i) => ({
        id: p.sku,
        values: values[i]!,
        metadata: { name: p.name.slice(0, 200) },
      })),
    );
    await store.recordIndexed(batch, Date.now());
  }

  const gone = await store.gone(max);
  for (const batch of chunks(gone, IN_CHUNK)) {
    await index.deleteByIds(batch);
    await store.forget(batch);
  }
  return { indexed: changed.length, removed: gone.length, more: changed.length === max };
}
