/**
 * Price books and contract prices as people and agents work with them: listing and reading books,
 * adding one, moving it along its lifecycle, setting its entries, assigning it, writing a
 * customer's contract prices, and previewing what a customer would pay. The REST routes, the MCP
 * tools and the admin pages all run these. What a book is, when it is in force and how its prices
 * rank are core's (`price-books`, `pricing`); each write has a `plan…` that a confirm card shows
 * before it runs, which names why it can't go ahead. Time and the new book's id come in as
 * arguments; the caller records the audit draft. Prices are in the base currency.
 */
import {
  BASE_CURRENCY,
  bookInForce,
  MAX_CONTRACT_PRICES_PER_CALL,
  MAX_PRICE_BOOK_ENTRIES_PER_CALL,
  PRICE_BOOK_LIFECYCLE,
  type PriceBook,
  type PriceBookAssignment,
  type PriceBookEntry,
  type PriceBookStatus,
  type PricePreviewLine,
  priceBookEntryProblem,
  priceBookHeadProblem,
  resolvePrice,
} from '@commerceworker/core';
import type {
  CompanyDirectory,
  PriceBookStore,
  PricingStore,
} from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

type Fail = { ok: false; error: string };
type Books = { readonly books: PriceBookStore };
type BooksAndPricing = Books & { readonly pricing: PricingStore };
/** What assigning a book also reads: the customer's company, whose status gates it. */
type AssignPorts = BooksAndPricing & { readonly companies: CompanyDirectory };

const NO_BOOK = 'No such price book.';
const NO_CUSTOMER = 'No such customer.';

/** A page cursor for entries: opaque to callers, the last entry's SKU and quantity. */
const encodeCursor = (c: { sku: string; minQty: number }) =>
  btoa(unescape(encodeURIComponent(JSON.stringify([c.sku, c.minQty]))));

function decodeCursor(text: string): { sku: string; minQty: number } | null {
  try {
    const [sku, minQty] = JSON.parse(decodeURIComponent(escape(atob(text)))) as unknown[];
    return typeof sku === 'string' && typeof minQty === 'number' ? { sku, minQty } : null;
  } catch {
    return null;
  }
}

export async function listPriceBooks(
  ports: Books,
  q: { status?: PriceBookStatus; after?: string; limit?: number } = {},
) {
  const page = await ports.books.list({
    status: q.status,
    after: q.after ?? null,
    limit: Math.min(Math.max(q.limit ?? 25, 1), 100),
  });
  return { books: page.rows, total: page.total, next: page.next };
}

/** One book (by id or code), who it is assigned to, and a page of its entries. */
export async function getPriceBook(
  ports: Books,
  q: { bookId: string; after?: string; limit?: number },
): Promise<
  | {
      ok: true;
      book: PriceBook;
      assignments: PriceBookAssignment[];
      entries: PriceBookEntry[];
      entryTotal: number;
      next: string | null;
    }
  | Fail
> {
  const book = await ports.books.find(q.bookId);
  if (!book) return { ok: false, error: NO_BOOK };
  const after = q.after === undefined ? null : decodeCursor(q.after);
  if (q.after !== undefined && !after) return { ok: false, error: 'That is not a page cursor.' };
  const [assignments, page] = await Promise.all([
    ports.books.assignments(book.id),
    ports.books.entries(book.id, {
      after,
      limit: Math.min(Math.max(q.limit ?? 50, 1), 200),
    }),
  ]);
  return {
    ok: true,
    book,
    assignments,
    entries: page.rows,
    entryTotal: page.total,
    next: page.next ? encodeCursor(page.next) : null,
  };
}

export type CreatePriceBookInput = {
  code: string;
  name: string;
  priority?: number;
  startsAt?: number;
  endsAt?: number;
};

/** Why a book can't be made as asked, or null; the code is normalized. */
export const planPriceBook = priceBookHeadProblem;

/** Adds a book in draft: it prices nothing until it has entries and assignees and is active. */
export async function createPriceBook(
  ports: Books,
  input: CreatePriceBookInput,
  by: string,
  now: number,
  id: string,
): Promise<{ ok: true; book: PriceBook; audit: AuditDraft } | Fail> {
  const { code, problem } = planPriceBook(input);
  if (problem || !code) return { ok: false, error: problem ?? 'Give the book a code.' };
  const book: PriceBook = {
    id,
    code,
    name: input.name.trim(),
    priority: input.priority ?? 0,
    status: 'draft',
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    createdBy: by,
    createdAt: now,
    updatedAt: now,
  };
  if (!(await ports.books.create(book)))
    return { ok: false, error: `The code ${code} is taken by another price book.` };
  return {
    ok: true,
    book,
    audit: {
      action: 'price_book.created',
      target: id,
      detail: { code, name: book.name, priority: book.priority },
    },
  };
}

/**
 * What moving a book to `status` would do, for a card: the book, its reach, whether its dates
 * would put it in force once active (`inDates`), and why not.
 */
export async function planPriceBookStatus(
  ports: Books,
  input: { bookId: string; status: PriceBookStatus },
  now: number,
) {
  const book = await ports.books.find(input.bookId);
  if (!book) return { book: undefined, assigned: 0, entries: 0, inDates: false, problem: NO_BOOK };
  const [assignments, entries] = await Promise.all([
    ports.books.assignments(book.id),
    ports.books.entries(book.id, { after: null, limit: 1 }),
  ]);
  const problem =
    book.status === input.status
      ? `${book.name} is already ${input.status}.`
      : PRICE_BOOK_LIFECYCLE.can(book.status, input.status)
        ? null
        : `A ${book.status} book can't become ${input.status}.`;
  return {
    book,
    assigned: assignments.length,
    entries: entries.total,
    inDates: bookInForce({ ...book, status: 'active' }, now),
    problem,
  };
}

/** Moves a book along its lifecycle, as one compare-and-set on the status it was read in. */
export async function setPriceBookStatus(
  ports: Books,
  input: { bookId: string; status: PriceBookStatus },
  now: number,
): Promise<{ ok: true; book: PriceBook; from: PriceBookStatus; audit: AuditDraft } | Fail> {
  const plan = await planPriceBookStatus(ports, input, now);
  if (plan.problem || !plan.book) return { ok: false, error: plan.problem ?? NO_BOOK };
  const { book } = plan;
  if (!(await ports.books.transition(book.id, book.status, input.status, now)))
    return {
      ok: false,
      error: `${book.name} was changed by someone else just now: read it again.`,
    };
  return {
    ok: true,
    book: { ...book, status: input.status, updatedAt: now },
    from: book.status,
    audit: {
      action: 'price_book.status',
      target: book.id,
      detail: { code: book.code, from: book.status, to: input.status },
    },
  };
}

export type EntryInput = {
  sku: string;
  minQty?: number;
  price?: number | null;
  discountPct?: number | null;
  remove?: boolean;
};

const keyOf = (e: { sku: string; minQty?: number }) => `${e.sku}~${e.minQty ?? 1}`;

/** What writing entries would do, for a card, and why it can't be done. */
export async function planPriceBookEntries(
  ports: BooksAndPricing,
  input: { bookId: string; entries: readonly EntryInput[] },
  now: number,
) {
  const book = await ports.books.find(input.bookId);
  const puts = input.entries.filter((e) => !e.remove);
  const removes = input.entries.filter((e) => e.remove);
  const none = { book, puts: puts.length, removes: removes.length };
  if (!book) return { ...none, assigned: 0, inDates: false, problem: NO_BOOK };
  const live = { assigned: 0, inDates: bookInForce({ ...book, status: 'active' }, now) };
  if (book.status === 'archived')
    return { ...none, ...live, problem: `${book.name} is archived and can't change.` };
  if (input.entries.length > MAX_PRICE_BOOK_ENTRIES_PER_CALL)
    return {
      ...none,
      ...live,
      problem: `At most ${MAX_PRICE_BOOK_ENTRIES_PER_CALL} entries a call.`,
    };
  const seen = new Set<string>();
  for (const e of input.entries) {
    const why = priceBookEntryProblem(e, e.remove === true);
    if (why) return { ...none, ...live, problem: why };
    if (seen.has(keyOf(e)))
      return { ...none, ...live, problem: `${e.sku} appears twice at the same quantity.` };
    seen.add(keyOf(e));
  }
  const skus = [...new Set(puts.map((e) => e.sku))];
  const known = new Set((await ports.pricing.products(skus)).map((p) => p.sku));
  const unknown = skus.filter((s) => !known.has(s));
  const assigned = (await ports.books.assignments(book.id)).length;
  return {
    ...none,
    assigned,
    inDates: live.inDates,
    problem: unknown.length ? `No such product: ${unknown.slice(0, 5).join(', ')}.` : null,
  };
}

/** Adds, replaces and removes entries: a SKU at a quantity and up, at a price or a percent off. */
export async function putPriceBookEntries(
  ports: BooksAndPricing,
  input: { bookId: string; entries: readonly EntryInput[] },
  now: number,
): Promise<{ ok: true; book: PriceBook; put: number; removed: number; audit: AuditDraft } | Fail> {
  const plan = await planPriceBookEntries(ports, input, now);
  if (plan.problem || !plan.book) return { ok: false, error: plan.problem ?? NO_BOOK };
  const { book } = plan;
  const puts: PriceBookEntry[] = input.entries
    .filter((e) => !e.remove)
    .map((e) => ({
      sku: e.sku,
      minQty: e.minQty ?? 1,
      price: e.price ?? null,
      discountPct: e.discountPct ?? null,
    }));
  const removes = input.entries
    .filter((e) => e.remove)
    .map((e) => ({ sku: e.sku, minQty: e.minQty ?? 1 }));
  // Each write is idempotent, so a call that stops between the two converges when it is repeated.
  if (removes.length) await ports.books.removeEntries(book.id, removes);
  if (puts.length) await ports.books.putEntries(book.id, puts, now);
  return {
    ok: true,
    book,
    put: puts.length,
    removed: removes.length,
    audit: {
      action: 'price_book.entries',
      target: book.id,
      detail: { code: book.code, put: puts.length, removed: removes.length },
    },
  };
}

export type AssignInput = { bookId: string; customerId?: string; tier?: string; remove?: boolean };

/** What an assignment would do, for a card: the book, to whom, and why not. */
export async function planPriceBookAssignment(ports: AssignPorts, input: AssignInput) {
  const book = await ports.books.find(input.bookId);
  const tier = input.tier?.trim() || undefined;
  const to = input.customerId ? { customerId: input.customerId } : tier ? { tier } : null;
  const customer = input.customerId ? await ports.pricing.customer(input.customerId) : undefined;
  const company = input.customerId
    ? await ports.companies.company({ all: true }, input.customerId)
    : undefined;
  const problem = !book
    ? NO_BOOK
    : input.customerId && tier
      ? 'Name a customer or a tier, not both.'
      : !to
        ? 'Name a customer or a tier.'
        : input.customerId && !customer
          ? NO_CUSTOMER
          : company && company.status !== 'active' && !input.remove
            ? `${customer?.name ?? input.customerId} is ${company.status}: a book is assigned only to an active company.`
            : book.status === 'archived' && !input.remove
              ? `${book.name} is archived and can't be assigned.`
              : null;
  return { book, to, customer, problem };
}

/** Assigns a book to a customer or a tier, or takes the assignment away. */
export async function assignPriceBook(
  ports: AssignPorts,
  input: AssignInput,
  now: number,
): Promise<{ ok: true; book: PriceBook; audit: AuditDraft } | Fail> {
  const { book, to, problem } = await planPriceBookAssignment(ports, input);
  if (problem || !book || !to) return { ok: false, error: problem ?? NO_BOOK };
  const who = 'customerId' in to ? `customer ${to.customerId}` : `the ${to.tier} tier`;
  if (input.remove) {
    if (!(await ports.books.unassign(book.id, to)))
      return { ok: false, error: `${book.name} isn't assigned to ${who}.` };
  } else if (!(await ports.books.assign(book.id, to, now)))
    return { ok: false, error: `${book.name} is already assigned to ${who}.` };
  return {
    ok: true,
    book,
    audit: {
      action: input.remove ? 'price_book.unassigned' : 'price_book.assigned',
      target: book.id,
      detail: { code: book.code, ...to },
    },
  };
}

export type ContractPriceInput = { sku: string; price: number | null };

/** What writing contract prices would do, for a card, and why it can't be done. */
export async function planContractPrices(
  ports: BooksAndPricing,
  input: { customerId: string; prices: readonly ContractPriceInput[] },
) {
  const customer = await ports.pricing.customer(input.customerId);
  const sets = input.prices.filter((p) => p.price !== null);
  const info = { customer, sets: sets.length, removes: input.prices.length - sets.length };
  if (!customer) return { ...info, problem: NO_CUSTOMER };
  if (input.prices.length > MAX_CONTRACT_PRICES_PER_CALL)
    return { ...info, problem: `At most ${MAX_CONTRACT_PRICES_PER_CALL} prices a call.` };
  const seen = new Set<string>();
  for (const p of input.prices) {
    if (!p.sku.trim()) return { ...info, problem: 'A price names a SKU.' };
    if (p.price !== null && !(p.price >= 0))
      return { ...info, problem: `${p.sku}: a price is 0 or more.` };
    if (seen.has(p.sku)) return { ...info, problem: `${p.sku} appears twice.` };
    seen.add(p.sku);
  }
  const skus = sets.map((p) => p.sku);
  const known = new Set((await ports.pricing.products(skus)).map((p) => p.sku));
  const unknown = skus.filter((s) => !known.has(s));
  return {
    ...info,
    problem: unknown.length ? `No such product: ${unknown.slice(0, 5).join(', ')}.` : null,
  };
}

/** Sets, replaces and (with a null price) removes a customer's contract prices. */
export async function putContractPrices(
  ports: BooksAndPricing,
  input: { customerId: string; prices: readonly ContractPriceInput[] },
): Promise<{ ok: true; set: number; removed: number; audit: AuditDraft } | Fail> {
  const plan = await planContractPrices(ports, input);
  if (plan.problem) return { ok: false, error: plan.problem };
  const sets = input.prices.flatMap((p) =>
    p.price === null ? [] : [{ sku: p.sku, price: p.price }],
  );
  const removes = input.prices.filter((p) => p.price === null).map((p) => p.sku);
  if (removes.length) await ports.books.removeContractPrices(input.customerId, removes);
  if (sets.length) await ports.books.putContractPrices(input.customerId, sets);
  return {
    ok: true,
    set: sets.length,
    removed: removes.length,
    audit: {
      action: 'contract_price.saved',
      target: input.customerId,
      detail: { set: sets.length, removed: removes.length },
    },
  };
}

/**
 * What a customer would pay for these lines at `now`, in the base currency, and what priced each:
 * the same chain an order runs (`resolvePrice` over `pricing.priceInputs`), with every
 * source on. Nothing is written. With no customer, only the rules that name none apply.
 */
export async function previewPrice(
  ports: { readonly pricing: PricingStore },
  input: { customerId?: string; lines: readonly { sku: string; qty?: number }[] },
  now: number,
): Promise<
  | {
      ok: true;
      customerId: string | null;
      tier: string | null;
      currency: string;
      lines: PricePreviewLine[];
    }
  | Fail
> {
  if (input.customerId && !(await ports.pricing.customer(input.customerId)))
    return { ok: false, error: NO_CUSTOMER };
  const skus = [...new Set(input.lines.map((l) => l.sku))];
  const { products, chain } = await ports.pricing.priceInputs(
    skus,
    BASE_CURRENCY,
    input.customerId,
    true,
    now,
  );
  const listed = new Map(products.map((p) => [p.sku, p.price]));
  const unknown = skus.filter((s) => !listed.has(s));
  if (unknown.length || !chain)
    return { ok: false, error: `No such product: ${unknown.slice(0, 5).join(', ')}.` };
  return {
    ok: true,
    customerId: input.customerId ?? null,
    tier: chain.tier,
    currency: BASE_CURRENCY,
    lines: input.lines.map((l): PricePreviewLine => {
      const line = { sku: l.sku, qty: l.qty ?? 1 };
      const listPrice = listed.get(l.sku) ?? null;
      const r = resolvePrice(line, listPrice ?? 0, chain.sources, chain.rules, {
        customerId: input.customerId,
        customerTier: chain.tier,
        now,
      });
      return {
        ...line,
        listPrice,
        unitPrice: r.unitPrice,
        source: r.by.source,
        name: r.by.name,
        bookId: 'bookId' in r.by ? (r.by.bookId ?? null) : null,
      };
    }),
  };
}
