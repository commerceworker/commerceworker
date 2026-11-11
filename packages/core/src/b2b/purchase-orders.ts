/**
 * Purchase orders: a company's buyer's own PO, kept as a record that outlives the order it starts.
 * The rules here, with no storage, are the lifecycle, what makes a draft submittable
 * (`poDraftProblem`), how an order's progress moves the PO (`poTransitionFor`, `poPath`), and the
 * inputs the REST routes and MCP tools take. `docs/b2b.md` is the plan; D6 (a buyer's PO and the
 * inbound EDI, email and punchout POs are all records; `commerce.generate_po` stays the supplier
 * document) is the default this is built on.
 *
 * Only a draft is editable (v1 let a submitted PO be changed under the order it had started). A
 * submitted PO starts an order on the B2B PO flow, and from then on the order's progress is the
 * PO's: the OrderAgent mirrors it, and nothing else moves a PO past `submitted` but cancelling it.
 */
import { z } from 'zod';
import type { NodeRun } from '../api';
import { defineLifecycle } from '../lifecycle';
import { type OrderStatus, type PendingWait, TERMINAL_ORDER_STATUSES } from '../types';
import type { Company, CompanyMember } from './companies';

export const PO_STATUSES = [
  'draft',
  'submitted',
  'pending_approval',
  'approved',
  'rejected',
  'ordered',
  'fulfilled',
  'cancelled',
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/**
 * A draft is submitted or cancelled. A submitted PO waits for an approval, goes straight to
 * approved when none is needed, or is rejected or cancelled. An approved one is ordered and then
 * fulfilled; an ordered one is cancelled only when its order is.
 */
export const PO_LIFECYCLE = defineLifecycle<PoStatus>({
  draft: ['submitted', 'cancelled'],
  submitted: ['pending_approval', 'approved', 'rejected', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['ordered'],
  rejected: [],
  ordered: ['fulfilled', 'cancelled'],
  fulfilled: [],
  cancelled: [],
});

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  ordered: 'Ordered',
  fulfilled: 'Fulfilled',
  cancelled: 'Cancelled',
};

/** Where a PO came from: staff in the app, the API or MCP, or an inbound channel. */
export const PO_SOURCES = ['app', 'api', 'edi', 'email', 'punchout'] as const;
export type PoSource = (typeof PO_SOURCES)[number];

export const PO_SOURCE_LABELS: Record<PoSource, string> = {
  app: 'App',
  api: 'API',
  edi: 'EDI',
  email: 'Email',
  punchout: 'Punchout',
};

/** The sources of a PO that arrives from outside, recorded beside its order. */
export type PoInboundSource = Extract<PoSource, 'edi' | 'email' | 'punchout'>;

/** Only a draft can be edited. */
export const poEditable = (status: PoStatus) => status === 'draft';

/** A PO that no longer moves. */
export const poEnded = (status: PoStatus) => PO_LIFECYCLE.terminal(status);

/** The flow a submitted PO starts an order on (`b2bPurchaseOrderFlow`). */
export const PO_FLOW_ID = 'tpl-b2b-purchase-order';

/** Caps that keep a PO, a company's drafts and a page bounded. */
export const MAX_PO_LINES = 200;
export const MAX_PO_NUMBER = 64;
export const PO_PAGE = { default: 25, max: 100 } as const;

export interface PurchaseOrderLine {
  sku: string;
  name: string | null;
  qty: number;
  /** The price the buyer expects, if they wrote one. The flow prices the order, not this. */
  unitPrice: number | null;
}

export type PoShipTo = {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
};

export interface PurchaseOrder {
  id: string;
  /** The business customer's id: a PO belongs to its company. */
  companyId: string;
  /** The member who placed it; null for an inbound PO that names none. */
  buyerId: string | null;
  /** The buyer's own reference; unique within the company among POs not cancelled. */
  poNumber: string;
  status: PoStatus;
  currency: string;
  shipTo: PoShipTo | null;
  notes: string | null;
  /** The quote it was made from (S7), if any. */
  quoteId: string | null;
  /** The order it started; null until submitted. */
  orderId: string | null;
  source: PoSource;
  createdAt: number;
  updatedAt: number;
}

/** A PO with its lines. */
export interface PurchaseOrderDetail extends PurchaseOrder {
  lines: PurchaseOrderLine[];
}

/** A PO as a list shows it: its header and how many lines it has. */
export interface PurchaseOrderRow extends PurchaseOrder {
  lineCount: number;
}

/** The PO number as stored: trimmed, so ` PO-7 ` and `PO-7` are the same. */
export const normalizePoNumber = (poNumber: string) => poNumber.trim();

/** What `poDraftProblem` needs to know of a draft and the company and buyer it names. */
export type PoDraftContext = {
  company: Pick<Company, 'status'> | undefined;
  buyer: Pick<CompanyMember, 'companyId' | 'status'> | undefined;
  /** Another PO of the company (not cancelled) already has this number. */
  duplicate: boolean;
};

/**
 * Why a draft can't be submitted, or null: it has no lines, its number is taken, its company
 * isn't active, or the buyer it names isn't an active member of that company. It is checked when
 * a draft is saved (the numbers and lines) and again at submit (the company and buyer may have
 * changed since).
 */
export function poDraftProblem(
  draft: Pick<PurchaseOrder, 'companyId' | 'buyerId'> & { lines: readonly unknown[] },
  ctx: PoDraftContext,
): string | null {
  if (!draft.lines.length) return 'A purchase order needs at least one line.';
  if (ctx.duplicate) return 'Another purchase order of this company has that number.';
  if (!ctx.company) return `${draft.companyId} isn't a company.`;
  if (ctx.company.status !== 'active')
    return `Company ${draft.companyId} isn't active (${ctx.company.status}).`;
  if (draft.buyerId !== null)
    if (!ctx.buyer || ctx.buyer.companyId !== draft.companyId || ctx.buyer.status !== 'active')
      return `Buyer ${draft.buyerId} isn't an active member of ${draft.companyId}.`;
  return null;
}

/**
 * How far an order has got, as a PO sees it: the order's own status, or one of two things its
 * status doesn't say. `awaiting_approval`: an approval wait is open. `proceeding`: every approval
 * the flow has is settled (decided, or skipped by a condition) and the order is going ahead.
 */
export type PoOrderProgress = OrderStatus | 'awaiting_approval' | 'proceeding';

/**
 * The state a PO should be heading to for this progress, given where it is, or null when the
 * progress tells it nothing it doesn't know (a queued or running order, a PO already there or
 * past it). A declined order is a rejection while the PO is still waiting to be approved, and a
 * cancellation once it was (approved or ordered). A PO moves only along its lifecycle, so the
 * target may be several moves away (`poPath`).
 */
export function poTransitionFor(progress: PoOrderProgress, from: PoStatus): PoStatus | null {
  let to: PoStatus | null;
  switch (progress) {
    case 'awaiting_approval':
      to = 'pending_approval';
      break;
    case 'proceeding':
      to = 'ordered';
      break;
    case 'completed':
      to = 'fulfilled';
      break;
    case 'declined':
      to = from === 'submitted' || from === 'pending_approval' ? 'rejected' : 'cancelled';
      break;
    case 'cancelled':
    case 'failed':
    case 'rolled_back':
      to = 'cancelled';
      break;
    default:
      // queued, running, waiting
      return null;
  }
  // A PO that is a draft hasn't started an order; one that is there or past it has the news.
  if (from === 'draft' || from === to || !PO_LIFECYCLE.reachable(from).has(to)) return null;
  return to;
}

/**
 * How far an order has got, as its PO sees it, from the order's state and the ids of the flow's
 * approval nodes. A finished order is its status. One with an approval wait open is
 * `awaiting_approval`. One that is under way with every approval node approved or skipped is
 * `proceeding` (a gate that was rejected or timed out is not: the order is about to end declined,
 * and its PO is rejected, not ordered): that holds from the start for a flow with no approval, and only once the order has
 * run through its approval gates for one that has (a flow that checks credit before it asks isn't
 * `proceeding` while it checks). Null while there is nothing to say: queued, or not yet at a gate.
 */
export function poProgressOf(
  s: {
    status: OrderStatus;
    waits: readonly Pick<PendingWait, 'kind'>[];
    nodes: Record<string, Pick<NodeRun, 'status' | 'branches'> | undefined>;
  },
  approvalNodeIds: readonly string[],
): PoOrderProgress | null {
  if (TERMINAL_ORDER_STATUSES.includes(s.status)) return s.status;
  if (s.waits.some((w) => w.kind === 'approval')) return 'awaiting_approval';
  if (s.status === 'queued') return null;
  const cleared = approvalNodeIds.every((id) => {
    const node = s.nodes[id];
    return (
      node?.status === 'skipped' ||
      (node?.status === 'succeeded' && !!node.branches?.includes('approved'))
    );
  });
  return cleared ? 'proceeding' : null;
}

/**
 * The moves from `from` to `to`, each one allowed by the lifecycle, shortest first; empty when
 * there is no way. A sync applies them one compare-and-set at a time, so a PO that sat at
 * `submitted` while its order ran straight through is `approved`, `ordered` and `fulfilled` in
 * turn, never skipping a state.
 */
export function poPath(from: PoStatus, to: PoStatus): PoStatus[] {
  if (from === to) return [];
  const via = new Map<PoStatus, PoStatus>();
  const seen = new Set<PoStatus>([from]);
  for (let layer: PoStatus[] = [from]; layer.length; ) {
    const nextLayer: PoStatus[] = [];
    for (const s of layer)
      for (const n of PO_LIFECYCLE.next(s)) {
        if (seen.has(n)) continue;
        seen.add(n);
        via.set(n, s);
        nextLayer.push(n);
      }
    layer = nextLayer;
  }
  const path: PoStatus[] = [];
  for (let s: PoStatus | undefined = to; s && s !== from; s = via.get(s)) path.unshift(s);
  return via.has(to) ? path : [];
}

const id = z.string().min(1).max(100);

export const poLineInput = z.object({
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200).optional(),
  qty: z.number().positive().max(1e9),
  unitPrice: z
    .number()
    .nonnegative()
    .max(1e9)
    .optional()
    .describe('The price the buyer expects, if they wrote one; the flow prices the order'),
});
export type PoLineInput = z.infer<typeof poLineInput>;

const shipTo = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100).optional(),
  postalCode: z.string().trim().min(1).max(20),
  country: z.string().trim().min(2).max(60),
});

/** The fields of a draft, as a caller writes them. */
const poFields = {
  poNumber: z.string().trim().min(1).max(MAX_PO_NUMBER).describe('The buyer’s own PO number'),
  buyerId: id
    .nullable()
    .optional()
    .describe('The company member placing it (an active member of the company); null for none'),
  currency: z.string().length(3).optional().describe('Defaults to USD'),
  shipTo: shipTo.nullable().optional(),
  notes: z.string().trim().min(1).max(2000).nullable().optional(),
  quoteId: id.nullable().optional().describe('The quote this PO was made from'),
  lines: z.array(poLineInput).min(1).max(MAX_PO_LINES),
};

export const createPoDraftInput = z.object({
  companyId: id.describe('The business customer’s id'),
  ...poFields,
});
export type CreatePoDraftInput = z.infer<typeof createPoDraftInput>;

export const updatePoDraftInput = z.object({
  poId: id,
  poNumber: poFields.poNumber.optional(),
  buyerId: poFields.buyerId,
  currency: poFields.currency,
  shipTo: poFields.shipTo,
  notes: poFields.notes,
  quoteId: poFields.quoteId,
  lines: poFields.lines
    .optional()
    .describe('The whole list of lines: it replaces the draft’s lines'),
});
export type UpdatePoDraftInput = z.infer<typeof updatePoDraftInput>;

/** A PO's keys as an opaque cursor: newest first, so the creation time and the id. */
export type PoCursor = { readonly at: number; readonly id: string };

export function encodePoCursor(c: PoCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify([c.at, c.id]));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The cursor a page handed out, or undefined for anything else. */
export function decodePoCursor(raw: string): PoCursor | undefined {
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'number' &&
      typeof parsed[1] === 'string'
    )
      return { at: parsed[0], id: parsed[1] };
  } catch {
    // Not one of ours.
  }
  return undefined;
}

/**
 * How an order start is tied to a PO. `link`: the order is the one a submitted PO starts (its id).
 * `record`: the order came in from outside as a PO (EDI, email) and the engine records the PO
 * beside it. The engine sets `meta.purchaseOrderId` from this and from nothing a caller sent, so
 * the PO an order's progress is mirrored into is never one a caller named.
 */
export type PurchaseOrderStart =
  | { link: string }
  | { record: { source: PoInboundSource; poNumber: string } };

/**
 * The number an emailed PO is recorded under until the extract node reads the document's own: made
 * from the message's fingerprint, so a redelivery of the same message gets the same one.
 */
export const provisionalPoNumber = (fingerprint: string) =>
  `EML-${fingerprint.slice(0, 10).toUpperCase()}`;

/**
 * The number an order's invoice carries as the buyer's reference: the PO's own, except an emailed
 * PO's provisional one, which isn't the buyer's.
 */
export const invoicePoNumber = (po: Pick<PurchaseOrder, 'source' | 'poNumber'>) =>
  po.source === 'email' ? null : po.poNumber;

/** The id of the PO recorded for an order that arrived as one. */
export const poIdForOrder = (orderId: string) => `po_${orderId.replace(/^ord_/, '')}`;

/** The `meta.purchaseOrderId` an order names, or undefined when it names none. */
export function orderPurchaseOrderId(meta: Record<string, unknown> | undefined) {
  const v = meta?.purchaseOrderId;
  return typeof v === 'string' && v ? v : undefined;
}

/** The meta a PO's order carries: its number (the invoice shows it), buyer, ship-to and notes. */
export function poOrderMeta(
  po: Pick<PurchaseOrder, 'poNumber' | 'buyerId' | 'shipTo' | 'notes'>,
): Record<string, unknown> {
  return {
    poNumber: po.poNumber,
    ...(po.buyerId ? { buyerId: po.buyerId } : {}),
    ...(po.shipTo ? { shipTo: po.shipTo } : {}),
    ...(po.notes ? { notes: po.notes } : {}),
  };
}

/** The key a PO starts its order under, so submitting twice starts one order. */
export const poOrderKey = (poId: string) => `po:${poId}`;
