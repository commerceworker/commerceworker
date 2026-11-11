/**
 * Quotes for the list and the editor. Reads only: every change goes through the assistant's tools
 * (`create_quote`, `update_quote`, `send_quote`, `accept_quote`, `decline_quote`, `revise_quote`,
 * `expire_quote`, `convert_quote`), the same use-cases REST and MCP run. A staff page reads every
 * company's (`{ all: true }`).
 */
import { getQuote, listQuotes, quoteConversionSettled } from '@commerceworker/application/commerce';
import { type QuoteDetail, quoteState } from '@commerceworker/core';
import type { QuoteScope } from '@commerceworker/ports/commerce';
import type { QuoteFilters } from './quotes';
import { companyDirectory, pricingStore, purchaseOrderStore, quoteStore } from './wire.server';

export const QUOTE_LIST_PAGE = 25;

const ports = () => ({
  quotes: quoteStore(),
  companies: companyDirectory(),
  pricing: pricingStore(),
  purchaseOrders: purchaseOrderStore(),
});
const ALL: QuoteScope = { all: true };

/** A page of quotes, with the names of the companies on it so a row reads as a company, not an id. */
export async function quotePage(filters: QuoteFilters, cursor: string | undefined) {
  const now = Date.now();
  const r = await listQuotes(ports(), ALL, {
    companyId: filters.company,
    status: filters.status,
    search: filters.q,
    cursor,
    limit: QUOTE_LIST_PAGE,
  });
  if (!r.ok) return { quotes: [], total: 0, cursor: null, companies: {}, error: r.error };
  const ids = [...new Set(r.quotes.map((q) => q.companyId))];
  const names = await companyDirectory().companiesById(ALL, ids);
  return {
    // What each is now: a sent or accepted quote past its expiry reads as expired.
    quotes: r.quotes.map((q) => ({ ...q, state: quoteState(q, now) })),
    total: r.total,
    cursor: r.cursor,
    companies: Object.fromEntries(names.map((c) => [c.customerId, c.name])),
    error: null,
  };
}

/** One quote with its versions and company and, for a draft, the company's active members to pick a buyer from. */
export async function quoteDetail(id: string) {
  const r = await getQuote(ports(), ALL, id);
  if (!r.ok) return null;
  // A read by id carries its lines and versions (a list's rows carry a count).
  const quote = r.quote as unknown as QuoteDetail & {
    versions: { id: string; version: number; status: QuoteDetail['status'] }[];
    total: number;
    href: string;
  };
  const [company, members] = await Promise.all([
    companyDirectory().company(ALL, quote.companyId),
    companyDirectory().members(ALL, { companyId: quote.companyId, status: 'active', limit: 100 }),
  ]);
  // Converted for good: an order is recorded, or the PO draft exists.
  const settled = await quoteConversionSettled(ports(), ALL, quote);
  return {
    quote,
    settled,
    state: quoteState(quote, Date.now()),
    company: company
      ? { id: company.customerId, name: company.name, status: company.status }
      : null,
    members: members.rows.map((m) => ({ id: m.id, name: m.name, email: m.email })),
  };
}
