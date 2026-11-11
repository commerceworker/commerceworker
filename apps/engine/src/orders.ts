import { recordInboundPo } from '@commerceworker/application/commerce';
import {
  type FlowVersion,
  newId,
  type Order,
  orderBuyerId,
  orderInputSchema,
  type StartOrderInput,
  type StartOrderOnceInput,
  type StartOrderOnceResult,
  type StartOrderResult,
  startFingerprint,
  withoutSimulation,
} from '@commerceworker/core';
import { recordAudit } from './audit';
import { rememberAddress } from './customer-addresses';
import { loadFlowVersion } from './flows';
import { orderAgent } from './namespaces';
import { companyDirectory, documentStore, orderRecords, purchaseOrderStore } from './wire';
import type { OrderWorkflowParams } from './workflow';

/**
 * An order whose meta came from a caller (the binding: the web app's pages, the REST API, signed
 * and channel webhooks; and A2A's place_order): `meta.ucp`, `meta.cart` and `meta.plugin` are the
 * engine's own marks, set only when a UCP checkout, a cart or a plugin starts an order inside the
 * engine, so whatever a caller sent under them is dropped. A forged `meta.ucp` would point the
 * order's webhooks at a platform.
 */
export function fromOutside<T extends StartOrderInput>(req: T): T {
  // `purchaseOrder` is the engine's own call to tie an order to a PO: a `link` from a caller would
  // point an order at a PO it names, so it goes. A `record` is the web app's own, for an inbound PO.
  const out: T = req.purchaseOrder && 'link' in req.purchaseOrder ? withoutLink(req) : req;
  const meta = out.input.meta;
  if (!meta || !('ucp' in meta || 'cart' in meta || 'plugin' in meta)) return out;
  const { ucp: _ucp, cart: _cart, plugin: _plugin, ...rest } = meta;
  return { ...out, input: { ...out.input, meta: rest } };
}

function withoutLink<T extends StartOrderInput>(req: T): T {
  const { purchaseOrder: _link, ...rest } = req;
  return rest as T;
}

/**
 * Ties the order to its purchase order, if the request names one, and returns the PO for
 * `meta.purchaseOrderId`: the one place that meta is set, so the PO an order's progress is mirrored
 * into is never one a caller named. A `link` ties the order a submitted PO starts; a `record` writes
 * the PO an inbound order is (EDI, email), once per order, and an order whose PO can't be recorded
 * (no company, a number the company already holds) goes ahead without one. Safe to repeat.
 */
async function tiePurchaseOrder(
  env: Env,
  req: StartOrderInput,
  orderId: string,
  now: number,
): Promise<{ id: string; poNumber: string | null } | undefined> {
  const want = req.purchaseOrder;
  if (!want) return undefined;
  const store = purchaseOrderStore(env);
  if ('link' in want) {
    // The order exists but isn't this PO's: its progress must never reach another's, so it stops here.
    if (!(await store.linkOrder({ all: true }, want.link, orderId, now)))
      throw new Error(`Purchase order ${want.link} can't be tied to order ${orderId}`);
  } else {
    const input = orderInputSchema.parse(req.input);
    const r = await recordInboundPo(
      { purchaseOrders: store, companies: companyDirectory(env) },
      {
        orderId,
        companyId: input.customerId,
        poNumber: want.record.poNumber,
        source: want.record.source,
        currency: input.currency,
        lines: input.lines,
        shipTo: input.meta.shipTo,
        buyerId: orderBuyerId(input.meta),
      },
      now,
    );
    if (!r.ok)
      console.warn(
        JSON.stringify({ type: 'purchase_order_not_recorded', orderId, error: r.error }),
      );
    else if (r.audit)
      await recordAudit(env, r.audit.action, {
        actor: { kind: 'channel', id: `${want.record.source}`, name: want.record.source },
        target: r.audit.target ?? null,
        detail: r.audit.detail,
      });
  }
  const po = await store.byOrder(orderId);
  // An emailed PO's number is provisional, so it stays off the invoice; the others' is the buyer's own.
  return po && { id: po.id, poNumber: po.source === 'email' ? null : po.poNumber };
}

/** What a caller's `meta` may carry into an order: nothing that names a PO. */
function withoutPurchaseOrderId<T extends StartOrderInput>(req: T): T {
  const meta = req.input.meta;
  if (!meta || !('purchaseOrderId' in meta)) return req;
  const { purchaseOrderId: _po, ...rest } = meta;
  return { ...req, input: { ...req.input, meta: rest } };
}

/** Creates the order row, initialises its OrderAgent and starts generation 1 of its Workflow. */
export async function startOrder(env: Env, req: StartOrderInput): Promise<StartOrderResult> {
  // Without a key there is nothing to replay, so there is never a mismatch.
  return (await start(env, req)) as StartOrderResult;
}

/**
 * Starts an order at most once per idempotency key. The row is inserted first, so the unique index
 * decides which of two concurrent requests creates the order; the other gets the existing order
 * back. Every step after the insert is safe to repeat, so a replay of an order whose start failed
 * part-way finishes it. A replay must match the original request's fingerprint, or it is refused.
 */
export function startOrderOnce(env: Env, req: StartOrderOnceInput): Promise<StartOrderOnceResult> {
  const { idempotencyKey, fingerprint, ...request } = req;
  return start(env, request, idempotencyKey, fingerprint);
}

async function start(
  env: Env,
  asked: StartOrderInput,
  key?: string,
  given?: string,
): Promise<StartOrderOnceResult> {
  // Every way in (the web app, the REST API, inbound orders, email, A2A, UCP) starts here, so a
  // simulated failure can't reach a deployment that doesn't allow them, whoever asks.
  const req = withoutPurchaseOrderId(
    String(env.SIMULATE_FAILURES) === 'true'
      ? asked
      : { ...asked, input: withoutSimulation(asked.input) },
  );
  const fingerprint = key ? (given ?? (await startFingerprint(req))) : null;
  const existing = async () => (key ? await orderRecords(env).byIdempotencyKey(key) : undefined);
  const replay = async (
    row: NonNullable<Awaited<ReturnType<typeof existing>>>,
  ): Promise<StartOrderOnceResult> => {
    if (row.fingerprint && row.fingerprint !== fingerprint) return { mismatch: true };
    // Still queued with no Workflow: the first request failed after the insert.
    if (
      row.status === 'queued' &&
      !(await instanceExists(env, row.instanceId ?? instanceIdFor(row.id)))
    ) {
      const flow = await loadFlowVersion(env, row.flowId, row.flowVersion);
      if (!flow) throw new Error(`Flow ${row.flowId} v${row.flowVersion} not found`);
      const po = await tiePurchaseOrder(env, req, row.id, row.createdAt);
      await launch(env, req, flow, row.id, row.createdAt, po);
    }
    return { orderId: row.id, replayed: true };
  };
  const prior = await existing();
  if (prior) return replay(prior);

  const flow = await loadFlowVersion(env, req.flowId, req.version);
  if (!flow) throw new Error(`Flow ${req.flowId} has no published version`);
  const input = orderInputSchema.parse(req.input);
  if (req.purchaseOrder && 'link' in req.purchaseOrder) {
    // Refused before the order exists, so a PO that can't be this order's leaves nothing behind.
    const po = await purchaseOrderStore(env).get({ all: true }, req.purchaseOrder.link);
    if (po?.orderId && key) {
      // It has an order. If that is this request's (a submit whose first try got that far, or a
      // retry that raced it), this is a replay of it, not a refusal.
      const started = await existing();
      if (started) return replay(started);
    }
    if (!po || po.companyId !== input.customerId || po.orderId)
      throw new Error(`Purchase order ${req.purchaseOrder.link} can't start this order`);
  }
  const orderId = newId('ord');
  const now = Date.now();
  try {
    await orderRecords(env).create({
      id: orderId,
      model: input.model,
      channel: input.channel,
      externalId: input.externalId ?? null,
      contactEmail: input.contact?.email ?? null,
      title: input.title ?? '',
      flowId: flow.id,
      flowVersion: flow.version,
      instanceId: instanceIdFor(orderId),
      customerId: input.customerId ?? null,
      buyerId: orderBuyerId(input.meta) ?? null,
      currency: input.currency,
      createdAt: now,
      idempotencyKey: key ?? null,
      idempotencyFingerprint: fingerprint,
      startedBy: req.startedBy ?? null,
    });
  } catch (err) {
    const raced = await existing();
    if (raced) return replay(raced);
    throw err;
  }
  // For the customer page only: an order starts whether or not its address is kept.
  try {
    await rememberAddress(env, {
      id: orderId,
      customerId: input.customerId,
      shipTo: input.meta.shipTo,
      at: now,
    });
  } catch (err) {
    console.error(JSON.stringify({ type: 'customer_address_failed', orderId, error: String(err) }));
  }
  const po = await tiePurchaseOrder(env, req, orderId, now);
  await launch(env, req, flow, orderId, now, po);
  return { orderId };
}

const instanceIdFor = (orderId: string) => `${orderId}-g1`;

/** Stores the inbound document, initialises the agent and creates the Workflow; all repeatable. */
async function launch(
  env: Env,
  req: StartOrderInput,
  flow: FlowVersion,
  orderId: string,
  createdAt: number,
  po?: { id: string; poNumber: string | null },
) {
  const input = orderInputSchema.parse(req.input);
  const order: Order = {
    ...input,
    // The PO's number is the buyer's reference on the invoice, unless the caller named one.
    meta: po
      ? {
          ...(po.poNumber ? { poNumber: po.poNumber } : {}),
          ...input.meta,
          purchaseOrderId: po.id,
        }
      : input.meta,
    id: orderId,
    createdAt,
    subtotal: 0,
    shipping: 0,
    tax: 0,
    total: 0,
  };
  const instanceId = instanceIdFor(orderId);
  if (input.documentText && !input.documentKey) {
    order.documentKey = await documentStore(env).put(
      orderId,
      'inbound',
      'po.txt',
      input.documentText,
      'text/plain; charset=utf-8',
    );
  }
  // Once the document is in R2, the agent's state and the Workflow's params carry only its key
  // (`ai.extract` reads it back from there).
  if (order.documentKey) delete order.documentText;
  await orderAgent(env, orderId).init(order, flow, instanceId);
  const params: OrderWorkflowParams = {
    orderId,
    flowId: flow.id,
    version: flow.version,
    generation: 1,
    order,
    vars: req.vars ?? {},
  };
  try {
    await env.ORDER_WORKFLOW.create({ id: instanceId, params });
  } catch (err) {
    // A concurrent replay created it first.
    if (!(await instanceExists(env, instanceId))) throw err;
  }
}

export async function instanceExists(env: Env, id: string) {
  try {
    await env.ORDER_WORKFLOW.get(id);
    return true;
  } catch {
    return false;
  }
}
