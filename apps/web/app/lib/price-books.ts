/**
 * How the Price books pages show a book's state and read their forms; core decides when a book is
 * in force (`priceBookState`) and the use-cases check what is written.
 */
import {
  MAX_PRICE_BOOK_ENTRIES_PER_CALL,
  PRICE_BOOK_STATUSES,
  type PriceBookState,
  priceBookHeadProblem,
} from '@commerceworker/core';
import type { Tone } from '~/components/status';

export const BOOK_STATES: Record<PriceBookState, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'idle' },
  active: { label: 'In force', tone: 'ok' },
  scheduled: { label: 'Scheduled', tone: 'wait' },
  ended: { label: 'Ended', tone: 'idle' },
  inactive: { label: 'Inactive', tone: 'idle' },
  archived: { label: 'Archived', tone: 'idle' },
};

export const STATUS_FILTERS = ['all', ...PRICE_BOOK_STATUSES] as const;

const DAY = 86_400_000;

/** The new book a form describes, as `create_price_book` takes it, or why it can't be one. */
export function priceBookFrom(f: FormData) {
  const s = (k: string) => String(f.get(k) ?? '').trim();
  const name = s('name').slice(0, 120);
  if (!name) return 'Give the book a name.';
  const priority = s('priority') ? Number(s('priority')) : 0;
  const startsAt = s('startsAt') ? Date.parse(`${s('startsAt')}T00:00:00Z`) : null;
  // The last day counts, so the book ends when the next one starts.
  const endsAt = s('endsAt') ? Date.parse(`${s('endsAt')}T00:00:00Z`) + DAY : null;
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) return 'A date is not a date.';
  const { code, problem } = priceBookHeadProblem({
    code: s('code'),
    priority,
    startsAt: startsAt ?? undefined,
    endsAt: endsAt ?? undefined,
  });
  if (problem || !code) return problem ?? 'Give the book a code.';
  return {
    code,
    name,
    priority,
    ...(startsAt !== null ? { startsAt } : {}),
    ...(endsAt !== null ? { endsAt } : {}),
  };
}

/**
 * Entries typed one a line: `SKU price`, `SKU quantity price`, with a percentage off list in
 * place of a price (`SKU 10%`, `SKU 100 12%`). Commas and semicolons count as spaces.
 */
export function entriesFrom(text: string) {
  const entries: {
    sku: string;
    minQty?: number;
    price?: number;
    discountPct?: number;
  }[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return 'Type at least one entry: a SKU, then a price.';
  if (lines.length > MAX_PRICE_BOOK_ENTRIES_PER_CALL)
    return `At most ${MAX_PRICE_BOOK_ENTRIES_PER_CALL} entries at a time.`;
  for (const [i, line] of lines.entries()) {
    const [sku, ...rest] = line.trim().split(/[\s,;]+/);
    const last = rest.at(-1);
    const bad = `Line ${i + 1}: write a SKU, an optional quantity, then a price or a percentage.`;
    if (!sku || !last || rest.length > 2) return bad;
    const pct = last.endsWith('%');
    const value = Number(pct ? last.slice(0, -1) : last);
    const minQty = rest.length === 2 ? Number(rest[0]) : undefined;
    if (!Number.isFinite(value) || (minQty !== undefined && !(minQty > 0))) return bad;
    entries.push({
      sku,
      ...(minQty !== undefined ? { minQty } : {}),
      ...(pct ? { discountPct: value } : { price: value }),
    });
  }
  return entries;
}

/** An entry's price as its table says it. */
export const entryLabel = (
  e: { price: number | null; discountPct: number | null },
  money: (n: number) => string,
) => (e.price !== null ? money(e.price) : `${e.discountPct}% off list`);
