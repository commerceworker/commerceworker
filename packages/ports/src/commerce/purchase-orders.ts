/**
 * Purchase orders and their lines. `d1PurchaseOrderStore` (packages/db) and
 * `InMemoryPurchaseOrderStore` (packages/test-kit) implement it, held to one contract.
 *
 * Every read takes a `scope`: one company's (`{ companyId }`) or everything (`{ all: true }`), so a
 * caller bound to a company cannot read another's by forgetting a filter. Lists are keyset paged,
 * newest first, with the total the filters match. Only a draft is edited, and the edit is one
 * guarded write that names the draft status, so it cannot land on a PO that was submitted a moment
 * before. A status moves only by a compare-and-set on the status the caller read: of a submit and
 * a cancel racing from `draft`, one wins and the other is told so. A PO number is unique within a
 * company among POs not cancelled.
 */
import type {
  PoCursor,
  PoStatus,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderRow,
} from '@commerceworker/core';

export type PurchaseOrderScope = { readonly companyId: string } | { readonly all: true };

/** What a list narrows by. `from` and `to` are creation times (ms), both inclusive. */
export interface PurchaseOrderFilter {
  /** Narrows to one company; a company-scoped read can't widen past its own. */
  readonly companyId?: string;
  readonly status?: PoStatus;
  /** The company member who placed it. */
  readonly buyerId?: string;
  /** Part of the PO number, matched literally and without regard to case. */
  readonly search?: string;
  readonly from?: number;
  readonly to?: number;
}

export interface PurchaseOrderPaging {
  readonly after?: PoCursor;
  readonly limit: number;
}

export interface PurchaseOrderPage {
  readonly rows: PurchaseOrderRow[];
  /** Every row the filters match, not just this page. */
  readonly total: number;
  /** Pass it as `after` for the next page; null on the last. */
  readonly next: PoCursor | null;
}

/** The fields a draft's edit changes; what it leaves out stays. */
export interface PurchaseOrderPatch {
  readonly poNumber?: string;
  readonly buyerId?: string | null;
  readonly currency?: string;
  readonly shipTo?: PurchaseOrder['shipTo'];
  readonly notes?: string | null;
  readonly quoteId?: string | null;
  /** The whole list, replacing the draft's. */
  readonly lines?: readonly PurchaseOrderLine[];
}

/** Why a write found a PO it can't have: `number` is taken in the company, `id` already exists. */
export type PurchaseOrderConflict = 'number' | 'id';

export interface PurchaseOrderStore {
  list(
    scope: PurchaseOrderScope,
    filter: PurchaseOrderFilter,
    paging: PurchaseOrderPaging,
  ): Promise<PurchaseOrderPage>;
  /** A PO with its lines, if the scope can see it. */
  get(scope: PurchaseOrderScope, id: string): Promise<PurchaseOrderDetail | undefined>;
  /** The company's PO with this number (any case) that isn't cancelled. */
  byNumber(
    scope: PurchaseOrderScope,
    companyId: string,
    poNumber: string,
  ): Promise<PurchaseOrder | undefined>;
  /** The PO an order started, if any: how the OrderAgent finds the PO it mirrors. */
  byOrder(orderId: string): Promise<PurchaseOrder | undefined>;
  /** Adds a PO with its lines, all or none; the conflict, and nothing written, when it can't. */
  create(
    po: PurchaseOrder,
    lines: readonly PurchaseOrderLine[],
  ): Promise<{ ok: true } | { ok: false; conflict: PurchaseOrderConflict }>;
  /**
   * Edits a PO that is still a draft, its lines and header together or not at all. `missing` when
   * it isn't there, or isn't a draft any more (the edit was refused); `conflict` when the new
   * number is taken.
   */
  updateDraft(
    scope: PurchaseOrderScope,
    id: string,
    patch: PurchaseOrderPatch,
    at: number,
  ): Promise<{ ok: true } | { ok: false; conflict: 'number' | 'missing' }>;
  /** `from` → `to`, only if the PO is still in `from`. False when it wasn't (or isn't there). */
  transition(
    scope: PurchaseOrderScope,
    id: string,
    from: PoStatus,
    to: PoStatus,
    at: number,
  ): Promise<boolean>;
  /** Records the order a PO started; true when it now names `orderId` (also when it already did). */
  linkOrder(scope: PurchaseOrderScope, id: string, orderId: string, at: number): Promise<boolean>;
}
