/**
 * Negotiated quotes: prices agreed with a company for a stretch of time, versioned as they are
 * negotiated. The rules here, with no storage, are the lifecycle (only a draft is editable;
 * revising makes a new version and leaves the old one read-only), what makes a draft sendable
 * (`quoteDraftProblem`, `quoteSendProblem`), when a quote's prices count (`quoteLive`,
 * `quoteLineRule`, the `quote` source of the pricing chain), how an accepted quote becomes an order
 * (`quoteConversion`), and the inputs the REST routes and MCP tools take. `docs/b2b.md` is the
 * plan; D7 (a quote reaches an order through a PO draft when the company uses POs) and D8 (quote
 * prices are in the base currency, like books and budgets) are the defaults this is built on.
 *
 * Statuses are v1's, minus `under_review` (a counter-offer is a new version) and `converted` (an
 * accepted quote keeps pricing until it expires, so conversion is a link on the quote, not a
 * status; see `QuoteConversion`).
 */
import { z } from 'zod';
import { defineLifecycle } from '../lifecycle';
import type { PriceRule } from '../pricing';
import type { Company, CompanyMember } from './companies';
import { decodePoCursor, encodePoCursor, type PoCursor } from './purchase-orders';

export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'superseded',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/**
 * A draft is sent (or withdrawn). A sent quote is accepted, declined or lapses; one that is sent,
 * declined or lapsed is revised, which supersedes it with a new draft version. An accepted quote
 * is a deal: it can only end early (`expired`), never be edited or revised. `superseded` is final.
 */
export const QUOTE_LIFECYCLE = defineLifecycle<QuoteStatus>({
  draft: ['sent', 'declined'],
  sent: ['accepted', 'declined', 'expired', 'superseded'],
  accepted: ['expired'],
  declined: ['superseded'],
  expired: ['superseded'],
  superseded: [],
});

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  superseded: 'Superseded',
};

/** The states a revision starts from. */
export const quoteRevisable = (status: QuoteStatus) => QUOTE_LIFECYCLE.can(status, 'superseded');

/** Only a draft can be edited. */
export const quoteEditable = (status: QuoteStatus) => status === 'draft';

/** Caps that keep a quote, a company's quotes and a page bounded. */
export const MAX_QUOTE_LINES = 200;
export const MAX_QUOTE_NAME = 120;
export const QUOTE_PAGE = { default: 25, max: 100 } as const;
export const QUOTE_VERSIONS_SHOWN = 50;

const DAY = 86_400_000;

/** What an accepted quote became: a PO draft (D7) or an order. */
export type QuoteConversionTarget = 'po' | 'order';
export const QUOTE_CONVERSION_TARGETS = ['po', 'order'] as const;

export interface QuoteLine {
  sku: string;
  name: string | null;
  /** The most a buyer may order at this price. */
  qty: number;
  /** The list price when the line was written, for what the quote takes off; null when unknown. */
  listPrice: number | null;
  /** The negotiated unit price, in the base currency. */
  unitPrice: number;
}

export interface Quote {
  id: string;
  /** The first version's id, shared by every version of one negotiation. */
  rootId: string;
  /** 1 for the first draft; a revision is the next number. */
  version: number;
  /** The business customer's id: a quote is a company's. */
  companyId: string;
  /** The company member it is for; null for none named. */
  buyerId: string | null;
  name: string;
  status: QuoteStatus;
  /** Ms. The quote's prices don't count from this instant on. Null only on a draft. */
  expiresAt: number | null;
  notes: string | null;
  /** What an accepted quote was turned into, once. */
  convertedTo: QuoteConversionTarget | null;
  convertedId: string | null;
  convertedAt: number | null;
  sentAt: number | null;
  /** When it was accepted or declined. */
  decidedAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A quote with its lines. */
export interface QuoteDetail extends Quote {
  lines: QuoteLine[];
}

/** A quote as a list shows it: its header, how many lines it has and what they total. */
export interface QuoteRow extends Quote {
  lineCount: number;
  total: number;
}

/** What a quote's lines come to: each line's quantity at its price. */
export const quoteTotal = (lines: readonly Pick<QuoteLine, 'qty' | 'unitPrice'>[]) =>
  Math.round(lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0) * 100) / 100;

/**
 * What a quote is, now: its status, except that a sent or accepted quote past its expiry reads as
 * expired (nothing has to run for it to lapse; `expire_quote` and an accept make it official).
 */
export function quoteState(q: Pick<Quote, 'status' | 'expiresAt'>, now: number): QuoteStatus {
  if (
    (q.status === 'sent' || q.status === 'accepted') &&
    q.expiresAt !== null &&
    now >= q.expiresAt
  )
    return 'expired';
  return q.status;
}

/** Whether the quote's prices count at `now`: accepted, and not yet expired. */
export const quoteLive = (q: Pick<Quote, 'status' | 'expiresAt'>, now: number): boolean =>
  q.status === 'accepted' && q.expiresAt !== null && now < q.expiresAt;

/**
 * The `quote` price source's entry for one line: the company's price for this SKU up to the line's
 * quantity, until the quote expires. The pricing chain ranks this source first and stops there, so
 * an accepted quote's price is the price. The id is stable per quote and line.
 */
export function quoteLineRule(
  q: Pick<Quote, 'id' | 'name' | 'companyId' | 'expiresAt'>,
  position: number,
  line: Pick<QuoteLine, 'sku' | 'qty' | 'unitPrice'>,
): PriceRule {
  return {
    id: `quote_${q.id}_${position}`,
    source: 'quote',
    name: `Quote ${q.name}`,
    sku: line.sku,
    customerId: q.companyId,
    maxQty: line.qty,
    price: line.unitPrice,
    endsAt: q.expiresAt,
  };
}

/** What `quoteDraftProblem` needs to know of the company, the buyer and the SKUs. */
export type QuoteDraftContext = {
  company: Pick<Company, 'status'> | undefined;
  buyer: Pick<CompanyMember, 'companyId' | 'status'> | undefined;
  /** SKUs on the quote that no product has. */
  unknownSkus: readonly string[];
};

/**
 * Why a draft can't be kept, or null: no lines, one SKU twice (a quote prices a SKU once, so a
 * smaller order can't pick up a deeper tier's price), a SKU that isn't a product, a company that
 * isn't active, or a buyer who isn't an active member of it. Checked when a draft is saved and
 * again when it is sent, since the company may have changed.
 */
export function quoteDraftProblem(
  draft: Pick<Quote, 'companyId' | 'buyerId'> & { lines: readonly Pick<QuoteLine, 'sku'>[] },
  ctx: QuoteDraftContext,
): string | null {
  if (!draft.lines.length) return 'A quote needs at least one line.';
  const seen = new Set<string>();
  for (const l of draft.lines) {
    if (seen.has(l.sku)) return `${l.sku} is on the quote twice: a quote prices a SKU once.`;
    seen.add(l.sku);
  }
  if (ctx.unknownSkus.length) return `No product has the SKU ${ctx.unknownSkus.join(', ')}.`;
  if (!ctx.company) return `${draft.companyId} isn't a company.`;
  if (ctx.company.status !== 'active')
    return `Company ${draft.companyId} isn't active (${ctx.company.status}).`;
  if (draft.buyerId !== null)
    if (!ctx.buyer || ctx.buyer.companyId !== draft.companyId || ctx.buyer.status !== 'active')
      return `Buyer ${draft.buyerId} isn't an active member of ${draft.companyId}.`;
  return null;
}

/** Why a quote can't be sent at `now`, beyond what a draft needs, or null: it needs an expiry ahead. */
export function quoteSendProblem(q: Pick<Quote, 'expiresAt'>, now: number): string | null {
  if (q.expiresAt === null) return 'A quote needs an expiry before it is sent.';
  if (q.expiresAt <= now) return 'The quote’s expiry has passed.';
  return null;
}

/** Why an accepted quote can't be turned into a PO or an order at `now`, or null. */
export function quoteConvertProblem(
  q: Pick<Quote, 'status' | 'expiresAt' | 'convertedId'>,
  now: number,
): string | null {
  if (q.status !== 'accepted')
    return `Only an accepted quote can be converted (this one is ${q.status}).`;
  const live = q.expiresAt !== null && now < q.expiresAt;
  // A conversion already made is a repeat, whatever the clock says, except that an order that
  // hasn't started yet would not be priced at a quote that has expired.
  if (q.convertedId)
    return quoteOrderUnstarted(q) && !live
      ? 'The quote has expired, so the order it was converting to would not be priced at it.'
      : null;
  return live ? null : 'The quote has expired.';
}

/** What a quote line takes off its list price, as a whole percentage; null with no list price. */
export function quoteLineDiscount(l: Pick<QuoteLine, 'listPrice' | 'unitPrice'>): number | null {
  if (!l.listPrice) return null;
  return Math.round((1 - l.unitPrice / l.listPrice) * 100);
}

/**
 * A quote's lines deepest discount from list first (then by SKU), each with its discount (0 with
 * no list price), and how many are below list: what a card names first so the lines that matter
 * most to what a company pays can't hide in a long quote.
 */
export function rankQuoteLines<L extends Pick<QuoteLine, 'sku' | 'listPrice' | 'unitPrice'>>(
  lines: readonly L[],
) {
  const ranked = lines
    .map((line) => ({ line, off: quoteLineDiscount(line) ?? 0 }))
    .sort((a, b) => b.off - a.off || a.line.sku.localeCompare(b.line.sku));
  return { ranked, below: ranked.filter((r) => r.off > 0).length };
}

/** A conversion to an order that was claimed (it names the start key) but whose order isn't recorded yet. */
export const quoteOrderUnstarted = (q: Pick<Quote, 'convertedId'>) =>
  q.convertedId?.startsWith('quote:') === true;

/**
 * D7: where an accepted quote goes. A company that uses POs (has any) gets a PO draft, which its
 * buyer's PO number and the PO flow's approvals then carry; any other goes straight to an order.
 */
export const quoteConversion = (companyUsesPos: boolean): QuoteConversionTarget =>
  companyUsesPos ? 'po' : 'order';

/** The id of the PO draft a quote becomes, so converting twice makes one. */
export const quotePoId = (quoteId: string) => `po_${quoteId}`;

/** The key an order a quote starts is made under, so converting twice starts one. */
export const quoteOrderKey = (quoteId: string) => `quote:${quoteId}`;

/** The PO number a quote's draft starts with, when the caller gave none: the quote and its version. */
export const quotePoNumber = (q: Pick<Quote, 'id' | 'version'>) =>
  `Q-${q.id.replace(/^qt_/, '').toUpperCase()}-V${q.version}`.slice(0, 64);

/** The expiry a day names: valid through the end of that day (UTC). */
export const expiryOfDay = (day: string) => Date.parse(day) + DAY;

/** The day a quote's expiry is the end of (UTC), as `expiryOfDay` reads it. */
export const dayOfExpiry = (expiresAt: number) =>
  new Date(expiresAt - 1).toISOString().slice(0, 10);

const id = z.string().min(1).max(100);

export const quoteLineInput = z.object({
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200).optional(),
  qty: z.number().positive().max(1e9).describe('The most the buyer may order at this price'),
  unitPrice: z.number().nonnegative().max(1e9).describe('The negotiated unit price, base currency'),
});
export type QuoteLineInput = z.infer<typeof quoteLineInput>;

const quoteFields = {
  name: z.string().trim().min(1).max(MAX_QUOTE_NAME).describe('What the quote is called'),
  buyerId: id
    .nullable()
    .optional()
    .describe('The company member it is for (an active member of the company); null for none'),
  expiresOn: z.iso
    .date()
    .nullable()
    .optional()
    .describe('The last day (UTC) the prices count; required before it is sent'),
  notes: z.string().trim().min(1).max(2000).nullable().optional(),
  lines: z.array(quoteLineInput).min(1).max(MAX_QUOTE_LINES),
};

export const createQuoteInput = z.object({
  companyId: id.describe('The business customer’s id'),
  ...quoteFields,
});
export type CreateQuoteInput = z.infer<typeof createQuoteInput>;

export const updateQuoteInput = z.object({
  quoteId: id,
  name: quoteFields.name.optional(),
  buyerId: quoteFields.buyerId,
  expiresOn: quoteFields.expiresOn,
  notes: quoteFields.notes,
  lines: quoteFields.lines
    .optional()
    .describe('The whole list of lines: it replaces the draft’s lines'),
});
export type UpdateQuoteInput = z.infer<typeof updateQuoteInput>;

/** A quote's keys as an opaque cursor: newest first, so the creation time and the id. */
export type QuoteCursor = PoCursor;
export const encodeQuoteCursor = encodePoCursor;
export const decodeQuoteCursor = decodePoCursor;
