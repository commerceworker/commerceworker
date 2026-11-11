/**
 * What UCP catalog search and lookup read: the catalog as its read edge publishes it (apps/delivery,
 * `CatalogDelivery`), never the catalog's own storage. A product is a published document, which has
 * already merged translations and picked its prices for one channel and locale. `edgeCatalogReader`
 * (`@commerceworker/adapters/catalog-edge`) implements it over the edge and the catalog's types and
 * channels, and `InMemoryCatalogReader` (`@commerceworker/test-kit`) in memory.
 *
 * Read-only. Every method answers for one channel, which only the use-case chooses.
 */
import type { ProductDoc } from '@commerceworker/core/product';

/** A published product document, as the edge serves it. */
export type CatalogDoc = ProductDoc;

/** The channel UCP shows: its currency, and the locales its documents are published in. */
export interface CatalogChannel {
  readonly code: string;
  readonly currency: string;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
}

/** One page of keyword hits, best match first. `next` is the offset of the page after. */
export interface CatalogSearchPage {
  readonly total: number;
  readonly keys: readonly string[];
  readonly next: number | null;
  /** An answer that couldn't reach every part of the index. */
  readonly partial: boolean;
}

/** One page of a category, in the edge's order. `next` is the edge's opaque cursor. */
export interface CatalogListingPage {
  readonly total: number;
  readonly keys: readonly string[];
  readonly next: string | null;
}

export interface CatalogReader {
  /** The channel UCP shows (the catalog's orders channel), or null when it isn't created. */
  channel(): Promise<CatalogChannel | null>;
  /**
   * Keyword search. `q` is already normalized (`normalizeQuery`), so every spelling of a query is
   * one edge cache entry.
   */
  search(
    channel: string,
    locale: string,
    q: string,
    page: { limit: number; offset: number },
  ): Promise<CatalogSearchPage>;
  /**
   * A category's products, optionally within a price range (minor units, inclusive). Null when the
   * category has no published listing. `cursor` is one the edge returned.
   */
  listing(
    channel: string,
    locale: string,
    category: string,
    page: { limit: number; cursor?: string; price?: { min?: number; max?: number } },
  ): Promise<CatalogListingPage | null>;
  /** The product with this key, or null. */
  doc(channel: string, locale: string, key: string): Promise<CatalogDoc | null>;
  /** The product holding this variant SKU, or null. */
  bySku(channel: string, locale: string, sku: string): Promise<CatalogDoc | null>;
  /** Option axis code → the name shown for it, for a product's type (`code@version`). */
  axisNames(type: string, locale: string): Promise<Record<string, string>>;
}
