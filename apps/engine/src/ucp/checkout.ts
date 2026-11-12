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
  CHECKOUT_CAPABILITY,
  type CheckoutPatch,
  type CheckoutSession,
  checkoutFlowProblem,
  checkoutPatch,
  type FlowGraph,
  type FlowVersion,
  FULFILLMENT_CAPABILITY,
  IDENTITY_LINKING_CAPABILITY,
  isFinalCheckout,
  isOpenCheckout,
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
import { bump, current, newSession, refresh, save } from '../checkout/session';
import { loadFlowVersion } from '../flows';
import { orderAgent } from '../namespaces';
import {
  checkoutSessions,
  orderQueries,
  paymentLedger,
  pricingStore,
  shippingStore,
} from '../wire';
import { ucpOrderCaller } from './caller';
import { paymentHandlers, ucpSettings } from './config';
import { linkedShopperFor } from './identity-link';
import { authorizeCheckout } from './payments';

export type UcpResult = { status: number; body: unknown; headers?: Record<string, string> };

/** Who is asking, and what was negotiated with them. */
export type UcpContext = {
  caller: PlatformCaller;
  capabilities: Map<UcpCapability, string>;
};

const protocol = (status: number, code: string, content: string): UcpResult => ({
  status,
  body: ucpError(code, content),
});

/**
 * The refusal for a platform that didn't negotiate checkout, or null. Every checkout operation
 * asks first, before it reads or claims anything: negotiating only the catalog or only orders
 * doesn't let a platform start a checkout.
 */
export function checkoutRefusal(ctx: UcpContext): UcpResult | null {
  return ctx.capabilities.has(CHECKOUT_CAPABILITY)
    ? null
    : protocol(403, 'forbidden', `The platform profile does not support ${CHECKOUT_CAPABILITY}.`);
}

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
  const s = await refresh(
    env,
    flow,
    patchCheckout(newSession(ctx.caller.id), checkoutPatch(input, undefined, ctx.capabilities)),
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
  // Checked on the version loaded now: a later publish may no longer authorize a card.
  if (!flow || checkoutFlowProblem(flow as unknown as FlowGraph))
    return protocol(503, 'unavailable', 'Checkout is not set up for this business.');
  const caller: CheckoutCaller = {
    ...callerOf(ctx),
    ...ucpOrderCaller(ctx.caller.id, s.id, ctx.caller.origin),
  };
  const instrument = selectedInstrument(parsed.data);
  const handler = paymentHandlers(env).find((h) => h.id === instrument?.handler_id);
  const done = await completeSession(
    env,
    caller,
    flow,
    s,
    {
      refusal:
        instrument && handler
          ? null
          : {
              code: 'payment_failed',
              content: 'Select one instrument of a payment handler this checkout offers.',
            },
      authorize: (claimed) => authorizeCheckout(env, claimed, handler!.name, instrument!),
    },
    // The origin is kept with the claim: the sweep places the order from the session alone.
    { claim: { completedOn: ctx.caller.origin } },
  );
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

/**
 * An order for a platform. With no `userToken` it is the platform's own: one a checkout of its
 * placed. With a linked shopper's access token (`Authorization: Bearer`, which the storefront
 * passes on) it is the shopper's: any order a checkout placed under their address, whoever's
 * checkout it was, and only for a token issued to this platform with `order:read` while the
 * platform lists identity linking. A token that doesn't qualify is refused (401, not silently
 * treated as no token), so a platform with an expired one learns to refresh it.
 */
export async function getOrder(
  env: Env,
  ctx: UcpContext,
  orderId: string,
  userToken?: string | null,
): Promise<UcpResult> {
  if (!ctx.capabilities.has(ORDER_CAPABILITY))
    return protocol(
      403,
      'forbidden',
      'The platform profile does not support dev.ucp.shopping.order.',
    );
  if (userToken === undefined || userToken === null) {
    const found = await orderEntity(env, orderId, ctx.capabilities, ctx.caller.origin);
    if (!found || found.session.ownerId !== ctx.caller.id) return gone('Order not found.');
    return { status: 200, body: found.entity };
  }
  const shopper = ctx.capabilities.has(IDENTITY_LINKING_CAPABILITY)
    ? await linkedShopperFor(env, userToken, ctx.caller.id)
    : null;
  if (!shopper)
    return {
      status: 401,
      body: ucpError(
        'unauthorized',
        'The access token is not valid for this platform, or has expired.',
      ),
      headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
    };
  // Placed under the shopper's address, as the account's own order page asks (`placedUnder`: the
  // order row's contact, an erased order names no one), and before anything of the order is read, so
  // an order that is another's, erased or unknown answers alike.
  if (!(await orderQueries(env).placedUnder(shopper.email, orderId)))
    return gone('Order not found.');
  const found = await orderEntity(env, orderId, ctx.capabilities, ctx.caller.origin);
  if (!found) return gone('Order not found.');
  return { status: 200, body: found.entity };
}
