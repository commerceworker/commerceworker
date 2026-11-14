import { env } from 'cloudflare:workers';
import type { CatalogOrderLine } from '@commerceworker/ports/commerce';
import { describeCatalogOrdersContract } from '@commerceworker/test-kit/commerce';
import { expect, it } from 'vitest';
import { d1CatalogOrders } from '../src/catalog-orders';

const DB = (env as unknown as { DB: D1Database }).DB;
describeCatalogOrdersContract('D1', async () => {
  await DB.prepare("DELETE FROM products WHERE sku LIKE 'coc_%'").run();
  return {
    store: d1CatalogOrders(DB),
    read: async (sku) => {
      const row = await DB.prepare(`SELECT sku, name, price, weight_kg AS weightKg,
      length_cm AS lengthCm, width_cm AS widthCm, height_cm AS heightCm,
      catalog_at AS at FROM products WHERE sku = ?`)
        .bind(sku)
        .first<CatalogOrderLine & { at: number }>();
      if (!row) return undefined;
      const { at, ...line } = row;
      return { at, line };
    },
  };
});

it('updates legacy rows without replacing commerce-owned fields', async () => {
  await DB.prepare(`INSERT INTO products (sku, name, price, cost, stock)
    VALUES ('coc_legacy', 'Legacy', 1, 7, 9)`).run();
  await d1CatalogOrders(DB).apply([
    {
      at: 10,
      line: {
        sku: 'coc_legacy',
        name: 'Current',
        price: 20,
        weightKg: null,
        lengthCm: null,
        widthCm: null,
        heightCm: null,
      },
    },
  ]);
  expect(
    await DB.prepare(
      "SELECT name, price, cost, stock, catalog_at FROM products WHERE sku = 'coc_legacy'",
    ).first(),
  ).toEqual({ name: 'Current', price: 20, cost: 7, stock: 9, catalog_at: 10 });
});
