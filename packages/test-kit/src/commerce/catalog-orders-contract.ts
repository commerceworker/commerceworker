import type { CatalogOrderLine, CatalogOrders } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

export function describeCatalogOrdersContract(
  name: string,
  make: () => Promise<{
    store: CatalogOrders;
    read: (sku: string) => Promise<{ line: CatalogOrderLine; at: number } | undefined>;
  }>,
) {
  describe(`${name}: catalog order products`, () => {
    it('keeps the newest fields, ignores equal timestamps and clears legacy missing dimensions', async () => {
      const { store, read } = await make();
      const line: CatalogOrderLine = {
        sku: 'coc_one',
        name: 'Crate',
        price: 12,
        weightKg: 4,
        lengthCm: 50,
        widthCm: 40,
        heightCm: 30,
      };
      await store.apply([{ line, at: 200 }]);
      await store.apply([
        { line: { ...line, name: 'Old' }, at: 100 },
        { line: { ...line, name: 'Equal' }, at: 200 },
      ]);
      expect(await read(line.sku)).toEqual({ line, at: 200 });
      const bare = { sku: line.sku, name: 'Bare', price: 15 } as CatalogOrderLine;
      await store.apply([{ line: bare, at: 300 }]);
      expect(await read(line.sku)).toEqual({
        at: 300,
        line: { ...bare, weightKg: null, lengthCm: null, widthCm: null, heightCm: null },
      });
    });

    it('handles empty batches and more than one hundred distinct SKUs', async () => {
      const { store, read } = await make();
      await store.apply([]);
      const rows = Array.from({ length: 205 }, (_, i) => ({
        at: 100,
        line: {
          sku: `coc_${i}`,
          name: `Product ${i}`,
          price: i,
          weightKg: null,
          lengthCm: null,
          widthCm: null,
          heightCm: null,
        },
      }));
      await store.apply(rows);
      for (const row of rows) expect(await read(row.line.sku)).toEqual(row);
    });
  });
}
