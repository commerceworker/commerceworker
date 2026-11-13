/**
 * A listing card made from the published document, for when KV can't answer. The publisher renders a
 * card and a document together (packages/core/src/product/render.ts), and the card is a slice of
 * the document; this is the same slice, built by hand because core's `renderForChannel` pulls in
 * the whole model and this Worker keeps to ~10 KiB (test/catalog-bundle.test.ts). One thing a card
 * has that a document doesn't say: which attributes the type marks `card`. Those come back as an
 * empty `attributes`; everything else a listing shows is there.
 */
import type { ProductCard, ProductDoc } from '@commerceworker/core/product';

/** The card for a published document's JSON, serialized as KV stores it; null for what isn't one. */
export function cardFromDoc(text: string): string | null {
  let doc: ProductDoc;
  try {
    doc = JSON.parse(text) as ProductDoc;
  } catch {
    return null;
  }
  if (!doc || typeof doc.key !== 'string') return null;
  const first = doc.media?.[0];
  const card: ProductCard = {
    key: doc.key,
    version: doc.version,
    title: doc.title,
    slug: doc.slug,
    brand: doc.brand,
    image: first && { src: first.src, alt: first.alt, width: first.width, height: first.height },
    price: doc.price,
    compareAt: doc.compareAt,
    priceRange: doc.priceRange,
    variants: doc.variants?.length ?? 0,
    attributes: {},
  };
  return JSON.stringify(card);
}
