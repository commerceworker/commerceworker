/**
 * The checkout and order operations as UCP serves them, the same for REST (./rest.ts) and MCP
 * (./mcp.ts). Each returns an HTTP status and the UCP body; the transports only frame them.
 *
 * This is the UCP adapter over the engine's checkout (../checkout/): it names the caller (the
 * platform, the `agent` channel, the `ucp:` idempotency prefix), says how the platform pays, and
 * maps the outcomes (a lost race is a 409, a refusal an error body). Sessions, pricing and the
 * completion sequence are the checkout's own.
 */

import {
  CHECKOUT_TTL_MS,
  type CheckoutPatch,
  type CheckoutSession,
  checkoutPatch,
  type FlowVersion,
  FULFILLMENT_CAPABILITY,
  isFinalCheckout,
  isOpenCheckout,
  newId,
  ORDER_CAPABILITY,
  type OrderState,
  orderPermalink,
  type PlatformCaller,
  patchCheckout,
  protocolIssues,
  selectedInstrument,
  toUcpCheckout,
  toUcpOrder,
  type UcpCapability,
  type UcpCheckoutInput,
  type UcpSettings,
  ucpCompleteInput,
  ucpError,
  ucpErrorResponse,
} from '@commerceworker/core';
import type { CheckoutCaller } from '../checkout/caller';
import { completeSession } from '../checkout/complete';
import { bump, current, refresh, save } from '../checkout/session';
import { loadFlowVersion } from '../flows';
import { orderAgent } from '../namespaces';
import { checkoutSessions, paymentLedger, pricingStore, shippingStore } from '../wire';
import { CHECKOUT_CURRENCY, paymentHandlers, ucpSettings } from './config';
import { authorizeCheckout } from './payments';

export type UcpResult = { status: number; body: unknown };

/** Who is asking, and what was negotiated with them. */
export type UcpContext = {
  caller: PlatformCaller;
  capabilities: Map<UcpCapability, string>;
};

const protocol = (status: number, code: string, content: string): UcpResult => ({
  status,
  body: ucpError(code, content),
});

const gone = (content: string): UcpResult => ({
  status: 200,
  body: ucpErrorResponse([
    { kind: 'error', code: 'not_found', content, severity: 'unrecoverable' },
  ]),
});

/** The platform as the checkout knows a caller. */
const callerOf = (ctx: UcpContext): CheckoutCaller => ({
  ownerId: ctx.caller.id,
  channel: 'agent',
  idempotencyPrefix: 'ucp',
  protocolIssues: (s) => protocolIssues(s, ctx.capabilities),
  pickupStores: ctx.capabilities.has(FULFILLMENT_CAPABILITY),
});

const raced = () =>
  protocol(409, 'conflict', 'The checkout changed while this request ran; get it and try again.');

async function checkoutFlow(env: Env, settings: UcpSettings): Promise<FlowVersion | null> {
  return settings.checkoutFlowId ? loadFlowVersion(env, settings.checkoutFlowId) : null;
}

async function respond(
  env: Env,
  s: CheckoutSession,
  ctx: UcpContext,
  status = 200,
  settings?: UcpSettings,
): Promise<UcpResult> {
  const conf = settings ?? (await ucpSettings(env));
  return {
    status,
    body: toUcpCheckout(s, {
      capabilities: ctx.capabilities,
      handlers: paymentHandlers(env),
      settings: conf,
      ...(s.orderId ? { permalink: orderPermalink(conf, ctx.caller.origin, s.orderId) } : {}),
    }),
  };
}

export async function createCheckout(
  env: Env,
  ctx: UcpContext,
  input: UcpCheckoutInput,
): Promise<UcpResult> {
  const settings = await ucpSettings(env);
  const flow = await checkoutFlow(env, settings);
  if (!flow) return protocol(503, 'unavailable', 'Checkout is not set up for this business.');
  const now = Date.now();
  const empty: CheckoutSession = {
    id: newId('chk'),
    ownerId: ctx.caller.id,
    status: 'incomplete',
    currency: CHECKOUT_CURRENCY,
    lines: [],
    buyer: {},
    fulfillment: 'ship',
    shipTo: null,
    shippingOption: null,
    quote: null,
    issues: [],
    orderId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CHECKOUT_TTL_MS,
    version: 1,
  };
  const s = await refresh(
    env,
    flow,
    patchCheckout(empty, checkoutPatch(input, undefined, ctx.capabilities)),
    callerOf(ctx),
    input,
  );
  // Nothing in it can be bought: there is no checkout to create.
  const unavailable = s.issues.filter((i) => i.code === 'item_unavailable');
  if (unavailable.length === s.lines.length)
    return {
      status: 200,
      body: ucpErrorResponse(
        unavailable.map((i) => ({ ...i, severity: 'unrecoverable' as const })),
      ),
    };
  await checkoutSessions(env).create(s);
  return respond(env, s, ctx, 201, settings);
}

export async function getCheckout(env: Env, ctx: UcpContext, id: string): Promise<UcpResult> {
  const s = await current(env, callerOf(ctx), id);
  return s ? respond(env, s, ctx) : gone('No such checkout.');
}

/** A refusal shown on the checkout as it is, without changing it. */
const asIs = (s: CheckoutSession, content: string, code = 'not_allowed'): CheckoutSession => ({
  ...s,
  issues: [...s.issues, { kind: 'error', code, content, severity: 'recoverable' }],
});

export async function updateCheckout(
  env: Env,
  ctx: UcpContext,
  id: string,
  input: UcpCheckoutInput,
): Promise<UcpResult> {
  const s = await current(env, callerOf(ctx), id);
  if (!s) return gone('No such checkout.');
  if (s.status === 'complete_in_progress')
    return respond(env, asIs(s, 'The checkout is being completed; it cannot change now.'), ctx);
  if (isFinalCheckout(s))
    return respond(env, asIs(s, `The checkout is ${s.status}; start a new one.`), ctx);
  const settings = await ucpSettings(env);
  const flow = await checkoutFlow(env, settings);
  if (!flow) return protocol(503, 'unavailable', 'Checkout is not set up for this business.');
  const patch: CheckoutPatch = checkoutPatch(input, s, ctx.capabilities);
  const next = await refresh(env, flow, bump(patchCheckout(s, patch), {}), callerOf(ctx), input);
  if (!(await save(env, next, s.version))) return raced();
  return respond(env, next, ctx, 200, settings);
}

export async function cancelCheckout(env: Env, ctx: UcpContext, id: string): Promise<UcpResult> {
  const s = await current(env, callerOf(ctx), id);
  if (!s) return gone('No such checkout.');
  if (!isOpenCheckout(s))
    return protocol(409, 'not_cancelable', `The checkout is ${s.status} and can't be canceled.`);
  const next = bump(s, { status: 'canceled', issues: [] });
  if (!(await save(env, next, s.version))) return raced();
  return respond(env, next, ctx);
}

export async function completeCheckout(
  env: Env,
  ctx: UcpContext,
  id: string,
  raw: unknown,
): Promise<UcpResult> {
  const parsed = ucpCompleteInput.safeParse(raw);
  if (!parsed.success)
    return protocol(
      400,
      'invalid_request',
      `Complete needs payment.instruments: ${parsed.error.issues[0]?.message}`,
    );
  const s = await current(env, callerOf(ctx), id);
  if (!s) return gone('No such checkout.');
  if (s.status === 'completed' || s.status === 'complete_in_progress') return respond(env, s, ctx);
  if (s.status === 'canceled') return respond(env, asIs(s, 'The checkout was canceled.'), ctx);

  const settings = await ucpSettings(env);
  const flow = await checkoutFlow(env, settings);
  if (!flow) return protocol(503, 'unavailable', 'Checkout is not set up for this business.');
  const caller: CheckoutCaller = {
    ...callerOf(ctx),
    meta: { ucp: { platformId: ctx.caller.id, checkoutId: s.id, origin: ctx.caller.origin } },
  };
  const instrument = selectedInstrument(parsed.data);
  const handler = paymentHandlers(env).find((h) => h.id === instrument?.handler_id);
  const done = await completeSession(env, caller, flow, s, {
    refusal:
      instrument && handler
        ? null
        : {
            code: 'payment_failed',
            content: 'Select one instrument of a payment handler this checkout offers.',
          },
    authorize: (claimed) => authorizeCheckout(env, claimed, handler!.name, instrument!),
  });
  return done.kind === 'raced' ? raced() : respond(env, done.session, ctx, 200, settings);
}

// ── Orders ────────────────────────────────────────────────────────────────

/** The session that placed `orderId`, if this platform's. */
export function sessionForOrder(env: Env, orderId: string) {
  return checkoutSessions(env).forOrder(orderId);
}

/** The UCP order entity for an order a checkout placed, or null. */
export async function orderEntity(
  env: Env,
  orderId: string,
  capabilities: Map<UcpCapability, string>,
  origin: string,
) {
  const s = await sessionForOrder(env, orderId);
  if (!s) return null;
  const state = (await orderAgent(env, orderId).snapshot()) as OrderState;
  if (!state.order) return null;
  const [ships, payments, catalog, settings] = await Promise.all([
    shippingStore(env).booked(orderId),
    paymentLedger(env).forOrder(orderId),
    pricingStore(env).products(state.order.lines.map((l) => l.sku)),
    ucpSettings(env),
  ]);
  const paid = payments.filter((p) => p.kind === 'refund');
  return {
    session: s,
    state,
    entity: toUcpOrder(
      {
        order: state.order,
        status: state.status,
        checkoutId: s.id,
        checkoutLines: s.lines,
        physical: new Set(catalog.filter((p) => p.kind !== 'digital').map((p) => p.sku)),
        shipTo: s.shipTo,
        shipments: ships,
        refunds: paid.map((r) => ({
          id: r.id,
          amount: r.amount,
          status: r.status,
          createdAt: r.createdAt,
        })),
        updatedAt: state.updatedAt,
        permalink: orderPermalink(settings, origin, orderId),
      },
      capabilities,
    ),
  };
}

export async function getOrder(env: Env, ctx: UcpContext, orderId: string): Promise<UcpResult> {
  if (!ctx.capabilities.has(ORDER_CAPABILITY))
    return protocol(
      403,
      'forbidden',
      'The platform profile does not support dev.ucp.shopping.order.',
    );
  const found = await orderEntity(env, orderId, ctx.capabilities, ctx.caller.origin);
  if (!found || found.session.ownerId !== ctx.caller.id) return gone('Order not found.');
  return { status: 200, body: found.entity };
}
