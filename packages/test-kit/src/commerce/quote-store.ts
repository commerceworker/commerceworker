/**
 * The quotes port in memory. The contract in ./quote-store-contract.ts holds it to the same
 * behaviour as the D1 store (packages/db), so use-case tests on it mean what they say about
 * production. The rows live in one `QuoteData`, which an `InMemoryPricingStore` can read too, so
 * a quote accepted here prices orders there, as on D1 where both ports read the same tables.
 */
import type {
  Quote,
  QuoteConversionTarget,
  QuoteDetail,
  QuoteLine,
  QuoteStatus,
} from '@commerceworker/core';
import { quoteTotal } from '@commerceworker/core';
import type {
  QuoteFilter,
  QuotePage,
  QuotePaging,
  QuotePatch,
  QuoteScope,
  QuoteStore,
} from '@commerceworker/ports/commerce';

export class QuoteData {
  readonly rows = new Map<string, { quote: Quote; lines: QuoteLine[] }>();
}

const sees = (scope: QuoteScope, companyId: string) =>
  'all' in scope || scope.companyId === companyId;

export class InMemoryQuoteStore implements QuoteStore {
  constructor(private readonly data: QuoteData = new QuoteData()) {}

  async list(scope: QuoteScope, f: QuoteFilter, paging: QuotePaging): Promise<QuotePage> {
    const needle = f.search?.trim().toLowerCase();
    const all = [...this.data.rows.values()]
      .map((r) => r.quote)
      .filter(
        (q) =>
          sees(scope, q.companyId) &&
          (!f.companyId || q.companyId === f.companyId) &&
          (!f.status || q.status === f.status) &&
          (!f.rootId || q.rootId === f.rootId) &&
          // Where each negotiation stands: the old versions are asked for by name.
          (f.status || f.rootId || q.status !== 'superseded') &&
          (!needle || q.name.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const { after } = paging;
    const rest = after
      ? all.filter((q) => q.createdAt < after.at || (q.createdAt === after.at && q.id < after.id))
      : all;
    const shown = rest.slice(0, paging.limit);
    const last = shown.at(-1);
    return {
      rows: shown.map((q) => {
        const lines = this.data.rows.get(q.id)?.lines ?? [];
        return { ...structuredClone(q), lineCount: lines.length, total: quoteTotal(lines) };
      }),
      total: all.length,
      next: rest.length > paging.limit && last ? { at: last.createdAt, id: last.id } : null,
    };
  }

  async get(scope: QuoteScope, id: string): Promise<QuoteDetail | undefined> {
    const r = this.data.rows.get(id);
    return r && sees(scope, r.quote.companyId)
      ? structuredClone({ ...r.quote, lines: r.lines })
      : undefined;
  }

  async versions(scope: QuoteScope, rootId: string) {
    return [...this.data.rows.values()]
      .map((r) => r.quote)
      .filter((q) => q.rootId === rootId && sees(scope, q.companyId))
      .sort((a, b) => a.version - b.version)
      .map(({ id, version, status }) => ({ id, version, status }));
  }

  private versionTaken(rootId: string, version: number) {
    return [...this.data.rows.values()].some(
      ({ quote }) => quote.rootId === rootId && quote.version === version,
    );
  }

  async create(quote: Quote, lines: readonly QuoteLine[]) {
    if (this.data.rows.has(quote.id)) return { ok: false as const, conflict: 'id' as const };
    if (this.versionTaken(quote.rootId, quote.version))
      return { ok: false as const, conflict: 'version' as const };
    this.data.rows.set(quote.id, {
      quote: structuredClone(quote),
      lines: structuredClone([...lines]),
    });
    return { ok: true as const };
  }

  async updateDraft(scope: QuoteScope, id: string, patch: QuotePatch, at: number) {
    const r = this.data.rows.get(id);
    if (r?.quote.status !== 'draft' || !sees(scope, r.quote.companyId))
      return { ok: false as const, conflict: 'missing' as const };
    const { lines, ...header } = patch;
    // Undefined means "leave it", as the D1 store reads it.
    const set = Object.fromEntries(Object.entries(header).filter(([, v]) => v !== undefined));
    r.quote = { ...r.quote, ...structuredClone(set), updatedAt: at };
    if (lines) r.lines = structuredClone([...lines]);
    return { ok: true as const };
  }

  async transition(scope: QuoteScope, id: string, from: QuoteStatus, to: QuoteStatus, at: number) {
    const r = this.data.rows.get(id);
    if (!r || r.quote.status !== from || !sees(scope, r.quote.companyId)) return false;
    r.quote = {
      ...r.quote,
      status: to,
      updatedAt: at,
      ...(to === 'sent' ? { sentAt: at } : {}),
      ...(to === 'accepted' || to === 'declined' ? { decidedAt: at } : {}),
    };
    return true;
  }

  async revise(
    scope: QuoteScope,
    id: string,
    from: QuoteStatus,
    next: Quote,
    lines: readonly QuoteLine[],
    at: number,
  ) {
    const r = this.data.rows.get(id);
    if (!r || r.quote.status !== from || !sees(scope, r.quote.companyId))
      return { ok: false as const, conflict: 'status' as const };
    if (this.data.rows.has(next.id)) return { ok: false as const, conflict: 'id' as const };
    if (this.versionTaken(next.rootId, next.version))
      return { ok: false as const, conflict: 'version' as const };
    r.quote = { ...r.quote, status: 'superseded', updatedAt: at };
    this.data.rows.set(next.id, {
      quote: structuredClone(next),
      lines: structuredClone([...lines]),
    });
    return { ok: true as const };
  }

  async markConverted(
    scope: QuoteScope,
    id: string,
    to: QuoteConversionTarget,
    convertedId: string,
    at: number,
  ): Promise<'new' | 'same' | false> {
    const r = this.data.rows.get(id);
    if (r?.quote.status !== 'accepted' || !sees(scope, r.quote.companyId)) return false;
    if (r.quote.convertedId)
      return r.quote.convertedId === convertedId && r.quote.convertedTo === to ? 'same' : false;
    r.quote = { ...r.quote, convertedTo: to, convertedId, convertedAt: at, updatedAt: at };
    return 'new';
  }

  async settleConversion(scope: QuoteScope, id: string, from: string, to: string, at: number) {
    const r = this.data.rows.get(id);
    if (!r || !sees(scope, r.quote.companyId)) return false;
    if (r.quote.convertedId !== from && r.quote.convertedId !== to) return false;
    r.quote = { ...r.quote, convertedId: to, updatedAt: at };
    return true;
  }
}
