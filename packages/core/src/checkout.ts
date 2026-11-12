/**
 * Agentic checkout, independent of the protocol that carries it (UCP today, see ./ucp/): a
 * session a buying agent builds up (lines, buyer, ship-to, shipping option), priced by the
 * checkout flow's own pricing nodes, then completed into an order of that flow. Pure: the engine
 * stores sessions in D1 and runs the quote (apps/engine/src/ucp/).
 *
 * A session's status follows from what it holds: anything the buyer must still supply, or an
 * error the agent can fix, keeps it `incomplete`; an error only a person can clear makes it
 * `requires_escalation`; otherwise it is `ready_for_complete`. Completing moves it through
 * `complete_in_progress` to `completed`, and from then on it never changes.
 */

import type { ShipAddress } from './address';
import { isBackEdge } from './graph';
import type { PromotionKind } from './promotions';
import type { ShippingOption } from './shipping';
import type { FlowGraph, FlowNode, FulfillmentMethod } from './types';

export const CHECKOUT_STATUSES = [
  'incomplete',
  'requires_escalation',
  'ready_for_complete',
  'complete_in_progress',
  'completed',
  'canceled',
] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

/** Statuses a session never leaves. */
export const FINAL_CHECKOUT_STATUSES: readonly CheckoutStatus[] = ['completed', 'canceled'];

/** How long a session lives when nothing says otherwise. */
export const CHECKOUT_TTL_MS = 6 * 3_600_000;

/** Lines per session, and units per line. */
export const MAX_CHECKOUT_LINES = 100;
export const MAX_LINE_QUANTITY = 10_000;

/**
 * What can be wrong with a session, as the protocol layer reports it:
 *
 * - `recoverable`: the agent can fix it by changing the session (an unknown SKU, a missing email).
 * - `requires_buyer_input`: the buyer must supply something no API field carries.
 * - `requires_buyer_review`: the buyer must approve something before the order is placed.
 * - `unrecoverable`: nothing can be done with this session; start a new one.
 */
export const ISSUE_SEVERITIES = [
  'recoverable',
  'requires_buyer_input',
  'requires_buyer_review',
  'unrecoverable',
] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export type CheckoutIssue = {
  kind: 'error' | 'warning' | 'info';
  code: string;
  content: string;
  /** JSONPath into the session as the protocol shows it, e.g. `$.line_items[0]`. */
  path?: string;
  /** Errors only. */
  severity?: IssueSeverity;
};

export type CheckoutLine = {
  /** Stable within the session, so an agent can name the line it changes. */
  id: string;
  sku: string;
  qty: number;
  /** Set by the quote. */
  title?: string;
  unitPrice?: number;
  /** Set by the quote when promotions lowered `unitPrice`: the price before them. */
  listPrice?: number;
};

export type CheckoutBuyer = {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
};

/** A promotion the quote's discount step applied, in the session's currency. */
export type QuoteDiscount = {
  /** The code that gave it; null for an automatic promotion. */
  code: string | null;
  /** The promotion's name. */
  title: string;
  kind: PromotionKind;
  /** What it took off the lines (or, for free shipping, the shipping charge). */
  amount: number;
};

/** The price of a session, as the checkout flow's pricing nodes worked it out. */
export type CheckoutQuote = {
  currency: string;
  lines: {
    id: string;
    sku: string;
    title: string;
    qty: number;
    unitPrice: number;
    /** A physical good: it needs a ship-to. */
    ships: boolean;
    /** The unit price before promotions, when the flow has a discount step. */
    listPrice?: number;
    /** What the line costs: `unitPrice` times `qty`, worked out by the quote (set on every quote it prices). */
    total?: number;
    /** The line before promotions (`listPrice` times `qty`; its `total` without a discount step). */
    listTotal?: number;
  }[];
  /** The lines before promotions: the sum of their `listTotal` (set by the quote, like them). */
  listSubtotal?: number;
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  /** Shipping options on offer for the ship-to; empty when nothing ships. */
  shippingOptions: ShippingOption[];
  /** The option the quote charged, if any. */
  shippingOption: string | null;
  /** Whether any line ships (a physical good). */
  ships: boolean;
  /**
   * What the flow's discount step did with the session's codes: the promotions it applied (their
   * amounts are already out of the line prices) and each code it refused, with why. Unset when
   * the flow has no discount step.
   */
  discounts?: { applied: QuoteDiscount[]; refused: { code: string; reason: string }[] };
};

/** A store offered for pickup. */
export type PickupStore = { id: string; name: string; postalCode?: string };

export type CheckoutSession = {
  id: string;
  /**
   * Who may act on it: a UCP platform's id, or `hosted:<sha256 of the buyer's cookie secret>` for a
   * hosted checkout (./hosted-checkout.ts), which starts as `hosted-start:<hash of its start token>`
   * until the buyer redeems the link.
   */
  ownerId: string;
  status: CheckoutStatus;
  currency: string;
  lines: CheckoutLine[];
  buyer: CheckoutBuyer;
  fulfillment: FulfillmentMethod;
  shipTo: Partial<ShipAddress> | null;
  shippingOption: string | null;
  /** The store the buyer collects from, when `fulfillment` is `pickup`. */
  pickupLocationId?: string | null;
  /** The stores that could take the whole order for pickup, as of the last write. */
  pickupStores?: PickupStore[];
  /** Promotion codes as the platform sent them; unset for a session that never had any. */
  promoCodes?: string[];
  quote: CheckoutQuote | null;
  issues: CheckoutIssue[];
  /** The customer it is priced for (contract prices, credit) and its order is placed for. */
  customerId?: string;
  /**
   * A hosted checkout's card payment, once the buyer has pressed Pay. `attempts` counts the
   * confirmation tokens it has been tried with (the cap against card testing); `token` is the one
   * being paid with and `intentId` the PaymentIntent it made, so a press retried after a lost answer
   * resumes the same hold, and the sweep can release it if nothing finishes (`sweeps` counts the times it
   * failed to settle it). Never shown to a buyer.
   */
  payment?: { attempts: number; token?: string; intentId?: string; sweeps?: number };
  /**
   * The origin a UCP platform completed it on, kept so the sweep can place the order the request
   * would have (`meta.ucp`) when the Worker died after the hold. Unset for a hosted checkout.
   */
  completedOn?: string;
  /** The order completing it started. */
  orderId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** Bumped on every write; writes compare it, so two never interleave. */
  version: number;
};

/** What a buying agent may change. Lines replace the session's lines when given. */
export type CheckoutPatch = {
  lines?: { id?: string; sku: string; qty: number }[];
  buyer?: CheckoutBuyer;
  shipTo?: Partial<ShipAddress> | null;
  shippingOption?: string | null;
  fulfillment?: FulfillmentMethod;
  pickupLocationId?: string | null;
  promoCodes?: string[];
};

export const isFinalCheckout = (s: Pick<CheckoutSession, 'status'>) =>
  FINAL_CHECKOUT_STATUSES.includes(s.status);

/** Whether the session may still be changed: not final, and not being completed. */
export const isOpenCheckout = (s: Pick<CheckoutSession, 'status'>) =>
  !isFinalCheckout(s) && s.status !== 'complete_in_progress';

export const isExpired = (s: Pick<CheckoutSession, 'expiresAt' | 'status'>, now: number) =>
  isOpenCheckout(s) && s.expiresAt <= now;

/** A new session's lines get ids `li_1`, `li_2`, …; a line keeps its id across updates. */
export function applyLines(
  current: CheckoutLine[],
  next: NonNullable<CheckoutPatch['lines']>,
): CheckoutLine[] {
  const known = new Map(current.map((l) => [l.id, l]));
  let n = current.reduce((m, l) => Math.max(m, Number(l.id.replace(/^li_/, '')) || 0), 0);
  return next.map((l) => {
    const kept = l.id ? known.get(l.id) : undefined;
    return kept ? { ...kept, sku: l.sku, qty: l.qty } : { id: `li_${++n}`, sku: l.sku, qty: l.qty };
  });
}

/** The session with `patch` applied; pricing and status are the caller's next step. */
export function patchCheckout(s: CheckoutSession, patch: CheckoutPatch): CheckoutSession {
  return {
    ...s,
    lines: patch.lines ? applyLines(s.lines, patch.lines) : s.lines,
    buyer: patch.buyer ? { ...patch.buyer } : s.buyer,
    shipTo: patch.shipTo !== undefined ? patch.shipTo : s.shipTo,
    shippingOption: patch.shippingOption !== undefined ? patch.shippingOption : s.shippingOption,
    ...(patch.fulfillment !== undefined ? { fulfillment: patch.fulfillment } : {}),
    ...(patch.pickupLocationId !== undefined ? { pickupLocationId: patch.pickupLocationId } : {}),
    ...(patch.promoCodes !== undefined ? { promoCodes: patch.promoCodes } : {}),
  };
}

/** Whether the buyer chose to collect the physical lines from a store. */
export const isPickup = (s: Pick<CheckoutSession, 'fulfillment' | 'pickupLocationId'>) =>
  s.fulfillment === 'pickup' && !!s.pickupLocationId;

/** What a ship-to needs before anything ships to it; the rest (name, line 2, region) is optional. */
export const ADDRESS_FIELDS = ['line1', 'city', 'postalCode', 'country'] as const;

/** Whether `a` has every `ADDRESS_FIELDS` field. It says nothing of whether the address is valid. */
export const isCompleteAddress = (a: Partial<ShipAddress> | null | undefined) =>
  ADDRESS_FIELDS.every((f) => !!a?.[f]);

/**
 * What the session still lacks before it can be completed, as recoverable errors: lines, an email
 * to send the confirmation to, and for anything that ships a full address and an option (the
 * flow's shipping node picks one, the cheapest unless it says otherwise, when the agent doesn't).
 * The quote's own problems come on top.
 */
export function missingInfo(s: CheckoutSession): CheckoutIssue[] {
  const out: CheckoutIssue[] = [];
  const missing = (path: string, content: string): CheckoutIssue => ({
    kind: 'error',
    code: 'missing',
    path,
    content,
    severity: 'recoverable',
  });
  if (!s.lines.length) out.push(missing('$.line_items', 'Add at least one line item.'));
  if (!s.buyer.email) out.push(missing('$.buyer.email', "The buyer's email is required."));
  const q = s.quote;
  // A pickup needs a store (checked by the protocol layer), not an address or a shipping option.
  if (q?.ships && !isPickup(s)) {
    if (!isCompleteAddress(s.shipTo))
      out.push(missing('$.fulfillment', 'A complete shipping address is required.'));
    if (q.shippingOptions.length && !s.shippingOption && !q.shippingOption)
      out.push(missing('$.fulfillment', 'Choose a shipping option.'));
  }
  return out;
}

/** The status a session in an open state should have, from its issues. */
export function openStatus(issues: CheckoutIssue[]): CheckoutStatus {
  const errors = issues.filter((i) => i.kind === 'error');
  if (
    errors.some(
      (i) => i.severity === 'requires_buyer_input' || i.severity === 'requires_buyer_review',
    )
  )
    return 'requires_escalation';
  return errors.length ? 'incomplete' : 'ready_for_complete';
}

/**
 * Node types the checkout runs, in graph order, to price a session exactly as the flow will, and
 * to tell the agent up front when the flow's store policy would refuse it.
 */
export const QUOTE_NODE_TYPES = [
  'commerce.validate',
  'commerce.price',
  'commerce.discount',
  'commerce.shipping_rate',
  'commerce.tax',
  'commerce.policy',
] as const;

/**
 * The flow's pricing nodes (`QUOTE_NODE_TYPES`) in the order the flow reaches them: a topological
 * order of the graph without loop back-edges, ties in node order. A type that appears twice is
 * priced once, at its first occurrence.
 */
export function quoteNodes(graph: FlowGraph): FlowNode[] {
  const edges = graph.edges.filter((e) => !isBackEdge(e));
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of edges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  const order: FlowNode[] = [];
  const ready = graph.nodes.filter((n) => !indegree.get(n.id));
  const placed = new Set<string>();
  while (ready.length) {
    const n = ready.shift()!;
    if (placed.has(n.id)) continue;
    placed.add(n.id);
    order.push(n);
    for (const e of edges)
      if (e.source === n.id) {
        const left = (indegree.get(e.target) ?? 0) - 1;
        indegree.set(e.target, left);
        if (left === 0) {
          const t = graph.nodes.find((x) => x.id === e.target);
          if (t) ready.push(t);
        }
      }
    ready.sort((a, b) => graph.nodes.indexOf(a) - graph.nodes.indexOf(b));
  }
  const seen = new Set<string>();
  return order.filter((n) => {
    if (!(QUOTE_NODE_TYPES as readonly string[]).includes(n.type) || seen.has(n.type)) return false;
    seen.add(n.type);
    return true;
  });
}

/**
 * Why a flow can't take checkouts, or null when it can: it must authorize a card, and must not
 * carry the order on the customer's account (an invoice billed to it, a stored-method charge): a
 * buyer pays with their own card, never the account's credit.
 */
export function checkoutFlowProblem(graph: FlowGraph): string | null {
  const authorize = graph.nodes.find((n) => n.type === 'commerce.authorize_payment');
  if (!authorize)
    return 'The checkout flow must authorize the payment (commerce.authorize_payment).';
  const method = authorize.config?.method;
  if (method !== undefined && method !== 'card' && method !== 'wallet')
    return `The checkout flow authorizes "${String(method)}"; checkout pays by card.`;
  if (authorize.config?.purpose === 'verify')
    return 'The checkout flow only verifies the card; it must hold the payment to capture it later.';
  const onAccount = graph.nodes.find(
    (n) =>
      n.type === 'commerce.charge' ||
      (n.type === 'commerce.invoice' && n.config?.onAccount !== false),
  );
  if (onAccount)
    return `The checkout flow carries the order on account (${onAccount.type}); checkout pays by card.`;
  return null;
}

/**
 * Whether the flow can fulfil a pickup, so a checkout may offer one: it has a Route fulfillment
 * step (`commerce.route_fulfillment`) that follows the order's own method (`from_order`, the
 * default; a step fixed to one method would send every order the same way) and an edge out of its
 * `pickup` branch, which is the path that holds the goods at the store and readies them. A flow
 * with no such path (the storefront template ships everything) offers no pickup.
 */
export function flowOffersPickup(graph: FlowGraph): boolean {
  return graph.nodes.some((n) => {
    if (n.type !== 'commerce.route_fulfillment') return false;
    const method = n.config?.method ?? 'from_order';
    return (
      method === 'from_order' &&
      graph.edges.some((e) => e.source === n.id && e.sourceHandle === 'pickup')
    );
  });
}
