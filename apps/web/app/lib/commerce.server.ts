/**
 * The Commerce page's back office, each list searched, counted and paged in D1 (the back office
 * port), so the page stays the same size however large the catalog, customer list or price book
 * grows. A search (`q`) narrows every list here, on the server. New order and the carts still read
 * everything through `commerceData` (`orders.server.ts`), for their pickers.
 */

import { listFxRates } from '@commerceworker/application/commerce';
import { COMPANY_STATUSES, CUSTOMER_KINDS } from '@commerceworker/core';
import type { BookList } from '@commerceworker/ports/commerce';
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

export async function commercePage(params: URLSearchParams) {
  // "#idz7qp" is how the app writes an order; a search for one shouldn't hide the rest.
  const q = params.get('q')?.trim().replace(/^#/, '') ?? '';
  // The customers list narrows by kind and by a business customer's company status.
  const kind = CUSTOMER_KINDS.find((k) => k === params.get(CUSTOMER_KIND_KEY));
  const status = COMPANY_STATUSES.find((s) => s === params.get(CUSTOMER_STATUS_KEY));
  const [page, rates] = await Promise.all([
    backOffice().page(
      q,
      (l) => pageOf(params, keyOf(l)),
      { list: LIST_SIZE, group: GROUP_SIZE },
      {
        kind,
        status,
      },
    ),
    currencies(),
  ]);
  return {
    q,
    customerFilter: { kind: kind ?? null, status: status ?? null },
    inventory: page.inventory,
    customers: page.customers,
    sellers: page.sellers,
    stores: page.stores,
    pricing: { sources: page.sources, rates },
  };
}

/** Each currency's rate, when it was set and by whom, as the rates table shows them. */
export async function fxRatesPage() {
  return (await listFxRates({ pricing: pricingStore() })).rates;
}

export type CommercePage = Awaited<ReturnType<typeof commercePage>>;
