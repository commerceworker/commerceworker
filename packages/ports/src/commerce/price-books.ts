/**
 * Price books and the contract prices staff write: the books themselves (their lifecycle, entries
 * and assignees) and a customer's contract prices. Reading prices to price an order is the pricing
 * port's (`PricingStore.pricingFor`), which joins the books assigned to a customer, in force at
 * the order's time. `d1PriceBookStore` (packages/db) and `InMemoryPriceBookStore` (packages/test-kit)
 * implement this, held to one contract.
 *
 * Plain records only. Lists are keyset-paged: a page names where the last one ended, so a write
 * between two pages shifts nothing.
 */
import type {
  PriceBook,
  PriceBookAssignee,
  PriceBookAssignment,
  PriceBookEntry,
  PriceBookStatus,
} from '@commerceworker/core';
import type { CompanyScope } from './companies';

/** Where a page of entries ended: the last entry's SKU and quantity. */
export type PriceBookEntryCursor = { readonly sku: string; readonly minQty: number };

export interface PriceBookPage {
  /** By code. */
  readonly rows: PriceBook[];
  /** How many books match across every page. */
  readonly total: number;
  /** The last row's code, to continue after; null at the end. */
  readonly next: string | null;
}

export interface PriceBookEntryPage {
  /** By SKU, then quantity. */
  readonly rows: PriceBookEntry[];
  readonly total: number;
  readonly next: PriceBookEntryCursor | null;
}

export interface ContractPrice {
  readonly sku: string;
  readonly price: number;
}

export interface PriceBookStore {
  /** Books by code, `limit` after the cursor (a code), optionally one status. */
  list(q: {
    status?: PriceBookStatus;
    after: string | null;
    limit: number;
  }): Promise<PriceBookPage>;
  /** A book by its id or its code. */
  find(idOrCode: string): Promise<PriceBook | undefined>;
  /** Adds a book; false (nothing written) when its id or code is taken. */
  create(book: PriceBook): Promise<boolean>;
  /**
   * Moves a book from `from` to `to` as one compare-and-set: false when the book wasn't in `from`
   * (it moved meanwhile, or is gone), so of two racing moves exactly one wins.
   */
  transition(id: string, from: PriceBookStatus, to: PriceBookStatus, at: number): Promise<boolean>;
  /** A book's entries, `limit` after the cursor. */
  entries(
    bookId: string,
    q: { after: PriceBookEntryCursor | null; limit: number },
  ): Promise<PriceBookEntryPage>;
  /** Adds or replaces entries (by SKU and quantity), in statements under D1's parameter limit. */
  putEntries(bookId: string, entries: readonly PriceBookEntry[], at: number): Promise<void>;
  /** Removes the entries at these SKUs and quantities. */
  removeEntries(bookId: string, keys: readonly { sku: string; minQty: number }[]): Promise<void>;
  /** Assigns a book; false when it already was. */
  assign(bookId: string, to: PriceBookAssignee, at: number): Promise<boolean>;
  /** Takes an assignment away; false when there wasn't one. */
  unassign(bookId: string, from: PriceBookAssignee): Promise<boolean>;
  /** A book's assignees, customers first, then tiers, each by name. */
  assignments(bookId: string): Promise<PriceBookAssignment[]>;
  /**
   * The books assigned to a customer, by id or through their `tier`, whatever their status, by
   * priority then code. Whether one is in force is core's (`bookInForce`). Under D1 the customer
   * is the company, so a company-scoped read sees only its own and none for another's (the pricing
   * chain itself is not access control and reads books for the order's customer).
   */
  forCustomer(scope: CompanyScope, customerId: string, tier: string | null): Promise<PriceBook[]>;
  /** A customer's contract prices, by SKU; none for a customer outside the scope. */
  contractPrices(scope: CompanyScope, customerId: string): Promise<ContractPrice[]>;
  /**
   * Sets contract prices (a SKU's again replaces it), in statements under D1's limit. False, with
   * nothing written, for a customer outside the scope.
   */
  putContractPrices(
    scope: CompanyScope,
    customerId: string,
    prices: readonly ContractPrice[],
  ): Promise<boolean>;
  /** Removes a customer's contract prices at these SKUs; false for one outside the scope. */
  removeContractPrices(
    scope: CompanyScope,
    customerId: string,
    skus: readonly string[],
  ): Promise<boolean>;
}
