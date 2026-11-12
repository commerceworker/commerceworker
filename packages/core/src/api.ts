/**
 * The contract between the web app and the engine's `EngineApi` RPC entrypoint, and the state
 * each order's OrderAgent syncs to browsers. The web app types its service binding with
 * `EngineRpc` rather than importing engine source; the storefront, with the much narrower
 * `StorefrontRpc`.
 */

import type { PurchaseOrderStart } from './b2b/purchase-orders';
import type {
  CartAttachment,
  CartOp,
  CartProductPage,
  CartState,
  CartView,
  CreateCartInput,
} from './cart';
import type { ErasureResult, SubjectExport } from './erasure';
import type { EdgeState, GraphIssue } from './graph';
import type { HealthReport } from './health';
import type {
  HostedChange,
  HostedCheckout,
  HostedCheckoutSettings,
  HostedPayInput,
  HostedPayment,
} from './hosted-checkout';
import type { BuyerOrderView } from './order-confirmation';
import type {
  PluginCase,
  PluginCaseResult,
  PluginInstallView,
  PluginStatus,
  PluginUsage,
} from './plugins';
import type { ProductDraftRequest, ProductDraftResult } from './product/api';
import type { CartGuest, SignedActor } from './roles';
import type {
  ShopperAddresses,
  ShopperOrderPage,
  ShopperSignedIn,
  ShopperStart,
  ShopperView,
} from './shopper';
import type { TaxCertificate, TaxCertificateChange, TaxCertificateInput } from './tax-exemption';
import type {
  FlowGraph,
  FlowVersion,
  NodeStatus,
  Order,
  OrderInputDraft,
  OrderModel,
  OrderStatus,
  PendingWait,
  TimelineEntry,
} from './types';
import type { UcpPlatformRef } from './ucp/profile';

export type NodeRun = {
  status: NodeStatus;
  runs: number;
  /** One line for the node card, e.g. "Reserved 3 lines" or "→ needs_approval". */
  summary?: string;
  output?: unknown;
  error?: string;
  branches?: string[];
  startedAt?: number;
  endedAt?: number;
};

/**
 * An order's state. `snapshot()` returns all of it. The OrderAgent's synced (broadcast) state is
 * the same shape with `flow` null and only the newest `TIMELINE_BROADCAST` timeline entries: the
 * pinned flow never changes, so a page reads it once (the agent's `getFlow()` or a snapshot), and
 * folds each broadcast's timeline into what it holds with `mergeTimeline`.
 */
export type OrderState = {
  orderId: string | null;
  status: OrderStatus;
  order: Order | null;
  /** Null in the agent's broadcast state. */
  flow: FlowVersion | null;
  nodes: Record<string, NodeRun>;
  edges: Record<string, EdgeState>;
  waits: PendingWait[];
  vars: Record<string, unknown>;
  timeline: TimelineEntry[];
  /** Workflow instance currently driving the order. */
  instanceId: string | null;
  /** 1 for the first run; increments on each "continue as new". */
  generation: number;
  rollback: { outcome: 'complete' | 'failed'; error: string | null } | null;
  /** Reason when cancelled or failed. */
  reason?: string;
  updatedAt: number;
  /**
   * The sequence of the last Workflow report the agent applied: it rises with each, within a
   * `generation` (a new one restarts it), so a reader holding two states of an order can tell the
   * newer. The agent always sends it.
   */
  seq?: number;
};

export const EMPTY_ORDER_STATE: OrderState = {
  orderId: null,
  status: 'queued',
  order: null,
  flow: null,
  nodes: {},
  edges: {},
  waits: [],
  vars: {},
  timeline: [],
  instanceId: null,
  generation: 0,
  rollback: null,
  updatedAt: 0,
};

/** The most timeline entries an order keeps. */
export const TIMELINE_CAP = 400;
/** The newest timeline entries the OrderAgent broadcasts with its state. */
export const TIMELINE_BROADCAST = 50;

const entryId = (t: TimelineEntry) => t.key ?? `${t.at}|${t.kind}|${t.nodeId ?? ''}|${t.message}`;

/**
 * The timeline a page shows after a broadcast: the broadcast's entries (the newest, and
 * authoritative), after the older ones the page already held. A broadcast shorter than
 * `TIMELINE_BROADCAST` is the whole timeline. When the page holds no entry the broadcast starts
 * from, what it holds can't be trusted (the order was erased, which rewrites every entry, or the
 * page missed more than a broadcast's worth), so the broadcast alone is shown.
 */
export function mergeTimeline(held: TimelineEntry[], tail: TimelineEntry[]): TimelineEntry[] {
  if (tail.length < TIMELINE_BROADCAST) return tail;
  const ids = new Set(tail.map(entryId));
  const first = entryId(tail[0]!);
  const start = held.findIndex((t) => entryId(t) === first);
  if (start < 0) return tail;
  const older = held.slice(0, start).filter((t) => !ids.has(entryId(t)));
  return [...older, ...tail].slice(-TIMELINE_CAP);
}

/** The largest event payload (JSON) an order accepts; it lands in the order's variables. */
export const MAX_EVENT_PAYLOAD_BYTES = 32 * 1024;

/** True when a payload fits `MAX_EVENT_PAYLOAD_BYTES` once serialized. */
export function payloadFits(payload: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(payload ?? {})).byteLength <= MAX_EVENT_PAYLOAD_BYTES
  );
}

export type StartOrderInput = {
  flowId: string;
  /** Published version to run; defaults to the latest. */
  version?: number;
  input: OrderInputDraft;
  vars?: Record<string, unknown>;
  /**
   * The principal id starting it, set by the caller's server, never from a request body. Recorded
   * on the order, and not part of the fingerprint.
   */
  startedBy?: string;
  /**
   * Ties the order to a purchase order (`PurchaseOrderStart`). `link` is for the engine's own
   * callers (submitting a PO): the binding drops it, so a caller can't point an order at a PO.
   */
  purchaseOrder?: PurchaseOrderStart;
};

export type StartOrderResult = { orderId: string; replayed?: boolean };

/** A repeat of the same key and request returns the order it already created. */
export type StartOrderOnceInput = StartOrderInput & {
  idempotencyKey: string;
  /**
   * What a replay must match, when the caller knows better than the start request: an inbound
   * order fingerprints the sender's payload, so a retry still matches after the routing changes.
   */
  fingerprint?: string;
};

export type StartOrderOnceResult =
  | StartOrderResult
  /** The key already started an order from a different request. */
  | { mismatch: true };

/**
 * SHA-256 of what an order start asked for, with object keys sorted so property order doesn't
 * matter. A replayed idempotency key must carry the same fingerprint.
 */
export function startFingerprint(req: StartOrderInput): Promise<string> {
  return fingerprintOf({
    flowId: req.flowId,
    version: req.version ?? null,
    input: req.input,
    vars: req.vars ?? {},
  });
}

/** SHA-256 of any JSON value, with object keys sorted so property order doesn't matter. */
export async function fingerprintOf(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type CopilotRequest = {
  prompt: string;
  /** The graph being edited; omitted to create a new flow. */
  graph?: FlowGraph;
  model?: OrderModel;
};

export type CopilotResult = {
  graph: FlowGraph;
  /** What the copilot says it changed. */
  explanation: string;
  errors: GraphIssue[];
  warnings: GraphIssue[];
};

/**
 * A payment provider's webhook event, already verified by the web app: Stripe's event id, its type
 * (`invoice.paid`…) and the object it is about.
 */
export type PaymentEvent = {
  provider: 'stripe';
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

/**
 * `handled` (acted on), `duplicate` (this event id was handled before), `ignored` (not a type or an
 * object CommerceWorker acts on), or `retry`: the order isn't waiting for it yet, so the provider
 * should deliver it again later.
 */
export type PaymentEventResult = {
  outcome: 'handled' | 'duplicate' | 'ignored' | 'retry';
  orderId?: string;
  /** The order event delivered to a waiting node (`payment.received`, `payment.disputed`). */
  delivered?: string;
  reason?: string;
};

export interface EngineRpc {
  startOrder(input: StartOrderInput): Promise<StartOrderResult>;
  /** Starts an order at most once per idempotency key. */
  startOrderOnce(input: StartOrderOnceInput): Promise<StartOrderOnceResult>;
  /** Delivers a business event (e.g. "payment.received") to whichever node waits for it. */
  /**
   * Delivers a business event to the step waiting for it. With none waiting yet, an order still
   * running whose flow waits for it holds it until that step opens (`held: true`); a resend of one
   * already given to a step is `delivered` with `duplicate: true`.
   */
  sendEvent(
    orderId: string,
    event: string,
    payload?: Record<string, unknown>,
  ): Promise<{
    delivered: boolean;
    held?: true;
    duplicate?: true;
    nodeId?: string;
    notFound?: true;
  }>;
  /** A verified payment provider event (Stripe): settles invoices and resumes the order. */
  paymentEvent(event: PaymentEvent): Promise<PaymentEventResult>;
  /**
   * Casts a vote on an approval; the order resumes once the votes decide it. `actor` is signed for
   * `decide:<orderId>` (`signRpcActor`): its name is who the record names, its id the principal
   * checked against the order's starter. `onBehalfOf` is a company member's id: staff record that
   * member's vote (docs/b2b.md, D3).
   */
  decide(
    orderId: string,
    nodeId: string,
    decision: 'approved' | 'rejected',
    actor: SignedActor,
    note?: string,
    onBehalfOf?: string,
  ): Promise<
    | {
        ok: true;
        /** `recorded`: the vote counted but more are needed, so the order still waits. */
        outcome: 'recorded' | 'approved' | 'rejected';
        /** The approvals so far of those needed, like "1 of 2". */
        tally: string;
      }
    | {
        ok: false;
        /**
         * `no_run`: the order is recorded but the engine has no run for it to resume. `refused`: the
         * vote can't be taken (not an approver, already voted, already decided, …); `error` says why.
         */
        reason: 'not_found' | 'no_run' | 'not_waiting' | 'own_order' | 'forbidden' | 'refused';
        error?: string;
      }
  >;
  /** `finished` when the order had already ended, so there was nothing to cancel. */
  cancel(
    orderId: string,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'finished' }>;
  snapshot(orderId: string): Promise<OrderState | null>;
  copilot(req: CopilotRequest): Promise<CopilotResult>;
  /** Email intake: mailbox local part → flow id, from the engine's INTAKE_MAILBOXES. */
  intakeMailboxes(): Promise<Record<string, string>>;
  /** Everything held about the person with this email (orders capped; see `truncated`). */
  exportDataSubject(email: string): Promise<SubjectExport>;
  /**
   * Erases the person with this email from their orders, customer accounts, documents, messages
   * and intake log. Refused while any of their orders is still running.
   */
  eraseDataSubject(email: string): Promise<ErasureResult>;
  /**
   * Runs a workspace tool (`ASSISTANT_TOOLS`) for the REST API exactly as MCP runs it: its role,
   * an action's live preview and refusals, any step-up, and the audit trail (`via: api`). `actor`
   * is staff signed for `operation:<name>`; `input` is checked against `TOOL_INPUTS[name]`. A tool
   * only the page or the panel offers is refused, as it is over MCP. `key`, unique to the request
   * (an `Idempotency-Key`), makes an order it starts start once.
   */
  runOperation(
    name: string,
    input: unknown,
    actor: SignedActor,
    key?: string,
  ): Promise<Refusable<unknown> & { status?: 400 | 403 | 404 }>;
  /** Runs the stock review now (normally a daily cron on the Replenish Workflow). */
  runReplenish(): Promise<{ instanceId: string }>;
  /**
   * Brings the product index (what `ai.extract` matches by meaning) up to date with `products`
   * now, as the hourly cron does: one run, so `more` says whether SKUs are left for the next.
   * `actor` is an admin signed for `reindex-products`; anyone else is refused.
   */
  reindexProducts(actor: SignedActor): Promise<Refusable<ProductReindex>>;
  /**
   * The assistant drafts a catalog product's missing text (`draft_product_content`) and saves the
   * drafts on the product for a person to accept. `actor` is an operator or above signed for
   * `draft-product:<key>`; anyone else is refused, as is a product the catalog doesn't have.
   */
  draftProductContent(
    key: string,
    request: ProductDraftRequest,
    actor: SignedActor,
  ): Promise<Refusable<ProductDraftResult>>;
  /** Deep health: the engine's own D1 and R2 bindings answer. */
  health(): Promise<HealthReport>;
  /**
   * The deploy smoke test's write check (`HEALTH_WRITE_PATH`): a row through D1, an object through
   * R2 under `health/` and a row through the `HealthProbe` object's SQLite, each written, read back
   * and deleted. `signed` is the check's own header (`signHealthCheck`), passed on by the web app;
   * without it nothing is written and the report fails `signature`.
   */
  writeHealth(signed: string): Promise<HealthReport>;
  /**
   * The UCP business profile (`/.well-known/ucp`) with `origin`'s URLs, or null while agentic
   * checkout is off. The engine builds it because it holds the signing key.
   */
  ucpProfile(origin: string): Promise<Record<string, unknown> | null>;
  /**
   * Every installed plugin: how it runs, the manifest the deployment runs (node types, nav
   * entries, public paths), whether it answered just now, and why not.
   */
  pluginCatalog(): Promise<PluginStatus[]>;
  /** What still uses a plugin: flows, running orders, labels it couldn't void (`pnpm plugin:check`). */
  pluginUsage(id: string): Promise<PluginUsage>;
  /**
   * A sandboxed plugin's page: the web app forwards the request it built (signed principal,
   * allowlisted headers) here, since only the engine can load the plugin; it applies its own
   * response rules to what comes back. 404 for a plugin that isn't installed sandboxed.
   */
  pluginFetch(id: string, request: Request): Promise<Response>;
  /**
   * Runtime installs (an admin's; the web app has authorized them, and checked a step-up before
   * `approvePlugin`, `rollbackPlugin` and `uninstallPlugin`). A refusal comes back as
   * `{ ok: false, error }`, a message to show as it is. See docs/plugins.md, "Installing at
   * runtime".
   */
  listPluginInstalls(): Promise<PluginInstallView[]>;
  /** The names of the publishers whose signed files an admin may upload (never their keys). */
  pluginPublishers(): Promise<string[]>;
  uploadPlugin(bundle: string, by: string): Promise<Refusable<PluginInstallView>>;
  approvePlugin(
    id: string,
    sha: string,
    grant: { personalData: boolean },
    by: string,
  ): Promise<Refusable<{ id: string; version: string; sha: string; personalData: boolean }>>;
  setPluginSecret(
    id: string,
    name: string,
    value: string,
    by: string,
  ): Promise<Refusable<{ id: string; name: string }>>;
  setPluginEnabled(id: string, enabled: boolean): Promise<Refusable<{ id: string }>>;
  rollbackPlugin(id: string, sha: string): Promise<Refusable<{ id: string; version: string }>>;
  uninstallPlugin(id: string, by: string): Promise<Refusable<{ id: string }>>;
  /** Opens a staff cart, or says why it can't: the flow must price orders, the customer exist. */
  createCart(
    input: CreateCartInput,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** A cart as its agent holds it, or null for an id no cart has. */
  cartSnapshot(id: string): Promise<CartState | null>;
  /**
   * Applies one op to a staff cart as `actor` (`CartAgent.applyAs`), and the cart as it is after
   * it, priced again. An external cart is changed only on its buyer's page, so it is not found here.
   */
  changeCart(
    cartId: string,
    op: CartOp,
    /** A staff actor signed for `cart:<cartId>`. */
    actor: SignedActor,
  ): Promise<CartAnswer<{ cart: CartView }>>;
  /**
   * Submits a priced staff cart as an order of its flow, once (`CartAgent.submitAs`). With
   * `version`, only if the cart is still at that version (`CART_CHANGED_SINCE_CONFIRM` otherwise).
   */
  submitCart(
    cartId: string,
    actor: SignedActor,
    version?: number,
  ): Promise<CartAnswer<{ orderId: string }>>;
  /** Cancels a staff cart that hasn't ended (`CartAgent.cancelAs`). */
  cancelCart(cartId: string, actor: SignedActor): Promise<CartAnswer<{ cart: CartView }>>;
  /**
   * Saves an assistant draft's test cases (as an admin edited them) and runs them on its bundle in
   * the sandbox. Approving it needs every case passing.
   */
  runPluginCases(
    id: string,
    sha: string,
    cases: PluginCase[],
    by: string,
  ): Promise<Refusable<PluginCaseResult[]>>;
  /**
   * Adds a file the web app has stored (at `cartAttachmentKey`) to a staff cart, as `actor`; refused
   * for anyone who may not change the cart, a cart that has ended, or one that is full. An
   * external cart's buyer adds files through the storefront's `StorefrontRpc.addCartFile`.
   */
  attachToCart(
    cartId: string,
    attachment: Omit<CartAttachment, 'by' | 'at'>,
    /** Staff, signed for `cart:<cartId>`. */
    actor: SignedActor,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Finds products to add to a cart by SKU or name (`CART_SEARCH_LIMIT` at most), among those its
   * quote can price, with the unit price its flow charges where that is shown. Only for someone
   * who may change the cart while it is open; an empty `q` lists the first products by SKU.
   */
  searchCartProducts(
    cartId: string,
    q: string,
    /** Staff, signed for `cart:<cartId>`. */
    actor: SignedActor,
  ): Promise<CartAnswer<CartProductPage>>;
  /**
   * A customer's tax exemption certificates, oldest first, revoked ones included; null for an id
   * no customer has.
   */
  taxCertificates(customerId: string): Promise<TaxCertificate[] | null>;
  /**
   * Adds a certificate to a customer, unverified (it exempts nothing until verified), with the file
   * the web app stored at `taxCertificateKey`, if any. The certificate calls take staff at least
   * Operator, signed for `tax-certificates:<customerId>`; anyone else is refused. Each says whether
   * it changed anything: adding an id already there, or verifying or revoking again, doesn't.
   */
  addTaxCertificate(
    customerId: string,
    input: TaxCertificateInput,
    actor: SignedActor,
  ): Promise<Refusable<TaxCertificateChange>>;
  /**
   * Records that `actor` checked an active certificate with its issuer: orders placed from now are
   * exempt. With approval separation on, refused to whoever added it.
   */
  verifyTaxCertificate(
    customerId: string,
    id: string,
    actor: SignedActor,
  ): Promise<Refusable<TaxCertificateChange>>;
  /** Stops a certificate exempting orders placed from now. The row stays, revoked, for the record. */
  revokeTaxCertificate(
    customerId: string,
    id: string,
    actor: SignedActor,
  ): Promise<Refusable<TaxCertificateChange>>;
  /**
   * Forgets every A2A push config a person (or token) registered, and what is still queued for
   * them, when their connected apps end: a client that can no longer call /a2a stops hearing too.
   * `grants` names the apps (each app's A2A caller is its own, `a2aCaller`); without it, only
   * what the person or token registered outside any app. With `grantsOnly` and `grants`, only
   * those apps': an app ending its own access doesn't end the person's own push configs.
   */
  dropA2aPushes(
    kind: 'user' | 'token',
    id: string,
    grants?: readonly string[],
    grantsOnly?: boolean,
  ): Promise<{ configs: number }>;
}

/**
 * A change to a staff cart: done, refused (`error`, to show as it is), or `notFound` for an id no
 * staff cart has.
 */
export type CartAnswer<T> = ({ ok: true } & T) | { ok: false; error: string; notFound?: true };

/**
 * All the public storefront Worker can ask of the engine: the `StorefrontApi` entrypoint, which
 * the storefront binds instead of `EngineApi`. Every cart call takes the buyer as an actor the
 * storefront signed (`signGuestActor`, under `storefrontKey`) for `cart:<cartId>`, and the engine
 * admits it only to an external cart whose buyer it is. There is no staff, order, payment, plugin
 * or data-subject method here, and `fetch` serves only a cart's socket and `/ucp/*`.
 */
export interface StorefrontRpc {
  /** A cart's socket (`/agents/cart-agent/*`) or UCP (`/ucp/*`), signed for its path; anything else is 404. */
  fetch(request: Request): Promise<Response>;
  /** Deep health: the engine's own D1 and R2 bindings answer. */
  health(): Promise<HealthReport>;
  /** The UCP business profile with `origin`'s URLs, or null while agentic checkout is off. */
  ucpProfile(origin: string): Promise<Record<string, unknown> | null>;
  /** Whether agentic checkout is on (a checkout flow is set); changes rarely, so callers may cache it. */
  ucpCheckoutOn(): Promise<boolean>;
  /**
   * The live platform behind an API key (by its SHA-256), or null for an unknown or revoked one.
   * The engine records its use.
   */
  ucpPlatform(keyHash: string): Promise<UcpPlatformRef | null>;
  /**
   * Redeems an external cart's one-time start link: the buyer it admits and until when (the latest
   * the cart can stay open, `externalCartEnd`), or null for a link that is unknown, used or
   * expired, or a cart that has ended.
   */
  redeemCartStart(
    cartId: string,
    token: string,
  ): Promise<{ guest: CartGuest; expiresAt: number } | null>;
  /**
   * What the storefront offers: whether hosted checkout is on, whether a buyer may change the
   * lines, and whether payments are only recorded (a test order, no card). Changes rarely, so
   * callers may cache it.
   */
  storefrontSettings(): Promise<HostedCheckoutSettings>;
  /**
   * Redeems a hosted checkout's one-time start link, once: the engine mints the buyer's cookie
   * secret (it keeps only its hash) and returns it with the session's end, for the storefront to
   * set as the cookie. Null for a link that is unknown, used or expired, or while hosted checkout is off.
   */
  redeemCheckoutStart(
    checkoutId: string,
    token: string,
  ): Promise<{ secret: string; expiresAt: number } | null>;
  /**
   * The hosted session for the buyer holding the cookie `secret` (the value `redeemCheckoutStart`
   * returned; the engine hashes it to compare), with `actor` signed for `checkout:<id>`; null for anyone else's, a UCP platform's, an unknown one, or while
   * hosted checkout is off.
   */
  checkout(checkoutId: string, secret: string, actor: SignedActor): Promise<HostedCheckout | null>;
  /**
   * Changes the buyer's session: `patch` may set the buyer, ship-to, shipping option, fulfillment,
   * store and promo codes, and the lines only when the merchant's setting allows it; it can set no
   * price. `version` is the session version the buyer's page showed: when it is no longer the
   * session's, nothing is changed and the answer is `changed` with the session as it is. Null as
   * `checkout`; otherwise the session as it is now, or why not.
   */
  updateCheckout(
    checkoutId: string,
    patch: unknown,
    secret: string,
    actor: SignedActor,
    version?: number,
  ): Promise<HostedChange | null>;
  /**
   * Places the order for the buyer's session, in test mode only (PAYMENTS_MODE "mock": the payment
   * is recorded, no card is taken). Null as `checkout`; refused, with the session as it is, when
   * payments are real, the session isn't ready, or it changed while this ran. `shown` is the version
   * and total the buyer's page showed: a session at another version, or priced differently now, is
   * `changed` and no order is placed. The buyer pays with
   * their own instrument only: nothing is ever charged to an account or a saved card.
   */
  completeCheckout(
    checkoutId: string,
    secret: string,
    actor: SignedActor,
    shown?: { version: number; total: number },
  ): Promise<HostedChange | null>;
  /**
   * Pays the buyer's session by card (PAYMENTS_MODE "stripe"): `confirmationToken` is the Stripe
   * confirmation token the page made from its Payment Element, and `version` and `total` what the
   * page showed (a session at another version or priced differently now is `changed`, and nothing
   * is created). The engine prices again, claims the session, makes and confirms a PaymentIntent
   * for the quote's own total (never the page's), manual capture and no redirects, and starts the
   * order adopting it. The hold is the buyer's own: never an account, credit or a saved card. A
   * decline or a refusal reopens the session with the reason; a card that needs the buyer's bank
   * answers `authenticate`. Null as `checkout`; refused in test mode (use `completeCheckout`).
   */
  payCheckout(
    checkoutId: string,
    secret: string,
    actor: SignedActor,
    pay: HostedPayInput,
  ): Promise<HostedPayment | null>;
  /**
   * Finishes a card payment the buyer authenticated: retrieves the session's PaymentIntent, checks
   * it is for this checkout and the quoted amount and is an open authorization, and places the
   * order. A payment the bank refused releases the hold and reopens the session.
   */
  confirmCheckoutPayment(
    checkoutId: string,
    secret: string,
    actor: SignedActor,
  ): Promise<HostedChange | null>;
  /**
   * The file Apple Pay's domain verification fetches from the storefront
   * (`/.well-known/apple-developer-merchantid-domain-association`), or null when the deployment
   * has none. Public text; changes rarely, so callers may cache it.
   */
  applePayDomainAssociation(): Promise<string | null>;
  /** The cart as its agent holds it, or null unless `actor` is that external cart's buyer. */
  cartSnapshot(cartId: string, actor: SignedActor): Promise<CartState | null>;
  /** The name of the cart's customer, for its page, or null. */
  cartCustomerName(cartId: string, actor: SignedActor): Promise<string | null>;
  /**
   * Stores a file in the documents bucket at `cartAttachmentKey` and adds it to the cart as its
   * buyer, or says why not (a type or size the cart doesn't take, a cart that has ended or is
   * full); a file the cart refuses is not kept.
   */
  addCartFile(
    cartId: string,
    file: { id: string; name: string; type: string; body: ArrayBuffer },
    actor: SignedActor,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /** One of the cart's files for its buyer, or null for one the cart doesn't hold. */
  readCartFile(
    cartId: string,
    attachmentId: string,
    actor: SignedActor,
  ): Promise<{ body: ReadableStream } | null>;
  /** Counts a request from the buyer (a file download, say) as activity (`extendedCartExpiry`). */
  keepCartOpen(cartId: string, actor: SignedActor): Promise<void>;
  /**
   * An order as its buyer may see it (`BuyerOrderView`: no timeline, audit or notes), or null unless
   * `credential` is one of the order's live order-view credentials, as the confirmation email's
   * link carries it. Unknown, expired and wrong all answer null, so a caller learns nothing about
   * which orders exist.
   */
  orderReceipt(orderId: string, credential: string): Promise<BuyerOrderView | null>;
  /**
   * Sends a sign-in code and link to `email`, once a minute at most (`ShopperStart`). The answer
   * never depends on whether the address has orders. `actor` is signed for `shopper` (as are the
   * calls below): the engine takes the storefront's word under that call alone.
   */
  startShopperSignIn(email: string, actor: SignedActor): Promise<ShopperStart>;
  /**
   * Redeems the emailed code, once, for the address it was sent to; five wrong tries spend it. The
   * engine mints the session secret (keeping only its hash) and returns it for the storefront to
   * set as the cookie. Null for any refusal: wrong, used, expired or never sent look the same.
   */
  redeemShopperCode(
    email: string,
    code: string,
    actor: SignedActor,
  ): Promise<ShopperSignedIn | null>;
  /**
   * Who an unspent emailed link would sign in, as `p***@example.com`, or null for one that is
   * unknown, used or expired. Reads only: the page it is shown on is opened by mail scanners too,
   * and shows the shopper whose mailbox the link is for before they tap it.
   */
  shopperLinkPreview(token: string, actor: SignedActor): Promise<{ masked: string } | null>;
  /** Redeems the emailed link's token, once, as `redeemShopperCode` does. */
  redeemShopperLink(token: string, actor: SignedActor): Promise<ShopperSignedIn | null>;
  /**
   * Who the cookie's `secret` (the value a redemption returned; the engine hashes it to compare)
   * is signed in as, or null for an unknown, expired or ended one. A stored hash is no secret.
   */
  shopper(secret: string, actor: SignedActor): Promise<ShopperView | null>;
  /** Ends the session the cookie's `secret` names; nothing for one that is already gone. */
  shopperSignOut(secret: string, actor: SignedActor): Promise<void>;
  /**
   * A page of the orders placed under the session's address (`orders.contact_email`), newest first,
   * with `next`, the cursor of the page after it; a `cursor` that isn't one starts from the top.
   * Null with no session (unknown, ended, expired, or `secret` a stored hash). The scope is the
   * session's email and nothing the caller sends: erased orders have no address left and never show.
   * The account calls take `secret` and `actor` as `shopper` does.
   */
  shopperOrders(
    secret: string,
    actor: SignedActor,
    cursor?: string,
  ): Promise<ShopperOrderPage | null>;
  /**
   * One of those orders as its buyer sees it (`BuyerOrderView`), after checking again that it was
   * placed under the session's address. Another address's order, an erased one, an unknown id and
   * no session all answer null, so a caller learns nothing about which orders exist.
   */
  shopperOrder(secret: string, actor: SignedActor, id: string): Promise<BuyerOrderView | null>;
  /**
   * The places the shopper has shipped to: the ship-tos of their newest orders and the address
   * book's entries for a consumer customer with that email (never a business customer's, nor a
   * company member's), de-duplicated, most recently used first. Null with no session.
   */
  shopperAddresses(secret: string, actor: SignedActor): Promise<ShopperAddresses | null>;
  /**
   * Forgets one address-book entry by the id `shopperAddresses` gave; only entries of the
   * session's own email can go, an order's place is its record and stays. True when one was
   * forgotten, false for anything else and for a repeat.
   */
  forgetAddress(secret: string, actor: SignedActor, id: string): Promise<boolean>;
  /** Finds products to add to the cart by SKU or name, as `EngineRpc.searchCartProducts` does. */
  searchCartProducts(
    cartId: string,
    q: string,
    actor: SignedActor,
  ): Promise<CartAnswer<CartProductPage>>;
}

/**
 * One product index run: `done` with what it embedded (`indexed`), the SKUs whose vectors it
 * deleted (`removed`) and whether more were waiting than a run takes (`more`); `no_index` on a
 * deployment without one (a demo, local dev, mock AI), where extraction matches by words alone; or
 * `busy` while another run (the hourly cron's, another admin's) holds the lease.
 */
export type ProductReindex =
  | { status: 'done'; indexed: number; removed: number; more: boolean }
  | { status: 'no_index' }
  | { status: 'busy' };

/** What an engine call returns when it may be refused: its value, or why not (to show as it is). */
export type Refusable<T> = { ok: true; value: T } | { ok: false; error: string };
