/**
 * The back office's screens (Customers, Sellers, Inventory and Pricing), each list searched,
 * counted and paged in D1 (the back office port), so a screen stays the same size however large
 * the catalog, customer list or price book grows. Each screen reads only its own lists' rows. A
 * search (`q`) narrows them on the server. New order and the carts still read everything through
 * `commerceData` (`orders.server.ts`), for their pickers.
 */

import { listFxRates } from '@commerceworker/application/commerce';
import { COMPANY_STATUSES, CUSTOMER_KINDS } from '@commerceworker/core';
import type { BookList, BookListKind, CustomerFilter } from '@commerceworker/ports/commerce';
import {
  CUSTOMER_KIND_KEY,
  CUSTOMER_STATUS_KEY,
  GROUP_SIZE,
  LIST_SIZE,
  pageOf,
  pricesKey,
  storeKey,
} from './commerce-pages';
import { currencies } from './orders.server';
import { backOffice, pricingStore } from './wire.server';

/** The URL key a list keeps its page under. */
const keyOf = (l: BookList) =>
  l.list === 'store' ? storeKey(l.id) : l.list === 'prices' ? pricesKey(l.sourceId) : l.list;

/** "#idz7qp" is how the app writes an order; a search for one shouldn't hide the rest. */
const searchOf = (params: URLSearchParams) => params.get('q')?.trim().replace(/^#/, '') ?? '';

function read(params: URLSearchParams, lists: readonly BookListKind[], customers?: CustomerFilter) {
  return backOffice().page(
    searchOf(params),
    (l) => pageOf(params, keyOf(l)),
    { list: LIST_SIZE, group: GROUP_SIZE },
    { customers, lists },
  );
}

/** The customers list, narrowed by kind and by a business customer's company status. */
export async function customersPage(params: URLSearchParams) {
  const kind = CUSTOMER_KINDS.find((k) => k === params.get(CUSTOMER_KIND_KEY));
  const status = COMPANY_STATUSES.find((s) => s === params.get(CUSTOMER_STATUS_KEY));
  const page = await read(params, ['customers'], { kind, status });
  return {
    q: searchOf(params),
    customerFilter: { kind: kind ?? null, status: status ?? null },
    customers: page.customers,
  };
}

/** The marketplace's sellers. */
export async function sellersPage(params: URLSearchParams) {
  const page = await read(params, ['sellers']);
  return { q: searchOf(params), sellers: page.sellers };
}

/** Warehouse stock, and each store's own. */
export async function inventoryPage(params: URLSearchParams) {
  const page = await read(params, ['inventory', 'store']);
  return { q: searchOf(params), inventory: page.inventory, stores: page.stores };
}

/** The pricing chain, each source with a page of its entries, and the currencies' rates. */
export async function pricingPage(params: URLSearchParams) {
  const [page, rates] = await Promise.all([read(params, ['prices']), currencies()]);
  return { q: searchOf(params), pricing: { sources: page.sources, rates } };
}

export async function fxRatesPage() {
  return (await listFxRates({ pricing: pricingStore() })).rates;
}

/** Physical products out of stock and at or under their reorder point, for the overview. */
export function stockAlerts() {
  return backOffice().stockAlerts();
}
