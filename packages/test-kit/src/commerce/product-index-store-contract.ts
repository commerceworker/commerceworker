/**
 * The behaviour every `ProductIndexStore` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). The fixture is the whole catalog in the store.
 */
import type { ProductIndexStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { ProductIndexFixture } from './product-index-store';

export const PRODUCT_INDEX_FIXTURE: ProductIndexFixture = {
  products: [
    { sku: 'PI-BOLT', name: 'Steel bolt M8' },
    { sku: 'PI-NUT', name: 'Steel hex nut M8' },
    { sku: 'PI-TEE', name: 'Cotton tee' },
    { sku: `PI-${'X'.repeat(70)}`, name: 'Long SKU' },
  ],
  vectors: [
    { sku: 'PI-BOLT', name: 'Steel bolt M8' },
    { sku: 'PI-NUT', name: 'Hex nut' },
    { sku: 'PI-GONE', name: 'Discontinued' },
  ],
};

export function describeProductIndexStoreContract(
  name: string,
  make: (fixture: ProductIndexFixture) => Promise<ProductIndexStore>,
) {
  describe(`${name}: the product index store contract`, () => {
    const fresh = () => make(PRODUCT_INDEX_FIXTURE);

    it('reads products first by SKU, by SKU, and by the most name terms', async () => {
      const s = await fresh();
      expect((await s.first(2)).map((p) => p.sku)).toEqual(['PI-BOLT', 'PI-NUT']);
      expect((await s.bySku(['PI-TEE', 'PI-NONE'])).map((p) => p.sku)).toEqual(['PI-TEE']);
      expect((await s.byNameTerms(['hex', 'steel'], 10)).map((p) => p.sku)).toEqual([
        'PI-NUT',
        'PI-BOLT',
      ]);
      expect(await s.byNameTerms([], 10)).toEqual([]);
    });

    it('searches by SKU first, then by words, and lists every product for no text', async () => {
      const s = await fresh();
      expect((await s.search('PI-TEE', 10))[0]?.sku).toBe('PI-TEE');
      expect((await s.search('cotton', 10)).map((p) => p.sku)).toEqual(['PI-TEE']);
      expect((await s.search('steel', 10)).map((p) => p.sku).sort()).toEqual(['PI-BOLT', 'PI-NUT']);
      expect((await s.search('', 2)).map((p) => p.sku)).toEqual(['PI-BOLT', 'PI-NUT']);
      expect(await s.search('zzzzzz', 10)).toEqual([]);
    });

    it('finds products with no vector or a renamed one, and vectors of products gone', async () => {
      const s = await fresh();
      expect((await s.changed(10)).map((p) => p.sku)).toEqual(['PI-NUT', 'PI-TEE']);
      expect(await s.gone(10)).toEqual(['PI-GONE']);
      await s.recordIndexed([{ sku: 'PI-NUT', name: 'Steel hex nut M8' }], 5);
      await s.forget(['PI-GONE']);
      expect((await s.changed(10)).map((p) => p.sku)).toEqual(['PI-TEE']);
      expect(await s.gone(10)).toEqual([]);
    });

    it('lets one run hold the lease until it expires or is released', async () => {
      const s = await fresh();
      expect(await s.takeLease('run-a', 100, 200)).toBe(true);
      expect(await s.takeLease('run-b', 150, 250)).toBe(false);
      expect(await s.takeLease('run-b', 200, 300)).toBe(true);
      await s.releaseLease('run-a');
      expect(await s.takeLease('run-c', 210, 310)).toBe(false);
      await s.releaseLease('run-b');
      expect(await s.takeLease('run-c', 210, 310)).toBe(true);
    });
  });
}
