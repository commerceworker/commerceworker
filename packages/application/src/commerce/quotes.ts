/**
 * Negotiated quotes as staff, agents and orders meet them (`b2b/quotes.ts` in core). A quote is
 * drafted and edited as a draft (`createQuote`, `updateQuote`), sent (`sendQuote`), and accepted or
 * declined for its company (`acceptQuote`, `declineQuote`: staff record the company's answer until
 * its buyers can sign in). Negotiating is revising: `reviseQuote` supersedes a sent, declined or
 * expired quote with the next version as a draft. An accepted quote prices the company's orders
 * until it expires (the pricing chain's `quote` source, read by `pricingFor`), is ended early by
 * `expireQuote`, and is turned into a PO draft or an order once by `convertQuote`. The REST routes,
 * the MCP tools and the admin pages all run these. Each change is a `plan…` that reads and judges
 * (a card shows its refusal) and a write that plans again, so a stale preview can't push past a
 * rule; every move is a compare-and-set on the status it read, and a repeat finds the result of
 * the first. Time and new ids come in as arguments, the engine's own order start as `deps`; the
 * caller records the audit draft.
 */
import {
  BASE_CURRENCY,
  type CreateQuoteInput,
  createQuoteInput,
  DEFAULT_TEMPLATE,
  decodeQuoteCursor,
  encodeQuoteCursor,
  expiryOfDay,
  type OrderInputDraft,
  type PurchaseOrder,
  poDraftProblem,
  QUOTE_PAGE,
  QUOTE_STATUS_LABELS,
  type Quote,
  type QuoteConversionTarget,
  type QuoteDetail,
  type QuoteLine,
  type QuoteRow,
  type QuoteStatus,
  quoteConversion,
  quoteConvertProblem,
  quoteDraftProblem,
  quoteEditable,
  quoteOrderKey,
  quoteOrderUnstarted,
  quotePoId,
  quotePoNumber,
  quoteRevisable,
  quoteSendProblem,
  quoteState,
  quoteTotal,
  type UpdateQuoteInput,
  updateQuoteInput,
} from '@commerceworker/core';
import type {
  CompanyDirectory,
  PricingStore,
  PurchaseOrderStore,
  QuotePatch,
  QuoteScope,
  QuoteStore,
} from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

export type QuotePorts = {
  readonly quotes: QuoteStore;
  readonly companies: CompanyDirectory;
  /** The products a quote's SKUs must be, and their list prices. */
  readonly pricing: Pick<PricingStore, 'products'>;
};

/** Converting a quote to a PO draft also reads and writes purchase orders. */
export type QuoteConvertPorts = QuotePorts & { readonly purchaseOrders: PurchaseOrderStore };

const refuse = (error: string) => ({ ok: false as const, error });
type Refused = ReturnType<typeof refuse>;

/** What a change did; `audit` is null when it changed nothing (a repeat). */
export type QuoteChange<T = Record<string, never>> =
  | ({ ok: true; changed: boolean; audit: AuditDraft | null } & T)
  | Refused;

const firstIssue = (e: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}) => {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || 'input'}: ${i.message}` : 'Not a valid request.';
};

const NO_SUCH_QUOTE = 'No such quote.';
const href = (id: string) => `/quotes/${id}`;
const label = (status: QuoteStatus) => QUOTE_STATUS_LABELS[status].toLowerCase();

// ── Reads ──────────────────────────────────────────────────────────────────

/** A quote as the tools show it, with its lines and versions when they are loaded. */
export function quoteView(
  q: QuoteRow | QuoteDetail,
  versions?: { id: string; version: number; status: QuoteStatus }[],
) {
  return {
    ...q,
    total: 'lines' in q ? quoteTotal(q.lines) : q.total,
    ...(versions ? { versions } : {}),
    href: href(q.id),
  };
}

function cursorOf(raw: string | undefined) {
  if (raw === undefined) return { ok: true as const, after: undefined };
  const after = decodeQuoteCursor(raw);
  return after ? { ok: true as const, after } : refuse('That cursor isn’t one a page returned.');
}

export type QuoteListQuery = {
  companyId?: string;
  status?: QuoteStatus;
  rootId?: string;
  search?: string;
  cursor?: string;
  limit?: number;
};

export async function listQuotes(
  ports: Pick<QuotePorts, 'quotes'>,
  scope: QuoteScope,
  q: QuoteListQuery,
) {
  const at = cursorOf(q.cursor);
  if (!at.ok) return at;
  const page = await ports.quotes.list(
    scope,
    { companyId: q.companyId, status: q.status, rootId: q.rootId, search: q.search },
    { after: at.after, limit: q.limit ?? QUOTE_PAGE.default },
  );
  return {
    ok: true as const,
    quotes: page.rows.map((r) => quoteView(r)),
    total: page.total,
    cursor: page.next ? encodeQuoteCursor(page.next) : null,
  };
}

export async function getQuote(
  ports: Pick<QuotePorts, 'quotes'>,
  scope: QuoteScope,
  quoteId: string,
) {
  const q = await ports.quotes.get(scope, quoteId);
  if (!q) return refuse(NO_SUCH_QUOTE);
  const versions = await ports.quotes.versions(scope, q.rootId);
  return { ok: true as const, quote: quoteView(q, versions) };
}

// ── Drafting ───────────────────────────────────────────────────────────────

/**
 * The lines as stored: each with the list price it was written against (and the product's name
 * when the caller gave none). A SKU that isn't a product keeps no price; `draftProblem` names it.
 */
async function linesOf(
  ports: Pick<QuotePorts, 'pricing'>,
  lines: CreateQuoteInput['lines'],
): Promise<QuoteLine[]> {
  const found = new Map(
    (await ports.pricing.products([...new Set(lines.map((l) => l.sku))])).map((p) => [p.sku, p]),
  );
  return lines.map((l) => ({
    sku: l.sku,
    name: l.name ?? found.get(l.sku)?.name ?? null,
    qty: l.qty,
    listPrice: found.get(l.sku)?.price ?? null,
    unitPrice: l.unitPrice,
  }));
}

/** Why a draft as written can't be kept, or null: `quoteDraftProblem`, read from the ports. */
async function draftProblem(
  ports: Pick<QuotePorts, 'companies' | 'pricing'>,
  scope: QuoteScope,
  draft: Pick<Quote, 'companyId' | 'buyerId'> & { lines: readonly QuoteLine[] },
) {
  const [access, products] = await Promise.all([
    ports.companies.access(scope, draft.companyId, draft.buyerId ?? undefined),
    ports.pricing.products([...new Set(draft.lines.map((l) => l.sku))]),
  ]);
  const known = new Set(products.map((p) => p.sku));
  return quoteDraftProblem(draft, {
    company: access.company,
    buyer: access.buyer,
    unknownSkus: [...new Set(draft.lines.filter((l) => !known.has(l.sku)).map((l) => l.sku))],
  });
}

export type QuoteDraftPlan = { ok: true; quote: QuoteDetail };

/** What creating a draft would do, or why not. */
export async function planQuote(
  ports: QuotePorts,
  scope: QuoteScope,
  raw: unknown,
  newId: () => string,
  now: number,
  createdBy: string | null,
): Promise<QuoteDraftPlan | Refused> {
  const parsed = createQuoteInput.safeParse(raw);
  if (!parsed.success) return refuse(firstIssue(parsed.error));
  const i = parsed.data;
  const lines = await linesOf(ports, i.lines);
  const id = newId();
  const quote: QuoteDetail = {
    id,
    rootId: id,
    version: 1,
    companyId: i.companyId,
    buyerId: i.buyerId ?? null,
    name: i.name,
    status: 'draft',
    expiresAt: i.expiresOn ? expiryOfDay(i.expiresOn) : null,
    notes: i.notes ?? null,
    convertedTo: null,
    convertedId: null,
    convertedAt: null,
    sentAt: null,
    decidedAt: null,
    createdBy,
    createdAt: now,
    updatedAt: now,
    lines,
  };
  const problem = await draftProblem(ports, scope, quote);
  return problem ? refuse(problem) : { ok: true, quote };
}

export async function createQuote(
  ports: QuotePorts,
  scope: QuoteScope,
  raw: unknown,
  newId: () => string,
  now: number,
  createdBy: string | null,
): Promise<QuoteChange<{ quote: QuoteDetail }>> {
  const plan = await planQuote(ports, scope, raw, newId, now, createdBy);
  if (!plan.ok) return plan;
  const { lines, ...quote } = plan.quote;
  const made = await ports.quotes.create(quote, lines);
  if (!made.ok) return refuse('That quote already exists.');
  return {
    ok: true,
    changed: true,
    quote: plan.quote,
    audit: {
      action: 'quote.created',
      target: quote.id,
      detail: { company: quote.companyId, name: quote.name, lines: lines.length },
    },
  };
}

/** What changing a draft would do, or why not. */
export async function planQuoteUpdate(
  ports: QuotePorts,
  scope: QuoteScope,
  raw: unknown,
): Promise<
  | {
      ok: true;
      before: QuoteDetail;
      after: QuoteDetail;
      patch: QuotePatch;
      changes: string[];
    }
  | Refused
> {
  const parsed = updateQuoteInput.safeParse(raw);
  if (!parsed.success) return refuse(firstIssue(parsed.error));
  const i: UpdateQuoteInput = parsed.data;
  const before = await ports.quotes.get(scope, i.quoteId);
  if (!before) return refuse(NO_SUCH_QUOTE);
  if (!quoteEditable(before.status))
    return refuse(
      `${before.name} is ${label(before.status)}: only a draft can be changed${
        quoteRevisable(before.status) ? '; revise it for a new version' : ''
      }.`,
    );
  const patch: { -readonly [K in keyof QuotePatch]: QuotePatch[K] } = {};
  const changes: string[] = [];
  const note = (field: string, differs: boolean) => differs && changes.push(field);
  const after: QuoteDetail = { ...before };
  if (i.name !== undefined) {
    after.name = i.name;
    patch.name = i.name;
    note('name', i.name !== before.name);
  }
  if (i.buyerId !== undefined) {
    after.buyerId = i.buyerId;
    patch.buyerId = i.buyerId;
    note('buyer', i.buyerId !== before.buyerId);
  }
  if (i.expiresOn !== undefined) {
    after.expiresAt = i.expiresOn ? expiryOfDay(i.expiresOn) : null;
    patch.expiresAt = after.expiresAt;
    note('expiry', after.expiresAt !== before.expiresAt);
  }
  if (i.notes !== undefined) {
    after.notes = i.notes;
    patch.notes = i.notes;
    note('notes', i.notes !== before.notes);
  }
  if (i.lines !== undefined) {
    after.lines = await linesOf(ports, i.lines);
    patch.lines = after.lines;
    note('lines', JSON.stringify(after.lines) !== JSON.stringify(before.lines));
  }
  const problem = await draftProblem(ports, scope, after);
  if (problem) return refuse(problem);
  return { ok: true, before, after, patch, changes };
}

export async function updateQuote(
  ports: QuotePorts,
  scope: QuoteScope,
  raw: unknown,
  now: number,
): Promise<QuoteChange<{ quote: QuoteDetail }>> {
  const plan = await planQuoteUpdate(ports, scope, raw);
  if (!plan.ok) return plan;
  const { before, after, patch, changes } = plan;
  if (!changes.length) return { ok: true, changed: false, quote: before, audit: null };
  const res = await ports.quotes.updateDraft(scope, before.id, patch, now);
  if (!res.ok)
    return refuse(`${before.name} was sent or ended meanwhile: only a draft can be changed.`);
  return {
    ok: true,
    changed: true,
    quote: { ...after, updatedAt: now },
    audit: {
      action: 'quote.updated',
      target: before.id,
      detail: { company: before.companyId, name: after.name, changed: changes },
    },
  };
}

// ── Moving a quote along ───────────────────────────────────────────────────

export type QuoteMovePlan = {
  ok: true;
  quote: QuoteDetail;
  /** Already there: doing it again changes nothing. */
  repeat: boolean;
};

async function move(
  ports: Pick<QuotePorts, 'quotes'>,
  scope: QuoteScope,
  quote: QuoteDetail,
  from: QuoteStatus,
  to: QuoteStatus,
  now: number,
): Promise<QuoteDetail | Refused> {
  if (await ports.quotes.transition(scope, quote.id, from, to, now))
    return {
      ...quote,
      status: to,
      updatedAt: now,
      ...(to === 'sent' ? { sentAt: now } : {}),
      ...(to === 'accepted' || to === 'declined' ? { decidedAt: now } : {}),
    };
  // Another move got there first: say where the quote is now.
  const now2 = await ports.quotes.get(scope, quote.id);
  return refuse(
    now2
      ? `${quote.name} is ${label(now2.status)} now, so it can’t be ${label(to)}.`
      : NO_SUCH_QUOTE,
  );
}

/**
 * What a person confirmed when they were shown a draft to send: everything that goes out with it.
 * The confirm is held to it, so a draft edited after the card was shown isn't sent unseen.
 */
export const quoteFingerprint = (q: QuoteDetail) =>
  JSON.stringify([q.name, q.buyerId, q.expiresAt, q.notes, q.lines]);

/** What sending a draft would do, or why not. */
export async function planSendQuote(
  ports: QuotePorts,
  scope: QuoteScope,
  input: { quoteId: string },
  now: number,
): Promise<QuoteMovePlan | Refused> {
  const quote = await ports.quotes.get(scope, input.quoteId);
  if (!quote) return refuse(NO_SUCH_QUOTE);
  if (quote.status === 'sent') return { ok: true, quote, repeat: true };
  if (quote.status !== 'draft')
    return refuse(`${quote.name} is ${label(quote.status)}: only a draft can be sent.`);
  const problem = (await draftProblem(ports, scope, quote)) ?? quoteSendProblem(quote, now);
  return problem ? refuse(problem) : { ok: true, quote, repeat: false };
}

export async function sendQuote(
  ports: QuotePorts,
  scope: QuoteScope,
  input: {
    quoteId: string /** `quoteFingerprint` of what the person confirmed, when there was a preview. */;
    heldTo?: string | undefined;
  },
  now: number,
): Promise<QuoteChange<{ quote: QuoteDetail }>> {
  const plan = await planSendQuote(ports, scope, input, now);
  if (!plan.ok) return plan;
  if (plan.repeat) return { ok: true, changed: false, quote: plan.quote, audit: null };
  if (input.heldTo !== undefined && input.heldTo !== quoteFingerprint(plan.quote))
    return refuse(`${plan.quote.name} has changed since it was shown to you: look at it again.`);
  const moved = await move(ports, scope, plan.quote, 'draft', 'sent', now);
  if ('error' in moved) return moved;
  return {
    ok: true,
    changed: true,
    quote: moved,
    audit: {
      action: 'quote.sent',
      target: moved.id,
      detail: {
        company: moved.companyId,
        name: moved.name,
        version: moved.version,
        expiresAt: moved.expiresAt,
      },
    },
  };
}

/** What accepting a quote would do, or why not. A sent quote past its expiry has lapsed. */
export async function planAcceptQuote(
  ports: QuotePorts,
  scope: QuoteScope,
  input: { quoteId: string },
  now: number,
): Promise<QuoteMovePlan | Refused> {
  const quote = await ports.quotes.get(scope, input.quoteId);
  if (!quote) return refuse(NO_SUCH_QUOTE);
  if (quote.status === 'accepted') return { ok: true, quote, repeat: true };
  if (quote.status !== 'sent')
    return refuse(`${quote.name} is ${label(quote.status)}: only a sent quote can be accepted.`);
  if (quoteState(quote, now) === 'expired') return refuse(`${quote.name} has expired.`);
  // As at send: the company may have been suspended, or a product removed, since.
  const problem = await draftProblem(ports, scope, quote);
  return problem ? refuse(problem) : { ok: true, quote, repeat: false };
}

export async function acceptQuote(
  ports: QuotePorts,
  scope: QuoteScope,
  input: { quoteId: string; note?: string | undefined },
  now: number,
): Promise<QuoteChange<{ quote: QuoteDetail }>> {
  // A sent quote that has lapsed is made official, so nothing reads it as still open.
  const held = await ports.quotes.get(scope, input.quoteId);
  if (held?.status === 'sent' && quoteState(held, now) === 'expired') {
    await ports.quotes.transition(scope, held.id, 'sent', 'expired', now);
    return refuse(`${held.name} has expired.`);
  }
  const plan = await planAcceptQuote(ports, scope, input, now);
  if (!plan.ok) return plan;
  if (plan.repeat) return { ok: true, changed: false, quote: plan.quote, audit: null };
  const moved = await move(ports, scope, plan.quote, 'sent', 'accepted', now);
  if ('error' in moved) return moved;
  return {
    ok: true,
    changed: true,
    quote: moved,
    audit: {
      action: 'quote.accepted',
      target: moved.id,
      detail: {
        company: moved.companyId,
        name: moved.name,
        version: moved.version,
        expiresAt: moved.expiresAt,
        ...(input.note ? { note: input.note } : {}),
      },
    },
  };
}

/** What declining a quote would do, or why not: a sent quote is declined, a draft withdrawn. */
export async function planDeclineQuote(
  ports: Pick<QuotePorts, 'quotes'>,
  scope: QuoteScope,
  input: { quoteId: string },
): Promise<(QuoteMovePlan & { from: 'draft' | 'sent' }) | Refused> {
  const quote = await ports.quotes.get(scope, input.quoteId);
  if (!quote) return refuse(NO_SUCH_QUOTE);
  if (quote.status === 'declined') return { ok: true, quote, repeat: true, from: 'sent' };
  if (quote.status !== 'sent' && quote.status !== 'draft')
    return refuse(`${quote.name} is ${label(quote.status)}: it can’t be declined.`);
  return { ok: true, quote, repeat: false, from: quote.status };
}

export async function declineQuote(
  ports: Pick<QuotePorts, 'quotes'>,
  scope: QuoteScope,
  input: { quoteId: string; reason?: string | undefined },
  now: number,
): Promise<QuoteChange<{ quote: QuoteDetail }>> {
  const plan = await planDeclineQuote(ports, scope, input);
  if (!plan.ok) return plan;
  if (plan.repeat) return { ok: true, changed: false, quote: plan.quote, audit: null };
  const moved = await move(ports, scope, plan.quote, plan.from, 'declined', now);
  if ('error' in moved) return moved;
  return {
    ok: true,
    changed: true,
    quote: moved,
    audit: {
      action: 'quote.declined',
      target: moved.id,
      detail: {
        company: moved.companyId,
        name: moved.name,
        version: moved.version,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    },
  };
}

/** What ending a quote now would do, or why not: a sent or accepted quote ends. */
export async function planExpireQuote(
  ports: Pick<QuotePorts, 'quotes'>,
  scope: QuoteScope,
  input: { quoteId: string },
): Promise<(QuoteMovePlan & { from: 'sent' | 'accepted' }) | Refused> {
  const quote = await ports.quotes.get(scope, input.quoteId);
  if (!quote) return refuse(NO_SUCH_QUOTE);
  if (quote.status === 'expired') return { ok: true, quote, repeat: true, from: 'sent' };
  if (quote.status !== 'sent' && quote.status !== 'accepted')
    return refuse(`${quote.name} is ${label(quote.status)}: only a sent or accepted quote ends.`);
  return { ok: true, quote, repeat: false, from: quote.status };
}

export async function expireQuote(
  ports: Pick<QuotePorts, 'quotes'>,
  scope: QuoteScope,
  input: { quoteId: string },
  now: number,
): Promise<QuoteChange<{ quote: QuoteDetail }>> {
  const plan = await planExpireQuote(ports, scope, input);
  if (!plan.ok) return plan;
  if (plan.repeat) return { ok: true, changed: false, quote: plan.quote, audit: null };
  const moved = await move(ports, scope, plan.quote, plan.from, 'expired', now);
  if ('error' in moved) return moved;
  return {
    ok: true,
    changed: true,
    quote: moved,
    audit: {
      action: 'quote.expired',
      target: moved.id,
      detail: {
        company: moved.companyId,
        name: moved.name,
        version: moved.version,
        was: plan.from,
      },
    },
  };
}

// ── Revising ───────────────────────────────────────────────────────────────

export type QuoteRevisePlan = {
  ok: true;
  quote: QuoteDetail;
  /** The version a repeat finds already made, when this one was revised before. */
  existing: QuoteDetail | null;
};

/** What revising a quote would do, or why not. */
export async function planReviseQuote(
  ports: Pick<QuotePorts, 'quotes'>,
  scope: QuoteScope,
  input: { quoteId: string },
  now: number,
): Promise<QuoteRevisePlan | Refused> {
  const quote = await ports.quotes.get(scope, input.quoteId);
  if (!quote) return refuse(NO_SUCH_QUOTE);
  if (quote.status === 'superseded') {
    // A repeat of a revision that was made: its successor is the answer.
    const next = (await ports.quotes.versions(scope, quote.rootId)).find(
      (v) => v.version === quote.version + 1,
    );
    const existing = next && (await ports.quotes.get(scope, next.id));
    return existing
      ? { ok: true, quote, existing }
      : refuse(`${quote.name} is superseded and has no later version to open.`);
  }
  // An accepted quote past its expiry has lapsed: it reads as expired, so it can be revised.
  const lapsed = quote.status === 'accepted' && quoteState(quote, now) === 'expired';
  if (!quoteRevisable(quote.status) && !lapsed)
    return refuse(
      `${quote.name} is ${label(quote.status)}: ${
        quote.status === 'accepted'
          ? 'an accepted quote is a deal; end it first to start a new one'
          : 'only a sent, declined or expired quote can be revised'
      }.`,
    );
  return { ok: true, quote, existing: null };
}

export async function reviseQuote(
  ports: Pick<QuotePorts, 'quotes'>,
  scope: QuoteScope,
  input: { quoteId: string },
  newId: () => string,
  now: number,
  createdBy: string | null,
): Promise<QuoteChange<{ quote: QuoteDetail; previous: string }>> {
  const plan = await planReviseQuote(ports, scope, input, now);
  if (!plan.ok) return plan;
  if (plan.existing)
    return {
      ok: true,
      changed: false,
      quote: plan.existing,
      previous: plan.quote.id,
      audit: null,
    };
  const { lines, ...old } = plan.quote;
  if (old.status === 'accepted') {
    // The lapse is made official first, as accepting a lapsed sent quote does; a move that got
    // there first (an end, another revision) is read again by the revise below.
    if (await ports.quotes.transition(scope, old.id, 'accepted', 'expired', now))
      old.status = 'expired';
    else {
      const fresh = await ports.quotes.get(scope, old.id);
      if (fresh) old.status = fresh.status;
    }
  }
  const next: Quote = {
    ...old,
    id: newId(),
    version: old.version + 1,
    status: 'draft',
    // Its expiry stays while it is still ahead; a lapsed one is set again before it is sent.
    expiresAt: old.expiresAt !== null && old.expiresAt > now ? old.expiresAt : null,
    convertedTo: null,
    convertedId: null,
    convertedAt: null,
    sentAt: null,
    decidedAt: null,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  const res = await ports.quotes.revise(scope, old.id, old.status, next, lines, now);
  if (!res.ok) {
    // Another revision, or a move, got there first.
    const again = await planReviseQuote(ports, scope, input, now);
    if (again.ok && again.existing)
      return {
        ok: true,
        changed: false,
        quote: again.existing,
        previous: old.id,
        audit: null,
      };
    return refuse(`${old.name} changed meanwhile: look again.`);
  }
  return {
    ok: true,
    changed: true,
    quote: { ...next, lines },
    previous: old.id,
    audit: {
      action: 'quote.revised',
      target: next.id,
      detail: {
        company: next.companyId,
        name: next.name,
        from: old.id,
        version: next.version,
      },
    },
  };
}

// ── Converting ─────────────────────────────────────────────────────────────

/**
 * The engine's order start a quote makes when it goes straight to an order: once per key, with an
 * error text instead of a throw, so a refusal reads the way the others do.
 */
export type QuoteOrderDeps = {
  start(req: {
    key: string;
    flowId: string;
    /** The key was claimed before and the start is being finished: its order keeps its own flow. */
    resumed?: boolean;
    input: OrderInputDraft;
  }): Promise<{ ok: true; orderId: string; replayed: boolean } | { ok: false; error: string }>;
};

export type QuoteConvertInput = {
  quoteId: string;
  to?: QuoteConversionTarget | undefined;
  poNumber?: string | undefined;
  flowId?: string | undefined;
};

export type QuoteConvertPlan = {
  ok: true;
  quote: QuoteDetail;
  to: QuoteConversionTarget;
  /** Converted before: converting again makes nothing new, unless it is `resume`. */
  repeat: boolean;
  /** Claimed but never finished (an order not started, a PO draft not made): this call finishes it. */
  resume: boolean;
  poNumber: string;
  flowId: string;
};

/**
 * Whether what a quote was converted to is complete: its order is recorded, or its PO draft made.
 * A claim that stopped halfway (the order never started, the draft never made) isn't, so
 * converting again finishes it.
 */
export async function quoteConversionSettled(
  ports: Pick<QuoteConvertPorts, 'purchaseOrders'>,
  scope: QuoteScope,
  quote: Pick<Quote, 'id' | 'convertedTo' | 'convertedId'>,
): Promise<boolean> {
  if (!quote.convertedTo || !quote.convertedId) return false;
  return quote.convertedTo === 'order'
    ? !quoteOrderUnstarted(quote)
    : !!(await ports.purchaseOrders.get(scope, quotePoId(quote.id)));
}

/** What converting a quote would do, or why not. */
export async function planConvertQuote(
  ports: Pick<QuoteConvertPorts, 'quotes' | 'purchaseOrders'>,
  scope: QuoteScope,
  input: QuoteConvertInput,
  now: number,
): Promise<QuoteConvertPlan | Refused> {
  const quote = await ports.quotes.get(scope, input.quoteId);
  if (!quote) return refuse(NO_SUCH_QUOTE);
  const problem = quoteConvertProblem(quote, now);
  if (problem) return refuse(problem);
  const poNumber = input.poNumber ?? quotePoNumber(quote);
  const flowId = input.flowId ?? DEFAULT_TEMPLATE.b2b;
  if (quote.convertedTo && quote.convertedId) {
    const resume = !(await quoteConversionSettled(ports, scope, quote));
    return { ok: true, quote, to: quote.convertedTo, repeat: true, resume, poNumber, flowId };
  }
  // D7: a company that uses POs (has any) gets a PO draft; one that doesn't, an order.
  const to =
    input.to ??
    quoteConversion(
      (await ports.purchaseOrders.list(scope, { companyId: quote.companyId }, { limit: 1 })).total >
        0,
    );
  return { ok: true, quote, to, repeat: false, resume: false, poNumber, flowId };
}

export async function convertQuote(
  ports: QuoteConvertPorts,
  scope: QuoteScope,
  input: QuoteConvertInput,
  deps: QuoteOrderDeps,
  now: number,
): Promise<QuoteChange<{ quote: QuoteDetail; to: QuoteConversionTarget; resultId: string }>> {
  const plan = await planConvertQuote(ports, scope, input, now);
  if (!plan.ok) return plan;
  const { quote, to } = plan;
  // What the quote names while the conversion is under way: the PO draft's id, or the order's key
  // (the order's id isn't known until it starts). It is claimed first, with a guard on the quote
  // still being accepted, so nothing is made for a quote that was ended or converted meanwhile.
  const claim = to === 'po' ? quotePoId(quote.id) : quoteOrderKey(quote.id);
  // An order already recorded is the answer; a PO draft is looked at again (it may be cancelled).
  if (plan.repeat && !plan.resume && to === 'order' && quote.convertedId)
    return { ok: true, changed: false, quote, to, resultId: quote.convertedId, audit: null };

  let fresh = false;
  if (!plan.repeat) {
    // What can be known to refuse is checked before the claim, so a refusal leaves nothing behind.
    if (to === 'po') {
      const problem = await poDraftRefusal(ports, scope, quote, plan.poNumber);
      if (problem) return refuse(problem);
    }
    const claimed = await ports.quotes.markConverted(scope, quote.id, to, claim, now);
    if (claimed === false) {
      // Ended, converted by a racing call, or gone since it was read.
      const latest = await ports.quotes.get(scope, quote.id);
      // The same conversion, done (even to the order's id) by a call that got there first: a repeat.
      if (latest?.convertedTo === to && latest.convertedId)
        return {
          ok: true,
          changed: false,
          quote: latest,
          to,
          resultId: latest.convertedId,
          audit: null,
        };
      if (latest?.convertedId)
        return refuse(
          `${quote.name} was converted meanwhile, to ${latest.convertedTo === 'po' ? 'a purchase order draft' : 'an order'} ${latest.convertedId}.`,
        );
      return refuse(
        `${quote.name} is ${latest ? label(latest.status) : 'gone'}: it can’t be converted.`,
      );
    }
    // 'same': a racing call made this very claim and carries on with it; only the fresh one reports.
    fresh = claimed === 'new';
  }

  let resultId: string;
  if (to === 'po') {
    const made = await ensurePoDraft(ports, scope, quote, plan.poNumber, now);
    if (!made.ok) return made;
    resultId = made.id;
  } else {
    // The order is started once per quote (its key), whoever asks and however often.
    const started = await deps.start({
      key: claim,
      flowId: plan.flowId,
      // A resumed start names no flow of its own: the order the key already started keeps its.
      resumed: plan.resume,
      input: {
        model: 'b2b',
        channel: 'manual',
        externalId: quote.id,
        title: `Quote ${quote.name}`,
        customerId: quote.companyId,
        currency: BASE_CURRENCY,
        // No unit price: the order is priced by the chain, which reads this quote first.
        lines: quote.lines.map((l) => ({
          sku: l.sku,
          qty: l.qty,
          ...(l.name ? { name: l.name } : {}),
        })),
        meta: {
          quoteId: quote.id,
          ...(quote.buyerId ? { buyerId: quote.buyerId } : {}),
        },
      },
    });
    // The quote stays claimed: asking again starts the same order (its key) and records it.
    if (!started.ok) return refuse(`${quote.name}’s order didn’t start: ${started.error}`);
    resultId = started.orderId;
    await ports.quotes.settleConversion(scope, quote.id, claim, resultId, now);
  }
  const done = {
    ...quote,
    convertedTo: to,
    convertedId: resultId,
    convertedAt: now,
    updatedAt: now,
  };
  // Only the call that made the claim, or finished one that stalled, reports the change.
  if (!fresh && !plan.resume)
    return { ok: true, changed: false, quote: done, to, resultId, audit: null };
  return {
    ok: true,
    changed: true,
    quote: done,
    to,
    resultId,
    audit: {
      action: 'quote.converted',
      target: quote.id,
      detail: { company: quote.companyId, name: quote.name, to, result: resultId },
    },
  };
}

/** Why the PO draft a quote becomes can't be made, or null: its number is taken or a rule fails. */
async function poDraftRefusal(
  ports: QuoteConvertPorts,
  scope: QuoteScope,
  quote: QuoteDetail,
  poNumber: string,
): Promise<string | null> {
  // The draft of a conversion already begun is its own: it isn't a clash.
  if (await ports.purchaseOrders.get(scope, quotePoId(quote.id))) return null;
  const [access, held] = await Promise.all([
    ports.companies.access(scope, quote.companyId, quote.buyerId ?? undefined),
    ports.purchaseOrders.byNumber(scope, quote.companyId, poNumber),
  ]);
  if (held)
    return `Another purchase order of this company has the number ${poNumber}: give another with poNumber.`;
  return poDraftProblem(
    { companyId: quote.companyId, buyerId: quote.buyerId, lines: quote.lines },
    { company: access.company, buyer: access.buyer, duplicate: false },
  );
}

/**
 * The PO draft a quote becomes, once: its id comes from the quote (`quotePoId`), so a repeat, or
 * a conversion that stopped before the draft was made, finds or makes the same one. The lines
 * carry the quoted prices as the buyer's expected ones; the PO flow prices the order, and the
 * quote prices it. A draft that was cancelled is refused, not handed back as the result.
 */
async function ensurePoDraft(
  ports: QuoteConvertPorts,
  scope: QuoteScope,
  quote: QuoteDetail,
  poNumber: string,
  now: number,
): Promise<{ ok: true; id: string } | Refused> {
  const id = quotePoId(quote.id);
  const cancelled = refuse(
    `The purchase order draft ${id} made from ${quote.name} was cancelled: end the quote and revise it for a new one.`,
  );
  const existing = await ports.purchaseOrders.get(scope, id);
  if (existing) return existing.status === 'cancelled' ? cancelled : { ok: true, id };
  const problem = await poDraftRefusal(ports, scope, quote, poNumber);
  if (problem) return refuse(problem);
  const po: PurchaseOrder = {
    id,
    companyId: quote.companyId,
    buyerId: quote.buyerId,
    poNumber,
    status: 'draft',
    currency: BASE_CURRENCY,
    shipTo: null,
    notes: quote.notes,
    quoteId: quote.id,
    orderId: null,
    source: 'api',
    createdAt: now,
    updatedAt: now,
  };
  const made = await ports.purchaseOrders.create(
    po,
    quote.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPrice: l.unitPrice })),
  );
  // A conversion racing this one made the draft first (`id`): it is the same draft. A number
  // taken since the read above is the company's.
  if (!made.ok && made.conflict === 'number')
    return refuse(
      `Another purchase order of this company has the number ${poNumber}: give another with poNumber.`,
    );
  // A cancel that landed on the draft as it was made leaves no draft to hand back.
  const after = await ports.purchaseOrders.get(scope, id);
  return after?.status === 'cancelled' ? cancelled : { ok: true, id };
}
