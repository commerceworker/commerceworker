/**
 * The payment use-cases: authorize, capture, charge, void and refund, recorded in the payments
 * ledger. `PaymentMode` says whether new payments go to the card processor; in mock mode they are
 * only recorded, and `order.meta.simulate` ("payment_decline", "charge_fail") drives failures.
 * Voids, captures and refunds follow the row's own `provider`, so rows made before a mode change
 * are still settled where they were made.
 *
 * Every processor write carries an idempotency key derived from the payment row id, which is
 * derived from the step's effect key: a retried step replays the processor's first answer and never
 * pays twice. The ledger is written only after the processor answers. The refund plan and the
 * ledger's totals are core rules (`planRefund`, `paidTotal`, `refundedTotal`).
 */
import {
  fromMinor,
  isPaid,
  isRefund,
  money,
  type Order,
  type PaymentSource,
  paidPayments,
  paidTotal,
  paymentSource,
  planRefund,
  refundableTotal,
  refundedTotal,
  type SavedPayment,
  toMinor,
} from '@commerceworker/core';
import {
  IntentStateError,
  type NewPayment,
  PaymentClaimedError,
  PaymentDeclinedError,
  type PaymentLedger,
  type PaymentMode,
  type PaymentProcessor,
  type PaymentProvider,
  type PaymentRecord,
  type ProcessorIntent,
} from '@commerceworker/ports/commerce';

export type PaymentPorts = { readonly ledger: PaymentLedger; readonly mode: PaymentMode };

export type PaymentPurpose = 'hold' | 'verify';

export type PaymentResult = {
  paymentId: string | null;
  amount: number;
  status: string;
  /** Processor payments only: the intent, and why it was declined. */
  intentId?: string;
  reason?: string;
};

/** A row id from its parts, safe for D1 and as an idempotency key. */
export const paymentRowId = (prefix: string, ...parts: string[]) =>
  `${prefix}_${parts.join('_')}`.replace(/[^\w-]/g, '_');

const simulate = (order: Order) => String(order.meta?.simulate ?? '');
const sum = (rows: readonly PaymentRecord[]) => rows.reduce((s, p) => s + p.amount, 0);

const resultOf = (row: PaymentRecord): PaymentResult => ({
  paymentId: row.id,
  amount: row.amount,
  status: row.status,
  ...(row.provider === 'stripe' && row.externalId ? { intentId: row.externalId } : {}),
  ...(row.provider === 'stripe' && row.ref && row.status !== 'captured' ? { reason: row.ref } : {}),
});

/** Records a row once; a retried step gets what the first attempt recorded, not what it asked. */
async function record(ports: PaymentPorts, p: NewPayment): Promise<PaymentResult> {
  const row = await ports.ledger.record(p);
  if (row.provider === 'stripe') return resultOf(row);
  return { paymentId: p.id, amount: row.amount, status: row.status };
}

/** The provider recorded for a payment the processor doesn't take. */
const localProvider = (ports: PaymentPorts, source?: PaymentSource): PaymentProvider =>
  source === 'external' || source === 'offline' ? source : ports.mode.live() ? 'offline' : 'mock';

/** What the order and the customer's account say the order can be paid with. */
async function savedPayment(ports: PaymentPorts, order: Order): Promise<SavedPayment> {
  const row = order.customerId ? await ports.ledger.customer(order.customerId) : undefined;
  return {
    stripeCustomerId: order.payment?.stripeCustomerId ?? row?.stripeCustomerId ?? null,
    paymentMethodId: row?.paymentMethodId ?? null,
  };
}

/**
 * The payment method a new intent confirms with. With test keys, an order that gives none pays
 * with the processor's test card, and `meta.simulate` swaps in the test card that is always declined.
 */
function paymentMethodFor(
  processor: PaymentProcessor,
  source: PaymentSource,
  order: Order,
  saved: SavedPayment,
  decline: boolean,
): string | null {
  if (processor.testMode && decline) return 'pm_card_visa_chargeDeclined';
  if (source === 'confirm') return order.payment?.paymentMethodId ?? null;
  if (source === 'off_session') return saved.paymentMethodId ?? null;
  return processor.testMode ? 'pm_card_visa' : null;
}

/** Why an intent made elsewhere can't pay for this order, or null when it can. */
async function adoptProblem(
  ports: PaymentPorts,
  pi: ProcessorIntent,
  order: Order,
): Promise<string | null> {
  const amount = toMinor(order.total, order.currency);
  if (pi.currency !== order.currency.toLowerCase())
    return `PaymentIntent is in ${pi.currency.toUpperCase()}, the order in ${order.currency}`;
  if (pi.amount !== amount)
    return `PaymentIntent is for ${pi.amount}, the order for ${amount} (minor units)`;
  if (pi.status !== 'requires_capture')
    return `PaymentIntent is ${pi.status}, not an open authorization`;
  if (pi.metadata?.order_id && pi.metadata.order_id !== order.id)
    return `PaymentIntent belongs to order ${pi.metadata.order_id}`;
  // A checkout's intent names its session, which is the order's external id.
  if (pi.metadata?.checkout_id && order.externalId && pi.metadata.checkout_id !== order.externalId)
    return `PaymentIntent belongs to checkout ${pi.metadata.checkout_id}`;
  const other = await ports.ledger.forExternalId(pi.id);
  const taken = other.find((r) => r.orderId !== order.id);
  return taken ? `PaymentIntent already pays order ${taken.orderId}` : null;
}

/**
 * The order's processor customer: given on the order, already on the account, or created once
 * (keyed by the account, so racing steps make one). A guest gets one per order, which isn't stored.
 */
export async function ensureProcessorCustomer(
  ledger: PaymentLedger,
  processor: PaymentProcessor,
  order: Pick<Order, 'id' | 'customerId' | 'payment' | 'contact'>,
): Promise<string> {
  if (order.payment?.stripeCustomerId) return order.payment.stripeCustomerId;
  const account = order.customerId ? await ledger.customer(order.customerId) : undefined;
  if (account?.stripeCustomerId) return account.stripeCustomerId;
  const created = await processor.createCustomer(
    account
      ? { email: account.email, name: account.name, metadata: { customer_id: account.id } }
      : {
          email: order.contact?.email,
          name: order.contact?.name,
          metadata: { order_id: order.id },
        },
    account ? paymentRowId('cust', account.id) : paymentRowId('cust', order.id),
  );
  if (!account) return created;
  return ledger.claimStripeCustomer(account.id, created);
}

// ── Authorize ─────────────────────────────────────────────────────────────

/**
 * `hold` places an authorization for the order total (status `authorized`, captured later).
 * `verify` checks the card, saves it on the customer for off-session charges, and releases the
 * hold at once (status `verified`), so nothing is left open for a capture that never comes.
 */
export async function authorizePayment(
  ports: PaymentPorts,
  order: Order,
  stepKey: string,
  method: string,
  purpose: PaymentPurpose = 'hold',
): Promise<PaymentResult> {
  const id = paymentRowId('pay', order.id, stepKey);
  const kind = `authorization:${method}`;
  const ok = purpose === 'verify' ? 'verified' : 'authorized';
  const declined = simulate(order) === 'payment_decline';
  const base = { id, orderId: order.id, kind, amount: order.total, currency: order.currency };

  if (!ports.mode.live()) {
    const provider = order.payment?.provider === 'external' ? 'external' : 'mock';
    return record(ports, { ...base, provider, status: declined ? 'declined' : ok });
  }

  const done = await ports.ledger.find(id);
  if (done) return resultOf(done);
  const processor = ports.mode.processor();
  const saved = await savedPayment(ports, order);
  const source = paymentSource(order, method, saved);
  const decline = (reason: string, intentId?: string) =>
    record(ports, {
      ...base,
      provider: processor.id,
      status: 'declined',
      ref: reason,
      externalId: intentId,
    });
  // A hosted checkout's buyer pays with the card they just gave and nothing else: whatever else the
  // order or its customer carries (a saved method, an account, a recorded payment) is never used.
  if (order.meta?.hosted === true && source !== 'adopt')
    return decline('A hosted checkout is paid with the buyer’s own card');
  if (source === 'external' || source === 'offline')
    return record(ports, { ...base, provider: source, status: declined ? 'declined' : ok });

  let pi: ProcessorIntent;
  try {
    if (source === 'adopt') {
      pi = await processor.retrieveIntent(order.payment!.intentId!);
      const problem = await adoptProblem(ports, pi, order);
      if (problem) return decline(problem, pi.id);
    } else {
      const pm = paymentMethodFor(processor, source, order, saved, declined);
      if (!pm) return decline('No payment method on the order or the customer');
      const customer =
        purpose === 'verify'
          ? await ensureProcessorCustomer(ports.ledger, processor, order)
          : (order.payment?.stripeCustomerId ??
            (source === 'off_session' ? saved.stripeCustomerId : undefined));
      pi = await processor.createIntent(
        {
          amount: toMinor(order.total, order.currency),
          currency: order.currency.toLowerCase(),
          capture: 'manual',
          paymentMethod: pm,
          customer: customer ?? undefined,
          offSession: source === 'off_session' ? true : undefined,
          saveForLater: purpose === 'verify' && source !== 'off_session' ? true : undefined,
          anyMethod: true,
          description: order.title,
          metadata: { order_id: order.id, step: stepKey },
        },
        id,
      );
    }
  } catch (err) {
    if (err instanceof PaymentDeclinedError) return decline(err.reason, err.intentId);
    throw err;
  }

  if (pi.status !== 'requires_capture')
    return decline(
      pi.status === 'requires_action' ? 'authentication_required' : `PaymentIntent is ${pi.status}`,
      pi.id,
    );

  if (purpose === 'verify') {
    await processor.cancelIntent(pi.id, `${id}_release`);
    if (order.customerId && pi.paymentMethod)
      await ports.ledger.saveCard(order.customerId, {
        paymentMethodId: pi.paymentMethod,
        ...(pi.customer ? { stripeCustomerId: pi.customer } : {}),
      });
  }
  try {
    return await record(ports, {
      ...base,
      provider: processor.id,
      status: ok,
      externalId: pi.id,
    });
  } catch (err) {
    // Another row claimed the intent between `adoptProblem`'s look and this insert: the ledger's
    // unique index let one win, and this one is declined like any other adoption of a taken intent.
    if (!(err instanceof PaymentClaimedError)) throw err;
    const taken = (await ports.ledger.forExternalId(pi.id)).find(
      (r) => r.id !== id && r.kind.startsWith('authorization:') && r.status !== 'declined',
    );
    return decline(
      taken
        ? `PaymentIntent already pays order ${taken.orderId}`
        : 'PaymentIntent is already claimed',
      pi.id,
    );
  }
}

// ── Void ──────────────────────────────────────────────────────────────────

/**
 * Compensation: voids every open authorization for the order. Idempotent: the processor cancels
 * first (an intent already canceled counts), and the ledger changes only after it has; an intent
 * captured in the meantime is left to the capture.
 */
export async function voidAuthorizations(ports: PaymentPorts, orderId: string) {
  const open = (await ports.ledger.forOrder(orderId)).filter((p) => p.status === 'authorized');
  let voided = 0;
  for (const row of open) {
    if (row.provider === 'stripe' && row.externalId) {
      const processor = ports.mode.processor();
      try {
        await processor.cancelIntent(row.externalId, paymentRowId('void', row.id));
      } catch (err) {
        if (!(err instanceof IntentStateError)) throw err;
        const status = err.status ?? (await processor.retrieveIntent(row.externalId)).status;
        if (status !== 'canceled') continue;
      }
    }
    if (await ports.ledger.voidAuthorization(row.id)) voided++;
  }
  return voided;
}

/**
 * The processor canceled an intent (it expired, or someone canceled it in its dashboard): its open
 * authorization is voided. Returns the orders whose payment changed.
 */
export function markIntentCanceled(ports: Pick<PaymentPorts, 'ledger'>, intentId: string) {
  return ports.ledger.voidIntent(intentId);
}

/** The order a processor intent pays, if CommerceWorker made or adopted it. */
export async function orderForIntent(ports: Pick<PaymentPorts, 'ledger'>, intentId: string) {
  const rows = await ports.ledger.forExternalId(intentId);
  return rows.find((r) => r.provider === 'stripe')?.orderId ?? null;
}

// ── Capture ───────────────────────────────────────────────────────────────

export async function capturePayment(ports: PaymentPorts, order: Order, stepKey: string) {
  const id = `cap_${stepKey}_${order.id}`.replace(/[^\w-]/g, '_');
  const failed = { paymentId: null, amount: 0, status: 'failed' };
  // A retry after the capture was recorded returns it rather than looking for an open authorization.
  const done = await ports.ledger.find(id);
  if (done) return { paymentId: id, amount: done.amount, status: done.status };
  const rows = await ports.ledger.forOrder(order.id);
  const auth = rows.find((p) => p.status === 'authorized');
  // Captured in the processor's dashboard (reconciliation recorded it): the money is taken.
  if (!auth) return reconciledCapture(rows) ?? failed;
  // Never more than the order now costs: lines dropped after authorizing (a seller rejecting
  // their part) are released, not charged.
  const amount = money(Math.min(auth.amount, order.total));
  const currency = auth.currency ?? order.currency;
  if (auth.provider === 'stripe' && auth.externalId) {
    try {
      await ports.mode.processor().captureIntent(auth.externalId, toMinor(amount, currency), id);
    } catch (err) {
      // Voided before the capture reached it: nothing to capture.
      if (!(err instanceof IntentStateError)) throw err;
      if (err.status !== 'succeeded') return failed;
    }
  }
  // One transaction: the authorization flips only if still open, and the capture is recorded only
  // if this call flipped it, so a void racing the capture leaves exactly one of them.
  const row = await ports.ledger.capture(auth.id, {
    id,
    orderId: order.id,
    kind: 'capture',
    amount,
    status: 'succeeded',
    ref: auth.id,
    provider: auth.provider,
    externalId: auth.externalId,
    currency,
  });
  if (row) return { paymentId: id, amount: row.amount, status: row.status };
  // Lost the flip to a capture recorded from the processor's event: the one that took this very
  // authorization stands. Never another authorization's capture.
  const taken = (await ports.ledger.forOrder(order.id)).find(
    (p) => p.kind === 'capture' && p.status === 'succeeded' && p.ref === auth.id,
  );
  return taken ? { paymentId: taken.id, amount: taken.amount, status: taken.status } : failed;
}

/**
 * The capture reconciliation recorded for the order's authorization (`cap_stripe_<intent>`), when no
 * capture step of ours has taken money on it: a dashboard capture that landed before the flow's own.
 * A capture made by an earlier step is some other authorization's, and is never reported as this one's.
 * (Two capture steps against one reconciled authorization would both see it.)
 */
function reconciledCapture(rows: readonly PaymentRecord[]) {
  const captures = rows.filter((p) => p.kind === 'capture' && p.status === 'succeeded');
  if (captures.some((p) => !p.id.startsWith('cap_stripe_'))) return undefined;
  const row = captures.find((p) => p.id.startsWith('cap_stripe_'));
  return row ? { paymentId: row.id, amount: row.amount, status: row.status } : undefined;
}

// ── Charge ────────────────────────────────────────────────────────────────

/** A guest's card, saved by this order's `verify` authorization (guests have no account to hold it). */
async function verifiedCard(
  ports: PaymentPorts,
  processor: PaymentProcessor,
  orderId: string,
): Promise<SavedPayment> {
  const row = (await ports.ledger.forOrder(orderId))
    .filter((p) => p.provider === 'stripe' && p.status === 'verified')
    .at(-1);
  if (!row?.externalId) return {};
  const pi = await processor.retrieveIntent(row.externalId);
  return pi.customer && pi.paymentMethod
    ? { stripeCustomerId: pi.customer, paymentMethodId: pi.paymentMethod }
    : {};
}

/** Charges the order total at once (a subscription renewal): off-session with the saved card. */
export async function charge(
  ports: PaymentPorts,
  order: Order,
  stepKey: string,
): Promise<PaymentResult> {
  const id = paymentRowId('chg', order.id, stepKey);
  const fail = simulate(order) === 'charge_fail';
  const base = { id, orderId: order.id, kind: 'charge', amount: order.total };
  const currency = order.currency;

  if (!ports.mode.live()) {
    const provider = order.payment?.provider === 'external' ? 'external' : 'mock';
    return record(ports, { ...base, currency, provider, status: fail ? 'failed' : 'succeeded' });
  }

  const done = await ports.ledger.find(id);
  if (done) return resultOf(done);
  const processor = ports.mode.processor();
  const saved = await savedPayment(ports, order);
  if (!saved.paymentMethodId) Object.assign(saved, await verifiedCard(ports, processor, order.id));
  // An intent the order arrived with paid for its first payment, not this one.
  const payment = order.payment && { ...order.payment, intentId: undefined };
  const source = paymentSource({ payment }, 'card', saved);
  if (source === 'external')
    return record(ports, {
      ...base,
      currency,
      provider: source,
      status: fail ? 'failed' : 'succeeded',
    });

  const failed = (reason: string, intentId?: string) =>
    record(ports, {
      ...base,
      currency,
      provider: processor.id,
      status: 'failed',
      ref: reason,
      externalId: intentId,
    });
  const pm = paymentMethodFor(processor, source, order, saved, fail);
  if (!pm) return failed('No saved payment method to charge');
  const customer =
    order.payment?.stripeCustomerId ??
    (source === 'off_session' ? (saved.stripeCustomerId ?? undefined) : undefined);
  let pi: ProcessorIntent;
  try {
    pi = await processor.createIntent(
      {
        amount: toMinor(order.total, currency),
        currency: currency.toLowerCase(),
        capture: 'automatic',
        paymentMethod: pm,
        customer,
        offSession: customer ? true : undefined,
        anyMethod: !customer,
        description: order.title,
        metadata: { order_id: order.id, step: stepKey },
      },
      id,
    );
  } catch (err) {
    if (err instanceof PaymentDeclinedError) return failed(err.reason, err.intentId);
    throw err;
  }
  if (pi.status !== 'succeeded') return failed(`PaymentIntent is ${pi.status}`, pi.id);
  return record(ports, {
    ...base,
    currency,
    provider: processor.id,
    status: 'succeeded',
    externalId: pi.id,
  });
}

/** A supplier payment (accounts payable): recorded, never sent to the card processor. */
export function paySupplier(ports: PaymentPorts, order: Order, stepKey: string) {
  return record(ports, {
    id: paymentRowId('chg', order.id, `ap_${stepKey}`),
    orderId: order.id,
    kind: 'charge',
    amount: order.total,
    status: 'succeeded',
    currency: order.currency,
    provider: localProvider(ports),
  });
}

// ── Refund ────────────────────────────────────────────────────────────────

/**
 * Refunds up to `requested` (everything still refundable when omitted) of the money captured or
 * charged on the order. Keyed by step: a retried step returns the refund it already made.
 *
 * When any of that money went through the processor, the refund is spread over the payments
 * newest first, one refund row (and processor refund) per payment it draws on: `rfd_…`, then
 * `rfd_…_1`, `rfd_…_2`.
 */
export async function refund(
  ports: PaymentPorts,
  order: Order,
  stepKey: string,
  requested?: number,
): Promise<PaymentResult> {
  const id = paymentRowId('rfd', order.id, stepKey);
  const rows = await ports.ledger.forOrder(order.id);
  if (paidPayments(rows).some((p) => p.provider === 'stripe'))
    return refundAcross(ports, order, id, rows, requested);

  const done = rows.find((p) => p.id === id);
  if (done) return { paymentId: id, amount: done.amount, status: done.status };
  const refundable = refundableTotal(rows);
  const amount = money(Math.min(requested ?? refundable, refundable));
  if (amount <= 0) return { paymentId: null, amount: 0, status: 'failed' };
  return record(ports, {
    id,
    orderId: order.id,
    kind: 'refund',
    amount,
    status: 'succeeded',
    currency: order.currency,
    provider: localProvider(ports),
  });
}

async function refundAcross(
  ports: PaymentPorts,
  order: Order,
  id: string,
  rows: PaymentRecord[],
  requested: number | undefined,
): Promise<PaymentResult> {
  // This step's own parts are left out of the plan, so a retry plans exactly what it did before.
  const mine = (p: PaymentRecord) => p.id === id || p.id.startsWith(`${id}_`);
  const plan = planRefund(
    rows.filter((p) => !mine(p)),
    requested,
  );
  if (!plan.length) {
    const made = rows.filter(mine);
    return made.length
      ? { paymentId: id, amount: money(sum(made)), status: 'succeeded' }
      : { paymentId: null, amount: 0, status: 'failed' };
  }

  const processor = plan.some((x) => x.payment.provider === 'stripe')
    ? ports.mode.processor()
    : null;
  const ids = plan.map((_, i) => (i === 0 ? id : `${id}_${i}`));
  const existing = new Set((await ports.ledger.findMany(ids)).map((r) => r.id));
  for (const [i, part] of plan.entries()) {
    const partId = ids[i]!;
    if (existing.has(partId)) continue;
    const currency = part.payment.currency ?? order.currency;
    let externalId: string | undefined;
    let status = 'succeeded';
    if (part.payment.provider === 'stripe' && part.payment.externalId && processor) {
      const r = await processor.refund(
        {
          intentId: part.payment.externalId,
          amount: toMinor(part.amount, currency),
          // `row_id`: where this part is recorded, so a refund whose answer we lost is recorded
          // under it by reconciliation and the step's own `record` then finds it.
          metadata: { order_id: order.id, payment_id: part.payment.id, row_id: partId },
        },
        partId,
      );
      externalId = r.id;
      if (r.status === 'failed' || r.status === 'canceled') status = 'failed';
    }
    try {
      await record(ports, {
        id: partId,
        orderId: order.id,
        kind: 'refund',
        amount: part.amount,
        status,
        currency,
        provider: part.payment.provider,
        ref: part.payment.id,
        externalId,
      });
    } catch (err) {
      // The refund is already a row (recorded from the processor's event under another id).
      if (!(err instanceof PaymentClaimedError)) throw err;
    }
  }
  const made = (await ports.ledger.findMany(ids)).filter(isRefund);
  const amount = money(sum(made));
  return amount > 0
    ? { paymentId: id, amount, status: 'succeeded' }
    : { paymentId: null, amount: 0, status: 'failed' };
}

/** What has been refunded on the order so far. */
export async function refundedAmount(ports: Pick<PaymentPorts, 'ledger'>, orderId: string) {
  return refundedTotal(await ports.ledger.forOrder(orderId));
}

/** Money captured or charged on the order, before refunds. */
export async function paidAmount(ports: Pick<PaymentPorts, 'ledger'>, orderId: string) {
  return paidTotal(await ports.ledger.forOrder(orderId));
}

// ── Reconciliation ────────────────────────────────────────────────────────

/**
 * What the processor's events say that the ledger has to catch up with. `mismatch` is something it
 * can't fix: the caller logs it at error level and counts it.
 */
export type ReconcileOutcome =
  | { status: 'recorded'; orderId: string }
  | { status: 'known'; orderId: string }
  | { status: 'unknown' }
  /** Not yet: what it depends on hasn't been applied. The event is offered again. */
  | { status: 'retry'; orderId: string }
  | { status: 'mismatch'; orderId?: string; reason: string };

/**
 * The processor took an authorization's money (a capture made in its dashboard, or one of ours whose
 * answer was lost): the authorization flips to `captured` and a capture row is recorded, once, through
 * the ledger's own transaction. An intent already captured or charged here is `known`.
 */
export async function reconcileCapture(
  ports: Pick<PaymentPorts, 'ledger'>,
  intentId: string,
  receivedMinor: number,
): Promise<ReconcileOutcome> {
  const rows = (await ports.ledger.forExternalId(intentId)).filter((r) => r.provider === 'stripe');
  const first = rows[0];
  if (!first) return { status: 'unknown' };
  const auth = rows.find((r) => r.kind.startsWith('authorization:') && r.status === 'authorized');
  if (!auth) {
    if (rows.some((r) => r.kind === 'capture' || r.kind === 'charge'))
      return { status: 'known', orderId: first.orderId };
    return {
      status: 'mismatch',
      orderId: first.orderId,
      reason: `${intentId} succeeded in the processor but its authorization here is ${first.status}`,
    };
  }
  const currency = auth.currency ?? 'USD';
  const id = paymentRowId('cap', 'stripe', intentId);
  const row = await ports.ledger.capture(auth.id, {
    id,
    orderId: auth.orderId,
    kind: 'capture',
    amount: money(Math.min(fromMinor(receivedMinor, currency), auth.amount)),
    status: 'succeeded',
    ref: auth.id,
    provider: auth.provider,
    externalId: intentId,
    currency,
  });
  return row
    ? { status: 'recorded', orderId: auth.orderId }
    : { status: 'known', orderId: auth.orderId };
}

/**
 * A refund the processor made that the ledger doesn't have: a dashboard refund, or one of ours whose
 * answer was lost before its step recorded it (it names its row in `metadata.row_id`, so the step's
 * own record then finds it). Only a refund that has succeeded is recorded; a pending one comes again
 * as `refund.updated`. A refund of an intent still only authorized here is `retry`: its capture's
 * event hasn't been applied yet, and the claim is released so the event comes again.
 */
export async function reconcileRefund(
  ports: Pick<PaymentPorts, 'ledger'>,
  intentId: string,
  refund: { id: string; amount: number; status: string; metadata: Record<string, string> },
): Promise<ReconcileOutcome> {
  const rows = (await ports.ledger.forExternalId(intentId)).filter((r) => r.provider === 'stripe');
  const paid = rows.filter((r) => isPaid(r)).at(-1);
  const orderId = (paid ?? rows[0])?.orderId;
  if (!orderId) return { status: 'unknown' };
  if (refund.status !== 'succeeded') return { status: 'known', orderId };
  if ((await ports.ledger.forExternalId(refund.id)).some((r) => r.kind === 'refund'))
    return { status: 'known', orderId };
  if (!paid) {
    if (rows.some((r) => r.kind.startsWith('authorization:') && r.status === 'authorized'))
      return { status: 'retry', orderId };
    return {
      status: 'mismatch',
      orderId,
      reason: `${refund.id} refunds ${intentId}, which has no captured payment here`,
    };
  }
  const currency = paid.currency ?? 'USD';
  try {
    await ports.ledger.record({
      id: refund.metadata.row_id || paymentRowId('rfd', 'stripe', refund.id),
      orderId,
      kind: 'refund',
      amount: fromMinor(refund.amount, currency),
      status: 'succeeded',
      ref: refund.metadata.payment_id || paid.id,
      provider: 'stripe',
      externalId: refund.id,
      currency,
    });
  } catch (err) {
    if (err instanceof PaymentClaimedError) return { status: 'known', orderId };
    throw err;
  }
  return { status: 'recorded', orderId };
}
