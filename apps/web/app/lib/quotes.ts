/**
 * What the quote pages read from their query string and form fields: pure, so the loader and the
 * tests share one reading. Anything that isn't a known value is dropped rather than refused, as
 * the other list pages treat their filters. `quoteMoves` is core's lifecycle as the buttons a page
 * offers.
 */
import {
  QUOTE_LIFECYCLE,
  QUOTE_STATUSES,
  type QuoteStatus,
  quoteEditable,
  quoteRevisable,
} from '@commerceworker/core';
import type { Tone } from '~/components/status';

/** Each status as a stamp: waiting reads as waiting, an end without a deal as undone. */
export const QUOTE_TONE: Record<QuoteStatus, Tone> = {
  draft: 'idle',
  sent: 'wait',
  accepted: 'ok',
  declined: 'bad',
  expired: 'undo',
  superseded: 'undo',
};

export type QuoteFilters = { status?: QuoteStatus; company?: string; q?: string };

/** The filters a list's query string names. */
export function filtersFrom(params: URLSearchParams): QuoteFilters {
  const status = params.get('status');
  const company = params.get('company')?.trim();
  const q = params.get('q')?.trim();
  return {
    ...(QUOTE_STATUSES.includes(status as QuoteStatus) ? { status: status as QuoteStatus } : {}),
    ...(company ? { company: company.slice(0, 100) } : {}),
    ...(q ? { q: q.slice(0, 100) } : {}),
  };
}

/** A query string that keeps the filters, with `extra` (a cursor) on top; empty when there is none. */
export function filterQuery(f: QuoteFilters, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * The lines a form wrote: parallel `sku`, `name`, `qty` and `unitPrice` fields, a row at a time.
 * Blank rows are left out; a row with a SKU needs a positive quantity and a price, or the whole
 * form is refused with the row's number.
 */
export function linesFrom(f: FormData) {
  const skus = f.getAll('sku').map(String);
  const names = f.getAll('name').map(String);
  const qtys = f.getAll('qty').map(String);
  const prices = f.getAll('unitPrice').map(String);
  const lines: { sku: string; name?: string; qty: number; unitPrice: number }[] = [];
  for (const [i, raw] of skus.entries()) {
    const sku = raw.trim();
    if (!sku) continue;
    const qty = Number(qtys[i]?.trim());
    if (!qtys[i]?.trim() || !Number.isFinite(qty) || qty <= 0)
      return `Line ${i + 1} (${sku}) needs a quantity above zero.`;
    const priceText = prices[i]?.trim() ?? '';
    const unitPrice = Number(priceText);
    if (!priceText || !Number.isFinite(unitPrice) || unitPrice < 0)
      return `Line ${i + 1} (${sku}) needs a price, 0 or more.`;
    const name = names[i]?.trim();
    lines.push({ sku, ...(name ? { name } : {}), qty, unitPrice });
  }
  return lines;
}

/** The moves a quote may make next, from core's lifecycle, as the buttons the page offers. */
/**
 * `settled`: what the quote was converted to is complete (an order recorded, a PO draft made).
 * A claim that stopped halfway isn't, so Convert stays offered to finish it.
 */
export const quoteMoves = (status: QuoteStatus, settled: boolean) => ({
  edit: quoteEditable(status),
  send: QUOTE_LIFECYCLE.can(status, 'sent'),
  accept: QUOTE_LIFECYCLE.can(status, 'accepted'),
  // A draft is withdrawn through the same move.
  decline: QUOTE_LIFECYCLE.can(status, 'declined'),
  end: status === 'sent' || status === 'accepted',
  revise: quoteRevisable(status),
  convert: status === 'accepted' && !settled,
});
