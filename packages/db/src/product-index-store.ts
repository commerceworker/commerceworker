/**
 * The product index port (`ProductIndexStore`, @commerceworker/ports/commerce) on D1: `products`,
 * `product_vectors` and `product_index_lease`. Moved here from the engine's product indexing. Id
 * lists are read in runs under D1's 100-parameter limit. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import { ftsQuery, normalizeQuery } from '@commerceworker/core/product';
import type { NamedProduct, ProductIndexStore } from '@commerceworker/ports/commerce';
import { asc, inArray, sql } from 'drizzle-orm';
import { createDb } from './index';
import { products, productVectors } from './schema';

const IN_CHUNK = 90;
const chunks = <T>(xs: readonly T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export function d1ProductIndexStore(d1: D1Database): ProductIndexStore {
  const d = createDb(d1);
  return {
    first: (limit) =>
      d
        .select({ sku: products.sku, name: products.name })
        .from(products)
        .orderBy(asc(products.sku))
        .limit(limit),

    async bySku(skus) {
      const found = await Promise.all(
        chunks([...new Set(skus)], IN_CHUNK).map((c) =>
          d
            .select({ sku: products.sku, name: products.name })
            .from(products)
            .where(inArray(products.sku, c)),
        ),
      );
      return found.flat();
    },

    async search(typed, limit) {
      if (!typed)
        return (
          await d1
            .prepare('SELECT sku, name FROM products ORDER BY sku LIMIT ?')
            .bind(limit)
            .all<NamedProduct>()
        ).results;
      const exact = d1.prepare('SELECT sku, name FROM products WHERE sku = ?').bind(typed);
      const match = ftsQuery(normalizeQuery(typed));
      if (!match) return (await exact.all<NamedProduct>()).results;
      // Ranked (by the weights the migration set) and cut to a page inside FTS5, so only that page
      // is joined to `products`.
      const [bySku, byWords] = await d1.batch<NamedProduct>([
        exact,
        d1
          .prepare(
            `SELECT p.sku, p.name FROM (
               SELECT rowid AS id, rank FROM products_search WHERE products_search MATCH ?
               ORDER BY rank LIMIT ?
             ) m JOIN products p ON p.rowid = m.id ORDER BY m.rank, p.sku`,
          )
          .bind(match, limit),
      ]);
      const seen = new Set<string>();
      return [...(bySku?.results ?? []), ...(byWords?.results ?? [])]
        .filter((r) => !seen.has(r.sku) && seen.add(r.sku))
        .slice(0, limit);
    },

    async byNameTerms(terms, limit) {
      if (!terms.length) return [];
      // Names sharing the most of the terms, counted in SQL: one scan, the top rows back.
      const { results } = await d1
        .prepare(
          `SELECT sku, name FROM products WHERE ${terms.map((_, i) => `name LIKE ?${i + 1}`).join(' OR ')}
           ORDER BY ${terms.map((_, i) => `(name LIKE ?${i + 1})`).join(' + ')} DESC LIMIT ${Math.floor(limit)}`,
        )
        .bind(...terms.map((t) => `%${t}%`))
        .all<{ sku: string; name: string }>();
      return results;
    },

    async takeLease(holder, now, expiresAt) {
      const row = await d1
        .prepare(
          `INSERT INTO product_index_lease (id, holder, expires_at) VALUES (1, ?1, ?2)
           ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
           WHERE product_index_lease.expires_at <= ?3
           RETURNING holder`,
        )
        .bind(holder, expiresAt, now)
        .first<{ holder: string }>();
      return row?.holder === holder;
    },

    async releaseLease(holder) {
      await d1
        .prepare('DELETE FROM product_index_lease WHERE id = 1 AND holder = ?')
        .bind(holder)
        .run();
    },

    async changed(limit) {
      // A Vectorize id is at most 64 bytes; a longer SKU is left to the word search.
      const { results } = await d1
        .prepare(
          `SELECT p.sku AS sku, p.name AS name FROM products p
           LEFT JOIN product_vectors v ON v.sku = p.sku
           WHERE (v.sku IS NULL OR v.name <> p.name) AND length(CAST(p.sku AS BLOB)) <= 64
           ORDER BY p.sku LIMIT ?`,
        )
        .bind(limit)
        .all<{ sku: string; name: string }>();
      return results;
    },

    async recordIndexed(rows, at) {
      const [first, ...rest] = rows.map((p) =>
        d
          .insert(productVectors)
          .values({ sku: p.sku, name: p.name, indexedAt: at })
          .onConflictDoUpdate({ target: productVectors.sku, set: { name: p.name, indexedAt: at } }),
      );
      if (first) await d.batch([first, ...rest]);
    },

    async gone(limit) {
      const rows = await d
        .select({ sku: productVectors.sku })
        .from(productVectors)
        .where(sql`${productVectors.sku} NOT IN (SELECT ${products.sku} FROM ${products})`)
        .limit(limit);
      return rows.map((r) => r.sku);
    },

    async forget(skus) {
      for (const c of chunks([...skus], IN_CHUNK))
        await d.delete(productVectors).where(inArray(productVectors.sku, c));
    },
  };
}
