/**
 * The pricing port in memory, seeded from a fixture. The contract in ./pricing-store-contract.ts
 * holds it to the same behaviour as the D1 store (packages/db), so use-case tests on it mean what
 * they say about production.
 */
import {
  BASE_CURRENCY,
  type FxSource,
  matchCustomerByName,
  type PriceRule,
  type PriceSource,
  type Promotion,
} from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type {
  CustomerRecord,
  FxRateRecord,
  PricingStore,
  ProductRecord,
  Redemption,
} from '@commerceworker/ports/commerce';

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

  constructor(
    private readonly fixture: PricingFixture,
    private readonly clock: Clock,
  ) {}

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
    return this.allPromotions().filter((p) => codes.includes(p.code));
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
    if (all.some((x) => x.code === p.code || x.id === p.id)) return false;
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
  ) {
    return {
      products: await this.products(skus),
      fxRate: await this.fxRate(currency),
      chain: chain ? await this.pricingFor(customerId) : null,
    };
  }

  async pricingFor(customerId: string | undefined) {
    const customer = await this.customer(customerId);
    const sources = (this.fixture.priceSources ?? [])
      .filter((s) => s.active !== false)
      .map(({ active: _active, ...s }) => s);
    const contracts = customerId
      ? (this.fixture.contractPrices ?? []).filter((c) => c.customerId === customerId)
      : [];
    return {
      sources,
      rules: [
        ...(this.fixture.priceRules ?? []),
        ...contracts.map(
          (c): PriceRule => ({
            id: `contract_${c.customerId}_${c.sku}`,
            source: 'contract',
            name: 'Contract price',
            sku: c.sku,
            customerId: c.customerId,
            price: c.price,
          }),
        ),
      ],
      tier: customer?.tier ?? null,
    };
  }
}
