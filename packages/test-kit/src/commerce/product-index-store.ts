/**
 * The product index port in memory, seeded with products and their recorded vectors. The contract
 * in ./product-index-store-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { NamedProduct, ProductIndexStore } from '@commerceworker/ports/commerce';

export interface ProductIndexFixture {
  products?: NamedProduct[];
  vectors?: NamedProduct[];
}

const bySku = (a: NamedProduct, b: NamedProduct) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);

export class InMemoryProductIndexStore implements ProductIndexStore {
  private readonly products: NamedProduct[];
  private readonly vectors = new Map<string, string>();
  private lease: { holder: string; expiresAt: number } | null = null;

  constructor(fixture: ProductIndexFixture = {}) {
    this.products = structuredClone(fixture.products ?? []);
    for (const v of fixture.vectors ?? []) this.vectors.set(v.sku, v.name);
  }

  async first(limit: number) {
    return [...this.products].sort(bySku).slice(0, limit);
  }

  async bySku(skus: readonly string[]) {
    return this.products.filter((p) => skus.includes(p.sku));
  }

  async search(typed: string, limit: number) {
    if (!typed) return [...this.products].sort(bySku).slice(0, limit);
    const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
    const exact = this.products.filter((p) => p.sku === typed);
    const matched = this.products.filter(
      (p) => p.sku !== typed && words.every((w) => `${p.sku} ${p.name}`.toLowerCase().includes(w)),
    );
    return [...exact, ...matched.sort(bySku)].slice(0, limit);
  }

  async byNameTerms(terms: readonly string[], limit: number) {
    if (!terms.length) return [];
    const score = (p: NamedProduct) =>
      terms.filter((t) => p.name.toLowerCase().includes(t.toLowerCase())).length;
    return this.products
      .filter((p) => score(p) > 0)
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit);
  }

  async takeLease(holder: string, now: number, expiresAt: number) {
    if (this.lease && this.lease.expiresAt > now) return false;
    this.lease = { holder, expiresAt };
    return true;
  }

  async releaseLease(holder: string) {
    if (this.lease?.holder === holder) this.lease = null;
  }

  async changed(limit: number) {
    return this.products
      .filter(
        (p) => new TextEncoder().encode(p.sku).length <= 64 && this.vectors.get(p.sku) !== p.name,
      )
      .sort(bySku)
      .slice(0, limit);
  }

  async recordIndexed(rows: readonly NamedProduct[]) {
    for (const p of rows) this.vectors.set(p.sku, p.name);
  }

  async gone(limit: number) {
    const skus = new Set(this.products.map((p) => p.sku));
    return [...this.vectors.keys()].filter((s) => !skus.has(s)).slice(0, limit);
  }

  async forget(skus: readonly string[]) {
    for (const s of skus) this.vectors.delete(s);
  }
}
