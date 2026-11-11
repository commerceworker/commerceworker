/**
 * Price books for the Price books pages and the customer page: the books and their entries, and a
 * customer's books and contract prices. Reads only: every change goes through the assistant's
 * tools (`create_price_book` and the rest), which stop for a person's confirm.
 */
import {
  getPriceBook,
  listPriceBooks,
  readCustomerPricing,
} from '@commerceworker/application/commerce';
import type { PriceBookStatus } from '@commerceworker/core';
import { priceBookStore, pricingStore } from './wire.server';

export const bookPage = (q: { status?: PriceBookStatus; after?: string }) =>
  listPriceBooks({ books: priceBookStore() }, { ...q, limit: 25 });

/** One book by id or code, with its assignees and a page of entries; null when there is none. */
export async function bookDetail(idOrCode: string, after?: string) {
  const r = await getPriceBook({ books: priceBookStore() }, { bookId: idOrCode, after, limit: 50 });
  return r.ok ? r : null;
}

// A staff page reads every company's (`{ all: true }`); a company-bound caller would pass its own.

/** How many contract prices the customer's page lists. */
const CONTRACT_PRICES_SHOWN = 50;

/** The price books assigned to a customer (by id or through their tier) and their contract prices. */
export const customerPricing = (customer: { id: string; tier: string }, now: number) =>
  readCustomerPricing(
    { books: priceBookStore(), pricing: pricingStore() },
    { all: true },
    customer,
    now,
    CONTRACT_PRICES_SHOWN,
  );
