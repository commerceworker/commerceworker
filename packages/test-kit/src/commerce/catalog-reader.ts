/**
 * The catalog reader in memory, seeded with published documents. It answers as the read edge
 * does for what UCP asks: keyword search matches every word of the query against a product's
 * title, brand, description and SKUs, best match first being the order seeded; a listing is a
 * category's members, narrowed to those with a variant priced in the range, with an opaque cursor.
 * `calls` records each read, so a test can say what a use-case did and did not ask for.
 */
import { encodeListingCursor, gtin14, LISTING_SEGMENTS } from '@commerceworker/core/product';
import type {
  CatalogChannel,
  CatalogDoc,
  CatalogListingPage,
  CatalogReader,
  CatalogSearchPage,
} from '@commerceworker/ports/commerce';

export interface CatalogReaderFixture {
  /** The channel UCP shows; null when none is created. */
  channel?: CatalogChannel | null;
  /** Documents by locale: `docs.en` is what a read in `en` returns. A locale with none has none. */
  docs?: Record<string, CatalogDoc[]>;
  /** Type code → axis code → name, per locale (`axes.en.apparel.color`). */
  axes?: Record<string, Record<string, Record<string, string>>>;
  /** Hits of a search the edge answers partially (a shard failed). */
  partial?: boolean;
}

export const CATALOG_CHANNEL: CatalogChannel = {
  code: 'web',
  currency: 'USD',
  defaultLocale: 'en',
  locales: ['en', 'es'],
};

export class InMemoryCatalogReader implements CatalogReader {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly fixture: CatalogReaderFixture;

  constructor(fixture: CatalogReaderFixture = {}) {
    this.fixture = fixture;
  }

  private note(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }

  private docs(channel: string, locale: string): CatalogDoc[] {
    return channel === (this.fixture.channel?.code ?? CATALOG_CHANNEL.code)
      ? (this.fixture.docs?.[locale] ?? [])
      : [];
  }

  async channel() {
    this.note('channel');
    return this.fixture.channel === undefined ? CATALOG_CHANNEL : this.fixture.channel;
  }

  async search(
    channel: string,
    locale: string,
    q: string,
    page: { limit: number; offset: number },
  ): Promise<CatalogSearchPage> {
    this.note('search', channel, locale, q, page);
    const terms = q.split(/\s+/).filter(Boolean);
    const hits = this.docs(channel, locale).filter((d) => {
      const text = [d.title, d.brand, d.description, ...d.variants.map((v) => v.sku)]
        .join(' ')
        .toLowerCase();
      return terms.every((t) => text.includes(t.toLowerCase()));
    });
    const end = page.offset + page.limit;
    return {
      total: hits.length,
      keys: hits.slice(page.offset, end).map((d) => d.key),
      next: end < hits.length ? end : null,
      partial: this.fixture.partial === true,
    };
  }

  async listing(
    channel: string,
    locale: string,
    category: string,
    page: { limit: number; cursor?: string; price?: { min?: number; max?: number } },
  ): Promise<CatalogListingPage | null> {
    this.note('listing', channel, locale, category, page);
    const docs = this.docs(channel, locale);
    if (!docs.some((d) => d.categories.includes(category))) return null;
    const { min = 0, max = Number.POSITIVE_INFINITY } = page.price ?? {};
    const members = docs.filter(
      (d) =>
        d.categories.includes(category) &&
        d.variants.some((v) => v.price && v.price.amount >= min && v.price.amount <= max),
    );
    // The edge's cursor is a position per listing segment: this one keeps its offset in the first.
    const start = page.cursor ? Number.parseInt(page.cursor.split('.')[0] ?? '0', 36) : 0;
    const end = start + page.limit;
    return {
      total: members.length,
      keys: members.slice(start, end).map((d) => d.key),
      next:
        end < members.length
          ? encodeListingCursor([end, ...Array(LISTING_SEGMENTS - 1).fill(0)])
          : null,
    };
  }

  async doc(channel: string, locale: string, key: string) {
    this.note('doc', channel, locale, key);
    return this.docs(channel, locale).find((d) => d.key === key) ?? null;
  }

  async bySku(channel: string, locale: string, sku: string) {
    this.note('bySku', channel, locale, sku);
    return this.docs(channel, locale).find((d) => d.variants.some((v) => v.sku === sku)) ?? null;
  }

  async bySlug(channel: string, locale: string, slug: string) {
    this.note('bySlug', channel, locale, slug);
    return this.docs(channel, locale).find((d) => d.slug === slug) ?? null;
  }

  async byGtin(channel: string, locale: string, gtin: string) {
    this.note('byGtin', channel, locale, gtin);
    return (
      this.docs(channel, locale).find((d) =>
        d.variants.some((v) => v.gtin && gtin14(v.gtin) === gtin),
      ) ?? null
    );
  }

  async axisNames(type: string, locale: string) {
    this.note('axisNames', type, locale);
    return this.fixture.axes?.[locale]?.[type.split('@')[0] ?? ''] ?? {};
  }
}
