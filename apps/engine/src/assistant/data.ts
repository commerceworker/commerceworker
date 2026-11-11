/**
 * What the assistant reads and does, independent of the model. Every function takes the caller as
 * they are now and refuses what their role doesn't allow, so a tool can never do more than the
 * person asking could do themselves. Writes go through the same agents and helpers the pages use;
 * the audit trail names the person and the channel: "via assistant", "via MCP" or "via A2A".
 */

import {
  type ActionPreview,
  ASSISTANT_TOOLS,
  type AssessQuestions,
  type AssistantTool,
  type Attention,
  type AuditVia,
  atLeast,
  BASE_CURRENCY,
  boundText,
  describeDiff,
  describePlan,
  evaluateApprovalStatus,
  type Flow,
  type FlowGraph,
  type FlowProposal,
  flowAwaits,
  flowGraphSchema,
  flowReadsGoodsBack,
  graphDiff,
  isPanelOnly,
  ORDER_MODEL_LABELS,
  ORDER_MODELS,
  type OrderChannel,
  type OrderModel,
  type OrderState,
  type Principal,
  planSpec,
  RETURN_NOTE_MAX,
  type ReturnInput,
  ROLE_LABELS,
  type Role,
  returnRequest,
  TERMINAL_ORDER_STATUSES,
  type ToolInput,
  validateGraph,
} from '@commerceworker/core';
import type { VoteResult } from '../agent';
import { copilot, modelView } from '../ai';
import { plainPlan, tallyWith, voteRefusal, voterOf } from '../approvals';
import { recordAudit } from '../audit';
import { assess, resolveImages } from '../clef';
import { orderAgent } from '../namespaces';
import { registry } from '../plugins';
import { separationRefusal } from '../separation';
import { flowStore, inventoryStore, orderQueries, orderRecords, pricingStore } from '../wire';
import {
  previewDeleteWebhook,
  previewRevokeIntegration,
  previewRevokePlatform,
  previewUcpSettings,
  runDeleteWebhook,
  runRevokeIntegration,
  runRevokePlatform,
  runUcpSettings,
} from './access';
import {
  type PluginChange,
  previewApprovalSeparation,
  previewMemberRole,
  previewPlugin,
  previewRouting,
  requireSteppedUp,
  runApprovalSeparation,
  runMemberRole,
  runPlugin,
  runRouting,
  stepUpNeeded,
} from './admin';
import { previewBudget, previewBudgetStatus, runBudget, runBudgetStatus } from './budgets';
import { previewCancelCart, previewSubmit, runCancelCart, runSubmit } from './carts';
import { previewPublishCatalog, runPublishCatalog } from './catalog';
import {
  type CatalogWrite,
  type CatalogWriteTool,
  previewCatalogWrite,
  runCatalogWrite,
} from './catalog-writes';
import {
  type PromotionInput,
  previewCertificate,
  previewCreatePromotion,
  previewPromotionStatus,
  runCertificate,
  runCreatePromotion,
  runPromotionStatus,
} from './commerce';
import {
  previewCompanyStatus,
  previewCreateCustomer,
  previewMembers,
  previewRemoveMember,
  previewTeam,
  previewUpdateCustomer,
  runCompanyStatus,
  runCreateCustomer,
  runMembers,
  runRemoveMember,
  runTeam,
  runUpdateCustomer,
} from './companies';
import {
  previewCreditAdjustment,
  previewCreditLimit,
  runCreditAdjustment,
  runCreditLimit,
} from './credit';
import { draftHash, heldToDraft, previewTestFlow, runTestFlow } from './flows';
import { previewFxRate, runFxRate } from './fx';
import { previewRestart, previewStart, runRestart, runStart, type StartInput } from './orders';
import {
  previewContractPrices,
  previewCreatePriceBook,
  previewPriceBookAssignment,
  previewPriceBookEntries,
  previewPriceBookStatus,
  runContractPrices,
  runCreatePriceBook,
  runPriceBookAssignment,
  runPriceBookEntries,
  runPriceBookStatus,
} from './price-books';
import { previewCancelPo, previewSubmitPo, runCancelPo, runSubmitPo } from './purchase-orders';
import {
  previewAcceptQuote,
  previewConvertQuote,
  previewDeclineQuote,
  previewExpireQuote,
  previewSendQuote,
  runAcceptQuote,
  runConvertQuote,
  runDeclineQuote,
  runExpireQuote,
  runSendQuote,
} from './quotes';

export class Refused extends Error {}

export function requireRole(p: Principal, tool: AssistantTool) {
  const min = ASSISTANT_TOOLS[tool].role;
  if (!atLeast(p.role, min)) throw new Refused(`This needs the ${ROLE_LABELS[min]} role.`);
}

/**
 * Where a tool call came from: the workspace assistant, an MCP client, an A2A agent, or the REST
 * API (`EngineApi.runOperation`).
 */
export type Channel = 'assistant' | 'MCP' | 'A2A' | 'API';

/**
 * How a confirmed action reached `runAction`: with what the person's confirm was held to (the
 * preview's `bound`, kept server-side by the channel that showed it), or `direct` for a call the
 * caller composed without a preview (a typed A2A skill).
 */
export type Confirmed = { bound: Record<string, unknown> | null } | 'direct';

/** How the audit trail names an act taken for someone through a channel. */
export const via = (p: Principal, channel: Channel) => `${p.email ?? p.name} via ${channel}`;

/** How the audit log names each channel. */
export const AUDIT_CHANNEL: Record<Channel, AuditVia> = {
  assistant: 'assistant',
  MCP: 'mcp',
  A2A: 'a2a',
  API: 'api',
};

export function money(n: number | null | undefined, currency = BASE_CURRENCY) {
  if (n === null || n === undefined) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export const orderRef = (id: string) => `#${id.slice(-6)}`;

const LIST_CAP = 6;

// ── Reads ──────────────────────────────────────────────────────────────────

export async function attention(env: Env): Promise<Attention> {
  const found = await orderQueries(env).attention(Date.now(), LIST_CAP);
  // A wait for a person shows under approvals already; stalled means waiting on a business event.
  const awaitingPeople = new Set(found.approvals.map((a) => a.orderId));
  return { ...found, stalled: found.stalled.filter((o) => !awaitingPeople.has(o.id)) };
}

export type FindOrders = {
  status?: string;
  model?: string;
  channel?: string;
  customer?: string;
  q?: string;
  minTotal?: number;
  maxTotal?: number;
  sinceDays?: number;
  sort?: 'newest' | 'updated' | 'largest';
  limit?: number;
};

export async function findOrders(env: Env, f: FindOrders) {
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 50);
  const found = await orderQueries(env).find({ ...f, limit }, Date.now());
  return {
    count: found.count,
    total: money(found.total),
    shown: found.orders.length,
    orders: found.orders.map((r) => ({
      ...r,
      ref: orderRef(r.id),
      total: money(r.total, r.currency),
      href: `/orders/${r.id}`,
    })),
  };
}

/** An order id from a full id, a `#abc123` reference or its last characters. */
export async function resolveOrderId(env: Env, ref: string): Promise<string | null> {
  const id = ref.trim().replace(/^#/, '');
  return id ? orderQueries(env).resolveId(id) : null;
}

export async function snapshot(env: Env, orderId: string): Promise<OrderState | null> {
  const s = (await orderAgent(env, orderId).snapshot()) as OrderState;
  return s.orderId ? s : null;
}

async function loadOrder(env: Env, ref: string) {
  const id = await resolveOrderId(env, ref);
  const s = id ? await snapshot(env, id) : null;
  if (!id || !s) throw new Refused(`No order matches ${ref}.`);
  return { id, s };
}

const RETURN_BY_RECORD =
  'Record a return or claim from the order page, so its card shows the refund.';

/** A return or claim checked against the order as it stands, or why it can't be recorded. */
async function planReturn(env: Env, i: ActionInput['record_return'], p: Principal) {
  const { id, s } = await loadOrder(env, i.orderId);
  const wait = s.waits.find((x) => x.kind === 'event' && x.event === 'return.requested');
  if (!wait) return { id, s, issue: `${orderRef(id)} isn't waiting for a return.` };
  const checked = returnRequest(i, { lines: s.order?.lines ?? [], total: s.order?.total });
  if ('issue' in checked) return { id, s, issue: checked.issue };
  if (!checked.request.goodsBack && !flowReadsGoodsBack(s.flow))
    return {
      id,
      s,
      issue: `This order's flow always waits for goods to come back. Publish a flow with the “Goods coming back?” step first.`,
    };
  // Nothing comes back to prove the claim, so with separation on a second person records it.
  if (!checked.request.goodsBack && (await separationRefusal(env, id, p.id)))
    return { id, s, issue: 'You started this order, so someone else must record this claim.' };
  return { id, s, wait, request: checked.request };
}

/**
 * Typed questions about one order, answered with a probability per option. Images are limited to
 * this order's documents (or https and data URLs), as for the Assess node.
 */
export async function assessOrder(
  env: Env,
  ref: string,
  questions: AssessQuestions,
  imageRefs: string[] = [],
) {
  const { id, s } = await loadOrder(env, ref);
  const { images, notes } = await resolveImages(env, imageRefs, id);
  const { value, ...via } = await assess(
    env,
    {
      state: { ...modelView(env, { order: s.order!, vars: s.vars }), status: s.status },
      questions,
      images,
    },
    { orderId: id },
  );
  return { id, ref: orderRef(id), answers: value.answers, images: images.length, notes, ...via };
}

const label = (s: OrderState, nodeId: string) =>
  s.flow?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;

/** The step an output leads to, e.g. where "approved" goes from an approval. */
function nextStep(s: OrderState, nodeId: string, handle?: string) {
  const edge = s.flow?.edges.find(
    (e) => e.source === nodeId && (handle ? e.sourceHandle === handle : !e.sourceHandle),
  );
  return edge ? label(s, edge.target) : null;
}

export async function getOrder(env: Env, ref: string) {
  const { id, s } = await loadOrder(env, ref);
  const o = s.order!;
  const customer = o.customerId ? await pricingStore(env).customer(o.customerId) : null;
  // Where each vote stands, for approvals decided by more than one voice.
  const tallies = new Map(
    await Promise.all(
      s.waits.flatMap((w) =>
        w.approval
          ? [
              orderRecords(env)
                .votes(id, w.eventType)
                .then(
                  (votes) =>
                    [
                      w.eventType,
                      evaluateApprovalStatus(planSpec(w.approval!), w.approval!.eligible, votes)
                        .label,
                    ] as const,
                ),
            ]
          : [],
      ),
    ),
  );
  return {
    id,
    ref: orderRef(id),
    href: `/orders/${id}`,
    title: o.title || ORDER_MODEL_LABELS[o.model as OrderModel],
    model: o.model,
    channel: o.channel,
    status: s.status,
    reason: s.reason,
    customer: customer?.name ?? o.customerId ?? null,
    total: money(o.total, o.currency),
    lines: o.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    flow: s.flow ? `${s.flow.name} v${s.flow.version}` : null,
    waits: s.waits.map((w) => ({
      nodeId: w.nodeId,
      step: label(s, w.nodeId),
      since: new Date(w.since).toISOString(),
      kind: w.kind,
      title: w.title,
      event: w.event,
      assignee: w.assignee,
      approvers: w.approval ? describePlan(w.approval) || undefined : undefined,
      tally: tallies.get(w.eventType),
      amount: w.amount === undefined ? undefined : money(w.amount, o.currency),
      deadline: w.deadline ? new Date(w.deadline).toISOString() : undefined,
      onApprove: w.kind === 'approval' ? nextStep(s, w.nodeId, 'approved') : undefined,
      onReject: w.kind === 'approval' ? nextStep(s, w.nodeId, 'rejected') : undefined,
    })),
    steps: Object.entries(s.nodes)
      .filter(([, n]) => n.status !== 'pending')
      .map(([nodeId, n]) => ({
        nodeId,
        step: label(s, nodeId),
        status: n.status,
        summary: n.summary,
        error: n.error,
      })),
    recent: s.timeline
      .slice(-12)
      .map((t) => ({ at: new Date(t.at).toISOString(), message: t.message })),
  };
}

export async function findProducts(env: Env, q?: string, belowReorder?: boolean) {
  const rows = await inventoryStore(env).stockList({ q, belowReorder, limit: 40 });
  return { products: rows, href: '/commerce' };
}

export async function listFlows(env: Env) {
  const rows = await flowStore(env).list();
  return {
    flows: rows.map((f) => ({
      id: f.id,
      name: f.name,
      model: f.model,
      channels: f.channels,
      publishedVersion: f.publishedVersion,
      updatedAt: f.updatedAt,
      href: `/flows/${f.id}`,
    })),
  };
}

async function loadFlow(env: Env, flowId: string) {
  const row = await flowStore(env).flow(flowId);
  if (!row) throw new Refused(`No flow has the id ${flowId}.`);
  const graph = flowGraphSchema.parse({ nodes: row.nodes, edges: row.edges });
  const flow: Flow = {
    id: row.id,
    name: row.name,
    description: row.description,
    model: row.model as OrderModel,
    channels: row.channels as OrderChannel[],
    ...graph,
  };
  return { row, flow };
}

export async function getFlow(env: Env, flowId: string) {
  const { row, flow } = await loadFlow(env, flowId);
  const { errors, warnings } = validateGraph(flow, await registry(env));
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    channels: flow.channels,
    publishedVersion: row.publishedVersion,
    href: `/flows/${row.id}`,
    steps: flow.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label })),
    connections: flow.edges.map(
      (e) => `${e.source}${e.sourceHandle ? `:${e.sourceHandle}` : ''} → ${e.target}`,
    ),
    errors: errors.map((e) => e.message),
    warnings: warnings.map((e) => e.message),
    // What a publish or test over REST names, so it publishes this draft and no later one.
    draft: await draftHash(flow),
  };
}

/**
 * A whole proposed graph for the editor to show; nothing is saved. Starts from the graph on the
 * person's screen when they are editing this flow, so unsaved work is kept.
 */
export async function proposeFlowChange(
  env: Env,
  flowId: string,
  instruction: string,
  onScreen?: { graph?: FlowGraph; model?: string },
): Promise<FlowProposal> {
  const { flow } = await loadFlow(env, flowId);
  const start = onScreen?.graph ?? { nodes: flow.nodes, edges: flow.edges };
  const res = await copilot(env, {
    prompt: instruction,
    graph: start,
    model: ORDER_MODELS.find((m) => m === onScreen?.model) ?? flow.model,
  });
  return {
    flowId,
    flowName: flow.name,
    explanation: res.explanation,
    graph: res.graph,
    errors: res.errors,
    warnings: res.warnings,
    changes: graphDiff(start, res.graph),
  };
}

// ── Actions that wait for a person ─────────────────────────────────────────

/** A payload as the audit trail keeps it: each value one bounded line. */
const boundPayload = (p: EventPayload) =>
  Object.fromEntries(
    Object.entries(p).map(([k, v]) => [k, typeof v === 'string' ? boundText(v, 120) : v]),
  );

/** Who may do what on the team is a person's call, signed in as themselves, never a token's. */
const personOnly = (p: Principal) =>
  p.kind === 'user' && !('grant' in p)
    ? undefined
    : 'A person changes the team, signed in as themselves.';

/** A batch's approvals, each once. */
const batchOf = (i: ActionInput['decide_approvals']) => [
  ...new Map(i.approvals.map((a) => [`${a.orderId} ${a.nodeId}`, a])).values(),
];

/** What an event carries besides its name: flat values only (a seller's answer, an amount). */
export type EventPayload = Record<string, string | number | boolean | null>;

export type ActionInput = {
  decide_approval: {
    orderId: string;
    nodeId?: string;
    decision: 'approved' | 'rejected';
    note?: string;
    onBehalfOf?: string;
  };
  decide_approvals: {
    decision: 'approved' | 'rejected';
    note?: string;
    onBehalfOf?: string;
    approvals: { orderId: string; nodeId: string }[];
  };
  deliver_event: { orderId: string; event: string; payload?: EventPayload };
  cancel_order: { orderId: string; reason: string };
  record_return: { orderId: string } & ReturnInput;
  submit_cart: { cartId: string; cartVersion?: number };
  publish_flow: { flowId: string };
  run_stock_review: Record<string, never>;
  start_order: StartInput;
  restart_order: { orderId: string };
  cancel_cart: { cartId: string };
  test_flow: { flowId: string };
  publish_catalog: { keys: string[] };
  create_promotion: PromotionInput;
  set_member_role: { userId: string; role: Role };
  set_approval_separation: { on: boolean };
  set_assistant_routing: { on: boolean };
  set_plugin_enabled: { pluginId: string; enabled: boolean };
  approve_plugin: { pluginId: string; sha: string; personalData?: boolean };
  rollback_plugin: { pluginId: string; sha: string };
  uninstall_plugin: { pluginId: string };
  set_promotion_status: { promotionId: string; status: 'active' | 'paused' };
  set_fx_rate: ToolInput<'set_fx_rate'>;
  set_credit_limit: ToolInput<'set_credit_limit'>;
  adjust_credit: ToolInput<'adjust_credit'>;
  create_price_book: ToolInput<'create_price_book'>;
  set_price_book_status: ToolInput<'set_price_book_status'>;
  put_price_book_entries: ToolInput<'put_price_book_entries'>;
  assign_price_book: ToolInput<'assign_price_book'>;
  put_contract_prices: ToolInput<'put_contract_prices'>;
  verify_tax_certificate: { customerId: string; certificateId: string };
  revoke_tax_certificate: { customerId: string; certificateId: string };
  create_customer: ToolInput<'create_customer'>;
  update_customer: ToolInput<'update_customer'>;
  set_company_status: ToolInput<'set_company_status'>;
  put_company_members: ToolInput<'put_company_members'>;
  remove_company_member: ToolInput<'remove_company_member'>;
  put_company_team: ToolInput<'put_company_team'>;
  put_budget: ToolInput<'put_budget'>;
  set_budget_status: ToolInput<'set_budget_status'>;
  submit_po: ToolInput<'submit_po'>;
  cancel_po: ToolInput<'cancel_po'>;
  send_quote: ToolInput<'send_quote'>;
  accept_quote: ToolInput<'accept_quote'>;
  decline_quote: ToolInput<'decline_quote'>;
  expire_quote: ToolInput<'expire_quote'>;
  convert_quote: ToolInput<'convert_quote'>;
  delete_webhook_subscription: ToolInput<'delete_webhook_subscription'>;
  revoke_integration: ToolInput<'revoke_integration'>;
  set_ucp_settings: ToolInput<'set_ucp_settings'>;
  revoke_ucp_platform: ToolInput<'revoke_ucp_platform'>;
} & CatalogWrite;
export type ActionTool = keyof ActionInput;

/** The approval wait a decision is for: the one named, or the only one open. */
function approvalWait(s: OrderState, nodeId?: string) {
  const open = s.waits.filter((w) => w.kind === 'approval');
  return nodeId ? open.find((w) => w.nodeId === nodeId) : open.length === 1 ? open[0] : undefined;
}

const ROLLBACK_EFFECTS: Record<string, string> = {
  'commerce.reserve_inventory': 'Releases the stock it reserved',
  'commerce.authorize_payment': 'Voids the payment authorization',
  'commerce.ship': 'Cancels the shipment',
};

/**
 * The action resolved against live data, for the confirm card: what will happen, or why it can't.
 * Read-only; the same checks run again when the person confirms.
 */
export async function previewAction<T extends ActionTool>(
  env: Env,
  p: Principal,
  tool: T,
  input: ActionInput[T],
): Promise<ActionPreview> {
  const min = ASSISTANT_TOOLS[tool].role;
  const roleBlock = atLeast(p.role, min) ? undefined : `This needs the ${ROLE_LABELS[min]} role.`;
  try {
    switch (tool) {
      case 'decide_approval': {
        const i = input as ActionInput['decide_approval'];
        const { id, s } = await loadOrder(env, i.orderId);
        const w = approvalWait(s, i.nodeId);
        const o = s.order!;
        const own = await separationRefusal(env, id, p.id);
        const verb = i.decision === 'approved' ? 'Approve' : 'Reject';
        const next = w ? nextStep(s, w.nodeId, i.decision) : null;
        // Who may vote and where the vote would stand: said before anyone confirms.
        const plan = w ? (w.approval ?? plainPlan()) : undefined;
        const voter = voterOf({ id: p.id, by: p.name, role: p.role, onBehalfOf: i.onBehalfOf });
        const votes = w && plan ? await orderRecords(env).votes(id, w.eventType) : [];
        const vote =
          w && plan
            ? await voteRefusal(env, plan, votes, voter, o, i.onBehalfOf, i.decision)
            : undefined;
        const after = plan ? tallyWith(plan, votes, voter, i.decision) : undefined;
        const decides = after ? after.status !== 'pending' : true;
        const group = plan ? describePlan(plan) : '';
        return {
          title: `${verb} ${orderRef(id)}${w ? ` · ${label(s, w.nodeId)}` : ''}`,
          href: `/orders/${id}`,
          consequences: [
            `${o.title || ORDER_MODEL_LABELS[o.model as OrderModel]} · ${money(o.total, o.currency)}`,
            ...(group ? [`Decided by: ${group}`] : []),
            ...(i.onBehalfOf
              ? [`Records ${i.onBehalfOf}’s vote; you are named as having recorded it`]
              : []),
            decides
              ? next
                ? `The order goes on to ${next}`
                : 'The order continues from this approval'
              : `Counts as a vote (${after!.label}); the order keeps waiting until it is decided`,
            i.note ? `Note: “${i.note}”` : 'No note',
          ],
          blocked:
            roleBlock ??
            own ??
            (w
              ? (vote ?? undefined)
              : s.waits.some((x) => x.kind === 'approval')
                ? 'This order has more than one approval open. Name the step.'
                : 'Nothing on this order is waiting for an approval now.'),
        };
      }
      case 'decide_approvals': {
        const i = input as ActionInput['decide_approvals'];
        const rows = await Promise.all(
          batchOf(i).map(async (a) => ({
            a,
            p: await previewAction(env, p, 'decide_approval', {
              ...a,
              decision: i.decision,
              ...(i.onBehalfOf ? { onBehalfOf: i.onBehalfOf } : {}),
            }),
          })),
        );
        const going = rows.filter((r) => !r.p.blocked);
        const verb = i.decision === 'approved' ? 'Approve' : 'Reject';
        return {
          title: `${verb} ${going.length === 1 ? '1 approval' : `${going.length} approvals`}`,
          href: '/approvals',
          consequences: [
            ...going.map((r) => r.p.title.replace(/^(Approve|Reject) /, '')),
            ...rows
              .filter((r) => r.p.blocked)
              .map((r) => `Skipped ${orderRef(r.a.orderId)}: ${r.p.blocked}`),
            i.note ? `Note on each: “${boundText(i.note, 300)}”` : 'No note',
          ],
          blocked:
            roleBlock ?? (going.length ? undefined : (rows[0]?.p.blocked ?? 'Nothing to decide.')),
        };
      }
      case 'deliver_event': {
        const i = input as ActionInput['deliver_event'];
        const { id, s } = await loadOrder(env, i.orderId);
        const w = s.waits.find((x) => x.kind === 'event' && x.event === i.event);
        const next = w ? nextStep(s, w.nodeId) : null;
        // Nothing waits yet, but a step of its flow will: held until then, as over REST.
        const holds =
          !w &&
          !TERMINAL_ORDER_STATUSES.includes(s.status) &&
          flowAwaits(await orderAgent(env, id).getFlow(), i.event);
        // This card can't say what the request refunds; `record_return`'s does.
        if (i.event === 'return.requested')
          return {
            title: `Deliver ${i.event} to ${orderRef(id)}`,
            href: `/orders/${id}`,
            consequences: [],
            blocked: roleBlock ?? RETURN_BY_RECORD,
          };
        return {
          title: `Deliver ${i.event} to ${orderRef(id)}`,
          href: `/orders/${id}`,
          consequences: w
            ? [
                `Resumes ${w.title}`,
                next ? `Then ${next} runs` : 'The order continues from there',
                // Text a caller sent: quoted and bounded, never read as the card's own words.
                ...Object.entries(i.payload ?? {}).map(
                  ([k, v]) =>
                    `With ${boundText(k, 60) ?? '?'}: “${boundText(String(v), 120) ?? ''}”`,
                ),
              ]
            : holds
              ? [`Held on the order until a step waits for ${i.event}, then given to it`]
              : [],
          blocked:
            roleBlock ??
            (w || holds
              ? undefined
              : `Nothing on this order is waiting for ${i.event}.${
                  s.waits.length
                    ? ` It waits for: ${s.waits.map((x) => x.event ?? x.title).join(', ')}.`
                    : ''
                }`),
        };
      }
      case 'record_return': {
        const i = input as ActionInput['record_return'];
        const { id, s, wait, request, issue } = await planReturn(env, i, p);
        const next = wait ? nextStep(s, wait.nodeId) : null;
        return {
          title: `Record a ${request?.kind ?? 'return'} on ${orderRef(id)}`,
          href: `/orders/${id}`,
          consequences: request
            ? [
                `Reason: ${request.reason}`,
                ...request.lines.map((l) => `${l.qty} × ${boundText(l.sku, 120)}`),
                request.goodsBack
                  ? `Refunds ${money(request.amount, s.order?.currency)} once the goods arrive`
                  : `Refunds ${money(request.amount, s.order?.currency)} now: nothing comes back`,
                ...(request.note ? [`Note: “${boundText(request.note, RETURN_NOTE_MAX)}”`] : []),
                next ? `Then ${next} runs` : 'The order continues from there',
              ]
            : [],
          blocked: roleBlock ?? issue,
        };
      }
      case 'cancel_order': {
        const i = input as ActionInput['cancel_order'];
        const { id, s } = await loadOrder(env, i.orderId);
        const o = s.order!;
        const undo = [
          ...new Set(
            (s.flow?.nodes ?? [])
              .filter((n) => s.nodes[n.id]?.status === 'succeeded' && ROLLBACK_EFFECTS[n.type])
              .map((n) => ROLLBACK_EFFECTS[n.type]!),
          ),
        ];
        return {
          title: `Cancel ${orderRef(id)}`,
          href: `/orders/${id}`,
          consequences: [
            `${o.title || ORDER_MODEL_LABELS[o.model as OrderModel]} · ${money(o.total, o.currency)}`,
            ...undo,
            ...(s.waits.some((w) => w.kind === 'approval') ? ['Closes its open approvals'] : []),
            'Sends order.cancelled to webhook subscribers',
            `Reason: “${i.reason}”`,
          ],
          blocked:
            roleBlock ??
            (TERMINAL_ORDER_STATUSES.includes(s.status)
              ? `This order has already finished (${s.status.replace('_', ' ')}).`
              : undefined),
        };
      }
      case 'submit_cart':
        return await previewSubmit(env, p, input as ActionInput['submit_cart']);
      case 'set_member_role':
        return await previewMemberRole(
          env,
          p,
          input as ActionInput['set_member_role'],
          roleBlock ?? personOnly(p),
        );
      case 'set_approval_separation':
        return await previewApprovalSeparation(
          env,
          (input as ActionInput['set_approval_separation']).on,
          roleBlock ?? personOnly(p),
        );
      case 'set_assistant_routing':
        return await previewRouting(
          env,
          (input as ActionInput['set_assistant_routing']).on,
          roleBlock ?? personOnly(p),
        );
      case 'set_plugin_enabled':
      case 'approve_plugin':
      case 'rollback_plugin':
      case 'uninstall_plugin':
        return await previewPlugin(
          env,
          p,
          { tool, ...(input as object) } as PluginChange,
          roleBlock,
        );
      case 'create_promotion':
        return await previewCreatePromotion(
          env,
          input as ActionInput['create_promotion'],
          roleBlock,
        );
      case 'set_promotion_status':
        return await previewPromotionStatus(
          env,
          input as ActionInput['set_promotion_status'],
          roleBlock,
        );
      case 'verify_tax_certificate':
      case 'revoke_tax_certificate':
        return await previewCertificate(
          env,
          p,
          tool === 'verify_tax_certificate' ? 'verify' : 'revoke',
          input as ActionInput['verify_tax_certificate'],
          roleBlock,
        );
      case 'set_fx_rate':
        return await previewFxRate(env, input as ActionInput['set_fx_rate'], roleBlock);
      case 'create_customer':
        return await previewCreateCustomer(env, input as ActionInput['create_customer'], roleBlock);
      case 'update_customer':
        return await previewUpdateCustomer(env, input as ActionInput['update_customer'], roleBlock);
      case 'set_company_status':
        return await previewCompanyStatus(
          env,
          input as ActionInput['set_company_status'],
          roleBlock,
        );
      case 'put_company_members':
        return await previewMembers(env, input as ActionInput['put_company_members'], roleBlock);
      case 'remove_company_member':
        return await previewRemoveMember(
          env,
          input as ActionInput['remove_company_member'],
          roleBlock,
        );
      case 'put_company_team':
        return await previewTeam(env, input as ActionInput['put_company_team'], roleBlock);
      case 'set_credit_limit':
        return await previewCreditLimit(env, input as ActionInput['set_credit_limit'], roleBlock);
      case 'adjust_credit':
        return await previewCreditAdjustment(env, input as ActionInput['adjust_credit'], roleBlock);
      case 'create_price_book':
        return await previewCreatePriceBook(
          env,
          input as ActionInput['create_price_book'],
          roleBlock,
        );
      case 'set_price_book_status':
        return await previewPriceBookStatus(
          env,
          input as ActionInput['set_price_book_status'],
          roleBlock,
        );
      case 'put_price_book_entries':
        return await previewPriceBookEntries(
          env,
          input as ActionInput['put_price_book_entries'],
          roleBlock,
        );
      case 'assign_price_book':
        return await previewPriceBookAssignment(
          env,
          input as ActionInput['assign_price_book'],
          roleBlock,
        );
      case 'put_contract_prices':
        return await previewContractPrices(
          env,
          input as ActionInput['put_contract_prices'],
          roleBlock,
        );
      case 'put_budget':
        return await previewBudget(env, input as ActionInput['put_budget'], roleBlock);
      case 'set_budget_status':
        return await previewBudgetStatus(env, input as ActionInput['set_budget_status'], roleBlock);
      case 'submit_po':
        return await previewSubmitPo(env, input as ActionInput['submit_po'], roleBlock);
      case 'cancel_po':
        return await previewCancelPo(env, input as ActionInput['cancel_po'], roleBlock);
      case 'send_quote':
        return await previewSendQuote(env, input as ActionInput['send_quote'], roleBlock);
      case 'accept_quote':
        return await previewAcceptQuote(env, input as ActionInput['accept_quote'], roleBlock);
      case 'decline_quote':
        return await previewDeclineQuote(env, input as ActionInput['decline_quote'], roleBlock);
      case 'expire_quote':
        return await previewExpireQuote(env, input as ActionInput['expire_quote'], roleBlock);
      case 'convert_quote':
        return await previewConvertQuote(env, input as ActionInput['convert_quote'], roleBlock);
      case 'delete_webhook_subscription':
        return await previewDeleteWebhook(
          env,
          input as ActionInput['delete_webhook_subscription'],
          roleBlock,
        );
      case 'revoke_integration':
        return await previewRevokeIntegration(
          env,
          input as ActionInput['revoke_integration'],
          roleBlock,
        );
      case 'revoke_ucp_platform':
        return await previewRevokePlatform(
          env,
          input as ActionInput['revoke_ucp_platform'],
          roleBlock,
        );
      case 'set_ucp_settings':
        return await previewUcpSettings(env, input as ActionInput['set_ucp_settings'], roleBlock);
      case 'put_catalog_products':
      case 'delete_catalog_products':
      case 'delete_catalog_type':
      case 'delete_catalog_channel':
      case 'put_catalog_categories':
      case 'delete_catalog_categories':
      case 'start_catalog_feed':
      case 'cancel_catalog_feed':
      case 'reindex_catalog':
      case 'rebuild_catalog_gaps':
        return await previewCatalogWrite(
          env,
          tool,
          input as CatalogWrite[CatalogWriteTool],
          roleBlock,
        );
      case 'publish_catalog':
        return await previewPublishCatalog(
          env,
          (input as ActionInput['publish_catalog']).keys,
          roleBlock,
        );
      case 'test_flow':
        return await previewTestFlow(env, (input as ActionInput['test_flow']).flowId, roleBlock);
      case 'cancel_cart':
        return await previewCancelCart(
          env,
          (input as ActionInput['cancel_cart']).cartId,
          roleBlock,
        );
      case 'start_order':
        return await previewStart(env, input as ActionInput['start_order'], roleBlock);
      case 'restart_order': {
        const { id } = await loadOrder(env, (input as ActionInput['restart_order']).orderId);
        return await previewRestart(env, id, roleBlock);
      }

      case 'publish_flow': {
        const i = input as ActionInput['publish_flow'];
        const { row, flow } = await loadFlow(env, i.flowId);
        const { errors } = validateGraph(flow, await registry(env));
        const live = row.publishedVersion
          ? await flowStore(env).version(row.id, row.publishedVersion)
          : null;
        const diff = live
          ? describeDiff(graphDiff(live as unknown as FlowGraph, flow))
          : 'First version';
        const next = (row.publishedVersion ?? 0) + 1;
        return {
          bound: { draft: await draftHash(flow) },
          title: `Publish ${row.name} v${next}`,
          href: `/flows/${row.id}`,
          consequences: [
            live
              ? `${diff ?? 'No changes'} since v${row.publishedVersion}`
              : 'This is the first version',
            `New ${ORDER_MODEL_LABELS[flow.model]} orders run it; orders already running keep their version`,
            'Publishes the saved draft. Unsaved changes in an open editor are not included',
          ],
          blocked:
            roleBlock ??
            (errors.length
              ? `The draft has ${errors.length} problem${errors.length === 1 ? '' : 's'} to fix first: ${errors[0]!.message}`
              : live && !diff
                ? `Nothing to publish: v${row.publishedVersion} is current.`
                : undefined),
        };
      }
      case 'run_stock_review': {
        const low = (await findProducts(env, undefined, true)).products;
        return {
          title: 'Run the stock review now',
          href: '/commerce',
          consequences: [
            low.length
              ? `Starts a reorder for ${low.length} SKU${low.length === 1 ? '' : 's'} at or below the reorder point: ${low
                  .slice(0, 5)
                  .map((x) => x.sku)
                  .join(', ')}${low.length > 5 ? '…' : ''}`
              : 'No SKU is at or below its reorder point, so it should start nothing',
            'The same review runs every day at 06:00 UTC',
          ],
          blocked: roleBlock,
        };
      }
    }
  } catch (err) {
    if (err instanceof Refused)
      return { title: ASSISTANT_TOOLS[tool].label, consequences: [], blocked: err.message };
    throw err;
  }
  return { title: ASSISTANT_TOOLS[tool].label, consequences: [], blocked: 'Unknown action.' };
}

/** Carries out a confirmed action as the person, after checking it can still go ahead. */
export async function runAction<T extends ActionTool>(
  env: Env,
  p: Principal,
  tool: T,
  input: ActionInput[T],
  channel: Channel = 'assistant',
  confirmed?: Confirmed,
  /** A page's own button made the call (`act`), not a model. */
  direct?: boolean,
  /** What the confirm was for, unique to it: an order it starts is started once for it. */
  key?: string,
): Promise<Record<string, unknown>> {
  requireRole(p, tool);
  // Who may do what on the team is changed only in the app, never over MCP or A2A.
  if (isPanelOnly(tool) && channel !== 'assistant')
    throw new Refused('This is changed only in the app, by a person signed in.');
  const preview = await previewAction(env, p, tool, input);
  if (preview.blocked) throw new Refused(preview.blocked);
  // What its page asks a step-up for needs one on this session, read from the session itself.
  if (await stepUpNeeded(env, p, tool, input as Record<string, unknown>)) requireSteppedUp(p);
  const by = via(p, channel);
  // A connected app's grant and client, so the audit trail tells two apps one person connected apart.
  const app = p as { grant?: string; client?: string };
  const trail = {
    via: AUDIT_CHANNEL[channel],
    tool,
    ...(direct ? { direct: true } : {}),
    ...(app.grant ? { grant: app.grant } : {}),
    ...(app.client ? { client: app.client } : {}),
  };
  switch (tool) {
    case 'decide_approval': {
      const i = input as ActionInput['decide_approval'];
      const { id, s } = await loadOrder(env, i.orderId);
      const w = approvalWait(s, i.nodeId)!;
      const voted = (await orderAgent(env, id).castVote({
        nodeId: w.nodeId,
        decision: i.decision,
        by,
        note: i.note,
        deciderId: p.id,
        onBehalfOf: i.onBehalfOf,
        role: p.role,
      })) as VoteResult;
      if (!voted.ok) throw new Refused(voted.error);
      await recordAudit(env, 'approval.decided', {
        actor: p,
        target: id,
        detail: {
          nodeId: w.nodeId,
          decision: i.decision,
          ...(i.note ? { note: i.note } : {}),
          ...(i.onBehalfOf ? { onBehalfOf: i.onBehalfOf } : {}),
          ...(voted.audited ? { outcome: voted.outcome, tally: voted.tally } : {}),
          ...trail,
        },
      });
      return {
        done:
          voted.outcome === 'recorded'
            ? `Recorded a vote on ${orderRef(id)} (${voted.tally})`
            : preview.title,
        href: preview.href,
        outcome: voted.outcome,
        tally: voted.tally,
      };
    }
    case 'decide_approvals': {
      // Each one on its own, with its own checks and audit row: one refused doesn't stop the rest.
      const i = input as ActionInput['decide_approvals'];
      const results: {
        orderId: string;
        nodeId: string;
        ok: boolean;
        error?: string;
        outcome?: 'recorded' | 'approved' | 'rejected';
        tally?: string;
      }[] = [];
      for (const a of batchOf(i)) {
        try {
          const r = await runAction(
            env,
            p,
            'decide_approval',
            { ...a, decision: i.decision, note: i.note, onBehalfOf: i.onBehalfOf },
            channel,
            undefined,
            direct,
          );
          results.push({
            ...a,
            ok: true,
            ...(r.outcome
              ? {
                  outcome: r.outcome as 'recorded' | 'approved' | 'rejected',
                  tally: String(r.tally),
                }
              : {}),
          });
        } catch (err) {
          if (!(err instanceof Refused)) throw err;
          results.push({ ...a, ok: false, error: err.message });
        }
      }
      const ok = results.filter((r) => r.ok).length;
      if (!ok) throw new Refused(results[0]?.error ?? 'Nothing was decided.');
      const verb = i.decision === 'approved' ? 'Approved' : 'Rejected';
      // A vote that doesn't yet decide its approval is counted, not approved or rejected.
      const waiting = results.filter((r) => r.outcome === 'recorded').length;
      return {
        done: `${verb} ${ok - waiting} of ${results.length}${waiting ? `, ${waiting} recorded as a vote` : ''}`,
        href: '/approvals',
        results,
      };
    }
    case 'deliver_event': {
      const i = input as ActionInput['deliver_event'];
      if (i.event === 'return.requested') throw new Refused(RETURN_BY_RECORD);
      const { id } = await loadOrder(env, i.orderId);
      // Its source and `by` last: the payload never names who or what delivered it.
      const r = await orderAgent(env, id).deliver(
        i.event,
        { ...i.payload, source: AUDIT_CHANNEL[channel], by },
        { hold: true },
      );
      const held = !r.delivered && 'held' in r && r.held === true;
      if (!r.delivered && !held)
        throw new Refused(`Nothing on ${orderRef(id)} was waiting for ${i.event}.`);
      await recordAudit(env, 'order.event_delivered', {
        actor: p,
        target: id,
        detail: {
          event: i.event,
          ...(held ? { held: true } : { nodeId: 'nodeId' in r ? r.nodeId : undefined }),
          ...(i.payload ? { payload: boundPayload(i.payload) } : {}),
          ...trail,
        },
      });
      return {
        done: held ? `Held ${i.event} on ${orderRef(id)} until a step waits for it` : preview.title,
        href: preview.href,
      };
    }
    case 'record_return': {
      const i = input as ActionInput['record_return'];
      const { id, request, issue } = await planReturn(env, i, p);
      if (!request) throw new Refused(issue ?? `${orderRef(id)} isn't waiting for a return.`);
      // Its source and `by` last, as for any event: the request never names who delivered it.
      const r = await orderAgent(env, id).recordReturn(request, {
        source: AUDIT_CHANNEL[channel],
        by,
      });
      if (!r.delivered) throw new Refused(`${orderRef(id)} isn't waiting for a return.`);
      await recordAudit(env, 'order.event_delivered', {
        actor: p,
        target: id,
        detail: {
          event: 'return.requested',
          nodeId: r.nodeId,
          kind: request.kind,
          reasonCode: request.reasonCode,
          amount: request.amount,
          lines: request.lines.length,
          ...trail,
        },
      });
      return { done: preview.title, href: preview.href };
    }
    case 'cancel_order': {
      const i = input as ActionInput['cancel_order'];
      const { id } = await loadOrder(env, i.orderId);
      await orderAgent(env, id).cancel(`${i.reason} (${by})`);
      await recordAudit(env, 'order.cancelled', {
        actor: p,
        target: id,
        detail: { reason: i.reason, ...trail },
      });
      return { done: preview.title, href: preview.href };
    }
    case 'submit_cart':
      return runSubmit(env, p, input as ActionInput['submit_cart'], channel, confirmed);
    case 'cancel_cart':
      return runCancelCart(env, p, (input as ActionInput['cancel_cart']).cartId, trail);
    case 'set_member_role':
      return runMemberRole(env, p, input as ActionInput['set_member_role'], trail);
    case 'set_approval_separation':
      return runApprovalSeparation(
        env,
        p,
        (input as ActionInput['set_approval_separation']).on,
        trail,
      );
    case 'set_assistant_routing':
      return runRouting(env, p, (input as ActionInput['set_assistant_routing']).on, trail);
    case 'set_plugin_enabled':
    case 'approve_plugin':
    case 'rollback_plugin':
    case 'uninstall_plugin':
      return runPlugin(env, p, { tool, ...(input as object) } as PluginChange, trail);
    case 'create_promotion':
      return runCreatePromotion(env, p, input as ActionInput['create_promotion'], trail);
    case 'set_promotion_status':
      return runPromotionStatus(env, p, input as ActionInput['set_promotion_status'], trail);
    case 'verify_tax_certificate':
    case 'revoke_tax_certificate':
      return runCertificate(
        env,
        p,
        tool === 'verify_tax_certificate' ? 'verify' : 'revoke',
        input as ActionInput['verify_tax_certificate'],
        trail,
      );
    case 'set_fx_rate':
      return runFxRate(env, p, input as ActionInput['set_fx_rate'], trail);
    case 'create_customer':
      return runCreateCustomer(env, p, input as ActionInput['create_customer'], trail);
    case 'update_customer':
      return runUpdateCustomer(env, p, input as ActionInput['update_customer'], trail);
    case 'set_company_status':
      return runCompanyStatus(env, p, input as ActionInput['set_company_status'], trail);
    case 'put_company_members':
      return runMembers(env, p, input as ActionInput['put_company_members'], trail);
    case 'remove_company_member':
      return runRemoveMember(env, p, input as ActionInput['remove_company_member'], trail);
    case 'put_company_team':
      return runTeam(env, p, input as ActionInput['put_company_team'], trail);
    case 'set_credit_limit':
      return runCreditLimit(env, p, input as ActionInput['set_credit_limit'], trail);
    case 'adjust_credit':
      return runCreditAdjustment(env, p, input as ActionInput['adjust_credit'], trail, key);
    case 'create_price_book':
      return runCreatePriceBook(env, p, input as ActionInput['create_price_book'], trail);
    case 'set_price_book_status':
      return runPriceBookStatus(env, p, input as ActionInput['set_price_book_status'], trail);
    case 'put_price_book_entries':
      return runPriceBookEntries(env, p, input as ActionInput['put_price_book_entries'], trail);
    case 'assign_price_book':
      return runPriceBookAssignment(env, p, input as ActionInput['assign_price_book'], trail);
    case 'put_contract_prices':
      return runContractPrices(env, p, input as ActionInput['put_contract_prices'], trail);
    case 'put_budget':
      return runBudget(env, p, input as ActionInput['put_budget'], trail);
    case 'set_budget_status':
      return runBudgetStatus(env, p, input as ActionInput['set_budget_status'], trail);
    case 'submit_po':
      return runSubmitPo(env, p, input as ActionInput['submit_po'], trail);
    case 'cancel_po':
      return runCancelPo(env, p, input as ActionInput['cancel_po'], trail);
    case 'send_quote':
      return runSendQuote(env, p, input as ActionInput['send_quote'], trail, confirmed);
    case 'accept_quote':
      return runAcceptQuote(env, p, input as ActionInput['accept_quote'], trail);
    case 'decline_quote':
      return runDeclineQuote(env, p, input as ActionInput['decline_quote'], trail);
    case 'expire_quote':
      return runExpireQuote(env, p, input as ActionInput['expire_quote'], trail);
    case 'convert_quote':
      return runConvertQuote(env, p, input as ActionInput['convert_quote'], trail);
    case 'delete_webhook_subscription':
      return runDeleteWebhook(env, p, input as ActionInput['delete_webhook_subscription'], trail);
    case 'revoke_integration':
      return runRevokeIntegration(env, p, input as ActionInput['revoke_integration'], trail);
    case 'revoke_ucp_platform':
      return runRevokePlatform(env, p, input as ActionInput['revoke_ucp_platform'], trail);
    case 'set_ucp_settings':
      return runUcpSettings(env, p, input as ActionInput['set_ucp_settings'], trail);
    case 'put_catalog_products':
    case 'delete_catalog_products':
    case 'delete_catalog_type':
    case 'delete_catalog_channel':
    case 'put_catalog_categories':
    case 'delete_catalog_categories':
    case 'start_catalog_feed':
    case 'cancel_catalog_feed':
    case 'reindex_catalog':
    case 'rebuild_catalog_gaps':
      return runCatalogWrite(env, p, tool, input as CatalogWrite[CatalogWriteTool], trail);
    case 'publish_catalog':
      return runPublishCatalog(
        env,
        p,
        (input as ActionInput['publish_catalog']).keys,
        key,
        trail,
        confirmed,
      );
    case 'test_flow':
      return runTestFlow(env, p, (input as ActionInput['test_flow']).flowId, key, trail, confirmed);
    case 'start_order':
      return runStart(env, p, input as ActionInput['start_order'], key, trail);
    case 'restart_order': {
      const { id } = await loadOrder(env, (input as ActionInput['restart_order']).orderId);
      return runRestart(env, p, id, key, trail);
    }

    case 'publish_flow': {
      const i = input as ActionInput['publish_flow'];
      const { flow } = await loadFlow(env, i.flowId);
      await heldToDraft(confirmed, flow);
      const version = await flowStore(env).publish(
        { ...flow, nodes: flow.nodes, edges: flow.edges },
        { publishedBy: p.email ?? p.name },
      );
      await recordAudit(env, 'flow.published', {
        actor: p,
        target: flow.id,
        detail: { name: flow.name, version, ...trail },
      });
      return { done: `Published ${flow.name} v${version}`, href: `/flows/${flow.id}`, version };
    }
    case 'run_stock_review': {
      const instance = await env.REPLENISH.create({ params: {} });
      await recordAudit(env, 'stock.review_run', {
        actor: p,
        detail: { instanceId: instance.id, ...trail },
      });
      return { done: 'Started the stock review', href: '/commerce', instanceId: instance.id };
    }
  }
  throw new Refused('Unknown action.');
}
