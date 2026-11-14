import type { CatalogOrderLine, CatalogOrders } from '@commerceworker/ports/commerce';

export class InMemoryCatalogOrders implements CatalogOrders {
  readonly rows = new Map<string, { line: CatalogOrderLine; at: number }>();

  async apply(rows: { line: CatalogOrderLine; at: number }[]) {
    for (const { line, at } of rows) {
      const old = this.rows.get(line.sku);
      if (old && old.at >= at) continue;
      this.rows.set(line.sku, {
        at,
        line: {
          ...line,
          weightKg: line.weightKg ?? null,
          lengthCm: line.lengthCm ?? null,
          widthCm: line.widthCm ?? null,
          heightCm: line.heightCm ?? null,
        },
      });
    }
  }
}
