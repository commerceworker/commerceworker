import type { DeliveredAsset, LocalizedValue } from '@commerceworker/domain';

/**
 * The data access the generated GraphQL Delivery schema (`@commerceworker/graphql-gen`) calls,
 * bound to one space/environment and one caller. The application implements it
 * (`deliveryGraphResolvers`); the schema only consumes it.
 */

/** An entry rendered (locale-flattened, links resolved) by the resolvers. */
export interface ResolvedEntry {
  readonly id: string;
  readonly contentType: string;
  readonly fields: Record<string, unknown>;
  readonly publishedAt: string;
  /** When it was first published, when known. */
  readonly firstPublishedAt?: string;
}

export interface DeliverySearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

/**
 * A published asset for the `Asset` type: delivered with its text per locale (each field takes
 * its own `locale` argument, falling back to the query's).
 */
export interface ResolvedAsset {
  readonly asset: DeliveredAsset;
  /** The `asset(locale:)` the query asked for. */
  readonly locale?: string;
}

/** Data access the generated schema needs — bound to a space/environment. */
export interface DeliveryResolvers {
  entry(contentType: string, id: string, locale?: string): Promise<ResolvedEntry | null>;
  /** A singleton type's published entry (`<type>` with no `id`), null when it has none. */
  singleton(contentType: string, locale?: string): Promise<ResolvedEntry | null>;
  collection(
    contentType: string,
    args: {
      locale?: string;
      limit?: number;
      skip?: number;
      /** Field-level predicates keyed `fields.x[op]` (see Delivery query syntax). */
      where?: Record<string, unknown>;
      /** Sort keys, e.g. `["fields.title", "-sys.publishedAt"]`. */
      order?: readonly string[];
      /** Full-text search over string fields. */
      search?: string;
    },
  ): Promise<ResolvedEntry[]>;
  asset(id: string, locale?: string): Promise<ResolvedAsset | null>;
  /**
   * One locale's text (with the space's fallbacks; its default locale when none is named), as
   * the Asset type's `title`, `description` and `altText` read it.
   */
  localize(value: LocalizedValue, locale?: string): Promise<string | null>;
  search(query: string, topK?: number): Promise<DeliverySearchHit[]>;
}
