/**
 * OpenAPI 3.1 document for /api/v1, served at GET /api/v1/openapi.json. Request bodies are
 * generated from the same zod schemas the handlers validate with, so they can't drift.
 */

import {
  ASSISTANT_TOOLS,
  auditChainCheckSchema,
  auditEventSchema,
  auditEventsSchema,
  CART_EVENTS,
  CART_STATUSES,
  cancelResultSchema,
  cartOpSchema,
  cartRowSchema,
  cartRowsSchema,
  cartSubmittedSchema,
  decisionResultSchema,
  deliveriesSchema,
  deliveryRecordSchema,
  ediInterchangeResultSchema,
  ediResultSchema,
  erasureDoneSchema,
  erasureRefusalSchema,
  errorSchema,
  flowListSchema,
  flowSummarySchema,
  flowVersionSchema,
  ignoredTopicSchema,
  inboundOrderResultSchema,
  inboundOrderSchema,
  intakeAcceptedSchema,
  integrationSecretSchema,
  integrationsSchema,
  integrationViewSchema,
  isCartEvent,
  nodeRunSchema,
  ORDER_CHANNELS,
  ORDER_EVENTS,
  ORDER_MODELS,
  ORDER_STATUSES,
  OUTBOUND_EVENTS,
  okSchema,
  orderPageSchema,
  orderRowSchema,
  orderSchema,
  orderStateSchema,
  paymentEventResultSchema,
  pendingWaitSchema,
  pluginBundleFileSchema,
  pluginCaseResultSchema,
  pluginDisabledSchema,
  pluginInstallViewSchema,
  pluginListSchema,
  pluginManifestSchema,
  pluginSummarySchema,
  pluginUsageSchema,
  ROLE_LABELS,
  sendEventResultSchema,
  startOrderResultSchema,
  startOrderSchema,
  storefrontAdminSchema,
  storefrontSettingsInputSchema,
  storefrontSettingsSchema,
  subjectExportSchema,
  subscriptionSecretSchema,
  subscriptionsSchema,
  subscriptionViewSchema,
  TOOL_OUTPUTS,
  timelineEntrySchema,
  ucpAdminSchema,
  ucpPlatformKeySchema,
  ucpPlatformSchema,
  ucpSettingsSchema,
  whoamiOutput,
} from '@commerceworker/core';
import {
  aliasResponseSchema,
  BOARD_COLUMNS,
  boardCardSchema,
  boardPageSchema,
  boardResponseSchema,
  boardSummarySchema,
  catalogCategoriesDeleteInput,
  catalogCategoriesInput,
  catalogChannelInput,
  catalogDeleteInput,
  catalogDiscardInput,
  catalogDraftContentInput,
  catalogDraftsInput,
  catalogEditsInput,
  catalogProductsInput,
  catalogPublishInput,
  catalogTypeInput,
  categoriesDeletedSchema,
  categorySchema,
  channelDeletedSchema,
  channelSchema,
  discardedSchema,
  draftSchema,
  editResultSchema,
  editResultsSchema,
  feedResponseSchema,
  feedStatusSchema,
  feedsResponseSchema,
  fieldOverrideSchema,
  fieldRefSchema,
  GAP_KINDS,
  gapSchema,
  gapsRebuiltSchema,
  issueSchema,
  jsonSchema,
  productDataSchema,
  productDraftResultSchema,
  productResponseSchema,
  productSchema,
  productSheetSchema,
  productTypeSchema,
  publishResultSchema,
  publishResultsSchema,
  reindexedSchema,
  rejectionSchema,
  revisionSchema,
  sheetResponseSchema,
  stagedEditSchema,
  typeDeletedSchema,
  writeResultSchema,
  writeResultsSchema,
} from '@commerceworker/core/product';
import { z } from 'zod';
import {
  cancelInput,
  createCartInput,
  dataSubjectInput,
  decisionInput,
  eventSchema,
  integrationInput,
  orderEventInput,
  platformInput,
  submitCartInput,
  subscriptionInput,
} from './api-schemas';
import { AUDIT_GROUPS } from './audit';
import { operationBody, pathFields, REST_OPERATIONS } from './rest-operations';

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
const body = (s: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema: schema(s) } },
});
const ok = (description: string, ref?: string) => ({
  description,
  ...(ref ? { content: { 'application/json': { schema: { $ref: ref } } } } : {}),
});
/** What a handler sends back, so `io: 'output'`: defaults applied, not optional. */
const output = (s: z.ZodType) => z.toJSONSchema(s, { io: 'output', unrepresentable: 'any' });
const okJson = (description: string, s: z.ZodType | Record<string, unknown>) => ({
  description,
  content: {
    'application/json': { schema: s instanceof z.ZodType ? output(s) : s },
  },
});
const errorRef = '#/components/schemas/Error';

/**
 * The response schemas, by the name each takes in `components.schemas`. They are the zod schemas
 * of `@commerceworker/core` (next to the types they describe), so a route's documented response
 * is what its handler's types say; a schema one names inside another becomes a `$ref` to it.
 */
const COMPONENTS = {
  Json: jsonSchema,
  Order: orderSchema,
  FlowVersion: flowVersionSchema,
  FlowSummary: flowSummarySchema,
  FlowList: flowListSchema,
  OrderRow: orderRowSchema,
  OrderPage: orderPageSchema,
  NodeRun: nodeRunSchema,
  PendingWait: pendingWaitSchema,
  TimelineEntry: timelineEntrySchema,
  OrderState: orderStateSchema,
  StartOrderResult: startOrderResultSchema,
  SendEventResult: sendEventResultSchema,
  DecisionResult: decisionResultSchema,
  CancelResult: cancelResultSchema,
  CartRow: cartRowSchema,
  CartRows: cartRowsSchema,
  CartSubmitted: cartSubmittedSchema,
  PaymentEventResult: paymentEventResultSchema,
  InboundOrderResult: inboundOrderResultSchema,
  IgnoredTopic: ignoredTopicSchema,
  IntakeAccepted: intakeAcceptedSchema,
  EdiResult: ediResultSchema,
  EdiInterchangeResult: ediInterchangeResultSchema,
  AuditEvent: auditEventSchema,
  AuditEvents: auditEventsSchema,
  AuditChainCheck: auditChainCheckSchema,
  Issue: issueSchema,
  WriteResult: writeResultSchema,
  WriteResults: writeResultsSchema,
  Product: productSchema,
  ProductData: productDataSchema,
  ProductResponse: productResponseSchema,
  AliasResponse: aliasResponseSchema,
  FeedStatus: feedStatusSchema,
  FeedResponse: feedResponseSchema,
  FeedList: feedsResponseSchema,
  Rejection: rejectionSchema,
  BoardCard: boardCardSchema,
  BoardPage: boardPageSchema,
  BoardSummary: boardSummarySchema,
  BoardResponse: boardResponseSchema,
  Gap: gapSchema,
  FieldRef: fieldRefSchema,
  StagedEdit: stagedEditSchema,
  Draft: draftSchema,
  FieldOverride: fieldOverrideSchema,
  Revision: revisionSchema,
  ProductSheet: productSheetSchema,
  SheetResponse: sheetResponseSchema,
  EditResult: editResultSchema,
  EditResults: editResultsSchema,
  PublishResult: publishResultSchema,
  PublishResults: publishResultsSchema,
  Discarded: discardedSchema,
  TypeDeleted: typeDeletedSchema,
  ChannelDeleted: channelDeletedSchema,
  CategoriesDeleted: categoriesDeletedSchema,
  GapsRebuilt: gapsRebuiltSchema,
  Reindexed: reindexedSchema,
  ProductDraftResult: productDraftResultSchema,
  SubjectExport: subjectExportSchema,
  ErasureProgress: erasureDoneSchema,
  ErasureRefused: erasureRefusalSchema,
  Error: errorSchema,
  SubscriptionView: subscriptionViewSchema,
  Subscriptions: subscriptionsSchema,
  SubscriptionSecret: subscriptionSecretSchema,
  DeliveryRecord: deliveryRecordSchema,
  Deliveries: deliveriesSchema,
  IntegrationView: integrationViewSchema,
  Integrations: integrationsSchema,
  IntegrationSecret: integrationSecretSchema,
  Ok: okSchema,
  PluginSummary: pluginSummarySchema,
  PluginList: pluginListSchema,
  PluginManifest: pluginManifestSchema,
  PluginCaseResult: pluginCaseResultSchema,
  PluginInstallView: pluginInstallViewSchema,
  PluginDisabled: pluginDisabledSchema,
  PluginUsage: pluginUsageSchema,
  UcpPlatform: ucpPlatformSchema,
  UcpSettings: ucpSettingsSchema,
  UcpAdmin: ucpAdminSchema,
  StorefrontSettings: storefrontSettingsSchema,
  StorefrontAdmin: storefrontAdminSchema,
  UcpPlatformKey: ucpPlatformKeySchema,
} as const;

type Component = keyof typeof COMPONENTS;
const ref = (name: Component) => `#/components/schemas/${name}`;

/** The registered schemas as JSON Schema, each naming the others it uses by `$ref`. */
function componentSchemas() {
  const registry = z.registry<{ id: string }>();
  for (const [id, s] of Object.entries(COMPONENTS)) registry.add(s, { id });
  const { schemas } = z.toJSONSchema(registry, {
    io: 'output',
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  });
  return Object.fromEntries(
    Object.entries(schemas).map(([id, { $schema: _s, $id: _i, ...rest }]) => [id, rest]),
  );
}
// Every route that takes a bearer token can refuse these; a route lists a status of its own
// (409, 422…) beside them, after the spread, to say more.
const errors = {
  '400': ok('Invalid request', errorRef),
  '401': ok('Missing or wrong bearer token', errorRef),
  '403': ok('The caller’s role is too low, or only a person may do it', errorRef),
  '404': ok('Not found', errorRef),
  '429': ok("Over the caller's requests a minute; wait Retry-After seconds", errorRef),
};
// A signed route has no bearer token: its caller proves itself by the signature instead.
const signedErrors = {
  '400': ok('Invalid request', errorRef),
  '401': ok('Missing, wrong or expired signature', errorRef),
  '404': ok('Not found', errorRef),
  '429': ok("Over the caller's requests a minute; wait Retry-After seconds", errorRef),
};
const orderId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const cartId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const cart = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { cart: { $ref: '#/components/schemas/Cart' } },
        required: ['cart'],
      },
    },
  },
});

/** A staff cart as GET /api/v1/carts/{id} answers it (`CartView`). */
function cartSchema() {
  const amount = { type: 'number' };
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string', enum: [...CART_STATUSES] },
      customerId: { type: ['string', 'null'] },
      flowId: { type: 'string', description: 'The flow that prices it and runs its order' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Name the line in set_qty, set_qtys and remove' },
            sku: { type: 'string' },
            qty: { type: 'integer' },
            title: { type: 'string', description: 'Set by the quote' },
            unitPrice: { ...amount, description: 'Set by the quote' },
          },
          required: ['id', 'sku', 'qty'],
        },
      },
      promoCodes: { type: 'array', items: { type: 'string' } },
      shipTo: {
        type: ['object', 'null'],
        description:
          'Where it ships: `name`, `line1`, `line2`, `city`, `region`, `postalCode`, `country`. The quote prices shipping and tax for it, and the order adopts it',
      },
      shippingOption: {
        type: ['string', 'null'],
        description:
          "The option chosen from the quote's `shippingOptions`; null lets the flow pick (the quote's `shippingOption` says which it charged)",
      },
      quote: {
        type: ['object', 'null'],
        description:
          "What the cart costs, worked out by its flow's pricing nodes: `currency`, `lines`, `subtotal`, `shipping`, `tax`, `total`, `ships`, `shippingOptions` (what ships to the ship-to: `id`, `title`, `carrier`, `amount`, `minDays`, `maxDays`) and `shippingOption`",
      },
      quoteCurrent: {
        type: 'boolean',
        description: 'Whether `quote` prices the cart as it is now',
      },
      issues: {
        type: 'array',
        description: 'What the quote found: `{ kind: error|warning|info, code, content }`',
        items: { type: 'object' },
      },
      notReady: {
        type: ['string', 'null'],
        description: 'Why it cannot be submitted yet; null when it can',
      },
      orderId: { type: ['string', 'null'], description: 'The order submitting it started' },
      createdBy: { type: 'string' },
      createdAt: { type: 'integer', description: 'Epoch ms' },
      updatedAt: { type: 'integer', description: 'Epoch ms' },
      version: { type: 'integer', description: 'Bumped on every change' },
    },
    required: [
      'id',
      'title',
      'status',
      'flowId',
      'lines',
      'shipTo',
      'shippingOption',
      'quote',
      'quoteCurrent',
      'version',
    ],
  };
}

/** A GET operation's query parameters: its tool's input less its path's fields. */
function queryParameters(op: (typeof REST_OPERATIONS)[number]) {
  const j = schema(operationBody(op)) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return Object.entries(j.properties ?? {}).map(([name, s]) => ({
    name,
    in: 'query',
    required: (j.required ?? []).includes(name),
    schema: s,
  }));
}

/** REST_OPERATIONS, each documented from its tool: role, title, description and input. */
function operationPaths() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of REST_OPERATIONS) {
    const tool = ASSISTANT_TOOLS[op.tool];
    const route = `/api/v1${op.path}`;
    paths[route] ??= {};
    paths[route][op.method.toLowerCase()] = {
      summary: `${tool.title} (${ROLE_LABELS[tool.role]})`,
      description: `${tool.description} Runs as MCP's \`${op.tool}\` does: the same role, checks and refusals.`,
      ...(pathFields(op).length || op.method === 'GET'
        ? {
            parameters: [
              ...pathFields(op).map((name) => ({
                name,
                in: 'path',
                required: true,
                schema: { type: 'string' },
              })),
              // A GET takes the rest of its tool's input as query parameters.
              ...(op.method === 'GET' ? queryParameters(op) : []),
            ],
          }
        : {}),
      ...(op.method === 'POST' ? { requestBody: body(operationBody(op)) } : {}),
      // The engine answers with the tool's value as it stands (`runRestOperation`), the same one
      // MCP sends as structured content, so TOOL_OUTPUTS describes the body.
      responses: {
        '200': okJson('What the operation did or found', TOOL_OUTPUTS[op.tool]),
        '409': ok('Refused: the order, flow or record can’t do that now', errorRef),
        ...errors,
      },
      operationId: op.tool,
    };
  }
  return paths;
}

/**
 * Every hand-written route's `operationId` (snake_case, as the tool names REST_OPERATIONS rows
 * take), keyed by method and path. A generated SDK names its methods from these, so a rename is a
 * breaking change; `withOperationIds` refuses a route without one and an entry with no route.
 */
const OPERATION_IDS: Record<string, string> = {
  'get /api/v1/me': 'whoami',
  'get /api/v1/flows': 'list_flows',
  'get /api/v1/orders': 'list_orders',
  'post /api/v1/orders': 'start_order',
  'get /api/v1/orders/{id}': 'get_order_state',
  'post /api/v1/orders/{id}/events': 'deliver_order_event',
  'post /api/v1/orders/{id}/approvals/{nodeId}': 'decide_approval',
  'post /api/v1/orders/{id}/cancel': 'cancel_order',
  'get /api/v1/carts': 'list_carts',
  'post /api/v1/carts': 'create_cart',
  'get /api/v1/carts/{id}': 'get_cart',
  'post /api/v1/carts/{id}/ops': 'change_cart',
  'post /api/v1/carts/{id}/submit': 'submit_cart',
  'post /api/v1/carts/{id}/cancel': 'cancel_cart',
  'post /api/v1/webhooks/events': 'receive_order_event',
  'post /api/v1/webhooks/stripe': 'receive_stripe_webhook',
  'post /api/v1/channels/shopify/orders': 'receive_shopify_order',
  'post /api/v1/channels/edi/850': 'receive_edi_850',
  'post /api/v1/webhooks/orders': 'receive_inbound_order',
  'get /api/v1/audit-events': 'list_audit_events',
  'get /api/v1/audit-events/verify': 'verify_audit_chain',
  'post /api/v1/catalog/products': 'put_catalog_products',
  'get /api/v1/catalog/products/{key}': 'get_catalog_product',
  'post /api/v1/catalog/products/delete': 'delete_catalog_products',
  'get /api/v1/catalog/aliases/{alias}': 'resolve_catalog_alias',
  'get /api/v1/catalog/types': 'list_catalog_types',
  'post /api/v1/catalog/types': 'put_catalog_type',
  'delete /api/v1/catalog/types/{code}': 'delete_catalog_type',
  'delete /api/v1/catalog/channels/{code}': 'delete_catalog_channel',
  'post /api/v1/catalog/categories/delete': 'delete_catalog_categories',
  'get /api/v1/catalog/channels': 'list_catalog_channels',
  'post /api/v1/catalog/channels': 'put_catalog_channel',
  'get /api/v1/catalog/categories': 'list_catalog_categories',
  'post /api/v1/catalog/categories': 'put_catalog_categories',
  'get /api/v1/catalog/feeds': 'list_catalog_feeds',
  'post /api/v1/catalog/feeds': 'import_catalog_feed',
  'get /api/v1/catalog/feeds/{id}': 'get_catalog_feed',
  'post /api/v1/catalog/feeds/{id}/cancel': 'cancel_catalog_feed',
  'get /api/v1/catalog/board': 'get_catalog_board',
  'get /api/v1/catalog/board/{column}': 'get_catalog_board_column',
  'get /api/v1/catalog/products/{key}/sheet': 'get_catalog_product_sheet',
  'post /api/v1/catalog/products/{key}/draft': 'draft_catalog_product',
  'post /api/v1/catalog/edits': 'stage_catalog_edits',
  'post /api/v1/catalog/edits/discard': 'discard_catalog_edits',
  'post /api/v1/catalog/edits/publish': 'publish_catalog_edits',
  'post /api/v1/catalog/drafts': 'save_catalog_drafts',
  'post /api/v1/catalog/drafts/discard': 'discard_catalog_drafts',
  'post /api/v1/catalog/gaps/rebuild': 'rebuild_catalog_gaps',
  'post /api/v1/catalog/reindex': 'reindex_catalog',
  'post /api/v1/data-subjects/export': 'export_data_subject',
  'post /api/v1/data-subjects/erase': 'erase_data_subject',
  'get /api/v1/webhook-subscriptions': 'list_webhook_subscriptions',
  'post /api/v1/webhook-subscriptions': 'create_webhook_subscription',
  'delete /api/v1/webhook-subscriptions/{id}': 'delete_webhook_subscription',
  'post /api/v1/webhook-subscriptions/{id}/rotate': 'rotate_webhook_subscription_secret',
  'get /api/v1/webhook-subscriptions/{id}/deliveries': 'list_webhook_deliveries',
  'get /api/v1/integrations': 'list_integrations',
  'post /api/v1/integrations': 'create_integration',
  'post /api/v1/integrations/{id}/rotate': 'rotate_integration_secret',
  'delete /api/v1/integrations/{id}': 'revoke_integration',
  'get /api/v1/plugins': 'list_plugins',
  'post /api/v1/plugins': 'upload_plugin',
  'post /api/v1/plugins/{id}/disable': 'disable_plugin',
  'get /api/v1/plugins/{id}/usage': 'get_plugin_usage',
  'get /api/v1/ucp': 'get_ucp',
  'post /api/v1/ucp/settings': 'set_ucp_settings',
  'get /api/v1/storefront': 'get_storefront',
  'post /api/v1/storefront/settings': 'set_storefront_settings',
  'post /api/v1/ucp/platforms': 'add_ucp_platform',
  'delete /api/v1/ucp/platforms/{id}': 'revoke_ucp_platform',
};

/** Names each hand-written operation (REST_OPERATIONS rows are named by their tool already). */
function withOperationIds<T extends Record<string, unknown>>(paths: T): T {
  const unused = new Set(Object.keys(OPERATION_IDS));
  for (const [route, item] of Object.entries(paths) as [string, Record<string, unknown>][])
    for (const [method, op] of Object.entries(item) as [string, { operationId?: string }][]) {
      if (op.operationId) continue;
      const key = `${method} ${route}`;
      const id = OPERATION_IDS[key];
      if (!id) throw new Error(`${key} has no operationId: add it to OPERATION_IDS`);
      unused.delete(key);
      op.operationId = id;
    }
  if (unused.size) throw new Error(`OPERATION_IDS names no route: ${[...unused].join(', ')}`);
  return paths;
}

export function openApiDocument(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'CommerceWorker API',
      version: '1',
      description:
        'Start orders on a published flow, resume them with events and approvals, build carts that become orders, and subscribe to signed order events.',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    paths: withOperationIds({
      ...operationPaths(),
      '/api/v1/me': {
        get: {
          summary: 'The calling credential',
          description:
            'Who is calling and with what: how it signed in (`api_token`, `oauth` or `session`), its role, for an OAuth token the resource it was granted for, when it expires (ms since the epoch) and its subject (a person’s `id`, `name` and `email`, or an API token’s `id` and `label`). Any valid caller may ask, whatever its role. Never returns a secret, and is never cached. An OAuth access token granted for the MCP or A2A endpoint is refused here with `401`, as at every route.',
          responses: {
            ...errors,
            '200': ok('The calling credential', '#/components/schemas/Whoami'),
          },
        },
      },
      '/api/v1/flows': {
        get: {
          summary: 'List flows',
          responses: { '200': ok('Order Flows', ref('FlowList')), ...errors },
        },
      },
      '/api/v1/orders': {
        get: {
          summary: 'List orders',
          parameters: [
            { name: 'model', in: 'query', schema: { type: 'string', enum: [...ORDER_MODELS] } },
            { name: 'channel', in: 'query', schema: { type: 'string', enum: [...ORDER_CHANNELS] } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: [...ORDER_STATUSES] } },
            { name: 'q', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            {
              name: 'cursor',
              in: 'query',
              schema: { type: 'string' },
              description: 'The `nextCursor` of the previous page; omit for the newest orders.',
            },
          ],
          responses: {
            '200': ok('Newest first; nextCursor is null on the last page', ref('OrderPage')),
            ...errors,
          },
        },
        post: {
          summary: 'Start an order',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              schema: { type: 'string', maxLength: 255 },
              description:
                "A repeat with the same key and body returns 200 and the order it created; a different body under the same key returns 422. A key starting with one of CommerceWorker's own namespaces (cart:, ucp:, plugin:, order:, email:, a2a:, replenish:) returns 400.",
            },
          ],
          requestBody: body(startOrderSchema),
          responses: {
            '201': ok('Started', ref('StartOrderResult')),
            '200': ok('Replayed: the key already created this order', ref('StartOrderResult')),
            '422': ok(
              'The Idempotency-Key was already used with a different request',
              '#/components/schemas/Error',
            ),
            ...errors,
          },
        },
      },
      '/api/v1/orders/{id}': {
        get: {
          summary: 'Live order state from its agent',
          parameters: [orderId],
          responses: {
            '200': ok(
              'Order state: `status`, `nodes`, `waits`, `vars`, and `order` (an Order)',
              ref('OrderState'),
            ),
            ...errors,
          },
        },
      },
      '/api/v1/orders/{id}/events': {
        post: {
          summary: 'Deliver a business event to the node waiting for it',
          parameters: [orderId],
          requestBody: body(orderEventInput),
          responses: {
            '422': ok(
              'The payload sets a field the delivery records itself, or is a return or claim to record on the order page',
              errorRef,
            ),
            '200': ok(
              'Where the event went. With nothing waiting yet, `held` is true when the order holds it until a step of its flow waits for it, and `delivered` is false when it won’t',
              ref('SendEventResult'),
            ),
            ...errors,
          },
        },
      },
      '/api/v1/orders/{id}/approvals/{nodeId}': {
        post: {
          summary: 'Approve or reject an approval node (cast a vote)',
          parameters: [
            orderId,
            { name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: body(decisionInput),
          responses: {
            ...errors,
            '200': ok(
              'The vote counted: `outcome` is `recorded` when more votes are needed and the order still waits, else `approved` or `rejected`; `tally` is the approvals so far of those needed, like "1 of 2"',
              ref('DecisionResult'),
            ),
            '403': ok(
              'The caller lacks the approver role, or started this order and the workspace separates approvals',
              '#/components/schemas/Error',
            ),
            '409': ok(
              'That node is not waiting for an approval, or the vote can’t be taken: not one of its approvers, already voted, already decided, a buyer on their own order, or a company that isn’t active',
              '#/components/schemas/Error',
            ),
          },
        },
      },
      '/api/v1/orders/{id}/cancel': {
        post: {
          summary: 'Cancel an order and release everything it holds',
          parameters: [orderId],
          requestBody: body(cancelInput),
          responses: {
            '200': ok('Cancelled', ref('CancelResult')),
            '409': ok('The order has already finished', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/carts': {
        get: {
          summary: 'List staff carts, most recently changed first',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: [...CART_STATUSES] } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            '200': ok('Staff carts, most recently changed first', ref('CartRows')),
            ...errors,
          },
        },
        post: {
          summary: 'Open a cart (operator)',
          description:
            'The flow must be published and price orders (a Price lines step); it prices the cart as lines are added, and runs its order once submitted. The cart records the caller as who opened it.',
          requestBody: body(createCartInput),
          responses: {
            '201': cart('Opened'),
            '422': ok(
              'The flow is not published or does not price orders, or no such customer',
              '#/components/schemas/Error',
            ),
            ...errors,
          },
        },
      },
      '/api/v1/carts/{id}': {
        get: {
          summary: 'A cart: its lines, quote and problems',
          parameters: [cartId],
          responses: {
            '200': {
              ...cart('The cart'),
              headers: {
                ETag: {
                  description:
                    'The cart’s `version`, quoted: send it as If-Match to hold a submit to it',
                  schema: { type: 'string' },
                },
              },
            },
            ...errors,
          },
        },
      },
      '/api/v1/carts/{id}/ops': {
        post: {
          summary: 'Change a cart, one op at a time (operator)',
          description:
            "Applied as the caller, as if they made the change on the cart's page: `add` (adds to a line with that SKU), `set_qty` (0 removes the line), `set_qtys` (several lines at once, all or none: refused if any of them is gone), `remove`, `clear`, `lock`, `unlock`, `promo_add`, `promo_remove`, `rename`, `set_ship_to` (null clears the address and the option), `set_shipping_option` (an id from the quote's `shippingOptions`, or null to let the flow pick). Lines, codes, the ship-to and the option change only while the cart is open. The response has the cart priced again.",
          parameters: [cartId],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { type: 'object', ...schema(cartOpSchema) } },
            },
          },
          responses: {
            '200': cart('Applied'),
            '409': ok(
              'The cart refused it: locked, ended, a line that is gone, a code already applied…',
              '#/components/schemas/Error',
            ),
            ...errors,
          },
        },
      },
      '/api/v1/carts/{id}/submit': {
        post: {
          summary: 'Submit a cart as an order of its flow (operator)',
          description:
            'Only a cart with lines whose quote is current and found no errors. The order is started once, at the quoted lines, by the caller; the cart ends as `submitted` with its `orderId`.',
          parameters: [
            cartId,
            {
              name: 'If-Match',
              in: 'header',
              schema: { type: 'string' },
              description:
                'The ETag of the cart you read (its `version`, quoted): the submit goes ahead only if the cart is still at that version. The same as `version` in the body.',
            },
          ],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: schema(submitCartInput) } },
          },
          responses: {
            '201': ok('The order the cart became', ref('CartSubmitted')),
            '409': ok('Not ready (see `notReady`), or already ended', '#/components/schemas/Error'),
            '412': ok(
              'The cart changed since the version given; read it again',
              '#/components/schemas/Error',
            ),
            ...errors,
          },
        },
      },
      '/api/v1/carts/{id}/cancel': {
        post: {
          summary: 'Cancel a cart (operator)',
          parameters: [cartId],
          responses: {
            '200': cart('Cancelled'),
            '409': ok('The cart has already ended', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/webhooks/events': {
        post: {
          summary: 'Signed inbound event (no bearer token)',
          description:
            "Sign the raw body with your integration's secret: `X-CommerceWorker-Signature: t=<unix seconds>,k=<integration id>,v1=<hex HMAC-SHA256(secret, \"<t>.<body>\")>`. Signatures older than 5 minutes are rejected. `403` when the integration's scope doesn't allow the request.",
          security: [],
          parameters: [
            {
              name: 'X-CommerceWorker-Signature',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: body(eventSchema),
          responses: {
            '200': ok('Delivered', ref('SendEventResult')),
            '202': ok(
              'Held on the order until a step of its flow waits for it; no need to resend',
              ref('SendEventResult'),
            ),
            '403': ok('The integration’s scope doesn’t allow the request', errorRef),
            '422': ok(
              'The payload sets a field the delivery records itself, or is a return or claim to record on the order page',
              errorRef,
            ),
            // Not an error body: what the order answered, `delivered: false`.
            '409': ok(
              'The order won’t wait for this event (its flow has no such step, or it already holds as many as it can); retry later',
              ref('SendEventResult'),
            ),
            ...signedErrors,
          },
        },
      },
      '/api/v1/webhooks/stripe': {
        post: {
          summary: 'Stripe webhook (no bearer token)',
          description:
            "Add this URL as a Stripe webhook endpoint and enable `invoice.paid`, `payment_intent.canceled` and `charge.dispute.created`. Verified with `Stripe-Signature` (any `v1` signature from the endpoint's signing secret, within 5 minutes). Each event id is handled once. `invoice.paid` settles an invoice the order issued through Stripe and delivers `payment.received`; `payment_intent.canceled` voids the authorization it held; `charge.dispute.created` delivers `payment.disputed` to a node waiting for it. Other events are acknowledged and ignored.",
          security: [],
          parameters: [
            { name: 'Stripe-Signature', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            ...signedErrors,
            '200': ok(
              'Handled, already handled, or ignored (`outcome`)',
              ref('PaymentEventResult'),
            ),
            '400': ok('Bad signature, or not a Stripe event', '#/components/schemas/Error'),
            // Not an error body: the engine's answer, `outcome: retry`.
            '409': ok(
              'The order is not waiting for this payment yet; Stripe delivers it again later',
              ref('PaymentEventResult'),
            ),
            '500': ok('The engine failed; Stripe delivers it again later', errorRef),
            '503': ok('Stripe webhooks are not configured', '#/components/schemas/Error'),
          },
        },
      },
      '/api/v1/channels/shopify/orders': {
        post: {
          summary: 'Shopify orders/create webhook (no bearer token)',
          description:
            'Point a Shopify `orders/create` webhook here. Verified with `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the raw body with SHOPIFY_WEBHOOK_SECRET); other topics are acknowledged and ignored. The order is mapped to an inbound order (channel from `source_name`, model `b2b` when it has a company) and started once per Shopify order id. Where the deployment makes intake durable the verified body is kept and the answer is `202`: the order starts from a queue, and a body that can never start one is still a `400`.',
          security: [],
          parameters: [
            {
              name: 'X-Shopify-Hmac-Sha256',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
            { name: 'X-Shopify-Topic', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            ...signedErrors,
            '200': {
              description:
                'Already received (the order), or a topic other than orders/create (`{ ignored: true }`)',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [{ $ref: ref('InboundOrderResult') }, { $ref: ref('IgnoredTopic') }],
                  },
                },
              },
            },
            '201': ok('Order started', ref('InboundOrderResult')),
            '202': ok('Kept; the order starts from the queue', ref('IntakeAccepted')),
            '400': ok('Not JSON, or a line item without a SKU', '#/components/schemas/Error'),
            '409': ok('The routed flow is not published', '#/components/schemas/Error'),
            '422': ok(
              'This Shopify order was already received with different contents',
              '#/components/schemas/Error',
            ),
            '503': ok('SHOPIFY_WEBHOOK_SECRET is not set', '#/components/schemas/Error'),
          },
        },
      },
      '/api/v1/channels/edi/850': {
        post: {
          summary: 'EDI X12 850 purchase orders (operator)',
          description:
            'A raw X12 interchange of one or more 850 transactions from a trading partner listed in EDI_PARTNERS (ISA sender id → customer). Each PO starts at most once (key `order:edi:<sender>:<PO>`); the response lists the outcome per transaction, and `functionalAck` is the 997 to send back to the partner: AK5 `A` for each PO that started (or already had), `R` for one that couldn’t be taken. Where the deployment makes intake durable the interchange is kept and the answer is `202`: each accepted PO has `status` `202` and starts from a queue, and the 997 acknowledges the interchange as it was taken, not the orders as they start.',
          requestBody: {
            required: true,
            content: {
              'application/edi-x12': { schema: { type: 'string' } },
              'text/plain': { schema: { type: 'string' } },
            },
          },
          responses: {
            ...errors,
            '200': ok(
              'The outcome per transaction, and `functionalAck`, the X12 997 text',
              ref('EdiInterchangeResult'),
            ),
            '202': ok(
              'Kept; the purchase orders start from the queue. The 997 is in `functionalAck`',
              ref('EdiInterchangeResult'),
            ),
            '400': ok('Not a valid X12 interchange', '#/components/schemas/Error'),
            '403': ok(
              'The sender is not a configured trading partner, or the caller is not an operator',
              '#/components/schemas/Error',
            ),
          },
        },
      },
      '/api/v1/webhooks/orders': {
        post: {
          summary: 'Signed inbound order (no bearer token)',
          description:
            'Starts an order from a storefront, marketplace, POS or other channel, signed like `/api/v1/webhooks/events`. The flow is `flowId`, else the `ORDER_ROUTES` entry for `model:channel` or `model:*`, else the model’s default template. Channel and `externalId` identify the order: a repeat returns it, and the same pair with a different body is refused.',
          security: [],
          parameters: [
            {
              name: 'X-CommerceWorker-Signature',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: body(inboundOrderSchema),
          responses: {
            '200': ok('Already received; the existing order', ref('InboundOrderResult')),
            '201': ok('Order started', ref('InboundOrderResult')),
            '409': ok('The routed flow is not published', errorRef),
            '422': ok(
              'This channel and externalId were already received with different contents',
              errorRef,
            ),
            ...signedErrors,
          },
        },
      },
      '/api/v1/audit-events': {
        get: {
          summary: 'Audit log, newest first; or with `after`, oldest first for export (admin)',
          description:
            'Sign-ins, failed and throttled sign-ins, setup and recovery, team and token changes, and what was done to orders, approvals, flows and webhooks (through the app, the API, a signed webhook, the assistant, MCP or A2A). Each event carries its place in the hash chain (`seq`, `prevHash`, `hash`). Events are kept 400 days unless your contract sets another period, then archived.',
          parameters: [
            {
              name: 'type',
              in: 'query',
              schema: { type: 'string', enum: Object.keys(AUDIT_GROUPS) },
            },
            {
              name: 'before',
              in: 'query',
              description: 'Only events before this time (ms since the epoch), to page back',
              schema: { type: 'integer' },
            },
            {
              name: 'after',
              in: 'query',
              description:
                'Only sealed events after this `seq`, oldest first: page forward with the last `seq` you received (0 for the first page)',
              schema: { type: 'integer', minimum: 0 },
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
          ],
          responses: { '200': ok('The events', ref('AuditEvents')), ...errors },
        },
      },
      '/api/v1/audit-events/verify': {
        get: {
          summary: "Check the audit log's hash chain (admin)",
          description:
            "Recomputes each event's hash and checks it follows the one before, up to 2000 events a call. Without `after` it starts at the oldest event still kept; pass `next` from the response as `after` to continue. `ok: false` names the first event that fails (`brokenAt`) and why.",
          parameters: [
            {
              name: 'after',
              in: 'query',
              description: 'Start just after this `seq`',
              schema: { type: 'integer', minimum: 1 },
            },
          ],
          responses: {
            '200': ok(
              'Whether the chain holds; `ok: false` names the first event that fails',
              ref('AuditChainCheck'),
            ),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/products': {
        post: {
          summary: 'Write catalog products, up to 500 (operator)',
          description:
            "Validated against each product's type; an unchanged product writes nothing. Each result is `created`, `updated`, `unchanged` or `rejected` (with `issues`). Published documents follow within a minute; `urgent` purges cached copies sooner (purges are rationed, so keep it for takedowns and corrections).",
          requestBody: body(catalogProductsInput),
          responses: { '200': ok('What each product write did', ref('WriteResults')), ...errors },
        },
      },
      '/api/v1/catalog/products/{key}': {
        get: {
          summary: 'A stored catalog product',
          parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('The product', ref('ProductResponse')), ...errors },
        },
      },
      '/api/v1/catalog/products/delete': {
        post: {
          summary: 'Delete catalog products (operator)',
          requestBody: body(catalogDeleteInput),
          responses: { '200': ok('What each delete did', ref('WriteResults')), ...errors },
        },
      },
      '/api/v1/catalog/aliases/{alias}': {
        get: {
          summary:
            'The product holding a SKU, GTIN (any length: a UPC finds its EAN) or slug (`sku:ABC`, `gtin:…`, `slug:en:…`)',
          parameters: [{ name: 'alias', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('The product key', ref('AliasResponse')), ...errors },
        },
      },
      '/api/v1/catalog/types': {
        get: {
          summary: 'Product types, latest version of each',
          responses: {
            '200': okJson('Product types', z.object({ types: z.array(productTypeSchema) })),
            ...errors,
          },
        },
        post: {
          summary: 'Add a product type, or its next version (operator)',
          description:
            'A new type starts at version 1. A new version may only add: attributes, enum values, or relax `required` and deprecate. Anything else is refused with 409 and the reasons.',
          requestBody: body(catalogTypeInput),
          responses: {
            '201': okJson('The type as stored', z.object({ type: productTypeSchema })),
            '409': ok('The change would break stored products', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/types/{code}': {
        delete: {
          summary: 'Delete a product type, every version (operator)',
          description:
            'Refused with 409 while any product uses the type: delete or move them first.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok('Deleted', ref('TypeDeleted')),
            '409': ok('Products use it', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/channels/{code}': {
        delete: {
          summary: 'Delete a channel and take down everything it published (admin)',
          description:
            'Removes the channel and unpublishes its product documents, SKU and slug lookups, listing cards, category listings, search entries and category trees. Products keep their data for the channel, so adding it again and reindexing brings it back.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('Deleted', ref('ChannelDeleted')), ...errors },
        },
      },
      '/api/v1/catalog/categories/delete': {
        post: {
          summary: 'Delete categories (operator)',
          description:
            'Refused with 409 while a category has children not being deleted with it, or has products filed in it.',
          requestBody: body(catalogCategoriesDeleteInput),
          responses: {
            '200': ok('Deleted', ref('CategoriesDeleted')),
            '409': ok('Still in use', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/channels': {
        get: {
          summary: 'Catalog channels',
          responses: {
            '200': okJson('Channels', z.object({ channels: z.array(channelSchema) })),
            ...errors,
          },
        },
        post: {
          summary: 'Add or change a channel (operator)',
          description:
            'A changed currency or locale list reaches published documents on the next reindex.',
          requestBody: body(catalogChannelInput),
          responses: {
            '200': okJson('The channel as stored', z.object({ channel: channelSchema })),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/categories': {
        get: {
          summary: 'Catalog categories',
          responses: {
            '200': okJson('The categories', z.object({ categories: z.array(categorySchema) })),
            ...errors,
          },
        },
        post: {
          summary: 'Add or change categories (operator)',
          requestBody: body(catalogCategoriesInput),
          responses: {
            '200': okJson('The categories', z.object({ categories: z.array(categorySchema) })),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/feeds': {
        get: {
          summary: 'Recent catalog feeds, newest first',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          responses: { '200': ok('The feeds', ref('FeedList')), ...errors },
        },
        post: {
          summary: 'Import a feed file (operator)',
          description:
            'The request body is the file, streamed to the catalog: CSV (one row per variant) or NDJSON (one product per line). Answers 202 once the file is stored; poll the feed for its counts and the first rejected rows. Answers 408, storing nothing, when the body stops arriving for 30 seconds.',
          parameters: [
            {
              name: 'format',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: ['csv', 'ndjson'] },
            },
            { name: 'name', in: 'query', schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'text/csv': { schema: { type: 'string' } },
              'application/x-ndjson': { schema: { type: 'string' } },
            },
          },
          responses: { '202': ok('The feed, stored and queued', ref('FeedResponse')), ...errors },
        },
      },
      '/api/v1/catalog/feeds/{id}': {
        get: {
          summary: "A feed's progress and result",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('The feed', ref('FeedResponse')), ...errors },
        },
      },
      '/api/v1/catalog/feeds/{id}/cancel': {
        post: {
          summary: 'Cancel a feed (operator)',
          description:
            'Stops a feed that is queued, splitting or applying: no more of its file is read. Parts already handed to the catalog still apply, so some products may have been written. Answers 409 when the feed has already finished.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('The feed, cancelled', ref('FeedResponse')), ...errors },
        },
      },
      '/api/v1/catalog/board': {
        get: {
          summary: "The product editor's board",
          description:
            'Products per column (`gaps`, `drafted`, `staged`, `published` in the last day), gaps and products per gap kind, the latest finished feed and one still running. `indexBuilt` is false until every product stored before the gap index existed has been counted, which the catalog does on its own shortly after it is updated, and while a channel change is being recounted.',
          responses: {
            '200': ok('The board', ref('BoardResponse')),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/board/{column}': {
        get: {
          summary: "One board column's products, in key order",
          parameters: [
            {
              name: 'column',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: [...BOARD_COLUMNS] },
            },
            {
              name: 'kind',
              in: 'query',
              description: 'Only products with a gap of this kind',
              schema: { type: 'string', enum: [...GAP_KINDS] },
            },
            {
              name: 'cursor',
              in: 'query',
              description: 'The `cursor` from the page before',
              schema: { type: 'string' },
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          responses: {
            '200': ok('One page of cards; `cursor` is null on the last', ref('BoardPage')),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/products/{key}/sheet': {
        get: {
          summary: "A product's editor sheet",
          description:
            'The product as it is live and as the last feed sent it, its overrides (each with the feed value it was made against, the feed value now and whether they conflict), staged edits, assistant drafts (stale once the field changed), gaps, the last refused feed row and the last 50 published changes.',
          parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok('The sheet', ref('SheetResponse')),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/products/{key}/draft': {
        post: {
          summary: "Have the assistant draft a product's missing text (operator)",
          description:
            'The assistant writes the text the product is missing (a title, description, text attribute or image alt text in a locale it lacks, skipping one with a draft or staged edit waiting; up to 20, titles first, with `more` counting the rest), or the `fields` you name, from what the product says in its other locales, and saves each as a draft on the product. Nothing goes live until a person stages a draft and publishes it. `instruction` is your own guidance: tone, length, terms to keep.',
          parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: body(catalogDraftContentInput),
          responses: {
            '200': ok('What was drafted, and what was refused', ref('ProductDraftResult')),
            '422': ok(
              "Nothing to draft, the assistant allowance is spent or the model couldn't answer",
              '#/components/schemas/Error',
            ),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/edits': {
        post: {
          summary: 'Stage product edits, up to 500 (operator)',
          description:
            "Content only: title, description, slug, a product's localized text attributes and media alt text per locale, and status. `set` with a value (null removes the feed's value in that locale), or `clear` to show the feed's value again. Each is checked against the product as it is live and answered per edit; nothing goes live until it is published. Staging a field replaces its earlier staged edit and its draft; send `source: assistant` when accepting a draft.",
          requestBody: body(catalogEditsInput),
          responses: { '200': ok('What each edit did', ref('EditResults')), ...errors },
        },
      },
      '/api/v1/catalog/edits/discard': {
        post: {
          summary: 'Drop staged edits (operator)',
          requestBody: body(catalogDiscardInput),
          responses: { '200': ok('How many were dropped', ref('Discarded')), ...errors },
        },
      },
      '/api/v1/catalog/edits/publish': {
        post: {
          summary: "Publish products' staged edits, up to 500 (operator)",
          description:
            'Each product publishes all its staged edits or none. One is refused, keeping its edits staged with why, when a value it changes was changed since it was staged, an edit no longer fits, or a slug it sets belongs to another product. An edit stays over later feed imports; when a feed changes the value under it, the product shows a conflict. Send the same `requestId` again to get the first answer without publishing twice (one is made when you send none, and returned).',
          requestBody: body(catalogPublishInput),
          responses: {
            '200': ok('What publishing did with each product', ref('PublishResults')),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/drafts': {
        post: {
          summary: 'Save assistant drafts, up to 500 (operator)',
          description:
            'Drafts are text for one field and locale, checked like an edit but never staged or published until a person stages them. Status is not drafted.',
          requestBody: body(catalogDraftsInput),
          responses: { '200': ok('What each draft did', ref('EditResults')), ...errors },
        },
      },
      '/api/v1/catalog/drafts/discard': {
        post: {
          summary: 'Drop assistant drafts (operator)',
          requestBody: body(catalogDiscardInput),
          responses: { '200': ok('How many were dropped', ref('Discarded')), ...errors },
        },
      },
      '/api/v1/catalog/gaps/rebuild': {
        post: {
          summary: "Recount every product's content gaps (admin)",
          description:
            'Reads every product. Products stored before the gap index existed and channel changes are recounted on their own; this recounts now.',
          responses: { '200': ok('How many products were read', ref('GapsRebuilt')), ...errors },
        },
      },
      '/api/v1/catalog/reindex': {
        post: {
          summary: 'Republish every product (admin)',
          description:
            'After a channel or document change. Answers with how many products were queued.',
          responses: { '202': ok('How many products were queued', ref('Reindexed')), ...errors },
        },
      },
      '/api/v1/data-subjects/export': {
        post: {
          summary: 'Export everything held about a person, by email (admin)',
          description:
            'Their customer accounts, their orders (as a customer, as a guest buyer, or as the sender of an order email) with contact details, lines and metadata, the messages sent to them, their intake log entries, the documents on their orders and their accounts’ tax exemption certificates. Up to 500 orders; `truncated` says when there were more. `teamMember` says the address also belongs to a person on your team.',
          requestBody: body(dataSubjectInput),
          responses: {
            '200': ok('A JSON file of everything held about them', ref('SubjectExport')),
            ...errors,
          },
        },
      },
      '/api/v1/data-subjects/erase': {
        post: {
          summary: 'Erase a person from orders, accounts, documents and messages (admin)',
          description:
            'Removes who the person is and keeps the commercial record: their contact details, names, addresses, inbound documents and emails, and the messages sent to them go, as do their accounts’ tax exemption certificates and their files; lines, amounts, payments and shipments stay, and their customer accounts become "Erased customer". Works through 100 orders a call: repeat while `done` is false. Refused with 409 while any of their orders is still running. The audit log keeps its events under its own retention and names the request by a hash of the address.',
          requestBody: body(dataSubjectInput),
          responses: {
            '200': ok(
              'What this pass removed; repeat while `done` is false',
              ref('ErasureProgress'),
            ),
            '409': ok('Refused while the person has orders still running', ref('ErasureRefused')),
            ...errors,
          },
        },
      },
      '/api/v1/webhook-subscriptions': {
        get: {
          summary: 'List webhook subscriptions (admin)',
          responses: { '200': ok('Subscriptions', ref('Subscriptions')), ...errors },
        },
        post: {
          summary: 'Subscribe a URL to order events (admin)',
          description: 'The response carries the signing secret. It is shown only once.',
          requestBody: body(subscriptionInput),
          responses: {
            '201': ok('The subscription and its secret', ref('SubscriptionSecret')),
            ...errors,
          },
        },
      },
      '/api/v1/webhook-subscriptions/{id}': {
        delete: {
          summary: 'Delete a subscription (admin)',
          parameters: [orderId],
          responses: { '200': ok('Deleted', ref('Ok')), ...errors },
        },
      },
      '/api/v1/webhook-subscriptions/{id}/rotate': {
        post: {
          summary: 'Rotate a subscription signing secret (admin)',
          description:
            'Returns a new secret, shown once. For 24 hours each delivery carries a signature from the previous secret as well, so the receiver can switch without rejecting any.',
          parameters: [orderId],
          responses: {
            '200': ok('The subscription and its new secret', ref('SubscriptionSecret')),
            ...errors,
          },
        },
      },
      '/api/v1/webhook-subscriptions/{id}/deliveries': {
        get: {
          summary: 'Recent deliveries, newest first (admin)',
          parameters: [orderId],
          responses: { '200': ok('Deliveries', ref('Deliveries')), ...errors },
        },
      },
      '/api/v1/integrations': {
        get: {
          summary: 'List integrations, the signing keys for external systems (admin)',
          responses: {
            '200': ok('Integrations, without their secrets', ref('Integrations')),
            ...errors,
          },
        },
        post: {
          summary: 'Create an integration (admin)',
          description:
            'The scope says what its signed webhooks may do: `events` it may deliver, whether it may `startOrders`, the `flows` an order may name and the one `channel` it may reach. The response carries the signing secret. It is shown only once.',
          requestBody: body(integrationInput),
          responses: {
            '201': ok('The integration and its secret', ref('IntegrationSecret')),
            ...errors,
          },
        },
      },
      '/api/v1/integrations/{id}/rotate': {
        post: {
          summary: 'Rotate an integration secret (admin)',
          description:
            'Returns a new secret, shown once. The previous secret keeps working for 24 hours, so the sender can switch without a gap.',
          parameters: [orderId],
          responses: {
            '200': ok('The integration and its new secret', ref('IntegrationSecret')),
            ...errors,
          },
        },
      },
      '/api/v1/integrations/{id}': {
        delete: {
          summary: 'Revoke an integration (admin)',
          description: 'Both its secrets stop working at once.',
          parameters: [orderId],
          responses: { '200': ok('Revoked', ref('Ok')), ...errors },
        },
      },
      '/api/v1/plugins': {
        get: {
          summary:
            'The installed plugins, with their node types, the events they receive and whether they answer (admin)',
          responses: {
            '200': ok(
              'Each plugin: `runtime` is worker (its own Worker) or sandboxed (loaded by the engine); `source` is deployment (installed with the workspace) or installed (from a file, by an admin); `name` and `version` are null for a plugin whose manifest was refused; `provides` lists what it can do behind built-in nodes',
              ref('PluginList'),
            ),
            ...errors,
          },
        },
        post: {
          summary: 'Upload a signed plugin file for review (admin)',
          description:
            'The body is a .cwplugin file as its publisher signed it, at most 5 MiB. Refused unless its publisher is one this workspace trusts, its signature and contents check out, and it answers with the manifest it was signed with. An upload does not run: an admin reviews and approves it on the Plugins page, which asks them to confirm who they are.',
          requestBody: body(pluginBundleFileSchema),
          responses: {
            '201': ok(
              'The upload, `status` pending: what it asks for, to review',
              ref('PluginInstallView'),
            ),
            '413': ok('Larger than a plugin file may be', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/plugins/{id}/disable': {
        post: {
          summary: 'Turn off a plugin installed from a file (admin)',
          description:
            'Its steps stop running at once and flows that use it can no longer be published. Turn it back on from the Plugins page.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('Turned off', ref('PluginDisabled')), ...errors },
        },
      },
      '/api/v1/plugins/{id}/usage': {
        get: {
          summary: 'What uses a plugin: check this is empty before removing it (admin)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok(
              "Published flows that use its nodes or name it as a provider, running orders on them, and shipping labels it couldn't void yet (retried daily)",
              ref('PluginUsage'),
            ),
            ...errors,
          },
        },
      },
      '/api/v1/ucp': {
        get: {
          summary: 'Agentic checkout: its settings and the AI shopping platforms let in (admin)',
          responses: {
            '200': ok('The settings and the platforms, without their keys', ref('UcpAdmin')),
            ...errors,
          },
        },
      },
      '/api/v1/ucp/settings': {
        post: {
          summary: 'Set agentic checkout up, or turn it off (admin)',
          description:
            'The checkout flow is the published flow a completed checkout starts; it must authorize a card payment. `links` are the legal links every checkout shows, `orderUrl` (with `{id}`) is where a buyer sees their order, and `productUrl` (with `{slug}` or `{key}`) where they see a product in catalog search results. A null `checkoutFlowId` turns agentic checkout off.',
          requestBody: body(ucpSettingsSchema),
          responses: {
            '200': okJson('The settings as saved', z.object({ settings: ucpSettingsSchema })),
            '422': ok('The flow cannot take checkouts', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/storefront': {
        get: {
          summary: 'Hosted checkout: its settings (admin)',
          responses: { '200': ok('The settings as stored', ref('StorefrontAdmin')), ...errors },
        },
      },
      '/api/v1/storefront/settings': {
        post: {
          summary: 'Turn hosted checkout on or off, and set what a buyer may do on it (admin)',
          description:
            'Hosted checkout is the page a buyer pays on, opened from a one-time link `POST /api/v1/checkouts` makes. `checkoutFlowId` is the published flow that prices it and places its order (null uses agentic checkout’s); turning it on needs a flow that authorizes a card payment. `editLines` lets the buyer change the lines on their page. Turning it off stops every link and page at once. `storeName` is the name buyer pages show (plain text, up to 60 characters): leave it out to keep the current one, `null` clears it. Replaces the rest.',
          requestBody: body(storefrontSettingsInputSchema),
          responses: {
            '200': okJson(
              'The settings as saved',
              z.object({ settings: storefrontSettingsSchema }),
            ),
            '422': ok('The flow cannot take checkouts', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/ucp/platforms': {
        post: {
          summary: 'Let in an AI shopping platform (admin)',
          description:
            'The platform calls with the returned API key and names `profileUrl` in its `UCP-Agent` header. The key is shown only once. `redirectUris` are the exact return addresses a shopper may be sent back to when linking their identity to the platform; with none it can’t link one.',
          requestBody: body(platformInput),
          responses: { '201': ok('The platform and its key', ref('UcpPlatformKey')), ...errors },
        },
      },
      '/api/v1/ucp/platforms/{id}': {
        delete: {
          summary: 'Revoke an AI shopping platform (admin)',
          description: 'Its key stops working at once, and its orders stop sending it events.',
          parameters: [orderId],
          responses: { '200': ok('Revoked', ref('Ok')), ...errors },
        },
      },
    }),
    webhooks: Object.fromEntries(
      OUTBOUND_EVENTS.map((event) => [
        event,
        {
          post: {
            summary: event,
            description:
              'Signed with the subscription secret (`X-CommerceWorker-Signature`, same scheme as inbound). `X-CommerceWorker-Delivery` is stable across retries; dedupe on it.',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    $ref: `#/components/schemas/${isCartEvent(event) ? 'CartEvent' : 'OrderEvent'}`,
                  },
                },
              },
            },
            responses: { '2XX': { description: 'Accepted; any other status is retried' } },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API token (`cmw_live_…`, created on the Team page), or an OAuth access token granted for this API (resource `/api/v1`, discovered at `/.well-known/oauth-protected-resource/api/v1`)',
        },
      },
      schemas: {
        Whoami: output(whoamiOutput),
        Cart: cartSchema(),
        ...componentSchemas(),
        OrderEvent: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Delivery id' },
            event: { type: 'string', enum: [...ORDER_EVENTS] },
            occurredAt: { type: 'integer', description: 'Epoch ms' },
            orderId: { type: 'string' },
            data: {
              type: 'object',
              description:
                '`order` summary with its totals (`subtotal`, `shipping`, `tax`, `total`); `node` for node events; `outcome` and `reason` for order.completed / cancelled / failed.',
            },
          },
          required: ['id', 'event', 'occurredAt', 'orderId', 'data'],
        },
        CartEvent: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Delivery id' },
            event: { type: 'string', enum: [...CART_EVENTS] },
            occurredAt: { type: 'integer', description: 'Epoch ms' },
            cartId: { type: 'string' },
            orderId: {
              type: ['string', 'null'],
              description: 'The order the cart was submitted as; null until it was',
            },
            data: {
              type: 'object',
              properties: {
                cart: {
                  type: 'object',
                  description:
                    'The cart as it was: `id`, `title`, `status`, `flowId`, `source` (`staff` or `external`), `pluginId`, `customerId`, `lines` (`sku`, `qty`), `quote` (`currency`, `subtotal`, `shipping`, `tax`, `total`, or null when no quote prices it as it is), `orderId`, `createdAt`, `updatedAt` and `version`. Never its ship-to, chat, files or buyer.',
                },
              },
              required: ['cart'],
            },
          },
          required: ['id', 'event', 'occurredAt', 'cartId', 'orderId', 'data'],
        },
      },
    },
  };
}
