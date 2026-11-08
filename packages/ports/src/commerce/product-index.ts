/**
 * The bookkeeping of the semantic product index (the vectors live in Vectorize, the engine's AI
 * adapter): which products a document's extraction can match, which products changed since their
 * vector was written, which vectors are of products no longer sold, and the one lease a reindex
 * holds so two runs never overlap. `d1ProductIndexStore` (packages/db) and
 * `InMemoryProductIndexStore` (packages/test-kit) implement it, held to one contract.
 */

export interface NamedProduct {
  readonly sku: string;
  readonly name: string;
}

export interface ProductIndexStore {
  /** The first products by SKU, up to `limit`: the whole catalog when it is small. */
  first(limit: number): Promise<NamedProduct[]>;
  /** These products; unknown SKUs are absent. */
  bySku(skus: readonly string[]): Promise<NamedProduct[]>;
  /**
   * Products for what a person typed: the one whose SKU it is, then the full-text matches best
   * first, up to `limit` (every product by SKU when nothing was typed).
   */
  search(typed: string, limit: number): Promise<NamedProduct[]>;
  /** Products whose names hold the most of `terms`, the best first, up to `limit`. */
  byNameTerms(terms: readonly string[], limit: number): Promise<NamedProduct[]>;
  /**
   * Takes the lease for `holder` until `expiresAt`, or false while another holder's is unexpired at
   * `now`. One statement, so two runs starting together can't both take it.
   */
  takeLease(holder: string, now: number, expiresAt: number): Promise<boolean>;
  /** Frees the lease, if `holder` still holds it. */
  releaseLease(holder: string): Promise<void>;
  /** Products with no vector, or renamed since theirs (SKUs of at most 64 bytes), by SKU. */
  changed(limit: number): Promise<NamedProduct[]>;
  /** Records that these products' vectors were written at `at`. */
  recordIndexed(products: readonly NamedProduct[], at: number): Promise<void>;
  /** SKUs with a recorded vector whose product is gone. */
  gone(limit: number): Promise<string[]>;
  /** Forgets these SKUs' recorded vectors. */
  forget(skus: readonly string[]): Promise<void>;
}
