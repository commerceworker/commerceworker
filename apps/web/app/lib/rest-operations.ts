/**
 * REST routes that run a workspace tool exactly as MCP does: the engine's `runOperation` checks
 * the tool's role, runs an action's live preview and refusals (and any step-up), and writes the
 * audit trail (`via: api`). Each route names its tool; its `{placeholders}` are that tool's input
 * fields, read from the path, and the JSON body (a POST) or nothing (a GET) gives the rest. The
 * OpenAPI document is generated from this table and `TOOL_INPUTS`, and
 * tests/rest-mcp-parity.test.ts holds every entry to its tool.
 */
import {
  ASSISTANT_TOOLS,
  type AssistantTool,
  isPageOnly,
  isPanelOnly,
  type RestOperationTool,
  TOOL_INPUTS,
} from '@commerceworker/core';
import { z } from 'zod';

export type RestOperation = {
  readonly method: 'GET' | 'POST';
  /** Under /api/v1, e.g. `/orders/{orderId}/restart`. */
  readonly path: string;
  /** One of core's `REST_OPERATION_TOOLS`, which the engine checks too. */
  readonly tool: RestOperationTool;
};

export const REST_OPERATIONS: readonly RestOperation[] = [
  { method: 'GET', path: '/attention', tool: 'needs_attention' },
  { method: 'POST', path: '/orders/{orderId}/restart', tool: 'restart_order' },
  { method: 'POST', path: '/approvals/decide', tool: 'decide_approvals' },
  { method: 'GET', path: '/flows/{flowId}', tool: 'get_flow' },
  { method: 'POST', path: '/flows/new', tool: 'create_flow' },
  { method: 'POST', path: '/flows/{flowId}/publish', tool: 'publish_flow' },
  { method: 'POST', path: '/flows/{flowId}/test', tool: 'test_flow' },
  { method: 'POST', path: '/flows/{flowId}/duplicate', tool: 'duplicate_flow' },
  { method: 'POST', path: '/flows/{flowId}/archive', tool: 'archive_flow' },
  { method: 'GET', path: '/price-books', tool: 'list_price_books' },
  { method: 'POST', path: '/price-books', tool: 'create_price_book' },
  { method: 'GET', path: '/price-books/{bookId}', tool: 'get_price_book' },
  { method: 'POST', path: '/price-books/{bookId}/status', tool: 'set_price_book_status' },
  { method: 'POST', path: '/price-books/{bookId}/entries', tool: 'put_price_book_entries' },
  { method: 'POST', path: '/price-books/{bookId}/assignments', tool: 'assign_price_book' },
  { method: 'POST', path: '/customers/{customerId}/contract-prices', tool: 'put_contract_prices' },
  { method: 'POST', path: '/price-preview', tool: 'preview_price' },
  { method: 'GET', path: '/fx-rates', tool: 'list_fx_rates' },
  { method: 'POST', path: '/fx-rates/{currency}', tool: 'set_fx_rate' },
  { method: 'POST', path: '/promotions', tool: 'create_promotion' },
  { method: 'POST', path: '/promotions/{promotionId}/status', tool: 'set_promotion_status' },
  {
    method: 'POST',
    path: '/customers/{customerId}/tax-certificates/{certificateId}/verify',
    tool: 'verify_tax_certificate',
  },
  {
    method: 'POST',
    path: '/customers/{customerId}/tax-certificates/{certificateId}/revoke',
    tool: 'revoke_tax_certificate',
  },
  { method: 'GET', path: '/companies', tool: 'list_companies' },
  { method: 'GET', path: '/companies/{companyId}', tool: 'get_company' },
  { method: 'GET', path: '/companies/{companyId}/members', tool: 'list_company_members' },
  { method: 'POST', path: '/customers', tool: 'create_customer' },
  { method: 'POST', path: '/customers/{customerId}/update', tool: 'update_customer' },
  { method: 'POST', path: '/companies/{companyId}/status', tool: 'set_company_status' },
  { method: 'POST', path: '/companies/{companyId}/members', tool: 'put_company_members' },
  {
    method: 'POST',
    path: '/companies/{companyId}/members/{memberId}/remove',
    tool: 'remove_company_member',
  },
  { method: 'POST', path: '/companies/{companyId}/teams', tool: 'put_company_team' },
  { method: 'GET', path: '/customers/{customerId}/credit', tool: 'get_credit_account' },
  { method: 'POST', path: '/customers/{customerId}/credit/limit', tool: 'set_credit_limit' },
  { method: 'POST', path: '/customers/{customerId}/credit/adjustments', tool: 'adjust_credit' },
  { method: 'GET', path: '/companies/{companyId}/budgets', tool: 'list_budgets' },
  { method: 'POST', path: '/companies/{companyId}/budgets', tool: 'put_budget' },
  {
    method: 'POST',
    path: '/companies/{companyId}/budgets/{budgetId}/status',
    tool: 'set_budget_status',
  },
  { method: 'GET', path: '/purchase-orders', tool: 'list_purchase_orders' },
  { method: 'POST', path: '/purchase-orders', tool: 'create_po_draft' },
  { method: 'GET', path: '/purchase-orders/{poId}', tool: 'get_purchase_order' },
  { method: 'POST', path: '/purchase-orders/{poId}/update', tool: 'update_po_draft' },
  { method: 'POST', path: '/purchase-orders/{poId}/submit', tool: 'submit_po' },
  { method: 'POST', path: '/purchase-orders/{poId}/cancel', tool: 'cancel_po' },
  { method: 'GET', path: '/quotes', tool: 'list_quotes' },
  { method: 'POST', path: '/quotes', tool: 'create_quote' },
  { method: 'GET', path: '/quotes/{quoteId}', tool: 'get_quote' },
  { method: 'POST', path: '/quotes/{quoteId}/update', tool: 'update_quote' },
  { method: 'POST', path: '/quotes/{quoteId}/send', tool: 'send_quote' },
  { method: 'POST', path: '/quotes/{quoteId}/accept', tool: 'accept_quote' },
  { method: 'POST', path: '/quotes/{quoteId}/decline', tool: 'decline_quote' },
  { method: 'POST', path: '/quotes/{quoteId}/revise', tool: 'revise_quote' },
  { method: 'POST', path: '/quotes/{quoteId}/expire', tool: 'expire_quote' },
  { method: 'POST', path: '/quotes/{quoteId}/convert', tool: 'convert_quote' },
  { method: 'POST', path: '/stock/review', tool: 'run_stock_review' },
  { method: 'GET', path: '/stock', tool: 'find_products' },
  { method: 'POST', path: '/orders/{orderId}/assess', tool: 'assess_order' },
  { method: 'POST', path: '/flows/{flowId}/propose', tool: 'propose_flow_change' },
  { method: 'POST', path: '/plugin-drafts', tool: 'draft_plugin' },
];

const segments = (path: string) => path.split('/').filter(Boolean);

/** The path's `{placeholders}`, in order. */
export const pathFields = (op: RestOperation) =>
  segments(op.path)
    .filter((s) => s.startsWith('{'))
    .map((s) => s.slice(1, -1));

/** The operation a request names, with the fields its path gives; undefined when none does. */
export function matchOperation(
  method: string,
  parts: readonly string[],
): { op: RestOperation; fromPath: Record<string, string> } | undefined {
  for (const op of REST_OPERATIONS) {
    if (op.method !== method) continue;
    const want = segments(op.path);
    if (want.length !== parts.length) continue;
    const fromPath: Record<string, string> = {};
    const fits = want.every((w, i) => {
      const got = parts[i]!;
      if (!w.startsWith('{')) return w === got;
      fromPath[w.slice(1, -1)] = got;
      return got.length > 0 && got.length <= 200;
    });
    if (fits) return { op, fromPath };
  }
  return undefined;
}

/** The body an operation takes: its tool's input less the fields its path gives. */
export function operationBody(op: RestOperation): z.ZodObject {
  const fields = pathFields(op);
  const input = TOOL_INPUTS[op.tool] as z.ZodObject;
  return fields.length
    ? input.omit(Object.fromEntries(fields.map((f) => [f, true])) as Record<string, true>)
    : input;
}

/** Whether a tool can be a REST operation: MCP offers it (not the page's or the panel's alone). */
export const offeredOverRest = (tool: AssistantTool) => !isPageOnly(tool) && !isPanelOnly(tool);

export const operationRole = (op: RestOperation) => ASSISTANT_TOOLS[op.tool].role;

/**
 * A GET's input from its query string, each value read as the tool's field types it (`true` and
 * `false` for a boolean, a number for a number), so `?belowReorder=true` is the boolean MCP takes.
 * A field the tool doesn't take is left out; the tool's schema checks the rest.
 */
export function queryInput(op: RestOperation, params: URLSearchParams): Record<string, unknown> {
  const props =
    (
      z.toJSONSchema(operationBody(op), { io: 'input', unrepresentable: 'any' }) as {
        properties?: Record<string, { type?: string }>;
      }
    ).properties ?? {};
  const input: Record<string, unknown> = {};
  for (const [name, value] of params) {
    const type = props[name]?.type;
    if (!type) continue;
    input[name] =
      type === 'boolean'
        ? value === 'true'
          ? true
          : value === 'false'
            ? false
            : value
        : type === 'number' || type === 'integer'
          ? Number(value)
          : value;
  }
  return input;
}
