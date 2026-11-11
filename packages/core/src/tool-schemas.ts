/**
 * Each workspace tool's input and output, as zod schemas: what MCP lists as `inputSchema` and
 * `outputSchema`, what the assistant's model and A2A validate against, and (P2) what the REST API
 * shares. Names, roles, titles and descriptions are `ASSISTANT_TOOLS` (./assistant); the engine
 * runs each tool (apps/engine/src/assistant/tools.ts). Pure: zod and core only, so the web app can
 * read them too.
 */
import { z } from 'zod';
import { fingerprintOf } from './api';
import { assessQuestionsSchema } from './assess';
import type { AssistantTool } from './assistant';
import { AUDIT_GROUPS, type AuditGroup } from './audit';
import {
  BUDGET_ENFORCEMENTS,
  BUDGET_PAGE,
  BUDGET_PERIODS,
  BUDGET_STATUSES,
  budgetInput,
  SPEND_PAGE,
} from './b2b/budgets';
import {
  COMPANY_ROLES,
  COMPANY_STATUSES,
  companyMembersInput,
  companyTeamInput,
  createCustomerInput,
  MEMBER_STATUSES,
  updateCustomerInput,
} from './b2b/companies';
import {
  createPoDraftInput,
  PO_PAGE,
  PO_SOURCES,
  PO_STATUSES,
  updatePoDraftInput,
} from './b2b/purchase-orders';
import {
  createQuoteInput,
  QUOTE_CONVERSION_TARGETS,
  QUOTE_PAGE,
  QUOTE_STATUSES,
  updateQuoteInput,
} from './b2b/quotes';
import { CART_STATUSES, cartOpSchema, MAX_CART_TITLE, normalizePromoCode } from './cart';
import { CREDIT_ENTRY_KINDS, MAX_CREDIT_ADJUSTMENT } from './credit';
import { FX_SOURCES } from './fx';
import { flowGraphSchema } from './order-schemas';
import { MAX_DECISION_NOTE, RESERVED_EVENT_FIELDS } from './order-waits';
import { pluginCasesSchema } from './plugins';
import {
  MAX_CONTRACT_PRICES_PER_CALL,
  MAX_PRICE_BOOK_ENTRIES_PER_CALL,
  PRICE_BOOK_PRIORITY_LIMIT,
  PRICE_BOOK_STATUSES,
} from './price-books';
import { BOARD_COLUMNS } from './product/api';
import {
  fieldRefSchema,
  GAP_KINDS,
  MAX_DRAFT_FIELDS,
  PRODUCT_DRAFT_INSTRUCTION_MAX,
} from './product/content';
import {
  catalogCategoriesDeleteInput,
  catalogCategoriesInput,
  catalogChannelInput,
  catalogDeleteInput,
  catalogDiscardInput,
  catalogEditsInput,
  catalogFeedInput,
  catalogProductsInput,
  catalogTypeInput,
} from './product/inputs';
import { BOARD_PAGE_LIMIT, FEEDS_LIMIT } from './product/reads';
import { bxgyRuleSchema, bxgyShapeProblem } from './promotion-bxgy';
import {
  MAX_CONDITION_MESSAGE,
  PROMOTION_CONDITION_VARIABLES,
  promotionConditionProblem,
} from './promotion-conditions';
import { PROMOTION_KINDS, PROMOTION_STACKING } from './promotions';
import { RETURN_NOTE_MAX, RETURN_REASON_CODES, type ReturnReason } from './returns';
import { ROLES } from './roles';
import { FULFILLMENT_METHODS, ORDER_CHANNELS, ORDER_MODELS, ORDER_STATUSES } from './types';
import { ucpSettingsSchema } from './ucp/profile';

/**
 * The flow draft a publish or test is held to: `get_flow`'s `draft`. Over REST it is required (a
 * publish names the draft its caller read); over MCP the confirmation holds the draft the preview
 * showed.
 */
const DRAFT_FIELD = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .optional()
  .describe("get_flow's draft: refused if the flow's draft has changed since");

/** A page of companies or members. */
export const COMPANY_PAGE = { default: 25, max: 100 } as const;

/** The longest instruction a tool hands the model (a flow change, a plugin's rule). */
export const MODEL_INSTRUCTION_MAX = 4000;

/** The longest reason a cancel carries. */
export const MAX_CANCEL_REASON = 500;

/**
 * Fields an operation takes the same way over REST and MCP. Each transport builds its body from
 * these (REST's in apps/web/app/lib/api-schemas.ts), so a bound changes for both at once;
 * `apps/web/tests/rest-mcp-parity.test.ts` holds the two to each other.
 */
export const OPERATION_FIELDS = {
  decision: z.enum(['approved', 'rejected']),
  decisionNote: z.string().max(MAX_DECISION_NOTE),
  onBehalfOf: z
    .string()
    .min(1)
    .max(100)
    .describe(
      'A company member’s id: staff record that member’s vote on a company approval, audited',
    ),
  cancelReason: z.string().max(MAX_CANCEL_REASON),
  cartTitle: z.string().trim().min(1).max(MAX_CART_TITLE),
  cartFlowId: z.string().min(1).max(100),
  cartCustomerId: z.string().min(1).max(100),
  cartVersion: z.number().int().positive(),
} as const;
const F = OPERATION_FIELDS;

const orderId = z.string().describe('The order id (ord_…) or its #reference, e.g. #k3x9q2');
const cartId = z.string().max(100).describe('The cart id (cart_…)');
const productKey = z.string().min(1).max(128).describe('The product key');
const catalogCode = z.string().min(1).max(128);
const priceBookId = z.string().min(1).max(100).describe('The price book id (pb_…) or its code');
const pageCursor = z.string().max(300).optional().describe('`next` from the previous page');

/** Each tool's input. Built once per isolate. */

export const TOOL_INPUTS = {
  needs_attention: z.object({}),
  find_orders: z.object({
    status: z.enum(ORDER_STATUSES).optional(),
    model: z.enum(ORDER_MODELS).optional(),
    channel: z.enum(ORDER_CHANNELS).optional(),
    customer: z.string().optional().describe('Customer name or id'),
    q: z.string().optional().describe('Free text over id, title and customer'),
    minTotal: z.number().optional(),
    maxTotal: z.number().optional(),
    sinceDays: z.number().int().positive().optional().describe('Created in the last N days'),
    sort: z.enum(['newest', 'updated', 'largest']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  get_order: z.object({ orderId }),
  assess_order: z.object({
    orderId,
    questions: assessQuestionsSchema.describe(
      'Question id → { type: "noul", instructions } | { type: "choice", instructions, criteria: { optionId: description } } | { type: "score", instructions, criteria: [levels, lowest first] }',
    ),
    images: z
      .array(z.string())
      .max(4)
      .optional()
      .describe("Up to 4 images: the order's R2 document keys, https or data URLs"),
  }),
  find_products: z.object({
    q: z.string().max(200).optional().describe('SKU or name'),
    belowReorder: z.boolean().optional().describe('Only SKUs at or below their reorder point'),
  }),
  list_carts: z.object({
    status: z.enum(CART_STATUSES).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  get_cart: z.object({ cartId }),
  list_flows: z.object({}),
  get_flow: z.object({ flowId: z.string() }),
  propose_flow_change: z.object({
    flowId: z.string().max(60),
    instruction: z.string().min(1).max(MODEL_INSTRUCTION_MAX),
  }),
  draft_plugin: z.object({
    instruction: z
      .string()
      .min(1)
      .max(MODEL_INSTRUCTION_MAX)
      .describe('The rule in plain words, e.g. “hold orders over $5,000 shipping outside the US”'),
    pluginId: z
      .string()
      .max(100)
      .optional()
      .describe('A plugin the assistant drafted (ai-…), to revise as its next version'),
  }),
  draft_product_content: z.object({
    key: z.string().min(1).max(128).describe('The catalog product’s key'),
    fields: z
      .array(fieldRefSchema)
      .min(1)
      .max(MAX_DRAFT_FIELDS)
      .optional()
      .describe('Fields and locales to draft; omit to draft the text the product is missing'),
    instruction: z
      .string()
      .max(PRODUCT_DRAFT_INSTRUCTION_MAX)
      .optional()
      .describe('Guidance from the person: tone, length, terms to keep'),
  }),
  get_product: z.object({ key: productKey }),
  find_product_by_alias: z.object({
    alias: z
      .string()
      .min(1)
      .max(200)
      .describe('sku:ABC, gtin:… or slug:<locale>:… (the alias is case-sensitive)'),
  }),
  get_product_sheet: z.object({ key: productKey }),
  list_product_types: z.object({}),
  list_catalog_channels: z.object({}),
  list_categories: z.object({}),
  list_catalog_feeds: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(FEEDS_LIMIT.max)
      .optional()
      .describe(`Default ${FEEDS_LIMIT.default}`),
  }),
  get_catalog_feed: z.object({ feedId: z.string().min(1).max(100) }),
  catalog_board: z.object({}),
  catalog_board_column: z.object({
    column: z.enum(BOARD_COLUMNS),
    kind: z.enum(GAP_KINDS).optional().describe('Only products with this kind of gap'),
    cursor: z.string().max(500).optional().describe('The `cursor` a page returned'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(BOARD_PAGE_LIMIT.max)
      .optional()
      .describe(`Default ${BOARD_PAGE_LIMIT.default}`),
  }),
  create_cart: z.object({
    title: F.cartTitle,
    flowId: F.cartFlowId.describe('A published flow with a Price lines step (list_flows)'),
    customerId: F.cartCustomerId.optional().describe('The customer it is for (cus_…)'),
  }),
  change_cart: z.object({
    cartId,
    ops: z
      .array(cartOpSchema)
      .min(1)
      .max(20)
      .describe('Applied in order; line ids come from get_cart'),
  }),
  decide_approval: z.object({
    orderId,
    nodeId: z
      .string()
      .optional()
      .describe('The approval step; omit when the order has only one open'),
    decision: F.decision,
    note: F.decisionNote.optional(),
    onBehalfOf: F.onBehalfOf.optional(),
  }),
  decide_approvals: z.object({
    decision: F.decision,
    note: F.decisionNote.optional(),
    onBehalfOf: F.onBehalfOf.optional(),
    approvals: z
      .array(z.object({ orderId, nodeId: z.string().min(1).max(200) }))
      .min(1)
      .max(25)
      .describe('Each approval to decide: its order and the approval step'),
  }),
  deliver_event: z.object({
    orderId,
    event: z.string(),
    // Values no longer than the card shows; never a field that says who or what sent it.
    payload: z
      .record(
        z.string().min(1).max(60),
        z.union([z.string().max(120), z.number(), z.boolean(), z.null()]),
      )
      .refine((r) => Object.keys(r).length <= 20, 'At most 20 fields')
      .refine(
        (r) => !Object.keys(r).some((k) => RESERVED_EVENT_FIELDS.has(k)),
        `None of ${[...RESERVED_EVENT_FIELDS].join(', ')}`,
      )
      .optional()
      .describe('What the event carries, e.g. { "sellerId": "…", "decision": "accepted" }'),
  }),
  cancel_order: z.object({ orderId, reason: F.cancelReason }),
  record_return: z.object({
    orderId,
    reasonCode: z.enum(RETURN_REASON_CODES as [ReturnReason, ...ReturnReason[]]),
    lines: z
      .array(z.object({ sku: z.string().min(1).max(120), qty: z.number().positive() }))
      .min(1)
      .max(100),
    amount: z.number().min(0.01).optional(),
    note: z.string().max(RETURN_NOTE_MAX).optional(),
  }),
  submit_cart: z.object({
    cartId,
    cartVersion: F.cartVersion
      .optional()
      .describe('The cart version you read (get_cart); refused if the cart has changed since'),
  }),
  publish_flow: z.object({ flowId: z.string().max(60), draft: DRAFT_FIELD }),
  run_stock_review: z.object({}),
  start_order: z.object({
    flowId: z.string().max(100).describe('A published flow (list_flows)'),
    title: z.string().max(140).optional(),
    channel: z
      .enum(ORDER_CHANNELS)
      .optional()
      .describe('Where the order came from; manual if unsaid'),
    customerId: z.string().max(100).optional(),
    contact: z
      .object({ email: z.email().max(200), name: z.string().max(120).optional() })
      .optional()
      .describe('A guest buyer, when there is no customer'),
    fulfillment: z
      .object({
        method: z.enum(FULFILLMENT_METHODS),
        locationId: z.string().max(100).optional(),
      })
      .optional(),
    currency: z.string().length(3).optional(),
    lines: z
      .array(
        z.object({
          sku: z.string().min(1).max(100),
          qty: z.number().int().positive().max(1_000_000),
        }),
      )
      .max(100),
    documentText: z.string().max(20_000).optional().describe('Text the flow reads (a PO or email)'),
  }),
  restart_order: z.object({ orderId }),
  start_scenario: z.object({ scenarioId: z.string().max(60).describe('A demo scenario id') }),
  cancel_cart: z.object({ cartId }),
  draft_cart_reply: z.object({
    cartId,
    instruction: z.string().max(500).optional().describe('What the reply should say'),
  }),
  save_flow_draft: z.object({
    flowId: z.string().max(60),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    model: z.enum(ORDER_MODELS),
    channels: z.array(z.enum(ORDER_CHANNELS)).max(20).optional(),
    nodes: flowGraphSchema.shape.nodes.max(500),
    edges: flowGraphSchema.shape.edges.max(2000),
  }),
  create_flow: z.object({
    name: z.string().min(1).max(80),
    model: z.enum(ORDER_MODELS),
    start: z
      .enum(['template', 'blank', 'describe'])
      .describe('The model’s template, a blank start, or drafted from `prompt`'),
    prompt: z.string().max(4000).optional().describe('The steps, for start: describe'),
  }),
  duplicate_flow: z.object({ flowId: z.string().max(60) }),
  archive_flow: z.object({
    flowId: z.string().max(60),
    archived: z.boolean().describe('false restores it'),
  }),
  test_flow: z.object({ flowId: z.string().max(60), draft: DRAFT_FIELD }),
  stage_product_edits: catalogEditsInput,
  accept_product_drafts: z.object({ key: productKey }),
  discard_product_edits: catalogDiscardInput.extend({ what: z.enum(['staged', 'drafts']) }),
  put_catalog_products: catalogProductsInput,
  delete_catalog_products: catalogDeleteInput,
  put_catalog_type: catalogTypeInput,
  delete_catalog_type: z.object({ code: catalogCode }),
  put_catalog_channel: catalogChannelInput,
  delete_catalog_channel: z.object({ code: catalogCode }),
  put_catalog_categories: catalogCategoriesInput,
  delete_catalog_categories: catalogCategoriesDeleteInput,
  start_catalog_feed: catalogFeedInput,
  cancel_catalog_feed: z.object({ feedId: z.string().min(1).max(100) }),
  reindex_catalog: z.object({}),
  rebuild_catalog_gaps: z.object({}),
  create_promotion: z
    .object({
      // As a cart reads it (`normalizePromoCode`), so the code made is the code buyers enter.
      // Without one the promotion is automatic: it applies to any order it fits.
      code: z
        .string()
        .max(64)
        .transform((c, ctx) => {
          const code = normalizePromoCode(c);
          if (!code)
            ctx.addIssue({
              code: 'custom',
              message: 'Letters, digits, dashes and underscores, up to 32',
            });
          return code ?? '';
        })
        .optional()
        .describe('What buyers enter; leave out for an automatic promotion that needs no code'),
      name: z.string().max(120).optional().describe('Required when there is no code'),
      kind: z.enum(PROMOTION_KINDS),
      value: z.number().nonnegative().optional().describe('The percentage or amount off'),
      minSubtotal: z.number().nonnegative().optional(),
      skus: z.array(z.string().min(1).max(100)).max(200).optional(),
      customerId: z.string().max(100).optional(),
      validTo: z
        .number()
        .int()
        .positive()
        .max(Date.UTC(9999, 0, 1))
        .optional()
        .describe('Ends at, epoch ms'),
      maxRedemptions: z.number().int().positive().optional(),
      perCustomerLimit: z.number().int().positive().optional(),
      priority: z
        .number()
        .int()
        .min(-1000)
        .max(1000)
        .optional()
        .describe('Higher is considered first (default 0)'),
      stacking: z
        .enum(PROMOTION_STACKING)
        .optional()
        .describe('exclusive (default) is never combined with another; stackable combines'),
      maxDiscount: z
        .number()
        .positive()
        .optional()
        .describe('The most it takes off one order, in the base currency'),
      condition: z
        .record(z.string(), z.unknown())
        .superRefine((c, ctx) => {
          const why = promotionConditionProblem(c);
          if (why) ctx.addIssue({ code: 'custom', message: why });
        })
        .optional()
        .describe(
          `A JSON Logic expression the order must also meet, over ${Object.keys(PROMOTION_CONDITION_VARIABLES).join(', ')}`,
        ),
      conditionMessage: z
        .string()
        .max(MAX_CONDITION_MESSAGE)
        .optional()
        .describe('What a buyer entering the code is told when the condition fails'),
      bxgy: bxgyRuleSchema
        .optional()
        .describe(
          'The rule of a bxgy promotion (and of no other kind): buy {skus?, qty} earns get {skus?, qty, percent?} at a percentage off, repeat times per order. Leave buy.skus out for any line, get.skus out for the same lines as buy, percent out for free (100), repeat out for unlimited. The cheapest get units are discounted first',
        ),
    })
    .refine((p) => p.code !== undefined || !!p.name?.trim(), {
      message: 'A promotion without a code needs a name',
      path: ['name'],
    })
    .refine((p) => p.conditionMessage === undefined || p.condition !== undefined, {
      message: 'A condition message needs a condition',
      path: ['conditionMessage'],
    })
    .superRefine((p, ctx) => {
      const why = bxgyShapeProblem(p.kind, p.bxgy, p.skus);
      if (why) ctx.addIssue({ code: 'custom', message: why, path: ['bxgy'] });
    }),
  set_promotion_status: z.object({
    promotionId: z.string().max(60),
    status: z.enum(['active', 'paused']),
  }),
  list_price_books: z.object({
    status: z.enum(PRICE_BOOK_STATUSES).optional(),
    after: pageCursor,
    limit: z.number().int().min(1).max(100).optional().describe('Books a page, default 25'),
  }),
  get_price_book: z.object({
    bookId: priceBookId,
    after: pageCursor,
    limit: z.number().int().min(1).max(200).optional().describe('Entries a page, default 50'),
  }),
  preview_price: z.object({
    customerId: z
      .string()
      .max(100)
      .optional()
      .describe('The customer to price for; leave out for list and unassigned prices'),
    lines: z
      .array(
        z.object({
          sku: z.string().min(1).max(100),
          qty: z.number().positive().optional().describe('Default 1'),
        }),
      )
      .min(1)
      .max(50),
  }),
  create_price_book: z.object({
    code: z
      .string()
      .min(1)
      .max(64)
      .describe('Lower-case letters, digits, dashes and underscores, up to 32'),
    name: z.string().trim().min(1).max(120),
    priority: z
      .number()
      .int()
      .min(-PRICE_BOOK_PRIORITY_LIMIT)
      .max(PRICE_BOOK_PRIORITY_LIMIT)
      .optional()
      .describe('The higher wins when several assigned books price a line (default 0)'),
    startsAt: z
      .number()
      .int()
      .nonnegative()
      .max(Date.UTC(9999, 0, 1))
      .optional()
      .describe('In force from, epoch ms'),
    endsAt: z
      .number()
      .int()
      .positive()
      .max(Date.UTC(9999, 0, 1))
      .optional()
      .describe('In force until, epoch ms'),
  }),
  set_price_book_status: z.object({
    bookId: priceBookId,
    status: z.enum(['active', 'inactive', 'archived']),
  }),
  put_price_book_entries: z.object({
    bookId: priceBookId,
    entries: z
      .array(
        z.object({
          sku: z.string().min(1).max(100),
          minQty: z
            .number()
            .positive()
            .optional()
            .describe('Volume tier: from this quantity (default 1)'),
          price: z
            .number()
            .nonnegative()
            .optional()
            .describe('Unit price in USD, the base currency'),
          discountPct: z
            .number()
            .positive()
            .max(100)
            .optional()
            .describe('Percent off list, instead of a price'),
          remove: z.boolean().optional().describe('Remove this SKU and quantity from the book'),
        }),
      )
      .min(1)
      .max(MAX_PRICE_BOOK_ENTRIES_PER_CALL),
  }),
  assign_price_book: z.object({
    bookId: priceBookId,
    customerId: z.string().max(100).optional().describe('One customer; or a tier, not both'),
    tier: z.string().max(60).optional().describe('Every customer of this tier'),
    remove: z.boolean().optional().describe('Take the assignment away'),
  }),
  put_contract_prices: z.object({
    customerId: z.string().min(1).max(100),
    prices: z
      .array(
        z.object({
          sku: z.string().min(1).max(100),
          price: z
            .number()
            .nonnegative()
            .nullable()
            .describe('Unit price in USD; null removes the contract price'),
        }),
      )
      .min(1)
      .max(MAX_CONTRACT_PRICES_PER_CALL),
  }),
  list_fx_rates: z.object({}),
  set_fx_rate: z.object({
    currency: z.string().length(3).describe('ISO 4217 code in capitals, like EUR; never USD'),
    rate: z.number().positive().describe('Units of the currency per one USD'),
  }),
  verify_tax_certificate: z.object({
    customerId: z.string().max(100),
    certificateId: z.string().max(100),
  }),
  revoke_tax_certificate: z.object({
    customerId: z.string().max(100),
    certificateId: z.string().max(100),
  }),
  list_companies: z.object({
    status: z.enum(COMPANY_STATUSES).optional(),
    search: z.string().max(100).optional().describe('Part of the name, legal name or id'),
    cursor: z.string().max(500).optional().describe('The `cursor` a page returned'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(COMPANY_PAGE.max)
      .optional()
      .describe(`Default ${COMPANY_PAGE.default}`),
  }),
  get_company: z.object({ companyId: z.string().max(100).describe('The business customer’s id') }),
  list_company_members: z.object({
    companyId: z.string().max(100),
    status: z.enum(MEMBER_STATUSES).optional(),
    role: z.enum(COMPANY_ROLES).optional(),
    teamId: z.string().max(100).optional(),
    cursor: z.string().max(500).optional().describe('The `cursor` a page returned'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(COMPANY_PAGE.max)
      .optional()
      .describe(`Default ${COMPANY_PAGE.default}`),
  }),
  create_customer: createCustomerInput,
  update_customer: updateCustomerInput,
  set_company_status: z.object({
    companyId: z.string().max(100),
    status: z.enum(COMPANY_STATUSES),
  }),
  put_company_members: z.object({
    companyId: z.string().max(100),
    members: companyMembersInput,
  }),
  remove_company_member: z.object({
    companyId: z.string().max(100),
    memberId: z.string().max(100),
  }),
  put_company_team: companyTeamInput,
  get_credit_account: z.object({
    customerId: z.string().max(100),
    after: z
      .string()
      .max(200)
      .optional()
      .describe('The `next` of the previous page, to read the entries before it'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
  }),
  set_credit_limit: z.object({
    customerId: z.string().max(100),
    limit: z
      .number()
      .min(0)
      .max(MAX_CREDIT_ADJUSTMENT)
      .describe('In the base currency; 0 for none'),
  }),
  adjust_credit: z.object({
    customerId: z.string().max(100),
    amount: z
      .number()
      .min(-MAX_CREDIT_ADJUSTMENT)
      .max(MAX_CREDIT_ADJUSTMENT)
      .describe('In the base currency: negative for a credit memo or a payment received'),
    reason: z.string().min(1).max(500).describe('What the ledger shows beside the entry'),
  }),
  list_budgets: z.object({
    companyId: z.string().max(100).describe('The business customer’s id'),
    teamId: z.string().max(100).optional().describe('Only the budgets of this team'),
    status: z.enum(BUDGET_STATUSES).optional(),
    cursor: z.string().max(500).optional().describe('The `cursor` a page returned'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(BUDGET_PAGE.max)
      .optional()
      .describe(`Default ${BUDGET_PAGE.default}`),
  }),
  list_budget_spend: z.object({
    companyId: z.string().max(100).describe('The business customer’s id'),
    budgetId: z.string().max(100),
    cursor: z.string().max(500).optional().describe('The `cursor` a page returned'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SPEND_PAGE.max)
      .optional()
      .describe(`Default ${SPEND_PAGE.default}`),
  }),
  put_budget: budgetInput,
  set_budget_status: z.object({
    companyId: z.string().max(100),
    budgetId: z.string().max(100),
    status: z.enum(BUDGET_STATUSES),
  }),
  list_purchase_orders: z.object({
    companyId: z.string().max(100).optional().describe('Only this company’s purchase orders'),
    status: z.enum(PO_STATUSES).optional(),
    buyerId: z.string().max(100).optional().describe('Only POs this company member placed'),
    search: z.string().max(100).optional().describe('Part of the PO number'),
    from: z.iso.date().optional().describe('Created on or after this day (UTC), YYYY-MM-DD'),
    to: z.iso.date().optional().describe('Created on or before this day (UTC), YYYY-MM-DD'),
    cursor: z.string().max(500).optional().describe('The `cursor` a page returned'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PO_PAGE.max)
      .optional()
      .describe(`Default ${PO_PAGE.default}`),
  }),
  get_purchase_order: z.object({ poId: z.string().min(1).max(100) }),
  create_po_draft: createPoDraftInput,
  update_po_draft: updatePoDraftInput,
  submit_po: z.object({
    poId: z.string().min(1).max(100),
    flowId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('The flow to run it on; defaults to the B2B purchase order flow'),
  }),
  cancel_po: z.object({
    poId: z.string().min(1).max(100),
    reason: z.string().trim().min(1).max(500).optional().describe('Kept on the order’s timeline'),
  }),
  list_quotes: z.object({
    companyId: z.string().max(100).optional().describe('Only this company’s quotes'),
    status: z.enum(QUOTE_STATUSES).optional(),
    rootId: z
      .string()
      .max(100)
      .optional()
      .describe('Every version of the negotiation whose first version has this id'),
    search: z.string().max(100).optional().describe('Part of the quote’s name'),
    cursor: z.string().max(500).optional().describe('The `cursor` a page returned'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(QUOTE_PAGE.max)
      .optional()
      .describe(`Default ${QUOTE_PAGE.default}`),
  }),
  get_quote: z.object({ quoteId: z.string().min(1).max(100) }),
  create_quote: createQuoteInput,
  update_quote: updateQuoteInput,
  send_quote: z.object({ quoteId: z.string().min(1).max(100) }),
  accept_quote: z.object({
    quoteId: z.string().min(1).max(100),
    note: z.string().trim().min(1).max(500).optional().describe('Who accepted, and how'),
  }),
  decline_quote: z.object({
    quoteId: z.string().min(1).max(100),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  revise_quote: z.object({ quoteId: z.string().min(1).max(100) }),
  expire_quote: z.object({ quoteId: z.string().min(1).max(100) }),
  convert_quote: z.object({
    quoteId: z.string().min(1).max(100),
    to: z
      .enum(QUOTE_CONVERSION_TARGETS)
      .optional()
      .describe('po or order; defaults to po when the company has purchase orders, else order'),
    poNumber: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe('The PO number for a PO draft; defaults to one made from the quote'),
    flowId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('For an order: the flow to run it on; defaults to the B2B order flow'),
  }),
  set_member_role: z.object({ userId: z.string().max(60), role: z.enum(ROLES) }),
  set_approval_separation: z.object({ on: z.boolean() }),
  set_assistant_routing: z.object({ on: z.boolean() }),
  set_plugin_enabled: z.object({ pluginId: z.string().max(60), enabled: z.boolean() }),
  approve_plugin: z.object({
    pluginId: z.string().max(60),
    sha: z.string().max(80),
    personalData: z.boolean().optional().describe('Grant buyers’ details, when it asks for them'),
  }),
  rollback_plugin: z.object({ pluginId: z.string().max(60), sha: z.string().max(80) }),
  uninstall_plugin: z.object({ pluginId: z.string().max(60) }),
  run_plugin_cases: z.object({
    pluginId: z.string().max(60),
    sha: z.string().max(80),
    cases: pluginCasesSchema,
  }),
  list_audit_events: z.object({
    group: z.enum(Object.keys(AUDIT_GROUPS) as [AuditGroup, ...AuditGroup[]]).optional(),
    before: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only events before this time, epoch ms'),
    after: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('A seq: the sealed events after it, oldest first'),
    limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
  }),
  verify_audit_trail: z.object({
    after: z.number().int().nonnegative().optional().describe('A seq, from a previous `next`'),
  }),
  list_plugins: z.object({}),
  get_plugin_usage: z.object({ pluginId: z.string().max(60) }),
  list_webhook_subscriptions: z.object({}),
  list_webhook_deliveries: z.object({
    subscriptionId: z.string().max(60),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
  }),
  delete_webhook_subscription: z.object({ subscriptionId: z.string().min(1).max(60) }),
  list_integrations: z.object({}),
  revoke_integration: z.object({ integrationId: z.string().min(1).max(60) }),
  get_ucp_settings: z.object({}),
  // The REST body, exactly: one schema holds both transports to the same bounds.
  set_ucp_settings: ucpSettingsSchema,
  revoke_ucp_platform: z.object({ platformId: z.string().min(1).max(60) }),
  publish_catalog: z.object({
    keys: z.array(productKey).min(1).max(500).describe('Product keys whose staged edits publish'),
  }),
} satisfies Record<AssistantTool, z.ZodObject>;

export type ToolInput<T extends AssistantTool> = z.infer<(typeof TOOL_INPUTS)[T]>;

// What each tool returns, as MCP's `outputSchema`. Loose objects: they name the fields a client
// can rely on and let a later field through, so adding one never fails a call.
const row = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
const href = z.string().describe('Where to look in CommerceWorker, e.g. /orders/ord_…');
const money = z.string().describe('Formatted in the order’s currency, e.g. $1,250.00');
const orderRow = row({
  id: z.string(),
  ref: z.string(),
  title: z.string(),
  status: z.string(),
  waitingAt: z.string().nullable().describe('The steps it is waiting at, joined with ·'),
  stoppedAt: z.string().nullable().describe('The steps it failed or stopped at'),
  total: money,
  href,
});

const companyOutput = row({
  id: z.string().describe('The business customer’s id'),
  name: z.string(),
  status: z.enum(COMPANY_STATUSES),
  legalName: z.string(),
  taxId: z.string().nullable(),
  parentCompanyId: z.string().nullable(),
  tier: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const memberOutput = row({
  id: z.string(),
  companyId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(COMPANY_ROLES),
  teamId: z.string().nullable(),
  status: z.enum(MEMBER_STATUSES),
  orderLimit: z.number().nullable().describe('Base currency; null for no limit of their own'),
});

const budgetOutput = row({
  id: z.string(),
  companyId: z.string(),
  teamId: z.string().nullable().describe('The team it covers (and those under it); null for all'),
  name: z.string(),
  amount: z.number().describe('Per window, base currency'),
  period: z.enum(BUDGET_PERIODS),
  anchor: z.number().describe('When it starts counting (ms, UTC)'),
  enforcement: z.enum(BUDGET_ENFORCEMENTS),
  status: z.enum(BUDGET_STATUSES),
  window: row({
    start: z.number().describe('When the current window opened (ms, UTC)'),
    end: z.number().nullable().describe('When it closes; null for a one-time budget'),
  })
    .nullable()
    .describe('The window now; null before the budget starts'),
  spent: z.number().describe('Committed in the current window'),
  remaining: z.number().describe('Amount less spent; negative when over'),
});

const poLineOutput = row({
  sku: z.string(),
  name: z.string().nullable(),
  qty: z.number(),
  unitPrice: z.number().nullable().describe('What the buyer expected to pay; the flow prices it'),
});
const purchaseOrderOutput = row({
  id: z.string(),
  companyId: z.string(),
  buyerId: z.string().nullable(),
  poNumber: z.string(),
  status: z.enum(PO_STATUSES),
  currency: z.string(),
  shipTo: z.record(z.string(), z.string()).nullable(),
  notes: z.string().nullable(),
  quoteId: z.string().nullable(),
  orderId: z.string().nullable().describe('The order it started; null until submitted'),
  source: z.enum(PO_SOURCES),
  createdAt: z.number(),
  updatedAt: z.number(),
  lineCount: z.number().optional(),
  lines: z.array(poLineOutput).optional(),
});

const quoteLineOutput = row({
  sku: z.string(),
  name: z.string().nullable(),
  qty: z.number().describe('The most a buyer may order at this price'),
  listPrice: z.number().nullable().describe('List price when the line was written'),
  unitPrice: z.number().describe('The negotiated unit price, base currency'),
});
const quoteOutput = row({
  id: z.string(),
  rootId: z.string().describe('The first version’s id, shared by every version'),
  version: z.number(),
  companyId: z.string(),
  buyerId: z.string().nullable(),
  name: z.string(),
  status: z.enum(QUOTE_STATUSES),
  expiresAt: z.number().nullable().describe('Ms; the prices stop counting at this instant'),
  notes: z.string().nullable(),
  convertedTo: z.enum(QUOTE_CONVERSION_TARGETS).nullable(),
  convertedId: z.string().nullable().describe('The PO draft or order the quote became'),
  convertedAt: z.number().nullable(),
  sentAt: z.number().nullable(),
  decidedAt: z.number().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  total: z.number().describe('Its lines’ quantities at their prices'),
  lineCount: z.number().optional(),
  lines: z.array(quoteLineOutput).optional(),
  versions: z
    .array(row({ id: z.string(), version: z.number(), status: z.enum(QUOTE_STATUSES) }))
    .optional()
    .describe('Every version of the negotiation, oldest first'),
  href: z.string(),
});

const feedOutput = row({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  rows: z.number(),
  created: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  rejected: z.number(),
});

const cartOutput = row({
  id: z.string(),
  href,
  title: z.string(),
  status: z.string(),
  lines: z.array(row({ lineId: z.string(), sku: z.string(), qty: z.number() })),
  shipTo: row({}).nullable().describe('Where it ships (set_ship_to); null until set'),
  shippingOption: z
    .string()
    .nullable()
    .describe('The option it ships by: what the current quote charged, else the one chosen'),
  shippingOptions: z
    .array(row({ id: z.string(), title: z.string(), price: money }))
    .describe('What the flow offers for the ship-to; choose one with set_shipping_option'),
  priced: z.boolean().describe('Whether the total prices the cart as it is now'),
  total: money.describe('Formatted in the quote’s currency; empty until priced'),
  notReady: z.string().nullable().describe('Why it can’t be submitted yet; null when it can'),
});

/** A price book as the tools show it. */
const priceBookOutput = row({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  priority: z.number(),
  status: z.enum(PRICE_BOOK_STATUSES),
  startsAt: z.number().nullable(),
  endsAt: z.number().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Where a vote stands after it is recorded: still open, or decided. */
const decisionOutcome = z.enum(['recorded', 'approved', 'rejected']);

/** An action's result: a preview and code on the first call, what was done on the second. */
const actionOutput = row({
  preview: row({
    title: z.string(),
    consequences: z.array(z.string()),
    href: z.string().optional(),
  }).optional(),
  confirmation: z.string().optional().describe('Send it back with the same input once agreed'),
  expiresAt: z.number().optional(),
  next: z.string().optional(),
  done: z.string().optional().describe('What happened, once the action ran'),
  href: z.string().optional(),
});

export const TOOL_OUTPUTS = {
  needs_attention: row({
    approvals: z.array(row({ id: z.string(), orderId: z.string(), title: z.string() })),
    failed: z.array(row({ id: z.string(), title: z.string(), status: z.string() })),
    stalled: z.array(row({ id: z.string(), title: z.string() })),
    counts: row({ approvals: z.number(), failed: z.number(), stalled: z.number() }),
  }),
  find_orders: row({
    count: z.number().describe('All matches, not only the rows shown'),
    total: money.describe('The total of all matches, in USD'),
    shown: z.number(),
    orders: z.array(orderRow),
  }),
  get_order: row({
    id: z.string(),
    ref: z.string(),
    href,
    title: z.string(),
    status: z.string(),
    total: money,
    waits: z.array(
      row({
        nodeId: z.string(),
        step: z.string().describe('The label of the step it waits at'),
        since: z.string(),
        kind: z.string(),
        title: z.string(),
      }),
    ),
    steps: z.array(row({ nodeId: z.string(), step: z.string(), status: z.string() })),
    recent: z.array(row({ at: z.string(), message: z.string() })),
  }),
  assess_order: row({
    id: z.string(),
    ref: z.string(),
    answers: z.record(z.string(), row({ type: z.string() })),
    images: z.number().describe('Images the assessment used'),
    notes: z.array(z.string()),
    source: z.enum(['model', 'heuristic']),
  }),
  find_products: row({
    products: z.array(
      row({ sku: z.string(), name: z.string(), stock: z.number(), available: z.number() }),
    ),
    href,
  }),
  list_carts: row({
    shown: z.number(),
    carts: z.array(row({ id: z.string(), title: z.string(), status: z.string(), href })),
  }),
  get_cart: cartOutput,
  list_flows: row({
    flows: z.array(row({ id: z.string(), name: z.string(), href })),
  }),
  get_flow: row({
    id: z.string(),
    name: z.string(),
    href,
    steps: z.array(row({ id: z.string(), type: z.string(), label: z.string() })),
    connections: z.array(z.string()),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
    draft: z.string().describe('The draft’s fingerprint: name it to publish or test this draft'),
  }),
  propose_flow_change: row({
    flowId: z.string(),
    flowName: z.string(),
    explanation: z.string(),
    graph: row({ nodes: z.array(row({})), edges: z.array(row({})) }),
    changes: row({
      added: z.number(),
      removed: z.number(),
      edited: z.number(),
      rewired: z.number(),
    }),
  }),
  draft_plugin: row({
    id: z.string().describe('The drafted plugin, ai-…'),
    sha: z.string(),
    name: z.string(),
    version: z.string(),
    explanation: z.string(),
    nodes: z.array(row({ type: z.string(), label: z.string() })),
    cases: row({ total: z.number(), passed: z.number() }),
    href: href.describe('Where an admin reviews, tests and approves it'),
  }),
  draft_product_content: row({
    key: z.string(),
    title: z.string(),
    drafted: z.array(row({ ref: row({ field: z.string() }), value: z.string() })),
    refused: z.array(row({ ref: row({ field: z.string() }), issues: z.array(z.string()) })),
    model: z.string().nullable().describe('The model that wrote them'),
  }),
  get_product: row({ product: row({ key: z.string(), type: z.string(), version: z.number() }) }),
  find_product_by_alias: row({ key: z.string().describe('The product key, for get_product') }),
  get_product_sheet: row({
    sheet: row({
      product: row({ key: z.string() }),
      feed: row({}),
      overrides: z.array(row({})),
      staged: z.array(row({})),
      drafts: z.array(row({})),
      gaps: z.array(row({ kind: z.string(), field: z.string() })),
      rejection: row({}).nullable(),
      revisions: z.array(row({})),
    }),
  }),
  list_product_types: row({
    types: z.array(row({ code: z.string(), version: z.number(), attributes: z.array(row({})) })),
  }),
  list_catalog_channels: row({ channels: z.array(row({ code: z.string() })) }),
  list_categories: row({ categories: z.array(row({ code: z.string() })) }),
  list_catalog_feeds: row({ feeds: z.array(feedOutput) }),
  get_catalog_feed: row({ feed: feedOutput }),
  catalog_board: row({
    board: row({
      columns: z.record(z.string(), z.number()).describe('Products per column'),
      gapsByKind: z.record(z.string(), row({ gaps: z.number(), products: z.number() })),
      lastFeed: feedOutput.nullable(),
      runningFeed: feedOutput.nullable(),
      indexBuilt: z.boolean().describe('False while the gap index is still being built'),
    }),
  }),
  catalog_board_column: row({
    items: z.array(row({ key: z.string(), title: z.string(), column: z.string() })),
    cursor: z.string().nullable().describe('Pass it back for the next page; null at the end'),
  }),
  create_cart: cartOutput,
  change_cart: cartOutput.extend({ applied: z.number().describe('Ops applied') }),
  decide_approval: actionOutput.extend({
    outcome: decisionOutcome.optional().describe('Once confirmed: where the vote stands'),
    tally: z.string().optional().describe('Approvals so far of those needed, like "1 of 2"'),
  }),
  decide_approvals: actionOutput.extend({
    results: z
      .array(
        row({
          orderId: z.string(),
          nodeId: z.string(),
          ok: z.boolean(),
          error: z.string().optional(),
          outcome: decisionOutcome.optional(),
          tally: z.string().optional(),
        }),
      )
      .optional()
      .describe('How each approval went, once confirmed'),
  }),
  deliver_event: actionOutput,
  cancel_order: actionOutput,
  record_return: actionOutput,
  submit_cart: actionOutput,
  publish_flow: actionOutput,
  run_stock_review: actionOutput,
  start_order: actionOutput,
  restart_order: actionOutput,
  start_scenario: actionOutput,
  cancel_cart: actionOutput,
  draft_cart_reply: row({ done: z.string(), href: z.string(), draft: z.string() }),
  save_flow_draft: row({
    done: z.string(),
    href: z.string(),
    id: z.string(),
    errors: z.array(row({ message: z.string() })),
    warnings: z.array(row({ message: z.string() })),
  }),
  create_flow: row({ done: z.string(), href: z.string(), id: z.string() }),
  duplicate_flow: row({ done: z.string(), href: z.string(), id: z.string() }),
  archive_flow: row({ done: z.string(), href: z.string(), id: z.string() }),
  test_flow: actionOutput,
  stage_product_edits: row({ done: z.string(), href: z.string(), results: z.array(row({})) }),
  accept_product_drafts: row({ done: z.string(), href: z.string(), results: z.array(row({})) }),
  discard_product_edits: row({ done: z.string(), href: z.string(), discarded: z.number() }),
  publish_catalog: actionOutput.extend({ results: z.array(row({})).optional() }),
  put_catalog_products: actionOutput.extend({ results: z.array(row({})).optional() }),
  delete_catalog_products: actionOutput.extend({ results: z.array(row({})).optional() }),
  put_catalog_type: row({ done: z.string(), href: z.string(), type: row({ code: z.string() }) }),
  delete_catalog_type: actionOutput,
  put_catalog_channel: row({
    done: z.string(),
    href: z.string(),
    channel: row({ code: z.string() }),
  }),
  delete_catalog_channel: actionOutput,
  put_catalog_categories: actionOutput.extend({ categories: z.array(row({})).optional() }),
  delete_catalog_categories: actionOutput,
  start_catalog_feed: actionOutput.extend({ feed: feedOutput.optional() }),
  cancel_catalog_feed: actionOutput.extend({ feed: feedOutput.optional() }),
  reindex_catalog: actionOutput,
  rebuild_catalog_gaps: actionOutput,
  create_promotion: actionOutput,
  set_member_role: actionOutput,
  set_approval_separation: actionOutput,
  set_assistant_routing: actionOutput,
  set_plugin_enabled: actionOutput,
  approve_plugin: actionOutput,
  rollback_plugin: actionOutput,
  uninstall_plugin: actionOutput,
  run_plugin_cases: row({ done: z.string(), href: z.string(), results: z.array(row({})) }),
  list_audit_events: row({
    events: z.array(
      row({
        id: z.string(),
        at: z.number(),
        action: z.string(),
        actor: z.string().nullable(),
        target: z.string().nullable(),
        detail: z.record(z.string(), z.unknown()).nullable(),
        seq: z.number().nullable(),
      }),
    ),
  }),
  verify_audit_trail: row({
    ok: z.boolean(),
    checked: z.number(),
    brokenAt: z.number().optional(),
    reason: z.string().optional(),
    next: z.number().optional().describe('Call again with after set to this, to check the rest'),
  }),
  list_plugins: row({
    plugins: z.array(
      row({
        id: z.string(),
        runtime: z.string(),
        source: z.string(),
        name: z.string().nullable(),
        version: z.string().nullable(),
        nodes: z.array(z.string()),
        events: z.array(z.string()),
        provides: z.array(z.string()),
        healthy: z.boolean(),
        error: z.string().optional(),
      }),
    ),
  }),
  get_plugin_usage: row({
    flows: z.array(row({ id: z.string(), version: z.number() })),
    orders: z.array(row({ id: z.string(), flowId: z.string(), version: z.number() })),
    labels: z.array(row({ id: z.string(), orderId: z.string() })),
  }),
  list_webhook_subscriptions: row({
    subscriptions: z.array(
      row({
        id: z.string(),
        url: z.string(),
        events: z.array(z.string()),
        active: z.boolean(),
        createdAt: z.number(),
        previousExpiresAt: z.number().nullable(),
      }),
    ),
  }),
  list_webhook_deliveries: row({
    deliveries: z.array(
      row({
        id: z.string(),
        event: z.string(),
        orderId: z.string(),
        status: z.string(),
        attempts: z.number(),
        payload: z.unknown(),
      }),
    ),
  }),
  delete_webhook_subscription: actionOutput,
  list_integrations: row({
    integrations: z.array(
      row({
        id: z.string(),
        name: z.string(),
        events: z.array(z.string()),
        startOrders: z.boolean(),
        flows: z.array(z.string()),
        channel: z.string().nullable(),
        createdAt: z.number(),
        createdBy: z.string().nullable(),
        lastUsedAt: z.number().nullable(),
        revokedAt: z.number().nullable(),
        previousExpiresAt: z.number().nullable(),
      }),
    ),
  }),
  revoke_integration: actionOutput,
  get_ucp_settings: row({
    settings: row({
      checkoutFlowId: z.string().nullable().describe('The flow checkouts start; null while off'),
      links: z.array(row({ type: z.string(), url: z.string(), title: z.string().optional() })),
      orderUrl: z.string().nullable(),
    }),
    platforms: z.array(
      row({
        id: z.string(),
        name: z.string(),
        profileUrl: z.string(),
        keyPrefix: z.string().describe('The key’s first characters, to tell keys apart'),
        createdAt: z.number(),
        createdBy: z.string().nullable(),
        lastUsedAt: z.number().nullable(),
        revokedAt: z.number().nullable(),
      }),
    ),
  }),
  set_ucp_settings: actionOutput,
  revoke_ucp_platform: actionOutput,
  list_fx_rates: row({
    base: z.string().describe('The base currency every rate is per one of'),
    rates: z.array(
      row({
        currency: z.string(),
        rate: z.number().nullable().describe('Null while the deployment names it but has no rate'),
        updatedAt: z.number().nullable(),
        source: z.enum(FX_SOURCES).nullable().describe('ecb is the daily refresh'),
        updatedBy: z.string().nullable().describe('Who, for a person’s rate'),
      }),
    ),
  }),
  set_fx_rate: actionOutput,
  list_companies: row({
    companies: z.array(companyOutput),
    total: z.number().describe('Every company the filters match'),
    cursor: z.string().nullable().describe('Pass it back for the next page; null at the end'),
  }),
  get_company: row({
    company: companyOutput,
    teams: z.array(
      row({ id: z.string(), parentId: z.string().nullable(), name: z.string(), path: z.string() }),
    ),
  }),
  list_company_members: row({
    members: z.array(memberOutput),
    total: z.number().describe('Every member the filters match'),
    cursor: z.string().nullable().describe('Pass it back for the next page; null at the end'),
  }),
  create_customer: actionOutput,
  update_customer: actionOutput,
  set_company_status: actionOutput,
  put_company_members: actionOutput,
  remove_company_member: actionOutput,
  put_company_team: actionOutput,
  list_price_books: row({
    books: z.array(priceBookOutput),
    total: z.number().describe('Books with this status, across every page'),
    next: z.string().nullable().describe('Pass as after for the next page; null at the end'),
  }),
  get_price_book: row({
    book: priceBookOutput,
    assignments: z.array(
      row({
        customerId: z.string().nullable(),
        tier: z.string().nullable(),
        createdAt: z.number(),
      }),
    ),
    entries: z.array(
      row({
        sku: z.string(),
        minQty: z.number(),
        price: z.number().nullable(),
        discountPct: z.number().nullable(),
      }),
    ),
    entryTotal: z.number(),
    next: z.string().nullable(),
  }),
  preview_price: row({
    customerId: z.string().nullable(),
    tier: z.string().nullable(),
    currency: z.string().describe('The base currency every price is in'),
    lines: z.array(
      row({
        sku: z.string(),
        qty: z.number(),
        listPrice: z.number().nullable().describe('Null for a SKU with no product'),
        unitPrice: z.number(),
        source: z.string().describe('price_book, contract, volume or list'),
        name: z.string().describe('The book’s name for a book price'),
        bookId: z.string().nullable(),
      }),
    ),
  }),
  create_price_book: actionOutput.extend({ id: z.string().optional() }),
  set_price_book_status: actionOutput,
  put_price_book_entries: actionOutput,
  assign_price_book: actionOutput,
  put_contract_prices: actionOutput,
  list_budgets: row({
    budgets: z.array(budgetOutput),
    total: z.number().describe('Every budget the filters match'),
    cursor: z.string().nullable().describe('Pass it back for the next page; null at the end'),
  }),
  list_budget_spend: row({
    entries: z.array(
      row({
        id: z.string(),
        orderId: z.string(),
        amount: z
          .number()
          .describe(
            'Base currency, as committed; a given-back commit keeps its amount and reads status reversed',
          ),
        windowStart: z.number().describe('The window it counts in (ms, UTC)'),
        at: z.number().describe('When it was recorded (ms, UTC)'),
        status: z.enum(['committed', 'reversed']),
      }),
    ),
    total: z.number().describe('Every entry the budget has'),
    cursor: z.string().nullable().describe('Pass it back for the next page; null at the end'),
  }),
  put_budget: actionOutput,
  set_budget_status: actionOutput,
  list_purchase_orders: row({
    purchaseOrders: z.array(purchaseOrderOutput),
    total: z.number().describe('Every purchase order the filters match'),
    cursor: z.string().nullable().describe('Pass it back for the next page; null at the end'),
  }),
  get_purchase_order: row({ purchaseOrder: purchaseOrderOutput }),
  create_po_draft: row({
    done: z.string().describe('What happened'),
    href: z.string(),
    purchaseOrder: purchaseOrderOutput,
  }),
  update_po_draft: row({
    done: z.string().describe('What happened'),
    href: z.string(),
    purchaseOrder: purchaseOrderOutput,
  }),
  submit_po: actionOutput,
  cancel_po: actionOutput,
  list_quotes: row({
    quotes: z.array(quoteOutput),
    total: z.number().describe('Every quote the filters match'),
    cursor: z.string().nullable().describe('Pass it back for the next page; null at the end'),
  }),
  get_quote: row({ quote: quoteOutput }),
  create_quote: row({
    done: z.string().describe('What happened'),
    href: z.string(),
    quote: quoteOutput,
  }),
  update_quote: row({
    done: z.string().describe('What happened'),
    href: z.string(),
    quote: quoteOutput,
  }),
  revise_quote: row({
    done: z.string().describe('What happened'),
    href: z.string(),
    quote: quoteOutput,
  }),
  send_quote: actionOutput,
  accept_quote: actionOutput,
  decline_quote: actionOutput,
  expire_quote: actionOutput,
  convert_quote: actionOutput,
  set_promotion_status: actionOutput,
  verify_tax_certificate: actionOutput,
  revoke_tax_certificate: actionOutput,
  get_credit_account: row({
    customerId: z.string(),
    limit: z.number(),
    balance: z.number(),
    held: z.number().describe('What open orders have claimed of the limit'),
    available: z.number().describe('The limit less the balance and what is held'),
    currency: z.string(),
    entries: z.array(
      row({
        id: z.string(),
        at: z.number(),
        kind: z.enum(CREDIT_ENTRY_KINDS),
        orderId: z.string().nullable(),
        amount: z.number().describe('Positive adds to what is owed'),
        balanceAfter: z.number(),
        reference: z.string().nullable(),
        note: z.string().nullable(),
      }),
    ),
    next: z.string().nullable().describe('Pass as after for the earlier entries; null at the end'),
  }),
  set_credit_limit: actionOutput,
  adjust_credit: actionOutput,
} satisfies Record<AssistantTool, z.ZodObject>;

/**
 * The workspace tools the REST API may run (`EngineRpc.runOperation`), checked by the engine as
 * well as the web app's route table. A flow's publish and test name the draft their caller read
 * (`DRAFT_BOUND_TOOLS`).
 */
export const REST_OPERATION_TOOLS = [
  'needs_attention',
  'restart_order',
  'decide_approvals',
  'get_flow',
  'create_flow',
  'duplicate_flow',
  'archive_flow',
  'create_promotion',
  'set_promotion_status',
  'list_price_books',
  'get_price_book',
  'preview_price',
  'create_price_book',
  'set_price_book_status',
  'put_price_book_entries',
  'assign_price_book',
  'put_contract_prices',
  'list_fx_rates',
  'set_fx_rate',
  'verify_tax_certificate',
  'revoke_tax_certificate',
  'list_companies',
  'get_company',
  'list_company_members',
  'create_customer',
  'update_customer',
  'set_company_status',
  'put_company_members',
  'remove_company_member',
  'put_company_team',
  'get_credit_account',
  'set_credit_limit',
  'adjust_credit',
  'list_budgets',
  'list_budget_spend',
  'put_budget',
  'set_budget_status',
  'list_purchase_orders',
  'get_purchase_order',
  'create_po_draft',
  'update_po_draft',
  'submit_po',
  'cancel_po',
  'list_quotes',
  'get_quote',
  'create_quote',
  'update_quote',
  'send_quote',
  'accept_quote',
  'decline_quote',
  'revise_quote',
  'expire_quote',
  'convert_quote',
  'run_stock_review',
  'find_products',
  'assess_order',
  'propose_flow_change',
  'draft_plugin',
  'publish_flow',
  'test_flow',
] as const satisfies readonly AssistantTool[];

/** REST operations held to the flow draft their caller read (`draft`, from `get_flow`). */
export const DRAFT_BOUND_TOOLS: readonly RestOperationTool[] = ['publish_flow', 'test_flow'];

/** Why a publish or test over REST needs `draft`. */
export const NAME_THE_DRAFT =
  "Name the draft you read: send get_flow's draft, so a later edit isn't published in its place.";
export type RestOperationTool = (typeof REST_OPERATION_TOOLS)[number];

export const isRestOperationTool = (name: string): name is RestOperationTool =>
  (REST_OPERATION_TOOLS as readonly string[]).includes(name);

/** Why a token can't run a tool a person always confirms (`PERSON_CONFIRMS_TOOLS`). */
export const PERSON_CONFIRMS =
  'A person signed in as themselves does this, never an API token: it changes what buyers pay or owe.';

/**
 * The call a REST operation's actor is signed for: the tool and exactly the input it was signed
 * with, so a signed actor works for that one call and nothing else.
 */
export async function operationCall(tool: string, input: unknown): Promise<string> {
  return `operation:${tool}:${await fingerprintOf(input ?? {})}`;
}
