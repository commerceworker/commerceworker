/**
 * Every operation is accounted for on both transports. Each REST operation (in the OpenAPI
 * document) has an MCP tool twin, or is REST's alone with a reason; each workspace tool MCP offers
 * has a REST twin, or is MCP's alone with a reason. A reason is either by design (who or what may
 * use it) or a gap still to close. A new route or tool that is neither fails here, so the two
 * transports can't drift apart unnoticed. rest-mcp-parity.test.ts holds each twin's inputs alike.
 */
import { ASSISTANT_TOOLS, type AssistantTool, isPageOnly, isPanelOnly } from '@commerceworker/core';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../app/lib/openapi';
import { REST_OPERATIONS } from '../app/lib/rest-operations';

type Why = { design: string } | { gap: string };

/** REST routes and the tool each twins, besides REST_OPERATIONS (which name theirs). */
const TWINS: Record<string, AssistantTool> = {
  'GET /api/v1/flows': 'list_flows',
  'GET /api/v1/orders': 'find_orders',
  'POST /api/v1/orders': 'start_order',
  'GET /api/v1/orders/{id}': 'get_order',
  'POST /api/v1/orders/{id}/events': 'deliver_event',
  'POST /api/v1/orders/{id}/approvals/{nodeId}': 'decide_approval',
  'POST /api/v1/orders/{id}/cancel': 'cancel_order',
  'GET /api/v1/carts': 'list_carts',
  'POST /api/v1/carts': 'create_cart',
  'GET /api/v1/carts/{id}': 'get_cart',
  'POST /api/v1/carts/{id}/ops': 'change_cart',
  'POST /api/v1/carts/{id}/submit': 'submit_cart',
  'POST /api/v1/carts/{id}/cancel': 'cancel_cart',
  'POST /api/v1/catalog/products/{key}/draft': 'draft_product_content',
  'POST /api/v1/catalog/edits/publish': 'publish_catalog',
  'POST /api/v1/plugins/{id}/disable': 'set_plugin_enabled',
  'GET /api/v1/audit-events': 'list_audit_events',
  'GET /api/v1/audit-events/verify': 'verify_audit_trail',
  'GET /api/v1/plugins': 'list_plugins',
  'GET /api/v1/plugins/{id}/usage': 'get_plugin_usage',
  'GET /api/v1/webhook-subscriptions': 'list_webhook_subscriptions',
  'GET /api/v1/webhook-subscriptions/{id}/deliveries': 'list_webhook_deliveries',
  'GET /api/v1/catalog/products/{key}': 'get_product',
  'GET /api/v1/catalog/products/{key}/sheet': 'get_product_sheet',
  'GET /api/v1/catalog/aliases/{alias}': 'find_product_by_alias',
  'GET /api/v1/catalog/types': 'list_product_types',
  'GET /api/v1/catalog/channels': 'list_catalog_channels',
  'GET /api/v1/catalog/categories': 'list_categories',
  'GET /api/v1/catalog/feeds': 'list_catalog_feeds',
  'GET /api/v1/catalog/feeds/{id}': 'get_catalog_feed',
  'GET /api/v1/catalog/board': 'catalog_board',
  'GET /api/v1/catalog/board/{column}': 'catalog_board_column',
  'POST /api/v1/catalog/products': 'put_catalog_products',
  'POST /api/v1/catalog/products/delete': 'delete_catalog_products',
  'POST /api/v1/catalog/types': 'put_catalog_type',
  'DELETE /api/v1/catalog/types/{code}': 'delete_catalog_type',
  'POST /api/v1/catalog/channels': 'put_catalog_channel',
  'DELETE /api/v1/catalog/channels/{code}': 'delete_catalog_channel',
  'POST /api/v1/catalog/categories': 'put_catalog_categories',
  'POST /api/v1/catalog/categories/delete': 'delete_catalog_categories',
  'POST /api/v1/catalog/feeds': 'start_catalog_feed',
  'POST /api/v1/catalog/feeds/{id}/cancel': 'cancel_catalog_feed',
  'POST /api/v1/catalog/reindex': 'reindex_catalog',
  'POST /api/v1/catalog/gaps/rebuild': 'rebuild_catalog_gaps',
  'POST /api/v1/catalog/edits': 'stage_product_edits',
  // One tool drops either: `what` names staged edits or drafts.
  'POST /api/v1/catalog/edits/discard': 'discard_product_edits',
  'POST /api/v1/catalog/drafts/discard': 'discard_product_edits',
};

const SIGNED = {
  design:
    'Signed by an outside system (an integration, Stripe, a channel), not called by a person or agent',
};
const CREDENTIALS = {
  design:
    'Issues or rotates a credential shown once; given only to a person in the app or a token they hold',
};

/** REST operations with no tool, and why. */
const REST_ONLY: Record<string, Why> = {
  'POST /api/v1/catalog/drafts': {
    design:
      'Stores drafts a caller wrote; over MCP the assistant writes them (draft_product_content), and a caller’s own text is staged as an edit',
  },
  'POST /api/v1/webhooks/events': SIGNED,
  'POST /api/v1/webhooks/orders': SIGNED,
  'POST /api/v1/webhooks/stripe': SIGNED,
  'POST /api/v1/channels/shopify/orders': SIGNED,
  'POST /api/v1/channels/edi/850': SIGNED,
  'POST /api/v1/data-subjects/export': {
    design: 'Everything held about a person: an admin’s request, never an agent’s',
  },
  'POST /api/v1/data-subjects/erase': {
    design: 'Erasing a person cannot be undone: an admin’s request, never an agent’s',
  },
  'POST /api/v1/webhook-subscriptions': CREDENTIALS,
  'DELETE /api/v1/webhook-subscriptions/{id}': { gap: 'Removing a webhook subscription (admin)' },
  'POST /api/v1/webhook-subscriptions/{id}/rotate': CREDENTIALS,
  'GET /api/v1/integrations': { gap: 'Listing integrations (admin)' },
  'POST /api/v1/integrations': CREDENTIALS,
  'POST /api/v1/integrations/{id}/rotate': CREDENTIALS,
  'DELETE /api/v1/integrations/{id}': { gap: 'Revoking an integration (admin)' },
  'POST /api/v1/plugins': { design: 'Uploads a signed plugin bundle: a file, from a person or CI' },
  'GET /api/v1/ucp': { gap: 'UCP settings and platforms (admin)' },
  'POST /api/v1/ucp/settings': { gap: 'Changing UCP settings (admin)' },
  'POST /api/v1/ucp/platforms': CREDENTIALS,
  'DELETE /api/v1/ucp/platforms/{id}': { gap: 'Revoking a UCP platform (admin)' },
};

/** Tools MCP offers with no REST route, and why. */
const MCP_ONLY: Partial<Record<AssistantTool, Why>> = {
  approve_plugin: { design: 'Needs a step-up, which only a person’s session in the app can give' },
  rollback_plugin: { design: 'Needs a step-up, which only a person’s session in the app can give' },
  uninstall_plugin: {
    design: 'Needs a step-up, which only a person’s session in the app can give',
  },
};

const doc = openApiDocument('https://app.test') as {
  paths: Record<string, Record<string, unknown>>;
};
const restOps = Object.entries(doc.paths).flatMap(([path, methods]) =>
  Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
);
const routed = new Map<string, AssistantTool>([
  ...REST_OPERATIONS.map((o) => [`${o.method} /api/v1${o.path}`, o.tool] as const),
  ...Object.entries(TWINS),
]);
const mcpTools = (Object.keys(ASSISTANT_TOOLS) as AssistantTool[]).filter(
  (t) => !isPageOnly(t) && !isPanelOnly(t),
);

describe('every operation is on both transports, or says why not', () => {
  it('accounts for every REST operation', () => {
    const loose = restOps.filter((op) => !routed.has(op) && !(op in REST_ONLY));
    expect(loose, 'REST operations with no tool and no reason').toEqual([]);
  });

  it('accounts for every tool MCP offers', () => {
    const twinned = new Set(routed.values());
    const loose = mcpTools.filter((t) => !twinned.has(t) && !(t in MCP_ONLY));
    expect(loose, 'MCP tools with no REST route and no reason').toEqual([]);
  });

  it('keeps no stale entry', () => {
    for (const op of [...Object.keys(TWINS), ...Object.keys(REST_ONLY)])
      expect(restOps, `${op} is not in the OpenAPI document`).toContain(op);
    for (const t of Object.keys(MCP_ONLY) as AssistantTool[]) {
      expect(mcpTools, `${t} isn't a tool MCP offers`).toContain(t);
      expect(
        [...routed.values()],
        `${t} has a REST route now: drop it from MCP_ONLY`,
      ).not.toContain(t);
    }
    for (const op of Object.keys(REST_ONLY))
      expect(routed.has(op), `${op} has a tool now: drop it from REST_ONLY`).toBe(false);
  });

  it('counts what is left to close', () => {
    const gaps = [...Object.values(REST_ONLY), ...Object.values(MCP_ONLY)].filter(
      (w) => 'gap' in w,
    );
    // Exactly: closing a gap lowers it, and a new one-sided operation must say why here.
    expect(gaps.length).toBe(GAPS_OPEN);
  });
});

/** The gaps open today: the admin routes (webhooks, integrations, UCP) and six model-backed tools. */
const GAPS_OPEN = 6;
