/**
 * The price book port in memory. The contract in ./price-book-store-contract.ts holds it to the
 * same behaviour as the D1 store (packages/db). Books, entries, assignments and contract prices
 * live in one `PriceBookData`, which an `InMemoryPricingStore` can read too, so a price book
 * written here prices orders there, as on D1 where both ports read the same tables.
 */
import type {
  PriceBook,
  PriceBookAssignee,
  PriceBookAssignment,
  PriceBookEntry,
  PriceBookStatus,
} from '@commerceworker/core';
import type {
  CompanyScope,
  ContractPrice,
  PriceBookEntryCursor,
  PriceBookStore,
} from '@commerceworker/ports/commerce';

export class PriceBookData {
  readonly books: PriceBook[] = [];
  readonly assignments: PriceBookAssignment[] = [];
  /** By book id, then by `sku~minQty`. */
  readonly entries = new Map<string, Map<string, PriceBookEntry>>();
  /** By customer id, then SKU. */
  readonly contracts = new Map<string, Map<string, number>>();
}

const entryKey = (sku: string, minQty: number) => `${sku}~${minQty}`;

const byEntry = (a: { sku: string; minQty: number }, b: { sku: string; minQty: number }) =>
  a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.minQty - b.minQty;

/** The entries of a book, in the order a page reads them. */
export const sortedEntries = (data: PriceBookData, bookId: string): PriceBookEntry[] =>
  [...(data.entries.get(bookId)?.values() ?? [])].sort(byEntry);

export class InMemoryPriceBookStore implements PriceBookStore {
  constructor(private readonly data: PriceBookData = new PriceBookData()) {}

  async list(q: { status?: PriceBookStatus; after: string | null; limit: number }) {
    const matching = this.data.books
      .filter((b) => !q.status || b.status === q.status)
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const rest = q.after === null ? matching : matching.filter((b) => b.code > (q.after as string));
    const rows = rest.slice(0, q.limit).map((b) => ({ ...b }));
    return {
      rows,
      total: matching.length,
      next: rest.length > q.limit ? (rows.at(-1)?.code ?? null) : null,
    };
  }

  async find(idOrCode: string) {
    const b = this.data.books.find((x) => x.id === idOrCode || x.code === idOrCode);
    return b ? { ...b } : undefined;
  }

  async create(book: PriceBook) {
    if (this.data.books.some((b) => b.id === book.id || b.code === book.code)) return false;
    this.data.books.push({ ...book });
    return true;
  }

  async transition(id: string, from: PriceBookStatus, to: PriceBookStatus, at: number) {
    const b = this.data.books.find((x) => x.id === id);
    if (!b || b.status !== from) return false;
    b.status = to;
    b.updatedAt = at;
    return true;
  }

  async entries(bookId: string, q: { after: PriceBookEntryCursor | null; limit: number }) {
    const all = sortedEntries(this.data, bookId);
    const rest = q.after ? all.filter((e) => byEntry(e, q.after as PriceBookEntryCursor) > 0) : all;
    const rows = rest.slice(0, q.limit);
    const last = rows.at(-1);
    return {
      rows,
      total: all.length,
      next: rest.length > q.limit && last ? { sku: last.sku, minQty: last.minQty } : null,
    };
  }

  async putEntries(bookId: string, entries: readonly PriceBookEntry[]) {
    const mine = this.data.entries.get(bookId) ?? new Map<string, PriceBookEntry>();
    for (const e of entries) mine.set(entryKey(e.sku, e.minQty), { ...e });
    this.data.entries.set(bookId, mine);
  }

  async removeEntries(bookId: string, keys: readonly { sku: string; minQty: number }[]) {
    const mine = this.data.entries.get(bookId);
    for (const k of keys) mine?.delete(entryKey(k.sku, k.minQty));
  }

  private assigned(bookId: string, to: PriceBookAssignee) {
    return this.data.assignments.findIndex(
      (a) =>
        a.bookId === bookId &&
        ('customerId' in to ? a.customerId === to.customerId : a.tier === to.tier),
    );
  }

  async assign(bookId: string, to: PriceBookAssignee, at: number) {
    if (this.assigned(bookId, to) >= 0) return false;
    this.data.assignments.push({
      bookId,
      customerId: 'customerId' in to ? to.customerId : null,
      tier: 'tier' in to ? to.tier : null,
      createdAt: at,
    });
    return true;
  }

  async unassign(bookId: string, from: PriceBookAssignee) {
    const i = this.assigned(bookId, from);
    if (i < 0) return false;
    this.data.assignments.splice(i, 1);
    return true;
  }

  async assignments(bookId: string) {
    return this.data.assignments
      .filter((a) => a.bookId === bookId)
      .map((a) => ({ ...a }))
      .sort(
        (a, b) =>
          Number(a.customerId === null) - Number(b.customerId === null) ||
          (a.customerId ?? '').localeCompare(b.customerId ?? '') ||
          (a.tier ?? '').localeCompare(b.tier ?? ''),
      );
  }

  async forCustomer(scope: CompanyScope, customerId: string, tier: string | null) {
    if (!('all' in scope) && scope.companyId !== customerId) return [];
    const ids = new Set(
      this.data.assignments
        .filter((a) => a.customerId === customerId || (tier !== null && a.tier === tier))
        .map((a) => a.bookId),
    );
    return this.data.books
      .filter((b) => ids.has(b.id))
      .map((b) => ({ ...b }))
      .sort((a, b) => b.priority - a.priority || (a.code < b.code ? -1 : 1));
  }

  async contractPrices(scope: CompanyScope, customerId: string): Promise<ContractPrice[]> {
    if (!('all' in scope) && scope.companyId !== customerId) return [];
    return [...(this.data.contracts.get(customerId) ?? [])]
      .map(([sku, price]) => ({ sku, price }))
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  }

  async putContractPrices(
    scope: CompanyScope,
    customerId: string,
    prices: readonly ContractPrice[],
  ) {
    if (!('all' in scope) && scope.companyId !== customerId) return false;
    const mine = this.data.contracts.get(customerId) ?? new Map<string, number>();
    for (const p of prices) mine.set(p.sku, p.price);
    this.data.contracts.set(customerId, mine);
    return true;
  }

  async removeContractPrices(scope: CompanyScope, customerId: string, skus: readonly string[]) {
    if (!('all' in scope) && scope.companyId !== customerId) return false;
    for (const sku of skus) this.data.contracts.get(customerId)?.delete(sku);
    return true;
  }
}
