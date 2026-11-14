import type { CatalogOrders } from '@commerceworker/ports/commerce';

const UPSERT = `INSERT INTO products
    (sku, name, price, cost, catalog_at, weight_kg, length_cm, width_cm, height_cm)
  VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
  ON CONFLICT (sku) DO UPDATE SET name = excluded.name, price = excluded.price,
    catalog_at = excluded.catalog_at, weight_kg = excluded.weight_kg,
    length_cm = excluded.length_cm, width_cm = excluded.width_cm, height_cm = excluded.height_cm
  WHERE products.catalog_at IS NULL OR products.catalog_at < excluded.catalog_at`;

export function d1CatalogOrders(db: D1Database): CatalogOrders {
  return {
    async apply(rows) {
      const statements = rows.map(({ line, at }) =>
        db
          .prepare(UPSERT)
          .bind(
            line.sku,
            line.name,
            line.price,
            at,
            line.weightKg ?? null,
            line.lengthCm ?? null,
            line.widthCm ?? null,
            line.heightCm ?? null,
          ),
      );
      for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
    },
  };
}
