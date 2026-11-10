/**
 * What pricing an order needs from storage: the customer, the products, the promotions and their
 * redemptions, exchange rates, and the price chain. The engine's pricing, discount and credit
 * nodes and agentic checkout read through this port; `d1PricingStore` (packages/db) implements it
 * on D1 and `InMemoryPricingStore` (packages/test-kit) in memory, and one contract holds both.
 *
 * Plain records only: no SQL, ORM or driver type crosses it.
 */
import type { FxSource, PriceRule, PriceSource, Promotion } from '@commerceworker/core';

export interface CustomerRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  /** business | consumer | internal. Only business customers buy on account. */
  readonly kind: string;
  readonly tier: string;
  readonly creditLimit: number;
  readonly balance: number;
  readonly terms: string;
  readonly stripeCustomerId: string | null;
  readonly stripePaymentMethodId: string | null;
}

/** A stored exchange rate: units of `currency` per one base currency, and who set it, when. */
export interface FxRateRecord {
  readonly currency: string;
  readonly rate: number;
  readonly updatedAt: number;
  readonly source: FxSource;
  /** The person, for a person's rate. */
  readonly updatedBy: string | null;
}

export interface ProductRecord {
  readonly sku: string;
  readonly name: string;
  readonly price: number;
  readonly cost: number;
  readonly stock: number;
  readonly reserved: number;
  readonly reorderPoint: number;
  readonly reorderQty: number;
  readonly supplier: string;
  /** Marketplace seller; null when the operator sells it. */
  readonly sellerId: string | null;
  /** physical | digital. */
  readonly kind: string;
  /** When the catalog last set this row's name and price (ms); null if it never did. */
  readonly catalogAt: number | null;
  readonly weightKg: number | null;
  readonly lengthCm: number | null;
  readonly widthCm: number | null;
  readonly heightCm: number | null;
}

/** The pricing chain for one customer: active sources, their entries, and the customer's tier. */
export interface PricingInputs {
  readonly sources: PriceSource[];
  readonly rules: PriceRule[];
  readonly tier: string | null;
}

export interface Redemption {
  readonly promotion: Pick<Promotion, 'id' | 'maxRedemptions'>;
  readonly orderId: string;
  readonly customerId: string | undefined;
  readonly amount: number;
  /** The step that redeemed it: a retried step finds its own redemption. */
  readonly stepKey: string;
}

export interface PricingStore {
  customer(id: string | undefined): Promise<CustomerRecord | undefined>;
  /** Customers whose email is `email`, or ends with `@domain` (compared lower-cased). */
  customersByEmail(email: string, domain: string): Promise<{ id: string; email: string }[]>;
  /** These customers; unknown ids are absent. */
  customers(ids: readonly string[]): Promise<CustomerRecord[]>;
  /** The one customer whose name matches exactly (`matchCustomerByName` in core), else none. */
  customerByName(name: string): Promise<Pick<CustomerRecord, 'id' | 'name'> | undefined>;
  /** These SKUs' products, or every product when `skus` is absent. */
  products(skus?: readonly string[]): Promise<ProductRecord[]>;
  /** The promotions with these codes; an unknown kind reads as `pct`, any status but paused as active. */
  promotionsByCode(codes: readonly string[]): Promise<Promotion[]>;
  /**
   * The promotions with no code that apply at `at`: active, and inside their dates. Whether one
   * fits an order (customer, SKUs, subtotal, limits) is the core's to judge.
   */
  automaticPromotions(at: number): Promise<Promotion[]>;
  /** Redemptions of a promotion by orders other than `orderId`: all of them, and the customer's. */
  redemptionsOf(
    promotionId: string,
    orderId: string,
    customerId: string | undefined,
  ): Promise<{ total: number; byCustomer: number }>;
  /**
   * Records that the order redeemed the promotion, once per promotion and order, and only while
   * it is under its limit; the count and the write are one step, so two orders racing for the last
   * redemption can't both have it. True when the order holds the redemption.
   */
  redeem(r: Redemption): Promise<boolean>;
  /** Gives back what an order redeemed (a failed or cancelled order); safe to repeat. */
  releaseRedemptions(orderId: string): Promise<number>;
  /** Every promotion, newest first, with how many times each was redeemed. */
  listPromotions(): Promise<(Promotion & { redeemed: number })[]>;
  /** One promotion by id. */
  promotion(id: string): Promise<Promotion | undefined>;
  /**
   * Adds a promotion, active at once. Codes are unique: false (and nothing written) when the code
   * is taken. A promotion with no code is automatic and never conflicts.
   */
  createPromotion(
    p: Omit<Promotion, 'status' | 'currency' | 'validFrom'>,
    createdBy: string,
  ): Promise<boolean>;
  /** Pauses or reactivates a promotion. */
  setPromotionStatus(id: string, status: Promotion['status']): Promise<void>;
  /** Units of `currency` per one base currency (1 for the base itself), or null when unknown. */
  fxRate(currency: string): Promise<number | null>;
  /** Every stored rate but the base currency's, with when and by whom it was set. */
  fxRateRows(): Promise<FxRateRecord[]>;
  /**
   * Sets each currency's rate (units per one base currency), adding it when new, as of `at` and
   * recorded as `source`'s (`by` names the person). The base currency's rate is always 1 and is
   * never written. Returns how many it wrote.
   */
  setFxRates(
    rates: readonly { currency: string; rate: number }[],
    at: number,
    source: FxSource,
    by?: string,
  ): Promise<number>;
  /**
   * The price chain for a customer: contract prices become the contract source's entries, and the
   * price books assigned to the customer (by id, or by their tier) that are in force at `at` supply
   * the price-book source's entries, each tagged with its book (`bookId`, `bookPriority`, the
   * book's name). Book entries for SKUs other than `skus` are left out when it is given; entries
   * in no book are always read.
   */
  pricingFor(
    customerId: string | undefined,
    at: number,
    skus?: readonly string[],
  ): Promise<PricingInputs>;
  /**
   * What pricing an order reads, together: the SKUs' products, the currency's rate, and the price
   * chain unless `chain` is false (a buy-side order prices at cost). The same answers as
   * `products`, `fxRate` and `pricingFor` (for `skus`, as of `at`), read in one round trip where
   * the store can.
   */
  priceInputs(
    skus: readonly string[],
    currency: string,
    customerId: string | undefined,
    chain: boolean,
    at: number,
  ): Promise<{
    products: ProductRecord[];
    fxRate: number | null;
    chain: PricingInputs | null;
  }>;
}
