/**
 * The Commerce page's back office: the catalog, customers, sellers, stores' stock and pricing
 * sources, each list searched and paged, so the page stays the same size however large they grow;
 * everything at once for the new-order and cart pickers; and the currencies an order can be in.
 * Read only. `d1BackOffice` (packages/db) and `InMemoryBackOffice` (packages/test-kit) implement
 * it, held to one contract.
 */
import type { CompanyStatus } from '@commerceworker/core';
import type { StoreLocation } from './fulfillment';
import type { SellerRecord } from './marketplace';
import type { CustomerRecord, ProductRecord } from './pricing';

export type Paged<T> = {
  readonly rows: T[];
  readonly total: number;
  /** The page shown: the one asked for, or the last when that is past the end. */
  readonly page: number;
  readonly size: number;
};

/** A list on the page, to ask which of its pages to show. */
export type BookList =
  | { readonly list: 'inventory' | 'customers' | 'sellers' }
  | { readonly list: 'store'; readonly id: string }
  | { readonly list: 'prices'; readonly sourceId: string };

/** What narrows the customers list: a kind, and a business customer's company status. */
export interface CustomerFilter {
  readonly kind?: string;
  /** Only business customers have a company, so this leaves the others out. */
  readonly status?: CompanyStatus;
}

/** A customer as the list shows it: with its company's status, null when it has no company. */
export interface CustomerRow extends CustomerRecord {
  readonly companyStatus: CompanyStatus | null;
}

export interface PriceSourceRow {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly stopProcessing: boolean;
  readonly active: boolean;
}

export interface PriceRuleRow {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly sku: string | null;
  readonly customerId: string | null;
  readonly customerTier: string | null;
  readonly minQty: number | null;
  readonly price: number | null;
  readonly discountPct: number | null;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly createdAt: number;
}

export interface ContractPriceRow {
  readonly customerId: string;
  readonly sku: string;
  readonly price: number;
}

export interface LocationStockRow {
  readonly locationId: string;
  readonly sku: string;
  readonly stock: number;
  readonly reserved: number;
}

export interface FxRateRow {
  readonly currency: string;
  /** Units per unit of the base currency (whose rate is 1). */
  readonly rate: number;
  readonly updatedAt: number;
}

/** A pricing source's entry: a contract price (keyed customer-sku) or a rule. */
export interface PriceEntry {
  readonly key: string;
  /** A contract's customer (their id when they're gone), or the rule's name. */
  readonly name: string;
  readonly sku: string | null;
  readonly productName: string | null;
  readonly customerTier: string | null;
  /** A rule's customer (their id when they're gone); null for a contract price. */
  readonly customerName: string | null;
  readonly minQty: number | null;
  readonly price: number | null;
  readonly discountPct: number | null;
}

export interface BackOfficePage {
  /** Each product with what the stores hold of it (stock less reserved). */
  readonly inventory: Paged<ProductRecord & { inStores: number }>;
  readonly customers: Paged<CustomerRow>;
  readonly sellers: Paged<SellerRecord>;
  /** Every store, with a page of its stock. */
  readonly stores: (StoreLocation & {
    stock: Paged<{ sku: string; name: string | null; stock: number; reserved: number }>;
  })[];
  /** Every pricing source, by priority, with a page of its entries. */
  readonly sources: (PriceSourceRow & { entries: Paged<PriceEntry> })[];
}

export interface BackOfficeData {
  /** By name. */
  readonly customers: CustomerRecord[];
  /** By SKU. */
  readonly products: ProductRecord[];
  /** By priority. */
  readonly sources: PriceSourceRow[];
  /** By source, SKU and minimum quantity. */
  readonly rules: PriceRuleRow[];
  /** By customer and SKU. */
  readonly contracts: ContractPriceRow[];
  /** By name. */
  readonly sellers: SellerRecord[];
  /** By name, each with its stock by SKU. */
  readonly stores: (StoreLocation & { stock: LocationStockRow[] })[];
}

export interface BackOffice {
  /**
   * One page of every list for a search: `q` (case-insensitive, matched literally) narrows each
   * list by what it shows. A store whose name matches shows all it holds. `asked` says which page
   * of each list to show; lists are `sizes.list` rows a page, a store's stock and a source's
   * entries `sizes.group`. `customers` narrows the customers list alone, by kind and company
   * status.
   */
  page(
    q: string,
    asked: (list: BookList) => number,
    sizes: { list: number; group: number },
    customers?: CustomerFilter,
  ): Promise<BackOfficePage>;
  /** Every record the pickers choose from, in one round trip. */
  everything(): Promise<BackOfficeData>;
  /** Currencies an order can be in: those with a rate, the base currency first, then by code. */
  currencies(): Promise<FxRateRow[]>;
}
