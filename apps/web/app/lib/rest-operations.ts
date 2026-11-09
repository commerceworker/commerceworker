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
  TOOL_INPUTS,
} from '@commerceworker/core';
import type { z } from 'zod';

export type RestOperation = {
  readonly method: 'GET' | 'POST';
  /** Under /api/v1, e.g. `/orders/{orderId}/restart`. */
  readonly path: string;
  readonly tool: AssistantTool;
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
  { method: 'POST', path: '/stock/review', tool: 'run_stock_review' },
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
