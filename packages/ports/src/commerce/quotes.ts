/**
 * Negotiated quotes and their lines. `d1QuoteStore` (packages/db) and `InMemoryQuoteStore`
 * (packages/test-kit) implement it, held to one contract.
 *
 * Every read takes a `scope`: one company's (`{ companyId }`) or everything (`{ all: true }`), so a
 * caller bound to a company cannot read another's by forgetting a filter. Lists are keyset paged,
 * newest first, with the total the filters match. Only a draft is edited, and the edit is one
 * guarded write that names the draft status, so it cannot land on a quote that was sent a moment
 * before. A status moves only by a compare-and-set on the status the caller read: of a send and a
 * withdrawal, or an accept and a decline, racing from the same state, one wins and the other is
 * told so. A revision is one write that supersedes the old version and adds the next, or neither;
 * a negotiation has each version once, so two revisions racing make one.
 *
 * What the pricing chain reads of the accepted quotes is the pricing port's (`PricingStore`), over
 * the same data.
 */
import type {
  Quote,
  QuoteConversionTarget,
  QuoteCursor,
  QuoteDetail,
  QuoteLine,
  QuoteRow,
  QuoteStatus,
} from '@commerceworker/core';

export type QuoteScope = { readonly companyId: string } | { readonly all: true };

/** What a list narrows by. */
export interface QuoteFilter {
  /** Narrows to one company; a company-scoped read can't widen past its own. */
  readonly companyId?: string;
  readonly status?: QuoteStatus;
  /** Every version of one negotiation (the first version's id). */
  readonly rootId?: string;
  /** Part of the name, matched literally and without regard to case. */
  readonly search?: string;
}

export interface QuotePaging {
  readonly after?: QuoteCursor;
  readonly limit: number;
}

export interface QuotePage {
  readonly rows: QuoteRow[];
  /** Every row the filters match, not just this page. */
  readonly total: number;
  /** Pass it as `after` for the next page; null on the last. */
  readonly next: QuoteCursor | null;
}

/** The fields a draft's edit changes; what it leaves out stays. */
export interface QuotePatch {
  readonly name?: string;
  readonly buyerId?: string | null;
  readonly expiresAt?: number | null;
  readonly notes?: string | null;
  /** The whole list, replacing the draft's. */
  readonly lines?: readonly QuoteLine[];
}

/** One version of a negotiation, as the version list shows it. */
export interface QuoteVersion {
  readonly id: string;
  readonly version: number;
  readonly status: QuoteStatus;
}

export interface QuoteStore {
  /**
   * Quotes newest first. With neither a status nor a negotiation named, superseded versions are
   * left out: a list shows where each negotiation stands.
   */
  list(scope: QuoteScope, filter: QuoteFilter, paging: QuotePaging): Promise<QuotePage>;
  /** A quote with its lines, if the scope can see it. */
  get(scope: QuoteScope, id: string): Promise<QuoteDetail | undefined>;
  /** Every version of a negotiation, oldest first. */
  versions(scope: QuoteScope, rootId: string): Promise<QuoteVersion[]>;
  /** Adds a quote with its lines, all or none; the conflict, and nothing written, when it can't. */
  create(
    quote: Quote,
    lines: readonly QuoteLine[],
  ): Promise<{ ok: true } | { ok: false; conflict: 'id' | 'version' }>;
  /**
   * Edits a quote that is still a draft, its lines and header together or not at all. `missing`
   * when it isn't there, or isn't a draft any more (the edit was refused).
   */
  updateDraft(
    scope: QuoteScope,
    id: string,
    patch: QuotePatch,
    at: number,
  ): Promise<{ ok: true } | { ok: false; conflict: 'missing' }>;
  /**
   * `from` → `to`, only if the quote is still in `from`. False when it wasn't (or isn't there).
   * Moving to `sent` stamps `sentAt`, and to `accepted` or `declined` `decidedAt`.
   */
  transition(
    scope: QuoteScope,
    id: string,
    from: QuoteStatus,
    to: QuoteStatus,
    at: number,
  ): Promise<boolean>;
  /**
   * Supersedes the quote (only while it is in `from`) and adds `next`, its next version, with
   * `lines`, together or not at all. `status`: the quote wasn't in `from` any more. `version`: the
   * next version already exists (another revision won). `id`: `next`'s id is taken.
   */
  revise(
    scope: QuoteScope,
    id: string,
    from: QuoteStatus,
    next: Quote,
    lines: readonly QuoteLine[],
    at: number,
  ): Promise<{ ok: true } | { ok: false; conflict: 'status' | 'version' | 'id' }>;
  /**
   * Records what an accepted quote became, once. `new` when this call recorded it; `same` when it
   * already named `convertedId` (a repeat, or a racing call's claim); false when the quote isn't
   * accepted, or became something else.
   */
  markConverted(
    scope: QuoteScope,
    id: string,
    to: QuoteConversionTarget,
    convertedId: string,
    at: number,
  ): Promise<'new' | 'same' | false>;
  /**
   * Replaces what a conversion claimed (`from`: the order's start key) with what it made (`to`: the
   * order's id), only while the quote still names `from`. It doesn't need the quote to be accepted:
   * the claim was made while it was. True when it now names `to`.
   */
  settleConversion(
    scope: QuoteScope,
    id: string,
    from: string,
    to: string,
    at: number,
  ): Promise<boolean>;
}
