/**
 * UCP's MCP binding at `/ucp/mcp`: streamable HTTP, answered with plain JSON (one JSON-RPC
 * response per POST, no stream). The checkout and order operations are its tools, one for one:
 * `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout` and
 * `get_order`. Arguments are `{ meta, id?, checkout? }`, where `meta["ucp-agent"].profile` must be
 * the calling platform's profile and `meta["idempotency-key"]` is required to complete or cancel.
 * The catalog's reads, `search_catalog`, `lookup_catalog` and `get_product`, are tools too; their
 * argument is `{ meta, catalog }`, the request body of the same REST route (./catalog.ts), and they
 * take no idempotency key.
 *
 * It answers JSON-RPC itself rather than through the MCP SDK because UCP fixes the error shape: a
 * protocol error is a JSON-RPC error (-32001 for profile problems, -32000 otherwise), and a
 * business outcome is a result whose `structuredContent` is the UCP body.
 */

import {
  type PlatformCaller,
  UCP_CATALOG_TOOLS,
  type UcpCatalogOp,
  ucpCheckoutInput,
} from '@commerceworker/core';
import { idempotencyKeyProblem, readCappedText } from '../body';
import { catalogCall, isJson } from './catalog';
import {
  cancelCheckout,
  checkoutRefusal,
  completeCheckout,
  createCheckout,
  getCheckout,
  getOrder,
  type UcpResult,
  updateCheckout,
} from './checkout';
import { once } from './idempotency';
import { contextFor } from './rest';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_BODY = 256 * 1024;

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const meta = {
  type: 'object',
  properties: {
    'ucp-agent': {
      type: 'object',
      properties: { profile: { type: 'string', format: 'uri' } },
      required: ['profile'],
    },
    'idempotency-key': { type: 'string' },
  },
  required: ['ucp-agent'],
};
const id = { type: 'string', description: 'The checkout session id.' };
const checkout = {
  type: 'object',
  description:
    'The checkout payload (dev.ucp.shopping.checkout, with dev.ucp.shopping.fulfillment and dev.ucp.shopping.discount).',
};
const SCHEMA = 'https://ucp.dev/2026-08-25/schemas/shopping';
const catalog = (description: string) => ({ type: 'object', description });
/** A catalog result, or the error response a missing product or an unavailable catalog is. */
const catalogResult = (ref: string) => ({
  oneOf: [
    { $ref: `${SCHEMA}/${ref}` },
    { $ref: 'https://ucp.dev/2026-08-25/schemas/common/types/error_response.json' },
  ],
});
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOLS = [
  {
    name: 'create_checkout',
    description: 'Create a checkout session.',
    inputSchema: { type: 'object', properties: { meta, checkout }, required: ['meta', 'checkout'] },
    outputSchema: { $ref: `${SCHEMA}/checkout.json` },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'get_checkout',
    description: 'Get a checkout session.',
    inputSchema: { type: 'object', properties: { meta, id }, required: ['meta', 'id'] },
    outputSchema: { $ref: `${SCHEMA}/checkout.json` },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'update_checkout',
    description: 'Update a checkout session: the payload replaces the session.',
    inputSchema: {
      type: 'object',
      properties: { meta, id, checkout },
      required: ['meta', 'id', 'checkout'],
    },
    outputSchema: { $ref: `${SCHEMA}/checkout.json` },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'complete_checkout',
    description: 'Place the order: pay with the selected payment instrument.',
    inputSchema: {
      type: 'object',
      properties: { meta, id, checkout },
      required: ['meta', 'id', 'checkout'],
    },
    outputSchema: { $ref: `${SCHEMA}/checkout.json` },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'cancel_checkout',
    description: 'Cancel a checkout session.',
    inputSchema: { type: 'object', properties: { meta, id }, required: ['meta', 'id'] },
    outputSchema: { $ref: `${SCHEMA}/checkout.json` },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_order',
    description: 'Get an order this platform placed.',
    inputSchema: {
      type: 'object',
      properties: { meta, id: { type: 'string', description: 'The order id.' } },
      required: ['meta', 'id'],
    },
    outputSchema: { $ref: `${SCHEMA}/order.json` },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_catalog',
    description:
      'Search the catalog by query text, or list one category (filters.categories with a single value); filter by price in minor units. Prices are in the catalog currency.',
    inputSchema: {
      type: 'object',
      properties: {
        meta,
        catalog: catalog(
          'catalog_search.json#/$defs/search_request: query, filters, context, pagination',
        ),
      },
      required: ['meta', 'catalog'],
    },
    outputSchema: catalogResult('catalog_search.json#/$defs/search_response'),
    annotations: READ,
  },
  {
    name: 'lookup_catalog',
    description:
      'Look up products or variants by product key or SKU. Each variant says which ids resolved to it.',
    inputSchema: {
      type: 'object',
      properties: {
        meta,
        catalog: catalog(
          'catalog_lookup.json#/$defs/lookup_request: ids (up to 50), filters, context',
        ),
      },
      required: ['meta', 'catalog'],
    },
    outputSchema: catalogResult('catalog_lookup.json#/$defs/lookup_response'),
    annotations: READ,
  },
  {
    name: 'get_product',
    description:
      'Get one product by key or SKU, with each option value flagged for the selections made so far.',
    inputSchema: {
      type: 'object',
      properties: {
        meta,
        catalog: catalog(
          'catalog_lookup.json#/$defs/get_product_request: id, selected, preferences, filters, context',
        ),
      },
      required: ['meta', 'catalog'],
    },
    outputSchema: catalogResult('catalog_lookup.json#/$defs/get_product_response'),
    annotations: READ,
  },
] as const;

const reply = (id: unknown, body: Record<string, unknown>, status = 200) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, ...body }, { status });

const rpcError = (id: unknown, code: number, message: string, data?: unknown, status = 200) =>
  reply(id, { error: { code, message, ...(data === undefined ? {} : { data }) } }, status);

/** A UCP result as a tool result, or as a JSON-RPC error for a protocol error. */
function toolReply(rpcId: unknown, r: UcpResult): Response {
  if (r.status >= 400) {
    const body = r.body as { code?: string; content?: string };
    const profile = r.status === 422 || r.status === 424;
    return rpcError(rpcId, profile ? -32001 : -32000, body.content ?? 'Refused', body, r.status);
  }
  return reply(rpcId, {
    result: {
      structuredContent: r.body,
      content: [{ type: 'text', text: JSON.stringify(r.body) }],
    },
  });
}

export async function handleUcpMcp(
  request: Request,
  env: Env,
  caller: PlatformCaller,
): Promise<Response> {
  if (request.method !== 'POST')
    return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  if (!isJson(request)) return rpcError(null, -32600, 'Send application/json.', undefined, 415);
  const text = await readCappedText(request, MAX_BODY);
  if (text === null) return rpcError(null, -32600, 'Request too large', undefined, 413);
  let rpc: Rpc;
  try {
    rpc = JSON.parse(text) as Rpc;
  } catch {
    return rpcError(null, -32700, 'Parse error', undefined, 400);
  }
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.jsonrpc !== '2.0')
    return rpcError(null, -32600, 'Invalid request', undefined, 400);
  // A notification gets no answer.
  if (rpc.id === undefined) return new Response(null, { status: 202 });

  switch (rpc.method) {
    case 'initialize': {
      const asked = (rpc.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return reply(rpc.id, {
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(String(asked)) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: {
            name: 'commerceworker-ucp',
            title: 'CommerceWorker checkout (UCP)',
            version: '1.0.0',
          },
          instructions:
            'UCP for this business. Search and look up products with search_catalog, lookup_catalog and get_product (a variant\'s id is its SKU, which is a checkout line\'s item id). Create a checkout with line_items, add the buyer email and a shipping address (fulfillment), then complete it with a payment instrument from ucp.payment_handlers. Every call carries meta["ucp-agent"].profile.',
        },
      });
    }
    case 'ping':
      return reply(rpc.id, { result: {} });
    case 'tools/list':
      return reply(rpc.id, { result: { tools: TOOLS } });
    case 'tools/call':
      return callTool(env, caller, rpc);
    default:
      return rpcError(rpc.id, -32601, 'Method not found');
  }
}

async function callTool(env: Env, caller: PlatformCaller, rpc: Rpc): Promise<Response> {
  const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown };
  const args = (params.arguments ?? {}) as {
    meta?: { 'ucp-agent'?: { profile?: unknown }; 'idempotency-key'?: unknown };
    id?: unknown;
    checkout?: unknown;
    catalog?: unknown;
  };
  const name = String(params.name ?? '');
  if (!TOOLS.some((t) => t.name === name)) return rpcError(rpc.id, -32602, `Unknown tool ${name}`);
  const profile = args.meta?.['ucp-agent']?.profile;
  if (typeof profile !== 'string')
    return toolReply(rpc.id, {
      status: 400,
      body: { code: 'invalid_profile_url', content: 'Send meta["ucp-agent"].profile.' },
    });
  if (profile !== caller.profileUrl)
    return toolReply(rpc.id, {
      status: 403,
      body: {
        code: 'forbidden',
        content: 'meta["ucp-agent"] names a different profile than this key is for.',
      },
    });

  const negotiation = await contextFor(env, caller);
  if ('refusal' in negotiation) return toolReply(rpc.id, negotiation.refusal);
  const { ctx } = negotiation;
  // The catalog's reads take their request whole, and store nothing: no id, no idempotency key.
  if (UCP_CATALOG_TOOLS.includes(name))
    return toolReply(rpc.id, await catalogCall(env, ctx, name as UcpCatalogOp, args.catalog));
  // Every checkout tool needs checkout negotiated; the order and catalog tools have their own.
  if (name !== 'get_order') {
    const refused = checkoutRefusal(ctx);
    if (refused) return toolReply(rpc.id, refused);
  }
  const target = typeof args.id === 'string' ? args.id : '';
  const key = args.meta?.['idempotency-key'];
  const bad = (content: string) =>
    toolReply(rpc.id, { status: 400, body: { code: 'invalid_request', content } });
  const write = (op: () => Promise<UcpResult>, required = false) => {
    if (typeof key !== 'string' || !key)
      return required
        ? Promise.resolve<UcpResult>({
            status: 400,
            body: { code: 'idempotency_key_required', content: 'Send meta["idempotency-key"].' },
          })
        : op();
    const problem = idempotencyKeyProblem(key);
    if (problem)
      return Promise.resolve<UcpResult>({
        status: 400,
        body: { code: 'invalid_idempotency_key', content: problem },
      });
    const { meta: _meta, ...payload } = args;
    return once(env, caller.id, key, name, JSON.stringify(payload), op);
  };
  if (name !== 'create_checkout' && !target) return bad('Send the id.');

  switch (name) {
    case 'create_checkout':
    case 'update_checkout': {
      const input = ucpCheckoutInput.safeParse(args.checkout);
      if (!input.success) return bad(input.error.issues[0]?.message ?? 'Invalid checkout');
      return toolReply(
        rpc.id,
        await write(() =>
          name === 'create_checkout'
            ? createCheckout(env, ctx, input.data)
            : updateCheckout(env, ctx, target, input.data),
        ),
      );
    }
    case 'get_checkout':
      return toolReply(rpc.id, await getCheckout(env, ctx, target));
    case 'complete_checkout':
      return toolReply(
        rpc.id,
        await write(() => completeCheckout(env, ctx, target, args.checkout), true),
      );
    case 'cancel_checkout':
      return toolReply(rpc.id, await write(() => cancelCheckout(env, ctx, target), true));
    default:
      return toolReply(rpc.id, await getOrder(env, ctx, target));
  }
}
