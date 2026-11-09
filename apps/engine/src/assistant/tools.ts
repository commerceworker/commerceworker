/**
 * The workspace tools, once, for every channel that offers them: the assistant's model (AI SDK
 * tools in agent.ts) and MCP clients (mcp.ts). Names, roles, titles and descriptions are in
 * `ASSISTANT_TOOLS` (@commerceworker/core); this adds each tool's input schema and what it runs.
 * Every run checks the caller's role first, as they are now; actions also re-check the action
 * against live data (`runAction`).
 */

import {
  type AssistantContext,
  type AssistantTool,
  type AuditVia,
  isPageOnly,
  isPanelOnly,
  type Principal,
  type ToolInput,
} from '@commerceworker/core';
import type { StageEdit } from '@commerceworker/core/product';
import { runCases } from './admin';
import { draftCartReply } from './cart-reply';
import { changeCart, getCart, listCarts, openCart } from './carts';
import { acceptProductDrafts, discardProductEdits, stageProductEdits } from './catalog';
import {
  type ActionInput,
  type ActionTool,
  AUDIT_CHANNEL,
  assessOrder,
  attention,
  type Channel,
  type Confirmed,
  findOrders,
  findProducts,
  getFlow,
  getOrder,
  listFlows,
  proposeFlowChange,
  Refused,
  requireRole,
  runAction,
} from './data';
import { createFlow, duplicateFlow, saveFlowDraft, setFlowArchived } from './flows';
import { startScenario } from './orders';

/** The audit trail of a write that needs no confirm: the channel, the tool, a page's button. */
const trailOf = (p: Principal, tool: AssistantTool, opts: { via: Channel; direct?: boolean }) => {
  // A connected app's grant and client, as `runAction` records them.
  const app = p as { grant?: string; client?: string };
  return {
    via: AUDIT_CHANNEL[opts.via],
    tool,
    ...(opts.direct ? { direct: true } : {}),
    ...(app.grant ? { grant: app.grant } : {}),
    ...(app.client ? { client: app.client } : {}),
  };
};

import { draftPlugin } from './plugin-draft';
import { draftProductContent } from './product-draft';

const auditVia = (via: Channel): AuditVia => AUDIT_CHANNEL[via];

export { RESERVED_EVENT_FIELDS } from '@commerceworker/core';

export const ACTION_TOOLS: ActionTool[] = [
  'decide_approval',
  'decide_approvals',
  'deliver_event',
  'cancel_order',
  'record_return',
  'submit_cart',
  'publish_flow',
  'run_stock_review',
  'start_order',
  'restart_order',
  'cancel_cart',
  'test_flow',
  'publish_catalog',
  'create_promotion',
  'set_promotion_status',
  'verify_tax_certificate',
  'revoke_tax_certificate',
  'set_member_role',
  'set_approval_separation',
  'set_assistant_routing',
  'set_plugin_enabled',
  'approve_plugin',
  'rollback_plugin',
  'uninstall_plugin',
];

export const isActionTool = (name: AssistantTool): name is ActionTool =>
  ACTION_TOOLS.includes(name as ActionTool);

/**
 * Runs a tool as `p`. `via` names the channel in the order's audit trail ("… via MCP");
 * `context` is the assistant panel's page, which only the flow draft uses; `confirmed` is what
 * an action's confirm was held to (`runAction`); `direct` marks a call a page's own button made
 * through the assistant (`act`), so the audit trail tells it apart from one a model proposed.
 */
export async function runTool<T extends AssistantTool>(
  env: Env,
  p: Principal,
  name: T,
  input: ToolInput<T>,
  opts: {
    via: Channel;
    context?: AssistantContext;
    confirmed?: Confirmed;
    direct?: boolean;
    /** Unique to this call (a page's `act` id): an order it starts, it starts once. */
    key?: string;
  },
): Promise<unknown> {
  if (isPanelOnly(name) && opts.via !== 'assistant')
    throw new Refused('This is changed only in the app, by a person signed in.');
  if (isActionTool(name))
    return runAction(
      env,
      p,
      name,
      input as ActionInput[typeof name],
      opts.via,
      opts.confirmed,
      opts.direct,
      opts.key,
    );
  requireRole(p, name);
  // Only from the page's own button: the model, MCP and A2A never see it, and can't call it.
  if (isPageOnly(name) && !opts.direct) throw new Refused('This runs only from its page.');
  switch (name) {
    case 'needs_attention':
      return attention(env);
    case 'find_orders':
      return findOrders(env, input as ToolInput<'find_orders'>);
    case 'get_order':
      return getOrder(env, (input as ToolInput<'get_order'>).orderId);
    case 'assess_order': {
      const i = input as ToolInput<'assess_order'>;
      return assessOrder(env, i.orderId, i.questions, i.images);
    }
    case 'find_products': {
      const i = input as ToolInput<'find_products'>;
      return findProducts(env, i.q, i.belowReorder);
    }
    case 'list_carts':
      return listCarts(env, input as ToolInput<'list_carts'>);
    case 'get_cart':
      return getCart(env, (input as ToolInput<'get_cart'>).cartId);
    case 'create_cart':
      return openCart(env, p, input as ToolInput<'create_cart'>, opts.via);
    case 'change_cart': {
      const i = input as ToolInput<'change_cart'>;
      return changeCart(env, p, i.cartId, i.ops, opts.via, opts.direct);
    }
    case 'list_flows':
      return listFlows(env);
    case 'get_flow':
      return getFlow(env, (input as ToolInput<'get_flow'>).flowId);
    case 'propose_flow_change': {
      const i = input as ToolInput<'propose_flow_change'>;
      const c = opts.context;
      const onScreen = c?.kind === 'flow' && c.id === i.flowId ? c : undefined;
      return proposeFlowChange(env, i.flowId, i.instruction, onScreen);
    }
    case 'draft_plugin': {
      const i = input as ToolInput<'draft_plugin'>;
      return draftPlugin(env, p, i.instruction, { pluginId: i.pluginId, via: auditVia(opts.via) });
    }
    case 'run_plugin_cases':
      return runCases(env, p, input as ToolInput<'run_plugin_cases'>, trailOf(p, name, opts));
    case 'stage_product_edits':
      return stageProductEdits(
        env,
        p,
        (input as ToolInput<'stage_product_edits'>).edits as StageEdit[],
        trailOf(p, name, opts),
      );
    case 'accept_product_drafts':
      return acceptProductDrafts(
        env,
        p,
        (input as ToolInput<'accept_product_drafts'>).key,
        trailOf(p, name, opts),
      );
    case 'discard_product_edits': {
      const i = input as ToolInput<'discard_product_edits'>;
      return discardProductEdits(env, p, i.what, i.items, trailOf(p, name, opts));
    }
    case 'save_flow_draft':
      return saveFlowDraft(env, p, input as ToolInput<'save_flow_draft'>, trailOf(p, name, opts));
    case 'create_flow':
      return createFlow(env, p, input as ToolInput<'create_flow'>, trailOf(p, name, opts));
    case 'duplicate_flow':
      return duplicateFlow(
        env,
        p,
        (input as ToolInput<'duplicate_flow'>).flowId,
        trailOf(p, name, opts),
      );
    case 'archive_flow': {
      const i = input as ToolInput<'archive_flow'>;
      return setFlowArchived(env, p, i.flowId, i.archived, trailOf(p, name, opts));
    }
    case 'draft_cart_reply': {
      const i = input as ToolInput<'draft_cart_reply'>;
      return draftCartReply(env, p, i.cartId, i.instruction, trailOf(p, name, opts));
    }
    case 'start_scenario':
      return startScenario(
        env,
        p,
        (input as ToolInput<'start_scenario'>).scenarioId,
        trailOf(p, name, opts),
      );
    case 'draft_product_content': {
      const { key, ...request } = input as ToolInput<'draft_product_content'>;
      return draftProductContent(env, p, key, request, auditVia(opts.via));
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}
