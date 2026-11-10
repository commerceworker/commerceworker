/**
 * Executors for every node type that runs inside one durable `step.do`. Waiting and control-flow
 * nodes (approval, wait_event, wait, loop, end, continue_as_new) are handled by the interpreter
 * itself because they use `step.sleep` / `step.waitForEvent`.
 *
 * An executor returns the branch it took plus optional order and variable patches; the interpreter
 * applies the patches, so they replay deterministically from the memoized step result.
 */

import { NonRetryableError } from 'cloudflare:workflows';
import {
  answerSellerOrders,
  applyPromotions,
  bookReturnLabel,
  bookShipment,
  handOverOrder,
  MissingExchangeRateError,
  MissingLabelError,
  priceOrder,
  rateShipping,
  routeFulfillment,
  schedulePayouts,
  splitBySeller,
  taxOrder,
  voidShipmentLabels,
} from '@commerceworker/application/commerce';
import {
  type AiProvenance,
  assessBranch,
  assessQuestionsSchema,
  BASE_CURRENCY,
  budgetCheck,
  CUSTOMER_MATCHED_BY,
  checkAddress,
  creditCheck,
  DEFAULT_ORDER_BUDGET,
  describeAnswers,
  digitalLines,
  durationMs,
  evaluate,
  evaluatePolicy,
  type FlowNode,
  FULFILLMENT_METHOD_LABELS,
  type FulfillmentMethod,
  fromBase,
  getPath,
  guardRoute,
  interpolate,
  money,
  type NodeRegistry,
  ORDER_CHANNEL_LABELS,
  type Order,
  PROVIDER_MAX_TAX_RATE,
  policyRulesSchema,
  type RunContext,
  renderDocument,
  riskBranch,
  SHIPPING_SELECTIONS,
  type ShippingSelection,
  shippingConfigSchema,
  stockLines,
  stringList,
  taxExemptNote,
  taxRegionsSchema,
  threeWayMatch,
  truthy,
  uncheckedRoute,
  validateOrder,
} from '@commerceworker/core';
import * as ai from './ai';
import * as billing from './billing';
import * as clef from './clef';
import * as cx from './connectors';
import { refundedAmount } from './payments';
import { extractCatalog } from './product-index';
import { provide } from './providers';
import { liveCarrierQuote } from './shipping-rates';
import {
  balanceStore,
  commercePorts,
  documentStore,
  fulfillmentStore,
  inventoryStore,
  marketplaceStore,
  messageStore,
  pricingStore,
  shippingStore,
  taxCertificateStore,
} from './wire';
import { plural, varsSummary } from './words';

export type NodeResult = {
  branches?: string[];
  output?: unknown;
  summary?: string;
  order?: Partial<Order>;
  vars?: Record<string, unknown>;
  /** A plugin node's variables, merged into `vars.plugins[id]` (never over the flow's own). */
  pluginVars?: { id: string; vars: Record<string, unknown> };
};

export type ExecInput = {
  env: Env;
  node: FlowNode;
  config: Record<string, unknown>;
  ctx: RunContext;
  stepKey: string;
  /** The node types this run was planned with (its `load-plugins` snapshot, for plugin nodes). */
  registry?: NodeRegistry;
  /**
   * Pricing a checkout or cart (`quoteCheckout`), not running an order: nothing is written, so a
   * quote never redeems a promotion.
   */
  dryRun?: boolean;
  /**
   * The step has attempts left: a failed model call throws so the step retries, rather than
   * answering with the heuristic. Unset on the last attempt and outside a step.
   */
  retriesLeft?: boolean;
};

type Exec = (i: ExecInput) => Promise<NodeResult>;

/** How an AI node calls the model from its step (see `AiCall`). */
const aiCall = ({ ctx, retriesLeft }: ExecInput): ai.AiCall => ({
  retry: !!retriesLeft,
  orderId: ctx.order.id,
});

/**
 * The model didn't answer, outside mock mode. A risk score or route the heuristic made up must not
 * pass an order a model would have stopped, so those nodes fail closed on it.
 */
const unchecked = (via: AiProvenance) => via.source === 'heuristic' && via.fallback !== 'mock';

const str = (v: unknown, fb = '') => (typeof v === 'string' ? v : fb);
const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
/** Money for step summaries, in the order's currency: "$3,832.05". */
const cash = (n: number, ctx: RunContext) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: ctx.order.currency || 'USD',
  }).format(n);
const lineCount = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;

/** The plugin a node's Provider field names, or null for the built-in connector. */
const providerOf = (config: Record<string, unknown>) =>
  typeof config.provider === 'string' && config.provider && config.provider !== 'builtin'
    ? config.provider
    : null;

const passthrough: Exec = async () => ({ summary: 'Started' });

export const EXECUTORS: Record<string, Exec> = {
  'trigger.manual': passthrough,
  'trigger.webhook': async ({ ctx, config }) => {
    const { channel, externalId } = ctx.order;
    // The summary names the sending system only when the order says which it was (an inbound
    // order's `source`, e.g. "shopify"): the node's own default would repeat or contradict the channel.
    const given = str(ctx.order.meta?.source, '');
    const source = given || str(config.source, '');
    const named = given && given !== channel ? ` (${given})` : '';
    return {
      output: { channel, externalId: externalId ?? null, source },
      summary: `${ORDER_CHANNEL_LABELS[channel]}${externalId ? ` · ${externalId}` : ''}${named}`,
    };
  },
  'trigger.schedule': passthrough,
  'trigger.inventory_threshold': passthrough,
  'trigger.email_po': async ({ ctx }) => {
    const { channel, documentKey, externalId } = ctx.order;
    if (documentKey) return { summary: `Document ${documentKey.split('/').pop()}` };
    // The same flow takes EDI and API orders; say where this one came from.
    if (channel !== 'email')
      return { summary: `${ORDER_CHANNEL_LABELS[channel]}${externalId ? ` · ${externalId}` : ''}` };
    return { summary: 'Email received' };
  },

  'commerce.validate': async ({ env, ctx }) => {
    const [products, customer] = await Promise.all([
      pricingStore(env).products(ctx.order.lines.map((l) => l.sku)),
      pricingStore(env).customer(ctx.order.customerId),
    ]);
    const v = validateOrder(ctx.order, products, !!customer);
    if ('problem' in v) throw new NonRetryableError(v.problem);
    return {
      order: { lines: v.lines },
      output: { customer: customer?.name ?? null, lines: v.lines.length },
      summary: `${lineCount(v.lines.length)}${customer ? ` · ${customer.name}` : ''}`,
    };
  },

  'commerce.price': async ({ env, ctx, config }) => {
    // The pricing pipeline (packages/application/src/commerce/price-order.ts); this node words it.
    const result = await priceOrder({ pricing: pricingStore(env) }, ctx.order, {
      // No basis on the node runs the chain, as it always has.
      basis: typeof config.basis === 'string' ? config.basis : 'chain',
      useContracts: Boolean(config.useContracts),
      usePriceRules: Boolean(config.usePriceRules),
      now: ctx.now,
    }).catch((err) => {
      throw err instanceof MissingExchangeRateError ? new NonRetryableError(err.message) : err;
    });
    const { lines, fxRate: fx, totals: t, priced } = result;
    const bySource = (k: string) => priced.filter((x) => x.by === k).length;
    const notes = [
      ['contract', 'contract'],
      ['price_book', 'price book'],
      ['volume', 'volume'],
    ]
      .map(([k, label]) => [bySource(k!), label] as const)
      .filter(([n]) => n)
      .map(([n, label]) => `${n} ${label}`);
    return {
      order: { lines, fxRate: fx, ...t },
      output: {
        subtotal: t.subtotal,
        currency: ctx.order.currency,
        fxRate: fx,
        contracted: bySource('contract'),
        lines: priced,
      },
      summary: `Subtotal ${cash(t.subtotal, ctx)}${notes.length ? ` · ${notes.join(', ')}` : ''}`,
    };
  },

  'commerce.discount': async ({ env, ctx, stepKey, dryRun }) => {
    const r = await applyPromotions({ pricing: pricingStore(env) }, ctx.order, {
      now: ctx.now,
      stepKey,
      dryRun: dryRun === true,
    });
    if (!r.order) return { output: { applied: [], refused: [] }, summary: 'No promotions' };
    const off = r.applied.reduce((s, a) => s + a.amount, 0);
    return {
      order: r.order,
      output: { applied: r.applied, refused: r.refused },
      vars: { promotionsRefused: r.refused.map((x) => x.reason) },
      summary: r.applied.length
        ? `${r.applied.map((a) => a.code ?? a.name).join(', ')} · ${cash(off, ctx)} off`
        : r.refused.length
          ? r.refused.map((x) => x.reason).join(' ')
          : 'No promotions',
    };
  },

  'commerce.shipping_rate': async ({ env, ctx, config, node, stepKey }) => {
    const rates = shippingConfigSchema.safeParse(config.rates);
    if (!rates.success)
      throw new NonRetryableError(`Invalid shipping rates: ${rates.error.issues[0]?.message}`);
    const by = providerOf(config);
    const r = await rateShipping(
      { pricing: pricingStore(env), liveQuote: liveCarrierQuote(env) },
      ctx.order,
      {
        config: rates.data,
        select: (SHIPPING_SELECTIONS as readonly string[]).includes(str(config.select))
          ? (config.select as ShippingSelection)
          : 'from_order',
        provider: by
          ? {
              id: by,
              quote: (req) =>
                provide(env, by, {
                  surface: 'shipping.rates',
                  op: 'quote',
                  nodeId: node.id,
                  stepKey,
                  orderId: ctx.order.id,
                  config,
                  order: ctx.order,
                  input: { ...req, currency: BASE_CURRENCY },
                }).catch((err: unknown) => {
                  // As with a live carrier: rates fall back rather than fail the order.
                  console.warn(`shipping rates from ${by}`, err);
                  throw err;
                }),
            }
          : undefined,
      },
    );
    const method = ctx.order.fulfillment?.method ?? 'ship';
    if (r.outcome === 'none')
      return {
        branches: ['ok'],
        order: r.totals,
        output: { method, shipping: 0, option: null },
        summary:
          method === 'ship'
            ? 'Nothing to ship'
            : `No shipping (${FULFILLMENT_METHOD_LABELS[method].toLowerCase()})`,
      };
    // A provider that failed is named in the output and summary, not only in the logs.
    const fellBack = by && r.providerError ? { providerError: `${by}: ${r.providerError}` } : {};
    const note = by && r.providerError ? ` (${by} unavailable)` : '';
    const seen = {
      country: r.country ?? null,
      units: r.units,
      ...(r.weight ?? {}),
      source: r.source,
    };
    const chosen = r.chosen;
    if (!chosen || !r.totals) {
      const wanted = ctx.order.shippingOption;
      return {
        branches: ['unavailable'],
        output: { ...seen, options: r.options, wanted: wanted ?? null, ...fellBack },
        summary: `${wanted && r.options.length ? `“${wanted}” is not offered` : 'No shipping options'}${note}`,
      };
    }
    return {
      branches: ['ok'],
      order: { ...r.totals, shippingOption: chosen.id },
      output: { ...seen, option: chosen, options: r.options, ...fellBack },
      vars: { shippingCarrier: chosen.carrier },
      summary: `${chosen.title} (${chosen.carrier.toUpperCase()}) · ${chosen.free ? 'free' : cash(chosen.amount, ctx)}${note}`,
    };
  },

  'commerce.tax': async ({ env, ctx, config, node, stepKey, dryRun }) => {
    const by = providerOf(config);
    const regions = taxRegionsSchema.safeParse(config.regions ?? []);
    const r = await taxOrder({ certificates: taxCertificateStore(env) }, ctx.order, {
      now: ctx.now,
      exemptions: config.exemptions !== false,
      includeShipping: config.includeShipping !== false,
      regions: regions.success ? regions.data : [],
      fallbackRate: num(config.rate, 0.08),
      provider: by
        ? (input) =>
            provide(env, by, {
              surface: 'tax',
              op: 'calculate',
              nodeId: node.id,
              stepKey,
              orderId: ctx.order.id,
              config,
              order: ctx.order,
              input,
            })
        : undefined,
    });
    if (!r.ok)
      throw new NonRetryableError(
        r.problem === 'untaxable'
          ? `Tax provider “${by}” charged tax on nothing taxable`
          : `Tax provider “${by}” charged ${cash(r.amount, ctx)}, over ${PROVIDER_MAX_TAX_RATE * 100}% of ${cash(r.taxable, ctx)} taxable`,
      );
    const { rate, taxShipping, totals: t, certificate: cert, exempted } = r;
    // An order keeps the certificate's id, not its number, which names the business and would
    // outlive the customer's erasure in step outputs; a quote (never stored as a step) shows it.
    const exemption = cert
      ? { certificateId: cert.id, exempted, ...(dryRun ? { certificate: cert.number } : {}) }
      : null;
    return {
      order: { ...t, taxRate: rate, taxShipping },
      output: {
        rate,
        taxShipping,
        ...t,
        ...(by ? { provider: by } : {}),
        ...(exemption ? { exemption } : {}),
      },
      summary: exempted
        ? `${taxExemptNote({})} · total ${cash(t.total, ctx)}${by ? ` (${by})` : ''}`
        : `Tax ${cash(t.tax, ctx)} · total ${cash(t.total, ctx)}${by ? ` (${by})` : ''}`,
    };
  },

  'commerce.policy': async ({ ctx, config }) => {
    const rules = policyRulesSchema.safeParse(config.rules);
    if (!rules.success)
      throw new NonRetryableError(`Invalid policy rules: ${rules.error.issues[0]?.message}`);
    const r = evaluatePolicy(rules.data, ctx.order, ctx.now);
    return {
      branches: [r.pass ? 'pass' : 'fail'],
      output: r,
      vars: { policyFailures: r.failures },
      summary: r.pass ? `${rules.data.length} rules passed` : r.failures.join('; '),
    };
  },

  'commerce.credit_check': async ({ env, ctx, config }) => {
    const c = await pricingStore(env).customer(ctx.order.customerId);
    const r = creditCheck(c, ctx.order, {
      noAccount: str(config.noAccount, 'over_limit') === 'ok' ? 'ok' : 'over_limit',
    });
    if (!r.account || !c)
      return {
        branches: [r.ok ? 'ok' : 'over_limit'],
        summary: c ? `No credit account (${c.kind})` : 'Guest checkout (no credit account)',
        output: { available: 0 },
      };
    const local = (n: number) => cash(fromBase(n, ctx.order.fxRate), ctx);
    return {
      branches: [r.ok ? 'ok' : 'over_limit'],
      output: {
        limit: c.creditLimit,
        balance: c.balance,
        available: r.available,
        currency: BASE_CURRENCY,
      },
      summary: r.ok
        ? `Within credit (${local(r.available)} available)`
        : `Over limit by ${local(r.over)}`,
    };
  },

  'commerce.budget_check': async ({ ctx, config }) => {
    const budget = num(config.budget, DEFAULT_ORDER_BUDGET);
    const { within } = budgetCheck(ctx.order, budget);
    return {
      branches: [within ? 'within' : 'over'],
      output: { budget },
      summary: `${within ? 'Within' : 'Over'} budget of ${budget} ${BASE_CURRENCY}`,
    };
  },

  'commerce.reserve_inventory': async ({ env, ctx, config, stepKey }) => {
    const r = await inventoryStore(env).reserve(ctx.order, stepKey, {
      forceShort: cx.simulate(ctx.order) === 'out_of_stock',
    });
    const short = r.short.length > 0 && !config.allowBackorder;
    return {
      branches: [short ? 'backorder' : 'ok'],
      output: r,
      summary: short
        ? `Short: ${r.short.join(', ')}`
        : `Reserved ${lineCount(r.reservationIds.length)}`,
    };
  },

  'commerce.authorize_payment': async ({ env, ctx, config, stepKey }) => {
    const purpose = config.purpose === 'verify' ? 'verify' : 'hold';
    const method = str(config.method, 'card');
    const r = await cx.authorizePayment(env, ctx.order, stepKey, method, purpose);
    const ok = r.status === 'authorized' || r.status === 'verified';
    return {
      branches: [ok ? 'ok' : 'declined'],
      output: r,
      summary: !ok
        ? `Declined${r.reason ? `: ${r.reason}` : ''}`
        : r.status === 'verified'
          ? 'Verified and saved the card'
          : `Authorized ${cash(r.amount, ctx)}`,
    };
  },

  'commerce.capture_payment': async ({ env, ctx, stepKey }) => {
    const r = await cx.capturePayment(env, ctx.order, stepKey);
    const ok = r.status === 'succeeded';
    return {
      branches: [ok ? 'ok' : 'failed'],
      output: r,
      summary: ok ? `Captured ${cash(r.amount, ctx)}` : 'Nothing to capture',
    };
  },

  'commerce.charge': async ({ env, ctx, stepKey }) => {
    const r = await cx.charge(env, ctx.order, stepKey);
    const ok = r.status === 'succeeded';
    return {
      branches: [ok ? 'ok' : 'failed'],
      output: r,
      summary: ok ? `Charged ${cash(r.amount, ctx)}` : 'Charge failed',
    };
  },

  'commerce.refund': async ({ env, ctx, config, stepKey }) => {
    const expr = config.amount;
    const value = expr === undefined || expr === null || expr === '' ? null : evaluate(expr, ctx);
    const requested = value === null || value === undefined ? undefined : Number(value);
    if (requested !== undefined && !(requested >= 0))
      throw new NonRetryableError(`Refund amount is not a number: ${JSON.stringify(value)}`);
    const r = await cx.refund(env, ctx.order, stepKey, requested);
    const ok = r.status === 'succeeded';
    return {
      branches: [ok ? 'ok' : 'failed'],
      output: { ...r, reason: interpolate(str(config.reason), ctx) },
      vars: ok ? { refunded: r.amount } : undefined,
      summary: ok ? `Refunded ${cash(r.amount, ctx)}` : 'Nothing to refund',
    };
  },

  'commerce.invoice': async ({ env, ctx, config, stepKey }) => {
    const {
      key,
      terms,
      due,
      onAccount: owed,
      issued,
    } = await billing.invoiceOrder(
      env,
      ctx.order,
      stepKey,
      {
        terms: str(config.terms, 'due_on_receipt'),
        processor: config.provider === 'stripe',
        sendEmail: config.sendEmail !== false,
        onAccount: config.onAccount !== false,
      },
      ctx.now,
    );
    const stripe = issued
      ? {
          invoiceId: issued.externalId,
          number: issued.number,
          hostedUrl: issued.hostedUrl,
          status: issued.status,
        }
      : undefined;
    return {
      output: { key, terms, due, onAccount: owed, ...(stripe ? { stripe } : {}) },
      vars: {
        invoiceKey: key,
        dueDate: due,
        ...(issued?.hostedUrl ? { invoiceUrl: issued.hostedUrl } : {}),
      },
      summary: `${terms} · due ${due}${owed ? ' · on account' : ''}${issued ? ` · ${issued.provider === 'stripe' ? `Stripe ${issued.number ?? issued.externalId}` : 'Stripe (mock)'}` : ''}`,
    };
  },

  'commerce.generate_po': async ({ env, ctx, config, stepKey }) => {
    const supplier = interpolate(str(config.supplier, 'Supplier'), ctx) || 'Supplier';
    const key = await documentStore(env).put(
      ctx.order.id,
      'po',
      `${stepKey.replace('#', '-')}.html`,
      renderDocument(`Purchase order ${ctx.order.id}`, ctx.order, ctx.now, { Supplier: supplier }),
    );
    return {
      output: { key, supplier },
      vars: { poKey: key, supplier },
      summary: `PO to ${supplier}`,
    };
  },

  'commerce.ship': async ({ env, ctx, config, node, stepKey }) => {
    // from_order books the carrier of the option a shipping-rate node charged, else UPS.
    const chosen = str(config.carrier, 'ups');
    const carrier =
      chosen === 'from_order' ? str(ctx.vars.shippingCarrier, 'ups').toLowerCase() : chosen;
    const by = providerOf(config);
    const r = await bookShipment(
      commercePorts(env),
      ctx.order,
      stepKey,
      carrier,
      by ? { id: by, nodeId: node.id, config } : undefined,
    ).catch(nonRetryableLabel);
    const tracking = r.shipments.map((s) => s.tracking).join(', ');
    return {
      output: r,
      vars: { tracking },
      summary:
        r.shipments.length === 1
          ? `${r.carrier.toUpperCase()} ${r.tracking}`
          : `${r.shipments.length} ${r.carrier.toUpperCase()} shipments: ${tracking}`,
    };
  },

  'commerce.return_label': async ({ env, ctx, config, node, stepKey }) => {
    const by = providerOf(config);
    const r = await bookReturnLabel(
      commercePorts(env),
      ctx.order,
      stepKey,
      str(config.carrier, 'ups'),
      by ? { id: by, nodeId: node.id, config } : undefined,
    ).catch(nonRetryableLabel);
    return {
      output: r,
      vars: { returnTracking: r.tracking },
      summary: `Return ${r.carrier.toUpperCase()} ${r.tracking}`,
    };
  },

  'commerce.three_way_match': async ({ ctx, config }) => {
    const received =
      (ctx.vars.goods_received as { total?: number } | undefined)?.total ?? ctx.order.total;
    const invoiced =
      ctx.order.meta?.simulate === 'three_way_mismatch' ? ctx.order.total * 1.1 : ctx.order.total;
    const { drift, match } = threeWayMatch(
      ctx.order.total,
      received,
      invoiced,
      num(config.tolerance, 0.02),
    );
    return {
      branches: [match ? 'match' : 'mismatch'],
      output: { received, invoiced, drift },
      summary: match ? 'PO = receipt = invoice' : `Drift ${(drift * 100).toFixed(1)}%`,
    };
  },

  'commerce.pay_supplier': async ({ env, ctx, stepKey }) => {
    const r = await cx.paySupplier(env, ctx.order, stepKey);
    return { output: r, summary: `Scheduled ${cash(r.amount, ctx)}` };
  },

  'commerce.address_validate': async ({ env, ctx, config, node, stepKey }) => {
    const by = providerOf(config);
    const r = by
      ? await provide(env, by, {
          surface: 'address',
          op: 'validate',
          nodeId: node.id,
          stepKey,
          orderId: ctx.order.id,
          config,
          order: ctx.order,
          input: { address: ctx.order.meta?.shipTo ?? null },
        })
      : checkAddress(ctx.order.meta?.shipTo);
    return {
      branches: [r.status],
      output: r,
      vars: r.status === 'corrected' ? { suggestedAddress: r.address } : undefined,
      summary:
        r.status === 'valid'
          ? 'Address OK'
          : r.status === 'corrected'
            ? 'Suggested a corrected address'
            : r.issues.join('; ').slice(0, 300) || 'Address not usable',
    };
  },

  'commerce.restock': async ({ env, ctx, config, stepKey }) => {
    const expr = config.lines;
    const requested =
      expr === undefined || expr === null || expr === '' ? null : evaluate(expr, ctx);
    const lines = stockLines(requested, ctx.order.lines);
    await inventoryStore(env).restock(ctx.order.id, stepKey, lines);
    return {
      output: { lines },
      summary: `+${lines.reduce((s, l) => s + l.qty, 0)} units`,
    };
  },

  'commerce.erp_sync': async ({ ctx, config }) => {
    const ref = `${str(config.system, 'erp').toUpperCase()}-${ctx.order.id.slice(-8)}`;
    return { output: { ref }, vars: { erpRef: ref }, summary: ref };
  },

  'commerce.route_fulfillment': async ({ env, ctx, config }) => {
    const chosen = str(config.method, 'from_order');
    const method = (chosen === 'from_order' ? (ctx.order.fulfillment?.method ?? 'ship') : chosen) as
      | 'ship'
      | 'pickup'
      | 'carry_out'
      | 'digital';
    const r = await routeFulfillment(
      commercePorts(env),
      ctx.order,
      method === 'digital' ? 'ship' : method,
    );
    // A split names every source; otherwise the one store (none for central stock).
    const where = r.sources ? r.sources.map((x) => x.name).join(' and ') : (r.locationName ?? null);
    const at = (b: string) => (!where ? '' : b === 'ship' ? ` from ${where}` : ` at ${where}`);
    // Each line records where it ships from on a split; a single source clears any earlier split.
    const source = new Map(
      (r.sources ?? []).flatMap((x) => x.lines.map((i) => [i, x.locationId] as const)),
    );
    const lines = ctx.order.lines.map(({ locationId: _from, ...l }, i) => {
      const from = source.get(i);
      return from ? { ...l, locationId: from } : l;
    });
    return {
      branches: r.branches,
      output: r,
      ...(r.method && r.branches[0] !== 'unavailable'
        ? {
            order: {
              fulfillment: {
                method: r.method,
                ...(r.locationId ? { locationId: r.locationId } : {}),
              },
              lines,
            },
          }
        : {}),
      vars: { fulfillmentLocation: where },
      summary:
        r.branches[0] === 'unavailable'
          ? (r.reason ?? 'Unavailable')
          : r.branches
              .map((b) =>
                b === 'digital'
                  ? 'digital'
                  : `${b === 'pickup' ? 'Pick up' : FULFILLMENT_METHOD_LABELS[b as FulfillmentMethod]}${at(b)}`,
              )
              .join(' + '),
    };
  },

  'commerce.pickup_ready': async ({ env, ctx, stepKey }) => {
    const r = await fulfillmentStore(env).stagePickup(ctx.order.id, stepKey);
    return {
      output: r,
      vars: { pickupCode: r.pickupCode },
      summary: `Pickup code ${r.pickupCode}`,
    };
  },

  'commerce.handover': async ({ env, ctx, stepKey }) => {
    const r = await handOverOrder(commercePorts(env), ctx.order, stepKey);
    return { output: r, summary: r.collected === 'pickup' ? 'Collected' : 'Carried out' };
  },

  'commerce.deliver_digital': async ({ env, ctx, stepKey }) => {
    const products = await pricingStore(env).products(ctx.order.lines.map((l) => l.sku));
    const digital = digitalLines(ctx.order.lines, products);
    const codes = await fulfillmentStore(env).issueEntitlements(ctx.order.id, stepKey, digital);
    return {
      output: { entitlements: codes },
      vars: { entitlements: codes },
      summary: `${codes.length} ${codes.length === 1 ? 'code' : 'codes'} issued`,
    };
  },

  'commerce.split_by_seller': async ({ env, ctx }) => {
    const res = await splitBySeller(commercePorts(env), ctx.order);
    if (!res.ok) throw new NonRetryableError(res.error);
    const pending = res.parts.filter((p) => p.status === 'pending');
    return {
      branches: [pending.length ? 'awaiting' : 'accepted'],
      output: { parts: res.parts },
      vars: {
        sellers: res.parts.map((p) => p.sellerId),
        pendingSellers: pending.map((p) => p.sellerId),
      },
      summary: `${res.parts.length} ${res.parts.length === 1 ? 'seller' : 'sellers'}${pending.length ? ` · ${pending.length} awaiting` : ''}`,
    };
  },

  'commerce.seller_accept': async ({ env, ctx, config }) => {
    const res = await answerSellerOrders(
      commercePorts(env),
      ctx.order,
      str(config.decision, 'from_event') === 'expire_pending'
        ? { expire: 'No response' }
        : { response: ctx.vars.seller_responded },
    );
    if (!res.ok) throw new NonRetryableError(res.error);
    const { parts, outcome } = res;
    const output = { parts };
    const of = (status: string) => parts.filter((p) => p.status === status);
    if (outcome === 'pending')
      return {
        branches: ['pending'],
        output,
        vars: { pendingSellers: of('pending').map((p) => p.sellerId) },
        summary: `${of('pending').length} still to answer`,
      };
    if (outcome === 'rejected')
      return { branches: ['rejected'], output, summary: 'No seller accepted' };
    if (outcome === 'accepted')
      return { branches: ['accepted'], output, summary: `All ${of('accepted').length} accepted` };
    const rejected = of('rejected');
    return {
      branches: ['partial'],
      output,
      order: res.order,
      vars: { rejectedSellers: rejected.map((p) => p.sellerId) },
      summary: `${of('accepted').length} accepted, ${rejected.length} rejected (${rejected.map((p) => p.name).join(', ')})`,
    };
  },

  'commerce.payout': async ({ env, ctx, stepKey }) => {
    const rows = await schedulePayouts(
      commercePorts(env),
      ctx.order,
      stepKey,
      await refundedAmount(env, ctx.order.id),
    );
    const net = money(rows.reduce((s, r) => s + r.net, 0));
    const commission = money(rows.reduce((s, r) => s + r.commission, 0));
    return {
      output: { payouts: rows },
      vars: { commission, payouts: rows.map((r) => ({ sellerId: r.sellerId, net: r.net })) },
      summary: rows.length
        ? `${rows.length} ${rows.length === 1 ? 'payout' : 'payouts'} · ${cash(net, ctx)} net, ${cash(commission, ctx)} commission`
        : 'No third-party sellers',
    };
  },

  'commerce.notify': async ({ env, ctx, config, stepKey }) => {
    const to = str(config.to, 'customer');
    const customer = await pricingStore(env).customer(ctx.order.customerId);
    const recipient =
      to === 'customer'
        ? (customer?.email ?? ctx.order.contact?.email ?? 'customer')
        : to === 'supplier'
          ? str(ctx.vars.supplier, 'supplier')
          : 'team';
    const subject = interpolate(str(config.subject), ctx);
    const body = interpolate(str(config.body), ctx) || subject;
    if (to === 'seller') {
      const sellers = await marketplaceStore(env).contacts(ctx.order.id);
      // Each send is keyed by its seller, so they go out together.
      const sent = await Promise.all(
        sellers.map((s) =>
          messageStore(env).send(ctx.order.id, `${stepKey}:${s.id}`, {
            recipient: s.email,
            subject,
            body,
          }),
        ),
      );
      return {
        output: { messages: sent },
        summary: `→ ${sent.length} ${sent.length === 1 ? 'seller' : 'sellers'}: ${subject}`,
      };
    }
    const r = await messageStore(env).send(ctx.order.id, stepKey, { recipient, subject, body });
    return { output: r, summary: `→ ${recipient}: ${subject}` };
  },

  // ── Control (pure, but inside a step so `now` and friends replay identically) ──
  'control.condition': async ({ config, ctx }) => {
    const v = truthy(config.expression, ctx);
    return {
      branches: [v ? 'true' : 'false'],
      output: { value: v },
      summary: v ? 'true' : 'false',
    };
  },

  'control.set': async ({ config, ctx }) => {
    const assign = (config.assign ?? {}) as Record<string, unknown>;
    const vars = Object.fromEntries(
      Object.entries(assign).map(([k, expr]) => [k, evaluate(expr, ctx)]),
    );
    return {
      vars,
      output: vars,
      summary: varsSummary(vars),
    };
  },

  // ── AI ─────────────────────────────────────────────────────────────────────
  'ai.extract': async (i) => {
    const { env, ctx } = i;
    let text = ctx.order.documentText ?? '';
    if (!text && ctx.order.documentKey)
      text = (await documentStore(env).text(ctx.order.documentKey)) ?? '';
    if (!text) return { summary: 'No document; using order as given', output: { skipped: true } };
    // The entries this document can mean, not the whole table: that overflows the model's context.
    const catalog = await extractCatalog(env, text);
    const { value, ...via } = await ai.extractOrder(env, text, catalog, aiCall(i));
    const customer = ctx.order.customerId
      ? undefined
      : value.customerName
        ? await pricingStore(env).customerByName(value.customerName)
        : undefined;
    // Held to the catalog and quantity bounds in `extractOrder`; what didn't pass is in `rejected`.
    const lines = value.lines;
    return {
      order: {
        ...(lines.length ? { lines } : {}),
        // A name read from a document anyone can send: the account's exemptions don't follow it.
        ...(customer
          ? {
              customerId: customer.id,
              meta: { ...ctx.order.meta, [CUSTOMER_MATCHED_BY]: 'name' },
            }
          : {}),
        ...(value.poNumber
          ? {
              title: `${['b2b', 'procurement'].includes(ctx.order.model) ? 'PO' : 'Ref'} ${value.poNumber}`,
            }
          : {}),
      },
      output: { ...value, ...via },
      vars: { poNumber: value.poNumber },
      summary: `${lineCount(lines.length)}${customer ? ` · ${customer.name}` : ''}${value.rejected?.length ? ` · ${value.rejected.length} held back` : ''} (${via.source})`,
    };
  },

  'ai.classify': async (i) => {
    const { env, ctx, config } = i;
    const labels = stringList(config.labels, ['other']);
    const { value, ...via } = await ai.classify(env, ctx.order, labels, aiCall(i));
    return {
      vars: { [str(config.into, 'category')]: value.label },
      output: { ...value, ...via },
      summary: `${value.label} (${Math.round(value.confidence * 100)}%)`,
    };
  },

  'ai.risk_score': async (i) => {
    const { env, ctx, config } = i;
    const customer = await pricingStore(env).customer(ctx.order.customerId);
    const { value, ...via } = await ai.riskScore(env, ctx.order, customer, aiCall(i));
    const threshold = num(config.threshold, 70);
    const { branch, risk } = riskBranch(value.score, threshold, unchecked(via));
    if (unchecked(via))
      return {
        branches: [branch],
        vars: { risk },
        output: { ...value, ...via, unchecked: true },
        summary: 'Risk not checked: the model was unavailable, so treated as high',
      };
    return {
      branches: [branch],
      vars: { risk },
      output: { ...value, ...via },
      summary: `Risk ${Math.round(value.score)}${value.reasons[0] ? ` · ${value.reasons[0]}` : ''}`,
    };
  },

  'ai.forecast': async (i) => {
    const { env, ctx, config } = i;
    const stock = await pricingStore(env).products();
    const { value, ...via } = await ai.forecast(env, stock, num(config.horizonDays, 30), aiCall(i));
    const bySku = new Map(stock.map((p) => [p.sku, p]));
    const lines = value.lines.map((l) => ({
      sku: l.sku,
      qty: Math.round(l.qty),
      name: bySku.get(l.sku)?.name,
    }));
    const supplier = lines.length ? bySku.get(lines[0]!.sku)?.supplier : undefined;
    return {
      order: lines.length ? { lines } : { lines: ctx.order.lines },
      vars: supplier ? { supplier } : {},
      output: { ...value, ...via },
      summary: lines.length
        ? `${plural(lines.length, 'SKU')} to reorder (${via.source})`
        : 'Stock is healthy',
    };
  },

  'ai.summarize': async (i) => {
    const { env, ctx, config } = i;
    const { value, ...via } = await ai.summarize(
      env,
      { order: ctx.order, vars: ctx.vars, completed: ctx.nodes },
      aiCall(i),
    );
    return {
      vars: { [str(config.into, 'summary')]: value.summary },
      output: { ...value, ...via },
      summary: value.summary.slice(0, 80),
    };
  },

  'ai.router': async (i) => {
    const { env, ctx, config } = i;
    const routes = stringList(config.routes, ['auto_approve', 'needs_approval']);
    const customer = await pricingStore(env).customer(ctx.order.customerId);
    const { value, ...via } = await ai.route(
      env,
      str(config.instructions, 'Decide how to handle this order.'),
      routes,
      {
        order: ctx.order,
        customer,
        vars: ctx.vars,
        completed: ctx.nodes,
      },
      aiCall(i),
    );
    if (unchecked(via)) {
      // A person looks at it if the flow has that route; otherwise the heuristic's choice stands,
      // held to the same guards as the model's.
      const picked = uncheckedRoute(routes, value.route);
      const { route, overridden } = guardRoute(picked, config, routes, ctx);
      const reason =
        route === value.route
          ? value.reason
          : overridden
            ? `${overridden}'s guard didn't hold, so this order goes to ${route}.`
            : 'The model was unavailable, so this order goes to approval.';
      return {
        branches: [route],
        output: { route, reason, ...via, unchecked: true, ...(overridden ? { overridden } : {}) },
        summary: `→ ${route} (model unavailable)`,
      };
    }
    // The model can name only a configured route; a guarded one is taken only if its check holds.
    const { route, overridden } = guardRoute(value.route, config, routes, ctx);
    if (overridden)
      return {
        branches: [route],
        output: {
          ...value,
          ...via,
          route,
          overridden,
          reason: `The model chose ${overridden} (${value.reason}), but its guard didn't hold.`,
        },
        summary: `→ ${route} (${overridden}'s guard didn't hold)`,
      };
    return { branches: [route], output: { ...value, ...via }, summary: `→ ${route}` };
  },

  'ai.assess': async (i) => {
    const { env, ctx, config } = i;
    const parsed = assessQuestionsSchema.safeParse(config.questions);
    if (!parsed.success) throw new NonRetryableError('Assess: the questions are not valid');
    const questions = parsed.data;
    const state = ai.modelView(
      env,
      config.state === 'order'
        ? { order: ctx.order }
        : {
            order: ctx.order,
            customer: await pricingStore(env).customer(ctx.order.customerId),
            vars: ctx.vars,
            completed: ctx.nodes,
          },
    );
    const { images, notes } = await clef.resolveImages(
      env,
      imageRefs(config.images, ctx),
      ctx.order.id,
    );
    const { value, ...via } = await clef.assess(env, { state, questions, images }, aiCall(i));
    const branchOn = str(config.branchOn).trim();
    const branch = assessBranch(value.answers[branchOn], num(config.minConfidence, 0));
    return {
      branches: [branch],
      vars: { [str(config.into, 'assessment')]: value.answers },
      output: { answers: value.answers, images: images.length, notes, usage: value.usage, ...via },
      summary: `${describeAnswers(value.answers)} (${via.source})`.slice(0, 160),
    };
  },
};

/**
 * Image references for Assess. An entry that is exactly `{{path}}` takes the value there as is (a
 * string or a list of them, e.g. `{{order.meta.photos}}`); anything else is interpolated.
 */
function imageRefs(v: unknown, ctx: RunContext): string[] {
  const out: string[] = [];
  for (const entry of stringList(v, [])) {
    const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(entry);
    const value = whole ? getPath(ctx, whole[1]!) : interpolate(entry, ctx);
    for (const ref of Array.isArray(value) ? value : [value])
      if (typeof ref === 'string' && ref.trim()) out.push(ref.trim());
  }
  return out;
}

/** Saga compensations, registered on the step when the node type declares `rollback`. */
export const ROLLBACKS: Record<
  string,
  (env: Env, orderId: string, output: unknown, stepKey: string) => Promise<string>
> = {
  'commerce.reserve_inventory': async (env, orderId) =>
    `Released ${plural(await inventoryStore(env).release(orderId), 'reservation')}`,
  'commerce.discount': async (env, orderId) => {
    const n = await pricingStore(env).releaseRedemptions(orderId);
    return n
      ? `Gave back ${n} promotion ${n === 1 ? 'redemption' : 'redemptions'}`
      : 'No promotions to give back';
  },
  'commerce.authorize_payment': async (env, orderId) =>
    `Voided ${plural(await cx.voidAuthorizations(env, orderId), 'authorization')}`,
  'commerce.pickup_ready': async (env, _orderId, output) => {
    const id = (output as { shipmentId?: string } | undefined)?.shipmentId;
    if (id) await shippingStore(env).cancel(id);
    return id ? `Cancelled pickup ${id}` : 'No pickup to cancel';
  },
  'commerce.deliver_digital': async (env, orderId) =>
    `Revoked ${plural(await fulfillmentStore(env).revokeEntitlements(orderId), 'code')}`,
  // The sale is undone: the goods come back to the store, then the stock they consumed is
  // restored (once no shipment of the order is still with the customer or booked).
  'commerce.handover': async (env, orderId) => {
    const back = await fulfillmentStore(env).takeBack(orderId);
    const restored = await inventoryStore(env).restoreShipped(orderId);
    return back
      ? `Took back ${plural(back, 'hand-over')}, restored ${plural(restored, 'reservation')}`
      : 'Nothing handed over to take back';
  },
  'commerce.split_by_seller': async (env, orderId) =>
    `Cancelled ${plural(await marketplaceStore(env).cancel(orderId), 'seller order')}`,
  'commerce.payout': async (env, orderId) =>
    `Reversed ${plural(await marketplaceStore(env).reversePayouts(orderId), 'payout')}`,
  'commerce.ship': async (env, orderId, output, stepKey) => {
    const o = output as { shipmentId?: string; shipments?: { shipmentId: string }[] } | undefined;
    const ids = o?.shipments?.map((s) => s.shipmentId) ?? (o?.shipmentId ? [o.shipmentId] : []);
    // A provider's labels are voided there first. One it can't void stays `void_failed` (retried
    // daily) rather than failing the rollback, so the saga's earlier compensations still run.
    const { voided, failed, kept } = await voidShipmentLabels(
      commercePorts(env),
      orderId,
      stepKey,
      ids,
    );
    for (const id of ids) if (!kept.has(id)) await shippingStore(env).cancel(id);
    if (!ids.length) return 'No shipment to cancel';
    const restored = await inventoryStore(env).restoreShipped(orderId);
    return `Cancelled ${ids.join(', ')}${voided ? `, voided ${plural(voided, 'label')}` : ''}${failed ? `; ${plural(failed, 'label')} could not be voided with the label provider (retried daily)` : ''}${restored ? `, restocked ${plural(restored, 'line')}` : ''}`;
  },
  'commerce.invoice': async (env, orderId) => {
    // Void first: an invoice Stripe reports paid keeps its account charge, which the payment settles.
    const { voided, paid } = await billing.voidInvoices(env, orderId);
    const reversed = await balanceStore(env).reverse(orderId);
    return `Voided ${plural(voided, 'invoice')}${paid.length ? `, left paid ${paid.join(', ')}` : ''}, reversed ${plural(reversed, 'account charge')}`;
  },
};

/** A provider that returned no label for a package fails the node for good. */
function nonRetryableLabel(err: unknown): never {
  throw err instanceof MissingLabelError ? new NonRetryableError(err.message) : err;
}

/** Applies TIME_SCALE so demos compress days into minutes. Never below one second. */
export function scaled(env: Env, duration: string): number {
  const scale = Math.max(1, Number(env.TIME_SCALE) || 1);
  return Math.max(1000, Math.round(durationMs(duration) / scale));
}
