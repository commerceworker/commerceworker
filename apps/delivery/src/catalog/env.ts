/** What the catalog side of the delivery Worker binds. A content-only deployment binds none of it. */
export interface CatalogEnv {
  /** The catalog's published documents, alias pointers and category trees (read-only). */
  readonly PUBLISHED: R2Bucket;
  /** Listing cards and key to uid entries (read-only). */
  readonly CARDS: KVNamespace;
  /** The catalog Worker's `SearchApi` entrypoint (keyword search). */
  readonly CATALOG: Fetcher;
  /** Requests by route, channel, status and cache result, with latency. */
  readonly ANALYTICS?: AnalyticsEngineDataset;
}
