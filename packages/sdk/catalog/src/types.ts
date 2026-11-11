/**
 * What the catalog edge answers, redeclared here: the SDK imports no server code. Prices are the
 * channel's currency in minor units and text is already in the client's locale.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export interface Media {
  readonly src: string;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ProductVariant {
  readonly sku: string;
  readonly gtin?: string;
  readonly mpn?: string;
  readonly status: string;
  /** Each option axis as `{ code, label }`. */
  readonly options: Readonly<Record<string, { code: string; label: string }>>;
  readonly attributes: Readonly<Record<string, Json>>;
  readonly price?: Money;
  readonly media?: readonly Media[];
}

/** A published product, as `product`, `sku` and `slug` return it. */
export interface ProductDocument {
  readonly key: string;
  readonly type: string;
  readonly version: number;
  readonly updatedAt: number;
  readonly title: string;
  readonly slug?: string;
  readonly description?: string;
  readonly brand?: string;
  readonly categories: readonly string[];
  readonly primaryCategory?: string;
  readonly media: readonly (Media & { focus?: readonly [number, number] })[];
  readonly attributes: Readonly<Record<string, Json>>;
  readonly variants: readonly ProductVariant[];
  readonly price?: Money;
  readonly compareAt?: Money;
  readonly priceRange?: { readonly min: Money; readonly max: Money };
  readonly extra?: Readonly<Record<string, Json>>;
}

/** What lists show per product. */
export interface ProductCard {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly slug?: string;
  readonly brand?: string;
  readonly image?: Media;
  readonly price?: Money;
  readonly compareAt?: Money;
  readonly priceRange?: { readonly min: Money; readonly max: Money };
  /** How many variants the product has. */
  readonly variants: number;
  readonly attributes: Readonly<Record<string, Json>>;
}

export interface Category {
  readonly code: string;
  readonly parent: string | null;
  readonly name: string;
  readonly slug?: string;
  readonly position: number;
}

export interface FacetValue {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface RangeFacet {
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly buckets?: readonly unknown[];
}

/** One page of a category's listing. `next` is the opaque cursor of the page after, null on the last. */
export interface ListingPage {
  readonly total: number;
  readonly next: string | null;
  /** The sorts this category's listing supports. */
  readonly sorts: readonly string[];
  readonly products: readonly ProductCard[];
  readonly facets: Readonly<Record<string, { label: string; values: readonly FacetValue[] }>>;
  readonly ranges: Readonly<Record<string, RangeFacet>>;
}

/** One page of search results. `next` is the offset of the page after, null on the last. */
export interface SearchPage {
  readonly total: number;
  readonly next: number | null;
  readonly products: readonly ProductCard[];
  /** An answer that couldn't reach every part of the index; retry shortly. */
  readonly partial?: true;
}
