/**
 * Price books: a named list of prices (and volume tiers) with a priority and dates, assigned to a
 * customer or to a customer tier. They are the `price_book` source's entries in the pricing chain
 * (`resolvePrice`): of the books assigned to a customer that are in force, the highest-priority
 * one that prices a line wins, then the lowest price in it. Books are in the base currency, like
 * every price the chain holds; an order in another currency converts at its rate. Pure.
 */

import { defineLifecycle } from './lifecycle';

export const PRICE_BOOK_STATUSES = ['draft', 'active', 'inactive', 'archived'] as const;
export type PriceBookStatus = (typeof PRICE_BOOK_STATUSES)[number];

/** Archiving is for good; a book that was never active can be archived without having been used. */
export const PRICE_BOOK_LIFECYCLE = defineLifecycle<PriceBookStatus>({
  draft: ['active', 'archived'],
  active: ['inactive'],
  inactive: ['active', 'archived'],
  archived: [],
});

export type PriceBook = {
  id: string;
  /** What staff and agents call it: lower-case letters, digits, dashes and underscores. */
  code: string;
  name: string;
  /** The higher number wins when several assigned books price the same line. */
  priority: number;
  status: PriceBookStatus;
  /** Ms. A book isn't in force before it, or from `endsAt` on. Null for no bound. */
  startsAt: number | null;
  endsAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
};

/** What a book is, now: its status, narrowed by its dates when it is active. */
export type PriceBookState = PriceBookStatus | 'scheduled' | 'ended';

export function priceBookState(
  b: Pick<PriceBook, 'status' | 'startsAt' | 'endsAt'>,
  now: number,
): PriceBookState {
  if (b.status !== 'active') return b.status;
  if (b.startsAt !== null && now < b.startsAt) return 'scheduled';
  if (b.endsAt !== null && now >= b.endsAt) return 'ended';
  return 'active';
}

/** Whether the book's prices count at `now`: active, and inside its dates. */
export const bookInForce = (
  b: Pick<PriceBook, 'status' | 'startsAt' | 'endsAt'>,
  now: number,
): boolean => priceBookState(b, now) === 'active';

/** One price in a book: a SKU at a quantity and up, a fixed price or a percentage off list. */
export type PriceBookEntry = {
  sku: string;
  /** The line's quantity must be at least this: 1 for the base price, more for a volume tier. */
  minQty: number;
  price: number | null;
  discountPct: number | null;
};

/** A book is assigned to one customer, or to every customer of one tier. */
export type PriceBookAssignee = { customerId: string } | { tier: string };

export type PriceBookAssignment = {
  bookId: string;
  customerId: string | null;
  tier: string | null;
  createdAt: number;
};

/** What one call may carry, so a statement list and a tool's output stay bounded. */
export const MAX_PRICE_BOOK_ENTRIES_PER_CALL = 200;
export const MAX_CONTRACT_PRICES_PER_CALL = 200;

/** A book code as the form and the tools read it: trimmed, lower-cased, or null when it isn't one. */
export function normalizeBookCode(raw: string): string | null {
  const code = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(code) ? code : null;
}

/** The id of a book's entry: one per book, SKU and quantity, so writing it again replaces it. */
export const bookEntryId = (bookId: string, sku: string, minQty: number) =>
  `pbe_${bookId}~${sku}~${minQty}`;

/** Why the dates can't be a book's, or null. */
export function priceBookDatesProblem(startsAt: number | null, endsAt: number | null) {
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt)
    return 'A book ends after it starts.';
  return null;
}

/** A book's priority is a whole number within this far of zero. */
export const PRICE_BOOK_PRIORITY_LIMIT = 1000;

/**
 * A new book's code as stored (normalized) and what is wrong with the code, the priority or the
 * dates, if anything; the code is null when it isn't one.
 */
export function priceBookHeadProblem(input: {
  code: string;
  priority?: number;
  startsAt?: number | null;
  endsAt?: number | null;
}) {
  const code = normalizeBookCode(input.code);
  const priority = input.priority ?? 0;
  const problem = !code
    ? 'A code is lower-case letters, digits, dashes and underscores, up to 32.'
    : !Number.isInteger(priority) || Math.abs(priority) > PRICE_BOOK_PRIORITY_LIMIT
      ? `A priority is a whole number from -${PRICE_BOOK_PRIORITY_LIMIT} to ${PRICE_BOOK_PRIORITY_LIMIT}.`
      : priceBookDatesProblem(input.startsAt ?? null, input.endsAt ?? null);
  return { code, problem };
}

/** Why an entry can't be priced, or null: one of a price and a percentage, within bounds. */
export function priceBookEntryProblem(
  e: { sku: string; minQty?: number; price?: number | null; discountPct?: number | null },
  /** True for an entry that removes the row; it needs only its key. */
  remove = false,
): string | null {
  if (!e.sku.trim()) return 'An entry names a SKU.';
  if (e.minQty !== undefined && !(e.minQty > 0)) return `${e.sku}: a quantity is above 0.`;
  if (remove) return null;
  const hasPrice = e.price !== undefined && e.price !== null;
  const hasPct = e.discountPct !== undefined && e.discountPct !== null;
  if (hasPrice === hasPct) return `${e.sku}: give a price or a percentage off, not both.`;
  if (hasPrice && !((e.price as number) >= 0)) return `${e.sku}: a price is 0 or more.`;
  if (hasPct && !((e.discountPct as number) > 0 && (e.discountPct as number) <= 100))
    return `${e.sku}: a percentage is above 0 and at most 100.`;
  return null;
}

/** What a customer would pay for one line, and what priced it. */
export type PricePreviewLine = {
  sku: string;
  qty: number;
  /** Null for a SKU with no product. */
  listPrice: number | null;
  unitPrice: number;
  /** `quote`, `price_book`, `contract`, `volume` or `list`. */
  source: string;
  /** What priced it: the book's name for a book, the rule's name for another source. */
  name: string;
  bookId: string | null;
};
