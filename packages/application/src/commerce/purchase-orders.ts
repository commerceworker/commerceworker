/**
 * Purchase orders as staff, agents and orders meet them (`b2b/purchase-orders.ts` in core). A buyer's
 * PO is drafted and edited as a draft (`createPoDraft`, `updatePoDraft`), then submitted: that
 * starts an order on the B2B PO flow (`submitPo`), once per PO however often it is asked. From
 * then on the order's progress is the PO's (`syncPoFromOrder`, which the OrderAgent calls), and a
 * PO is cancelled with its order (`cancelPo`). A PO that arrives from outside (EDI, email) is
 * recorded beside its order (`recordInboundPo`). The REST routes, the MCP tools and the admin
 * pages all run these. Each change is a `plan…` that reads and judges (a card shows its refusal)
 * and a write that plans again, so a stale preview can't push past a rule. Time and new ids come
 * in as arguments, the engine's own order calls as `deps`; the caller records the audit draft.
 */
import {
  type CreatePoDraftInput,
  createPoDraftInput,
  decodePoCursor,
  encodePoCursor,
  invoicePoNumber,
  normalizePoNumber,
  type OrderInputDraft,
  PO_FLOW_ID,
  PO_LIFECYCLE,
  PO_PAGE,
  PO_STATUS_LABELS,
  type PoInboundSource,
  type PoOrderProgress,
  type PoShipTo,
  type PoSource,
  type PoStatus,
  type PurchaseOrder,
  type PurchaseOrderDetail,
  type PurchaseOrderLine,
  type PurchaseOrderRow,
  type PurchaseOrderStart,
  poDraftProblem,
  poEditable,
  poIdForOrder,
  poOrderKey,
  poOrderMeta,
  poPath,
  poTransitionFor,
  quoteLive,
  type UpdatePoDraftInput,
  updatePoDraftInput,
} from '@commerceworker/core';
import type {
  CompanyDirectory,
  PurchaseOrderPatch,
  PurchaseOrderScope,
  PurchaseOrderStore,
  QuoteStore,
} from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

export type PurchaseOrderPorts = {
  readonly purchaseOrders: PurchaseOrderStore;
  readonly companies: CompanyDirectory;
  /** Where a PO's quote is read, when it names one: submitting checks the quote is still in force. */
  readonly quotes?: Pick<QuoteStore, 'get'>;
};

const ALL: PurchaseOrderScope = { all: true };
const DAY = 86_400_000;

const refuse = (error: string) => ({ ok: false as const, error });
type Refused = ReturnType<typeof refuse>;

/** What a change did; `audit` is null when it changed nothing (a repeat). */
export type PoChange<T = Record<string, never>> =
  | ({ ok: true; changed: boolean; audit: AuditDraft | null } & T)
  | Refused;

const firstIssue = (e: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}) => {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || 'input'}: ${i.message}` : 'Not a valid request.';
};

const NO_SUCH_PO = 'No such purchase order.';
const href = (id: string) => `/purchase-orders/${id}`;

const linesOf = (lines: CreatePoDraftInput['lines']): PurchaseOrderLine[] =>
  lines.map((l) => ({
    sku: l.sku,
    name: l.name ?? null,
    qty: l.qty,
    unitPrice: l.unitPrice ?? null,
  }));

// ── Reads ──────────────────────────────────────────────────────────────────

/** A PO as the tools show it, with its lines when it has them loaded. */
export function poView(po: PurchaseOrderRow | PurchaseOrderDetail) {
  return { ...po, href: href(po.id) };
}

function cursorOf(raw: string | undefined) {
  if (raw === undefined) return { ok: true as const, after: undefined };
  const after = decodePoCursor(raw);
  return after ? { ok: true as const, after } : refuse('That cursor isn’t one a page returned.');
}

export type PoListQuery = {
  companyId?: string;
  status?: PoStatus;
  buyerId?: string;
  search?: string;
  /** Days (UTC), `YYYY-MM-DD`: created on or after `from`, on or before `to`. */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
};

export async function listPurchaseOrders(
  ports: Pick<PurchaseOrderPorts, 'purchaseOrders'>,
  scope: PurchaseOrderScope,
  q: PoListQuery,
) {
  const at = cursorOf(q.cursor);
  if (!at.ok) return at;
  const from = q.from === undefined ? undefined : Date.parse(q.from);
  const to = q.to === undefined ? undefined : Date.parse(q.to) + DAY - 1;
  if ((from !== undefined && Number.isNaN(from)) || (to !== undefined && Number.isNaN(to)))
    return refuse('from and to are days, like 2026-11-30.');
  const page = await ports.purchaseOrders.list(
    scope,
    {
      companyId: q.companyId,
      status: q.status,
      buyerId: q.buyerId,
      search: q.search,
      from,
      to,
    },
    { after: at.after, limit: q.limit ?? PO_PAGE.default },
  );
  return {
    ok: true as const,
    purchaseOrders: page.rows.map(poView),
    total: page.total,
    cursor: page.next ? encodePoCursor(page.next) : null,
  };
}

export async function getPurchaseOrder(
  ports: Pick<PurchaseOrderPorts, 'purchaseOrders'>,
  scope: PurchaseOrderScope,
  poId: string,
) {
  const po = await ports.purchaseOrders.get(scope, poId);
  return po ? { ok: true as const, purchaseOrder: poView(po) } : refuse(NO_SUCH_PO);
}

// ── Drafting ───────────────────────────────────────────────────────────────

/**
 * Why a draft as written can't be kept, or null: the lines, the number, the company and the buyer
 * (`poDraftProblem`), read from the ports.
 */
async function draftProblem(
  ports: PurchaseOrderPorts,
  scope: PurchaseOrderScope,
  draft: Pick<PurchaseOrder, 'companyId' | 'buyerId' | 'poNumber'> & { lines: readonly unknown[] },
  self?: string,
) {
  const [access, held] = await Promise.all([
    ports.companies.access(scope, draft.companyId, draft.buyerId ?? undefined),
    ports.purchaseOrders.byNumber(scope, draft.companyId, draft.poNumber),
  ]);
  return poDraftProblem(draft, {
    company: access.company,
    buyer: access.buyer,
    duplicate: !!held && held.id !== self,
  });
}

export type PoDraftPlan = { ok: true; po: PurchaseOrderDetail; added: boolean; changes: string[] };

/** What creating a draft would do, or why not. */
export async function planPoDraft(
  ports: PurchaseOrderPorts,
  scope: PurchaseOrderScope,
  raw: unknown,
  newId: () => string,
  now: number,
  source: Extract<PoSource, 'app' | 'api'> = 'api',
): Promise<PoDraftPlan | Refused> {
  const parsed = createPoDraftInput.safeParse(raw);
  if (!parsed.success) return refuse(firstIssue(parsed.error));
  const i = parsed.data;
  const lines = linesOf(i.lines);
  const po: PurchaseOrderDetail = {
    id: newId(),
    companyId: i.companyId,
    buyerId: i.buyerId ?? null,
    poNumber: normalizePoNumber(i.poNumber),
    status: 'draft',
    currency: (i.currency ?? 'USD').toUpperCase(),
    shipTo: i.shipTo ?? null,
    notes: i.notes ?? null,
    quoteId: i.quoteId ?? null,
    orderId: null,
    source,
    createdAt: now,
    updatedAt: now,
    lines,
  };
  const problem = await draftProblem(ports, scope, po);
  return problem ? refuse(problem) : { ok: true, po, added: true, changes: [] };
}

export async function createPoDraft(
  ports: PurchaseOrderPorts,
  scope: PurchaseOrderScope,
  raw: unknown,
  newId: () => string,
  now: number,
  source: Extract<PoSource, 'app' | 'api'> = 'api',
): Promise<PoChange<{ purchaseOrder: PurchaseOrderDetail }>> {
  const plan = await planPoDraft(ports, scope, raw, newId, now, source);
  if (!plan.ok) return plan;
  const { lines, ...po } = plan.po;
  const made = await ports.purchaseOrders.create(po, lines);
  if (!made.ok)
    return refuse(
      made.conflict === 'number'
        ? 'Another purchase order of this company has that number.'
        : 'That purchase order already exists.',
    );
  return {
    ok: true,
    changed: true,
    purchaseOrder: plan.po,
    audit: {
      action: 'purchase_order.created',
      target: po.id,
      detail: { company: po.companyId, poNumber: po.poNumber, lines: lines.length, source },
    },
  };
}

/** What changing a draft would do, or why not. */
export async function planPoUpdate(
  ports: PurchaseOrderPorts,
  scope: PurchaseOrderScope,
  raw: unknown,
): Promise<
  | {
      ok: true;
      before: PurchaseOrderDetail;
      after: PurchaseOrderDetail;
      patch: PurchaseOrderPatch;
      changes: string[];
    }
  | Refused
> {
  const parsed = updatePoDraftInput.safeParse(raw);
  if (!parsed.success) return refuse(firstIssue(parsed.error));
  const i: UpdatePoDraftInput = parsed.data;
  const before = await ports.purchaseOrders.get(scope, i.poId);
  if (!before) return refuse(NO_SUCH_PO);
  if (!poEditable(before.status))
    return refuse(
      `${before.poNumber} is ${PO_STATUS_LABELS[before.status].toLowerCase()}: only a draft can be changed.`,
    );
  const patch: {
    -readonly [K in keyof PurchaseOrderPatch]: PurchaseOrderPatch[K];
  } = {};
  const changes: string[] = [];
  const note = (field: string, differs: boolean) => differs && changes.push(field);
  const after: PurchaseOrderDetail = { ...before };
  if (i.poNumber !== undefined) {
    after.poNumber = normalizePoNumber(i.poNumber);
    patch.poNumber = after.poNumber;
    note('poNumber', after.poNumber !== before.poNumber);
  }
  if (i.buyerId !== undefined) {
    after.buyerId = i.buyerId;
    patch.buyerId = i.buyerId;
    note('buyer', i.buyerId !== before.buyerId);
  }
  if (i.currency !== undefined) {
    after.currency = i.currency.toUpperCase();
    patch.currency = after.currency;
    note('currency', after.currency !== before.currency);
  }
  if (i.shipTo !== undefined) {
    after.shipTo = i.shipTo as PoShipTo | null;
    patch.shipTo = after.shipTo;
    note('shipTo', JSON.stringify(after.shipTo) !== JSON.stringify(before.shipTo));
  }
  if (i.notes !== undefined) {
    after.notes = i.notes;
    patch.notes = i.notes;
    note('notes', i.notes !== before.notes);
  }
  if (i.quoteId !== undefined) {
    after.quoteId = i.quoteId;
    patch.quoteId = i.quoteId;
    note('quote', i.quoteId !== before.quoteId);
  }
  if (i.lines !== undefined) {
    after.lines = linesOf(i.lines);
    patch.lines = after.lines;
    note('lines', JSON.stringify(after.lines) !== JSON.stringify(before.lines));
  }
  const problem = await draftProblem(ports, scope, after, before.id);
  if (problem) return refuse(problem);
  return { ok: true, before, after, patch, changes };
}

export async function updatePoDraft(
  ports: PurchaseOrderPorts,
  scope: PurchaseOrderScope,
  raw: unknown,
  now: number,
): Promise<PoChange<{ purchaseOrder: PurchaseOrderDetail }>> {
  const plan = await planPoUpdate(ports, scope, raw);
  if (!plan.ok) return plan;
  const { before, after, patch, changes } = plan;
  if (!changes.length) return { ok: true, changed: false, purchaseOrder: before, audit: null };
  const res = await ports.purchaseOrders.updateDraft(scope, before.id, patch, now);
  if (!res.ok)
    return refuse(
      res.conflict === 'number'
        ? 'Another purchase order of this company has that number.'
        : `${before.poNumber} was submitted or cancelled meanwhile: only a draft can be changed.`,
    );
  return {
    ok: true,
    changed: true,
    purchaseOrder: { ...after, updatedAt: now },
    audit: {
      action: 'purchase_order.updated',
      target: before.id,
      detail: { company: before.companyId, poNumber: after.poNumber, changed: changes },
    },
  };
}

// ── Submitting and cancelling ──────────────────────────────────────────────

/**
 * The engine's order calls a PO makes: start its order once per key, and cancel one. Each answers
 * with an error text instead of throwing, so a refusal reads the way the others do.
 */
export type PoOrderDeps = {
  start(req: {
    key: string;
    flowId: string;
    input: OrderInputDraft;
    /** `{ link: poId }`, for the engine to tie the order to this PO before the flow runs. */
    purchaseOrder: { link: string };
  }): Promise<{ ok: true; orderId: string; replayed: boolean } | { ok: false; error: string }>;
  /** `finished`: the order ended some other way and can't be cancelled; its PO follows it. */
  cancel(
    orderId: string,
    reason: string,
  ): Promise<{ ok: true; outcome: 'cancelled' | 'finished' } | { ok: false; error: string }>;
};

const ORDER_CHANNEL: Record<PoSource, 'manual' | 'api' | 'edi' | 'email'> = {
  app: 'manual',
  api: 'api',
  edi: 'edi',
  email: 'email',
  punchout: 'edi',
};

export type PoSubmitPlan = {
  ok: true;
  po: PurchaseOrderDetail;
  flowId: string;
  /** Already submitted (it has an order, or is on its way to one): submitting again starts nothing new. */
  repeat: boolean;
};

/**
 * Why a draft made from a quote can't go to its order: the quote isn't in force any more (ended,
 * expired), so the order wouldn't be priced at it and the buyer would pay something else than what
 * the draft's lines say. The PO's `quoteId` can be cleared with `update_po_draft` to submit it
 * anyway, as an ordinary PO. A quote that can't be found is the caller's free-text reference.
 */
async function quoteProblem(
  ports: PurchaseOrderPorts,
  scope: PurchaseOrderScope,
  po: Pick<PurchaseOrder, 'poNumber' | 'quoteId'>,
  now: number,
): Promise<string | null> {
  if (!po.quoteId || !ports.quotes) return null;
  const q = await ports.quotes.get(scope, po.quoteId);
  if (!q || quoteLive(q, now)) return null;
  return `${po.poNumber} was made from quote ${q.name}, which is no longer in force (${q.status}${q.status === 'accepted' ? ', expired' : ''}): its order wouldn’t be priced at the quote. Clear the quote from the draft to submit it as an ordinary purchase order.`;
}

/** What submitting a PO would do, or why not. */
export async function planSubmitPo(
  ports: PurchaseOrderPorts,
  scope: PurchaseOrderScope,
  input: { poId: string; flowId?: string | undefined },
  now: number = Date.now(),
): Promise<PoSubmitPlan | Refused> {
  const po = await ports.purchaseOrders.get(scope, input.poId);
  if (!po) return refuse(NO_SUCH_PO);
  const flowId = input.flowId ?? PO_FLOW_ID;
  if (po.status === 'draft') {
    const problem =
      (await draftProblem(ports, scope, po, po.id)) ?? (await quoteProblem(ports, scope, po, now));
    return problem ? refuse(problem) : { ok: true, po, flowId, repeat: false };
  }
  // Submitted and not yet started, or started: both are a repeat. One that ended, or never was an
  // app's to submit, is not.
  if (po.status === 'cancelled' || po.status === 'rejected')
    return refuse(`${po.poNumber} is ${po.status}: it can’t be submitted.`);
  return { ok: true, po, flowId, repeat: true };
}

export async function submitPo(
  ports: PurchaseOrderPorts,
  scope: PurchaseOrderScope,
  input: { poId: string; flowId?: string | undefined },
  deps: PoOrderDeps,
  now: number,
): Promise<PoChange<{ purchaseOrder: PurchaseOrderDetail; orderId: string }>> {
  const plan = await planSubmitPo(ports, scope, input, now);
  if (!plan.ok) return plan;
  let po = plan.po;
  let changed = false;
  if (po.status === 'draft') {
    if (!(await ports.purchaseOrders.transition(scope, po.id, 'draft', 'submitted', now))) {
      // A cancel (or another submit) got there first. Another submit is a repeat to carry on with.
      const now2 = await ports.purchaseOrders.get(scope, po.id);
      if (!now2 || now2.status === 'draft' || now2.status === 'cancelled')
        return refuse(`${po.poNumber} was cancelled meanwhile.`);
      po = now2;
    } else {
      po = { ...po, status: 'submitted', updatedAt: now };
      changed = true;
    }
  }
  const started = await deps.start({
    key: poOrderKey(po.id),
    flowId: plan.flowId,
    purchaseOrder: { link: po.id },
    input: {
      model: 'b2b',
      channel: ORDER_CHANNEL[po.source],
      externalId: po.poNumber,
      title: `PO ${po.poNumber}`,
      customerId: po.companyId,
      currency: po.currency,
      lines: po.lines.map((l) => ({
        sku: l.sku,
        qty: l.qty,
        ...(l.name ? { name: l.name } : {}),
      })),
      meta: poOrderMeta(po),
    },
  });
  // The PO stays submitted with no order: submitting again starts it, or cancel ends it.
  if (!started.ok)
    return refuse(`${po.poNumber} is submitted but its order didn't start: ${started.error}`);
  await ports.purchaseOrders.linkOrder(scope, po.id, started.orderId, now);
  // A cancel that read the PO between the submit and the link found no order to cancel; the order
  // that started after it is cancelled here, so a cancelled PO never has a running one.
  const latest = await ports.purchaseOrders.get(scope, po.id);
  if (latest?.status === 'cancelled') {
    await deps.cancel(started.orderId, `Purchase order ${po.poNumber} was cancelled`);
    return refuse(`${po.poNumber} was cancelled meanwhile.`);
  }
  return {
    ok: true,
    changed: changed || !started.replayed,
    purchaseOrder: { ...po, orderId: started.orderId },
    orderId: started.orderId,
    audit:
      changed || !started.replayed
        ? {
            action: 'purchase_order.submitted',
            target: po.id,
            detail: {
              company: po.companyId,
              poNumber: po.poNumber,
              order: started.orderId,
              flow: plan.flowId,
            },
          }
        : null,
  };
}

export type PoCancelPlan = {
  ok: true;
  po: PurchaseOrderDetail;
  /** The order that is cancelled with it, when it has one that hasn't ended. */
  orderId: string | null;
  noop: boolean;
};

/** What cancelling a PO would do, or why not. */
export async function planCancelPo(
  ports: Pick<PurchaseOrderPorts, 'purchaseOrders'>,
  scope: PurchaseOrderScope,
  input: { poId: string },
): Promise<PoCancelPlan | Refused> {
  const po = await ports.purchaseOrders.get(scope, input.poId);
  if (!po) return refuse(NO_SUCH_PO);
  if (po.status === 'cancelled') return { ok: true, po, orderId: null, noop: true };
  if (!poPath(po.status, 'cancelled').length)
    return refuse(
      `${po.poNumber} is ${PO_STATUS_LABELS[po.status].toLowerCase()}, which is final.`,
    );
  return { ok: true, po, orderId: po.orderId, noop: false };
}

export async function cancelPo(
  ports: Pick<PurchaseOrderPorts, 'purchaseOrders'>,
  scope: PurchaseOrderScope,
  input: { poId: string; reason?: string | undefined },
  deps: Pick<PoOrderDeps, 'cancel'>,
  now: number,
): Promise<PoChange<{ purchaseOrder: PurchaseOrderDetail }>> {
  const plan = await planCancelPo(ports, scope, input);
  if (!plan.ok) return plan;
  if (plan.noop) return { ok: true, changed: false, purchaseOrder: plan.po, audit: null };
  const reason = input.reason ?? `Purchase order ${plan.po.poNumber} was cancelled`;
  // The order first: cancelling it gives back its credit hold, budget spend and stock, and the
  // OrderAgent follows with the PO. A finished order can't be cancelled; its PO says what it is.
  if (plan.orderId) {
    const ended = await deps.cancel(plan.orderId, reason);
    if (!ended.ok) return refuse(`${plan.po.poNumber}’s order didn’t cancel: ${ended.error}`);
    if (ended.outcome === 'finished')
      return refuse(
        `${plan.po.poNumber}’s order has already ended, so the purchase order can’t be cancelled.`,
      );
  }
  for (let attempt = 0; attempt < PO_LIFECYCLE.states.length; attempt++) {
    const po = await ports.purchaseOrders.get(scope, plan.po.id);
    if (!po) return refuse(NO_SUCH_PO);
    if (po.status === 'cancelled') {
      // A submit that started its order after the plan read, and linked it before this cancel
      // landed, left an order the plan didn't know: it is cancelled here, or it would run on
      // for a cancelled PO.
      if (po.orderId && po.orderId !== plan.orderId) await deps.cancel(po.orderId, reason);
      return {
        ok: true,
        changed: true,
        purchaseOrder: po,
        audit: {
          action: 'purchase_order.cancelled',
          target: po.id,
          detail: {
            company: po.companyId,
            poNumber: po.poNumber,
            ...(po.orderId ? { order: po.orderId } : {}),
            reason,
          },
        },
      };
    }
    const [step] = poPath(po.status, 'cancelled');
    if (!step)
      return refuse(
        `${po.poNumber} is ${PO_STATUS_LABELS[po.status].toLowerCase()}, which is final.`,
      );
    // A lost race is re-read: the PO moved (a submit, or the order's progress), and the next
    // look finds where it is now.
    await ports.purchaseOrders.transition(scope, po.id, po.status, step, now);
  }
  return refuse(`${plan.po.poNumber} kept changing: look again.`);
}

// ── Following the order ────────────────────────────────────────────────────

/**
 * Moves the PO an order started to where the order's progress puts it, one lifecycle move at a time
 * (`poTransitionFor`, `poPath`). It names the order, not the PO, and acts only on a PO that order
 * is linked to. It is safe to repeat, from a replayed report or two agents at once: a move another
 * writer made first is read again, and a PO already there or past it is left alone.
 */
export async function syncPoFromOrder(
  ports: Pick<PurchaseOrderPorts, 'purchaseOrders'>,
  orderId: string,
  progress: PoOrderProgress,
  now: number,
): Promise<{ found: boolean; status: PoStatus | null; moved: PoStatus[] }> {
  const moved: PoStatus[] = [];
  let po: PurchaseOrder | undefined = await ports.purchaseOrders.byOrder(orderId);
  if (!po) return { found: false, status: null, moved };
  for (let attempt = 0; attempt < PO_LIFECYCLE.states.length; attempt++) {
    const to = poTransitionFor(progress, po.status);
    const step: PoStatus | undefined = to ? poPath(po.status, to)[0] : undefined;
    if (!step) break;
    if (await ports.purchaseOrders.transition(ALL, po.id, po.status, step, now)) {
      moved.push(step);
      po = { ...po, status: step, updatedAt: now };
    } else {
      // Someone else moved it (a cancel, another report): look again.
      const fresh = await ports.purchaseOrders.byOrder(orderId);
      if (!fresh) break;
      po = fresh;
    }
  }
  return { found: true, status: po.status, moved };
}

// ── Arriving from outside ──────────────────────────────────────────────────

/**
 * Records the PO an inbound order is, in `submitted` and already linked to the order, with the
 * source it arrived by. EDI's lines come from the 850; an email's have yet to be read by the
 * extract node, so it is recorded with none. Safe to repeat (the order's own PO is returned), and
 * never in the way of the order: a company that doesn't exist, or a number the company already
 * has, says why it isn't recorded and the order goes ahead without it.
 */
export async function recordInboundPo(
  ports: PurchaseOrderPorts,
  input: {
    orderId: string;
    companyId: string | undefined;
    poNumber: string;
    source: PoInboundSource;
    currency: string;
    lines: readonly {
      sku: string;
      name?: string | undefined;
      qty: number;
      unitPrice?: number | undefined;
    }[];
    shipTo?: unknown;
    buyerId?: string | undefined;
  },
  now: number,
): Promise<
  { ok: true; purchaseOrder: PurchaseOrder; recorded: boolean; audit: AuditDraft | null } | Refused
> {
  const held = await ports.purchaseOrders.byOrder(input.orderId);
  if (held) return { ok: true, purchaseOrder: held, recorded: false, audit: null };
  if (!input.companyId)
    return refuse('The order has no customer, so it has no company to record a PO for.');
  const company = await ports.companies.company(ALL, input.companyId);
  if (!company)
    return refuse(`${input.companyId} is not a company: no purchase order is recorded.`);
  const poNumber = normalizePoNumber(input.poNumber).slice(0, 64);
  const shipTo = shipToOf(input.shipTo);
  const po: PurchaseOrder = {
    id: poIdForOrder(input.orderId),
    companyId: company.customerId,
    buyerId: input.buyerId ?? null,
    poNumber,
    status: 'submitted',
    currency: input.currency,
    shipTo,
    notes: null,
    quoteId: null,
    orderId: input.orderId,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
  const lines = input.lines.map(
    (l): PurchaseOrderLine => ({
      sku: l.sku,
      name: l.name ?? null,
      qty: l.qty,
      unitPrice: l.unitPrice ?? null,
    }),
  );
  const made = await ports.purchaseOrders.create(po, lines);
  if (!made.ok) {
    // A repeat that raced finds its own record; anything else is a number the company holds.
    const again = await ports.purchaseOrders.byOrder(input.orderId);
    if (again) return { ok: true, purchaseOrder: again, recorded: false, audit: null };
    return refuse(
      `${company.name} already has a purchase order ${poNumber}: this one isn’t recorded.`,
    );
  }
  return {
    ok: true,
    purchaseOrder: po,
    recorded: true,
    audit: {
      action: 'purchase_order.received',
      target: po.id,
      detail: {
        company: po.companyId,
        poNumber,
        source: input.source,
        order: input.orderId,
        lines: lines.length,
      },
    },
  };
}

/** An address an inbound order carried, when it is a whole one; the text form isn't kept. */
function shipToOf(raw: unknown): PoShipTo | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const text = (k: string) => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : undefined);
  const line1 = text('line1');
  const city = text('city');
  const postalCode = text('postalCode');
  const country = text('country');
  if (!line1 || !city || !postalCode || !country) return null;
  return {
    line1,
    city,
    postalCode,
    country,
    ...(text('name') ? { name: text('name') as string } : {}),
    ...(text('line2') ? { line2: text('line2') as string } : {}),
    ...(text('region') ? { region: text('region') as string } : {}),
  };
}

/**
 * Whether a submitted PO can start the order that names it (`link`), judged before the order
 * exists so a PO that can't be this order's leaves nothing behind. It can when it is found, is the
 * order's company's and has no order yet. One that already has an order is `ordered`: the engine
 * answers a replay of the request that started it, and refuses any other.
 */
export async function planPoStart(
  ports: Pick<PurchaseOrderPorts, 'purchaseOrders'>,
  link: string,
  customerId: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string; ordered: boolean }> {
  const po = await ports.purchaseOrders.get(ALL, link);
  if (po && po.companyId === customerId && !po.orderId) return { ok: true };
  return {
    ok: false,
    error: `Purchase order ${link} can't start this order`,
    ordered: !!po?.orderId,
  };
}

/**
 * Ties an order to the PO its start names, and says what the order carries of it
 * (`meta.purchaseOrderId` and the invoice's reference). A `link` ties the order a submitted PO
 * starts, and fails when it can't be this PO's: its progress must never reach another's. A `record`
 * writes the PO an inbound order is (EDI, email), once per order; an order whose PO can't be
 * recorded (no company, a number the company already holds) goes ahead without one and says why in
 * `warning`. Safe to repeat.
 */
export async function tieOrderToPo(
  ports: PurchaseOrderPorts,
  want: PurchaseOrderStart,
  order: {
    orderId: string;
    companyId: string | undefined;
    currency: string;
    lines: Parameters<typeof recordInboundPo>[1]['lines'];
    shipTo?: unknown;
    buyerId?: string | undefined;
  },
  now: number,
): Promise<
  | {
      ok: true;
      tied: { id: string; poNumber: string | null } | undefined;
      audit: AuditDraft | null;
      warning: string | null;
    }
  | Refused
> {
  let audit: AuditDraft | null = null;
  let warning: string | null = null;
  if ('link' in want) {
    if (!(await ports.purchaseOrders.linkOrder(ALL, want.link, order.orderId, now)))
      return refuse(`Purchase order ${want.link} can't be tied to order ${order.orderId}`);
  } else {
    const r = await recordInboundPo(
      ports,
      {
        orderId: order.orderId,
        companyId: order.companyId,
        poNumber: want.record.poNumber,
        source: want.record.source,
        currency: order.currency,
        lines: order.lines,
        shipTo: order.shipTo,
        buyerId: order.buyerId,
      },
      now,
    );
    if (!r.ok) warning = r.error;
    else audit = r.audit;
  }
  const po = await ports.purchaseOrders.byOrder(order.orderId);
  return { ok: true, tied: po && { id: po.id, poNumber: invoicePoNumber(po) }, audit, warning };
}
