/**
 * What the purchase order pages read from their query string and form fields: pure, so the loader
 * and the tests share one reading. Anything that isn't a known value is dropped rather than
 * refused, as the other list pages treat their filters.
 */
import {
  PO_SOURCE_LABELS,
  PO_STATUSES,
  type PoSource,
  type PoStatus,
  type PurchaseOrderLine,
} from '@commerceworker/core';
import type { Tone } from '~/components/status';

/** Each status as a stamp: waiting reads as waiting, an end without the goods as undone. */
export const PO_TONE: Record<PoStatus, Tone> = {
  draft: 'idle',
  submitted: 'wait',
  pending_approval: 'wait',
  approved: 'ok',
  ordered: 'ok',
  fulfilled: 'ok',
  rejected: 'bad',
  cancelled: 'undo',
};

export const PO_SOURCE_NAME = (s: PoSource) => PO_SOURCE_LABELS[s];

export type PoFilters = {
  status?: PoStatus;
  company?: string;
  from?: string;
  to?: string;
  q?: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: string | null) =>
  v && DAY.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;

/** The filters a list's query string names. */
export function filtersFrom(params: URLSearchParams): PoFilters {
  const status = params.get('status');
  const company = params.get('company')?.trim();
  const q = params.get('q')?.trim();
  return {
    ...(PO_STATUSES.includes(status as PoStatus) ? { status: status as PoStatus } : {}),
    ...(company ? { company: company.slice(0, 100) } : {}),
    ...(validDay(params.get('from')) ? { from: validDay(params.get('from')) } : {}),
    ...(validDay(params.get('to')) ? { to: validDay(params.get('to')) } : {}),
    ...(q ? { q: q.slice(0, 100) } : {}),
  };
}

/** A query string that keeps the filters, with `extra` (a cursor) on top; empty when there is none. */
export function filterQuery(f: PoFilters, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * The lines a form wrote: parallel `sku`, `name`, `qty` and `unitPrice` fields, a row at a time.
 * Blank rows are left out; a row with a SKU needs a positive quantity, or the whole form is refused.
 */
export function linesFrom(f: FormData): PurchaseOrderLine[] | string {
  const skus = f.getAll('sku').map(String);
  const names = f.getAll('name').map(String);
  const qtys = f.getAll('qty').map(String);
  const prices = f.getAll('unitPrice').map(String);
  const lines: PurchaseOrderLine[] = [];
  for (const [i, raw] of skus.entries()) {
    const sku = raw.trim();
    if (!sku) continue;
    const qty = Number(qtys[i]?.trim());
    if (!Number.isFinite(qty) || qty <= 0)
      return `Line ${i + 1} (${sku}) needs a quantity above zero.`;
    const priceText = prices[i]?.trim() ?? '';
    const unitPrice = priceText ? Number(priceText) : null;
    if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0))
      return `Line ${i + 1} (${sku}) has a price that isn’t a number.`;
    lines.push({ sku, name: names[i]?.trim() || null, qty, unitPrice });
  }
  return lines;
}

/** The ship-to a form wrote, or null when none of its fields has anything. */
export function shipToFrom(f: FormData) {
  const get = (k: string) => String(f.get(`shipTo.${k}`) ?? '').trim();
  const line1 = get('line1');
  const city = get('city');
  const postalCode = get('postalCode');
  const country = get('country');
  if (!line1 && !city && !postalCode && !country && !get('name')) return null;
  return {
    ...(get('name') ? { name: get('name') } : {}),
    line1,
    ...(get('line2') ? { line2: get('line2') } : {}),
    city,
    ...(get('region') ? { region: get('region') } : {}),
    postalCode,
    country,
  };
}
