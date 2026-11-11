/**
 * Purchase orders through the assistant, REST's and the pages' twin: reading them, drafting and
 * editing a draft (no confirm: a draft starts nothing), and submitting and cancelling (a confirm
 * card whose text says what it does to the order). The use-cases are
 * `@commerceworker/application`'s, the ones REST runs; the engine's own order calls (`PoOrderDeps`)
 * are the start path every other order takes (`startOrderOnce`) and the OrderAgent's cancel.
 */
import * as uc from '@commerceworker/application/commerce';
import {
  type ActionPreview,
  newId,
  PO_STATUS_LABELS,
  type Principal,
  TERMINAL_ORDER_STATUSES,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { ensureTemplates } from '../flows';
import { orderAgent } from '../namespaces';
import { startOrderOnce } from '../orders';
import { companyDirectory, purchaseOrderStore } from '../wire';
import { money, Refused } from './data';

type Trail = Record<string, unknown>;

const ALL = { all: true } as const;
const ports = (env: Env) => ({
  purchaseOrders: purchaseOrderStore(env),
  companies: companyDirectory(env),
});

/** A PO's page, and where a card sends the person. */
const href = (poId: string) => `/purchase-orders/${poId}`;

export async function readPurchaseOrders(env: Env, i: ToolInput<'list_purchase_orders'>) {
  const r = await uc.listPurchaseOrders(ports(env), ALL, i);
  if (!r.ok) throw new Refused(r.error);
  const { ok: _, ...rest } = r;
  return rest;
}

export async function readPurchaseOrder(env: Env, i: ToolInput<'get_purchase_order'>) {
  const r = await uc.getPurchaseOrder(ports(env), ALL, i.poId);
  if (!r.ok) throw new Refused(r.error);
  const { ok: _, ...rest } = r;
  return rest;
}

async function audited(
  env: Env,
  p: Principal,
  audit: uc.AuditDraft | null,
  trail: Trail,
): Promise<void> {
  if (audit)
    await recordAudit(env, audit.action, {
      actor: p,
      target: audit.target ?? null,
      detail: { ...audit.detail, ...trail },
    });
}

/** The page's own button and the assistant's panel are the app; a token or MCP is the API. */
const sourceOf = (trail: Trail) =>
  trail.via === 'assistant' || trail.via === 'app' ? 'app' : 'api';

export async function openPoDraft(
  env: Env,
  p: Principal,
  i: ToolInput<'create_po_draft'>,
  trail: Trail,
) {
  const r = await uc.createPoDraft(
    ports(env),
    ALL,
    i,
    () => newId('po'),
    Date.now(),
    sourceOf(trail),
  );
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return {
    done: `Drafted purchase order ${r.purchaseOrder.poNumber}`,
    href: href(r.purchaseOrder.id),
    purchaseOrder: uc.poView(r.purchaseOrder),
  };
}

export async function changePoDraft(
  env: Env,
  p: Principal,
  i: ToolInput<'update_po_draft'>,
  trail: Trail,
) {
  const r = await uc.updatePoDraft(ports(env), ALL, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return {
    done: r.changed
      ? `Changed purchase order ${r.purchaseOrder.poNumber}`
      : `Purchase order ${r.purchaseOrder.poNumber} is as asked`,
    href: href(r.purchaseOrder.id),
    purchaseOrder: uc.poView(r.purchaseOrder),
  };
}

/**
 * The engine's own order calls for a PO: the start every order takes, once per key and tied to the
 * PO before its flow runs, and the OrderAgent's cancel, told apart from an order that has ended.
 */
function orderDeps(env: Env, p: Principal, trail: Trail): uc.PoOrderDeps {
  return {
    async start(req) {
      try {
        // The PO flow is a template: a deployment that hasn't seeded one yet has none to run.
        await ensureTemplates(env);
        const started = await startOrderOnce(env, {
          flowId: req.flowId,
          input: req.input,
          purchaseOrder: req.purchaseOrder,
          startedBy: p.id,
          idempotencyKey: req.key,
        });
        if ('mismatch' in started)
          return {
            ok: false,
            error: 'This purchase order already started an order on another flow.',
          };
        if (!started.replayed)
          await recordAudit(env, 'order.started', {
            actor: p,
            target: started.orderId,
            detail: { flowId: req.flowId, purchaseOrder: req.purchaseOrder.link, ...trail },
          });
        return { ok: true, orderId: started.orderId, replayed: !!started.replayed };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async cancel(orderId, reason) {
      try {
        const agent = orderAgent(env, orderId);
        if ((await agent.cancel(reason)).ok) return { ok: true, outcome: 'cancelled' };
        // Refused: it has ended, or a cancel is already under way.
        const { status } = await agent.snapshot();
        return {
          ok: true,
          outcome:
            status !== 'cancelled' && TERMINAL_ORDER_STATUSES.includes(status)
              ? 'finished'
              : 'cancelled',
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export async function previewSubmitPo(
  env: Env,
  i: ToolInput<'submit_po'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planSubmitPo(ports(env), ALL, i);
  if (!plan.ok)
    return { title: 'Submit a purchase order', consequences: [], blocked: roleBlock ?? plan.error };
  const { po } = plan;
  const lines = po.lines.slice(0, 5).map((l) => `${l.sku} × ${l.qty}`);
  const priced = po.lines.every((l) => l.unitPrice !== null);
  const expected = po.lines.reduce((n, l) => n + l.qty * (l.unitPrice ?? 0), 0);
  const shipTo = po.shipTo
    ? [po.shipTo.name, po.shipTo.line1, po.shipTo.city, po.shipTo.postalCode, po.shipTo.country]
        .filter(Boolean)
        .join(', ')
    : 'no ship-to';
  const details = [
    `Lines: ${lines.join(', ')}${po.lines.length > 5 ? ` and ${po.lines.length - 5} more` : ''}`,
    // The flow prices the order; this is only what the buyer wrote.
    ...(priced
      ? [`The buyer expects ${money(expected, po.currency)} (the order is priced by the flow)`]
      : []),
    `Ships to: ${shipTo}`,
    `Buyer: ${po.buyerId ?? 'none named'}`,
  ];
  return {
    title: `Submit purchase order ${po.poNumber}`,
    href: href(po.id),
    consequences: plan.repeat
      ? [
          po.orderId
            ? 'Its order has already started; nothing new starts'
            : 'It is submitted but its order never started: this starts it',
          ...details,
        ]
      : [
          ...details,
          `Starts an order of ${po.lines.length} line${po.lines.length === 1 ? '' : 's'} for ${po.companyId} on ${plan.flowId}`,
          'The order is held to the company’s credit limit and budgets, and goes to its approvers when the flow asks',
          'The purchase order can’t be edited once submitted',
        ],
    blocked: roleBlock,
  };
}

export async function runSubmitPo(env: Env, p: Principal, i: ToolInput<'submit_po'>, trail: Trail) {
  const r = await uc.submitPo(ports(env), ALL, i, orderDeps(env, p, trail), Date.now());
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return {
    done: `Submitted purchase order ${r.purchaseOrder.poNumber} as order ${r.orderId}`,
    href: `/orders/${r.orderId}`,
    id: r.purchaseOrder.id,
    orderId: r.orderId,
  };
}

export async function previewCancelPo(
  env: Env,
  i: ToolInput<'cancel_po'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planCancelPo(ports(env), ALL, i);
  if (!plan.ok)
    return { title: 'Cancel a purchase order', consequences: [], blocked: roleBlock ?? plan.error };
  const { po } = plan;
  return {
    title: `Cancel purchase order ${po.poNumber}`,
    href: href(po.id),
    consequences: [
      `It is ${PO_STATUS_LABELS[po.status].toLowerCase()} now`,
      plan.orderId
        ? 'Its order is cancelled too: the credit hold, budget spend and stock it took are given back'
        : 'It has no order to cancel',
      'A cancelled purchase order’s number can be used again',
    ],
    blocked: roleBlock ?? (plan.noop ? 'It is already cancelled.' : undefined),
  };
}

export async function runCancelPo(env: Env, p: Principal, i: ToolInput<'cancel_po'>, trail: Trail) {
  const r = await uc.cancelPo(ports(env), ALL, i, orderDeps(env, p, trail), Date.now());
  if (!r.ok) throw new Refused(r.error);
  await audited(env, p, r.audit, trail);
  return {
    done: `Cancelled purchase order ${r.purchaseOrder.poNumber}`,
    href: href(r.purchaseOrder.id),
    id: r.purchaseOrder.id,
  };
}
