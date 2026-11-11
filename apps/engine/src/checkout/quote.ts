/**
 * Prices a checkout session with the checkout flow's own pricing nodes (validate, price, shipping
 * rate, tax and its store policy: `quoteNodes`), run in process on a draft of the order the session
 * would start; a policy the session breaks is an error the agent can fix. The
 * order the flow later runs prices the same lines the same way, so the PaymentIntent authorized at
 * completion matches the total its authorize node adopts. Nothing here writes: those executors
 * only read the catalog, prices, exchange rates and shipping rates.
 */

import { NonRetryableError } from 'cloudflare:workflows';
import {
  type AppliedPromotion,
  BASE_CURRENCY,
  type CheckoutIssue,
  type CheckoutQuote,
  type CheckoutSession,
  checkAddress,
  type FlowVersion,
  isBuySide,
  isPickup,
  type Order,
  type OrderChannel,
  type OrderLine,
  quoteNodes,
  type RunContext,
  type ShippingOption,
  taxExemptNote,
  withDefaults,
} from '@commerceworker/core';
import { EXECUTORS } from '../nodes';
import { providerOfError } from '../providers';
import { pricingStore } from '../wire';
import { stockShort } from '../words';

export type Quoted = { quote: CheckoutQuote | null; issues: CheckoutIssue[] };

const issue = (code: string, content: string, path: string): CheckoutIssue => ({
  kind: 'error',
  code,
  content,
  path,
  severity: 'recoverable',
});

/**
 * What a caller other than UCP adds to the draft: a cart is priced for its customer (contract
 * prices, credit) and carries its promo codes in `meta`.
 */
export type DraftExtra = {
  customerId?: string;
  channel?: OrderChannel;
  meta?: Record<string, unknown>;
};

/** The order a session would start, before any node has priced it. */
export function draftOrder(
  flow: FlowVersion,
  s: CheckoutSession,
  ships: boolean,
  extra: DraftExtra = {},
): Order {
  const name = [s.buyer.firstName, s.buyer.lastName].filter(Boolean).join(' ');
  return {
    id: `quote_${s.id}`,
    model: flow.model,
    channel: extra.channel ?? 'agent',
    externalId: s.id,
    ...(extra.customerId ? { customerId: extra.customerId } : {}),
    currency: s.currency,
    lines: s.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    ...(s.buyer.email
      ? {
          contact: {
            email: s.buyer.email,
            ...(name ? { name } : {}),
            ...(s.buyer.phone ? { phone: s.buyer.phone } : {}),
          },
        }
      : {}),
    fulfillment: !ships
      ? { method: 'digital' }
      : isPickup(s)
        ? { method: 'pickup', locationId: s.pickupLocationId! }
        : { method: 'ship' },
    ...(s.shippingOption ? { shippingOption: s.shippingOption } : {}),
    meta: {
      ...extra.meta,
      ...(s.promoCodes?.length ? { promoCodes: s.promoCodes } : {}),
      ...(s.shipTo ? { shipTo: s.shipTo } : {}),
    },
    createdAt: s.createdAt,
    subtotal: 0,
    shipping: 0,
    tax: 0,
    total: 0,
  };
}

export async function quoteCheckout(
  env: Env,
  flow: FlowVersion,
  s: CheckoutSession,
  extra: DraftExtra = {},
): Promise<Quoted> {
  const issues: CheckoutIssue[] = [];
  const products = new Map(
    (await pricingStore(env).products(s.lines.map((l) => l.sku))).map((p) => [p.sku, p]),
  );
  const held = new Map<string, number>();
  for (const [i, l] of s.lines.entries()) {
    const p = products.get(l.sku);
    if (!p) {
      issues.push(issue('item_unavailable', `${l.sku} is not sold here.`, `$.line_items[${i}]`));
      continue;
    }
    // A pickup draws on its store's stock, not the warehouse's: the store check in the checkout
    // (`pickupCheck`) holds it to that.
    if (p.kind === 'digital' || isPickup(s)) continue;
    const wanted = (held.get(l.sku) ?? 0) + l.qty;
    held.set(l.sku, wanted);
    if (wanted > p.stock - p.reserved)
      issues.push(
        issue(
          'out_of_stock',
          stockShort(p.name, Math.max(0, p.stock - p.reserved)),
          `$.line_items[${i}].quantity`,
        ),
      );
  }
  if (issues.some((i) => i.code === 'item_unavailable')) return { quote: null, issues };
  const ships = s.lines.some((l) => products.get(l.sku)?.kind !== 'digital');
  if (ships && s.shipTo && checkAddress(s.shipTo).status === 'invalid')
    issues.push(
      issue(
        'address_undeliverable',
        'The shipping address is incomplete or not valid.',
        '$.fulfillment',
      ),
    );

  const ctx: RunContext = {
    order: draftOrder(flow, s, ships, extra),
    nodes: {},
    vars: {},
    input: {},
    now: Date.now(),
    ref: s.id,
  };
  let options: ShippingOption[] = [];
  let chosen: string | null = null;
  let listed: OrderLine[] | null = null;
  let discounts: CheckoutQuote['discounts'];
  for (const node of quoteNodes(flow)) {
    const exec = EXECUTORS[node.type];
    if (!exec) continue;
    try {
      if (node.type === 'commerce.discount') listed = ctx.order.lines;
      const r = await exec({
        env,
        node,
        config: withDefaults(node.type, node.config),
        ctx,
        stepKey: `quote#${node.id}`,
        dryRun: true,
      });
      if (r.order) ctx.order = { ...ctx.order, ...r.order };
      if (node.type === 'commerce.policy' && r.branches?.includes('fail'))
        for (const failure of (r.vars?.policyFailures as string[] | undefined) ?? [])
          issues.push(issue('policy', failure, '$'));
      // A code the promotions step left out says why, without stopping the checkout.
      if (node.type === 'commerce.discount') {
        for (const reason of (r.vars?.promotionsRefused as string[] | undefined) ?? [])
          issues.push({
            kind: 'warning',
            code: 'promotion',
            content: reason,
            path: '$.promoCodes',
          });
        const out = r.output as {
          applied: AppliedPromotion[];
          refused: { code: string; reason: string }[];
        };
        discounts = {
          applied: out.applied.map((a) => ({
            code: a.code,
            title: a.name || a.code || 'Discount',
            kind: a.kind,
            amount: a.amount,
          })),
          refused: out.refused,
        };
      }
      // Why the quote charges less tax: the customer's certificate (a cart's; UCP buyers have
      // none). With a provider, only when it says the certificate exempted the order.
      const exempt = (
        r.output as { exemption?: { certificate?: string; exempted: boolean } } | undefined
      )?.exemption;
      if (node.type === 'commerce.tax' && exempt?.exempted)
        issues.push({
          kind: 'info',
          code: 'tax_exempt',
          content: taxExemptNote({ number: exempt.certificate }),
        });
      if (node.type === 'commerce.shipping_rate') {
        const out = (r.output ?? {}) as {
          options?: ShippingOption[];
          option?: ShippingOption | null;
        };
        options = out.options ?? [];
        chosen = out.option?.id ?? null;
        if (r.branches?.includes('unavailable'))
          issues.push(
            issue(
              s.shippingOption && options.length
                ? 'fulfillment_option_unavailable'
                : 'address_undeliverable',
              s.shippingOption && options.length
                ? `The shipping option “${s.shippingOption}” is not offered.`
                : 'Nothing ships to this address.',
              '$.fulfillment',
            ),
          );
      }
    } catch (err) {
      // A provider's failure (retryable or not) is an issue the platform can retry on, with a
      // fixed message: a provider's own text never reaches the buyer's agent.
      if (providerOfError(err)) {
        console.warn(`pricing checkout ${s.id}: provider ${providerOfError(err)}`, err);
        issues.push(issue('invalid', 'Shipping or tax could not be calculated right now.', '$'));
        return { quote: null, issues };
      }
      if (!(err instanceof NonRetryableError)) throw err;
      issues.push(issue('invalid', err.message, '$'));
      return { quote: null, issues };
    }
  }
  const o = ctx.order;
  return {
    quote: {
      currency: o.currency || BASE_CURRENCY,
      lines: o.lines.map((l, i) => ({
        id: s.lines[i]!.id,
        sku: l.sku,
        title: l.name ?? products.get(l.sku)?.name ?? l.sku,
        qty: l.qty,
        unitPrice: l.unitPrice ?? 0,
        ships: products.get(l.sku)?.kind !== 'digital',
        ...(listed ? { listPrice: listed[i]?.unitPrice ?? l.unitPrice ?? 0 } : {}),
      })),
      subtotal: o.subtotal,
      shipping: o.shipping ?? 0,
      tax: o.tax,
      total: o.total,
      shippingOptions: options,
      shippingOption: chosen,
      ships,
      ...(discounts ? { discounts } : {}),
    },
    issues,
  };
}

/**
 * What the flow's Price lines step charges for one of each SKU on the session's draft order: its
 * customer's contract prices and price rules, in its currency, before promotions, shipping and tax.
 * Run in process as a quote runs it, with the same draft, so a search shows what the quote then
 * charges for a line of one. Only the Price lines step runs: the one quote step before it
 * (validate) names and checks lines without pricing them (tests/cart-search.test.ts pins the two
 * prices together). `atCost` when the step prices at cost (basis `cost`, or `auto` on a
 * buy-side flow), for the caller to decide who may see a cost. Null when the flow has no Price
 * lines step or it can't price now (no exchange rate, say): the search then shows no prices.
 */
export async function unitPrices(
  env: Env,
  flow: FlowVersion,
  s: CheckoutSession,
  skus: string[],
  extra: DraftExtra = {},
): Promise<{ prices: Map<string, number>; atCost: boolean } | null> {
  const node = quoteNodes(flow).find((n) => n.type === 'commerce.price');
  const exec = EXECUTORS['commerce.price'];
  if (!node || !exec || !skus.length) return null;
  const config = withDefaults(node.type, node.config);
  const atCost = config.basis === 'cost' || (config.basis === 'auto' && isBuySide(flow.model));
  const order = {
    ...draftOrder(flow, s, true, extra),
    lines: skus.map((sku) => ({ sku, qty: 1 })),
  };
  try {
    const r = await exec({
      env,
      node,
      config,
      ctx: { order, nodes: {}, vars: {}, input: {}, now: Date.now(), ref: s.id },
      stepKey: `quote#${node.id}`,
      dryRun: true,
    });
    const prices = new Map<string, number>();
    for (const l of r.order?.lines ?? [])
      if (l.unitPrice !== undefined) prices.set(l.sku, l.unitPrice);
    return { prices, atCost };
  } catch (err) {
    console.warn(`unit prices for ${s.id}`, err);
    return null;
  }
}
