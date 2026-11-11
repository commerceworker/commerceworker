/**
 * The pricing port in memory, seeded from a fixture. The contract in ./pricing-store-contract.ts
 * holds it to the same behaviour as the D1 store (packages/db), so use-case tests on it mean what
 * they say about production.
 */
import {
  BASE_CURRENCY,
  bookEntryId,
  bookInForce,
  type FxSource,
  matchCustomerByName,
  type PriceRule,
  type PriceSource,
  type Promotion,
  quoteLineRule,
  quoteLive,
} from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type {
  CustomerRecord,
  FxRateRecord,
  PricingStore,
  ProductRecord,
  Redemption,
} from '@commerceworker/ports/commerce';
import { PriceBookData, sortedEntries } from './price-book-store';
import { QuoteData } from './quote-store';

/** What a pricing store holds, as a test seeds it. */
export interface PricingFixture {
  customers?: CustomerRecord[];
  products?: ProductRecord[];
  promotions?: Promotion[];
  fxRates?: { currency: string; rate: number; updatedAt?: number; source?: FxSource }[];
  priceSources?: (PriceSource & { active?: boolean })[];
  priceRules?: PriceRule[];
  contractPrices?: { customerId: string; sku: string; price: number }[];
}

type Held = Redemption & { at: number };

export class InMemoryPricingStore implements PricingStore {
  private readonly redemptions: Held[] = [];
  private readonly fxBy = new Map<string, string>();

  /**
   * Price books and contract prices. Give the same `PriceBookData` to an `InMemoryPriceBookStore`
   * to price with the books it writes; the fixture's contract prices are added to it.
   */
  private readonly data: PriceBookData;

  constructor(
    private readonly fixture: PricingFixture,
    private readonly clock: Clock,
    data: PriceBookData = new PriceBookData(),
    /** Quotes, from an `InMemoryQuoteStore` over the same `QuoteData`: the accepted ones price. */
    private readonly quotes: QuoteData = new QuoteData(),
  ) {
    this.data = data;
    for (const c of fixture.contractPrices ?? []) {
      const mine = data.contracts.get(c.customerId) ?? new Map<string, number>();
      if (!mine.has(c.sku)) mine.set(c.sku, c.price);
      data.contracts.set(c.customerId, mine);
    }
  }

  async customersByEmail(email: string, domain: string) {
    return (this.fixture.customers ?? [])
      .filter((c) => {
        const e = c.email.toLowerCase();
        return e === email.toLowerCase() || e.endsWith(`@${domain.toLowerCase()}`);
      })
      .map(({ id, email: e }) => ({ id, email: e }));
  }

  async customers(ids: readonly string[]) {
    return (this.fixture.customers ?? []).filter((c) => ids.includes(c.id));
  }

  async customer(id: string | undefined) {
    return id ? this.fixture.customers?.find((c) => c.id === id) : undefined;
  }

  async customerByName(name: string) {
    const match = matchCustomerByName(this.fixture.customers ?? [], name);
    return match ? { id: match.id, name: match.name } : undefined;
  }

  async products(skus?: readonly string[]) {
    const all = this.fixture.products ?? [];
    if (!skus) return [...all];
    const wanted = new Set(skus);
    return all.filter((p) => wanted.has(p.sku));
  }

  /** Seeded promotions, then those added here. */
  private promos: Promotion[] | undefined;

  private allPromotions() {
    this.promos ??= structuredClone(this.fixture.promotions ?? []);
    return this.promos;
  }

  async promotionsByCode(codes: readonly string[]) {
    return this.allPromotions().filter((p) => p.code !== null && codes.includes(p.code));
  }

  async automaticPromotions(at: number) {
    return this.allPromotions().filter(
      (p) =>
        p.code === null &&
        p.status === 'active' &&
        (p.validFrom === null || p.validFrom <= at) &&
        (p.validTo === null || p.validTo > at),
    );
  }

  async listPromotions() {
    return [...this.allPromotions()].reverse().map((p) => ({
      ...p,
      redeemed: this.redemptions.filter((r) => r.promotion.id === p.id).length,
    }));
  }

  async promotion(id: string) {
    return this.allPromotions().find((p) => p.id === id);
  }

  async createPromotion(p: Omit<Promotion, 'status' | 'currency' | 'validFrom'>) {
    const all = this.allPromotions();
    if (all.some((x) => (p.code !== null && x.code === p.code) || x.id === p.id)) return false;
    all.push({
      ...p,
      skus: p.skus?.length ? p.skus : null,
      currency: null,
      validFrom: null,
      status: 'active',
    });
    return true;
  }

  async setPromotionStatus(id: string, status: Promotion['status']) {
    const p = this.allPromotions().find((x) => x.id === id);
    if (p) p.status = status;
  }

  async redemptionsOf(promotionId: string, orderId: string, customerId: string | undefined) {
    const others = this.redemptions.filter(
      (r) => r.promotion.id === promotionId && r.orderId !== orderId,
    );
    return {
      total: others.length,
      // A guest order has no customer, so nothing counts as its own (as in SQL, NULL = NULL is false).
      byCustomer: customerId ? others.filter((r) => r.customerId === customerId).length : 0,
    };
  }

  async redeem(r: Redemption) {
    const mine = (h: Held) => h.promotion.id === r.promotion.id && h.orderId === r.orderId;
    if (this.redemptions.some(mine)) return true;
    const max = r.promotion.maxRedemptions ?? Number.MAX_SAFE_INTEGER;
    const taken = this.redemptions.filter((h) => h.promotion.id === r.promotion.id).length;
    if (taken >= max) return false;
    this.redemptions.push({ ...r, at: this.clock.now().getTime() });
    return true;
  }

  async releaseRedemptions(orderId: string) {
    let n = 0;
    for (let i = this.redemptions.length - 1; i >= 0; i--) {
      if (this.redemptions[i]?.orderId === orderId) {
        this.redemptions.splice(i, 1);
        n++;
      }
    }
    return n;
  }

  async fxRate(currency: string) {
    if (currency === BASE_CURRENCY) return 1;
    return this.fixture.fxRates?.find((f) => f.currency === currency)?.rate ?? null;
  }

  async fxRateRows(): Promise<FxRateRecord[]> {
    return (this.fixture.fxRates ?? [])
      .filter((f) => f.currency !== BASE_CURRENCY)
      .map((f) => ({
        currency: f.currency,
        rate: f.rate,
        updatedAt: f.updatedAt ?? 0,
        source: f.source ?? 'ecb',
        updatedBy: this.fxBy.get(f.currency) ?? null,
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }

  async setFxRates(
    rates: readonly { currency: string; rate: number }[],
    at: number,
    source: FxSource,
    by?: string,
  ) {
    const rows = rates.filter(
      (r) => r.currency !== BASE_CURRENCY && Number.isFinite(r.rate) && r.rate > 0,
    );
    const all = [...(this.fixture.fxRates ?? [])];
    for (const r of rows) {
      const next = { currency: r.currency, rate: r.rate, updatedAt: at, source };
      const i = all.findIndex((f) => f.currency === r.currency);
      if (i >= 0) all[i] = next;
      else all.push(next);
      if (by) this.fxBy.set(r.currency, by);
      else this.fxBy.delete(r.currency);
    }
    this.fixture.fxRates = all;
    return rows.length;
  }

  async priceInputs(
    skus: readonly string[],
    currency: string,
    customerId: string | undefined,
    chain: boolean,
    at: number,
  ) {
    return {
      products: await this.products(skus),
      fxRate: await this.fxRate(currency),
      chain: chain ? await this.pricingFor(customerId, at, skus) : null,
    };
  }

  async pricingFor(customerId: string | undefined, at: number, skus?: readonly string[]) {
    const customer = await this.customer(customerId);
    const tier = customer?.tier ?? null;
    const sources = (this.fixture.priceSources ?? [])
      .filter((s) => s.active !== false)
      .map(({ active: _active, ...s }) => s);
    const contracts = customerId ? [...(this.data.contracts.get(customerId) ?? [])] : [];
    // The books assigned to the customer, by id or through their tier, that are in force at `at`.
    const assigned = new Set(
      this.data.assignments
        .filter((a) => (customerId && a.customerId === customerId) || (tier && a.tier === tier))
        .map((a) => a.bookId),
    );
    const wanted = skus ? new Set(skus) : null;
    const entries = this.data.books
      .filter((b) => assigned.has(b.id) && bookInForce(b, at))
      .flatMap((b) =>
        sortedEntries(this.data, b.id)
          .filter((e) => !wanted || wanted.has(e.sku))
          .map(
            (e): PriceRule => ({
              id: bookEntryId(b.id, e.sku, e.minQty),
              source: 'price_book',
              name: b.name,
              sku: e.sku,
              minQty: e.minQty,
              price: e.price,
              discountPct: e.discountPct,
              bookId: b.id,
              bookPriority: b.priority,
            }),
          ),
      );
    // The company's accepted quotes that haven't expired: one entry a line.
    const quoted = customerId
      ? [...this.quotes.rows.values()]
          .filter(({ quote }) => quote.companyId === customerId && quoteLive(quote, at))
          .flatMap(({ quote, lines }) =>
            lines.flatMap((l, i) =>
              !wanted || wanted.has(l.sku) ? [quoteLineRule(quote, i, l)] : [],
            ),
          )
      : [];
    return {
      sources,
      rules: [
        ...(this.fixture.priceRules ?? []),
        ...entries,
        ...quoted,
        ...contracts.map(
          ([sku, price]): PriceRule => ({
            id: `contract_${customerId}_${sku}`,
            source: 'contract',
            name: 'Contract price',
            sku,
            customerId,
            price,
          }),
        ),
      ],
      tier,
    };
  }
}
