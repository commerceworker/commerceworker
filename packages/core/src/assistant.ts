/**
 * The workspace assistant's contract between the engine's AssistantAgent and the web app's panel.
 * One assistant per person; the page they are on travels with each message as its context.
 */

import type { GraphIssue } from './graph';
import type { Role } from './roles';
import type { FlowGraph } from './types';

/** What the assistant is looking at: everything, or the order, flow or cart open on the page. */
export type AssistantContext =
  | { kind: 'workspace' }
  | {
      kind: 'order';
      id: string;
      label: string;
      /** Whether it waits on an approval, so the panel only suggests asking about one then. */
      awaitingApproval?: boolean;
    }
  | {
      kind: 'flow';
      id: string;
      label: string;
      /** The editor's graph, unsaved changes included, so a proposal builds on what is on screen. */
      graph?: FlowGraph;
      model?: string;
    }
  | {
      kind: 'cart';
      id: string;
      /** The cart's id, never its title: a title is people's words. */
      label: string;
    };

/** What is waiting on a person, for the line at the top of the panel. */
export type Attention = {
  approvals: {
    id: string;
    orderId: string;
    nodeId: string;
    title: string;
    amount: number | null;
    requestedAt: number;
  }[];
  /** Orders that failed or rolled back recently. */
  failed: { id: string; title: string; status: string; updatedAt: number }[];
  /**
   * Orders waiting on an event for longer than a day, measured from when the current wait opened
   * (`waitingSince`; an order indexed before that was recorded falls back to `updatedAt`).
   */
  stalled: {
    id: string;
    title: string;
    waitingOn: string | null;
    waitingSince: number | null;
    updatedAt: number;
  }[];
  /** Totals; the lists above are capped. */
  counts: { approvals: number; failed: number; stalled: number };
};

export type AssistantTool =
  | 'whoami'
  | 'needs_attention'
  | 'find_orders'
  | 'get_order'
  | 'assess_order'
  | 'find_products'
  | 'list_carts'
  | 'get_cart'
  | 'list_flows'
  | 'get_flow'
  | 'propose_flow_change'
  | 'draft_plugin'
  | 'draft_product_content'
  | 'get_product'
  | 'find_product_by_alias'
  | 'get_product_sheet'
  | 'list_product_types'
  | 'list_catalog_channels'
  | 'list_categories'
  | 'list_catalog_feeds'
  | 'get_catalog_feed'
  | 'catalog_board'
  | 'catalog_board_column'
  | 'create_cart'
  | 'change_cart'
  | 'decide_approval'
  | 'decide_approvals'
  | 'deliver_event'
  | 'cancel_order'
  | 'record_return'
  | 'submit_cart'
  | 'publish_flow'
  | 'run_stock_review'
  | 'start_order'
  | 'restart_order'
  | 'start_scenario'
  | 'cancel_cart'
  | 'save_flow_draft'
  | 'create_flow'
  | 'duplicate_flow'
  | 'archive_flow'
  | 'test_flow'
  | 'stage_product_edits'
  | 'accept_product_drafts'
  | 'discard_product_edits'
  | 'publish_catalog'
  | 'put_catalog_products'
  | 'delete_catalog_products'
  | 'put_catalog_type'
  | 'delete_catalog_type'
  | 'put_catalog_channel'
  | 'delete_catalog_channel'
  | 'put_catalog_categories'
  | 'delete_catalog_categories'
  | 'start_catalog_feed'
  | 'cancel_catalog_feed'
  | 'reindex_catalog'
  | 'rebuild_catalog_gaps'
  | 'create_promotion'
  | 'set_promotion_status'
  | 'list_price_books'
  | 'get_price_book'
  | 'preview_price'
  | 'create_price_book'
  | 'set_price_book_status'
  | 'put_price_book_entries'
  | 'assign_price_book'
  | 'put_contract_prices'
  | 'list_fx_rates'
  | 'set_fx_rate'
  | 'verify_tax_certificate'
  | 'revoke_tax_certificate'
  | 'list_companies'
  | 'get_company'
  | 'list_company_members'
  | 'create_customer'
  | 'update_customer'
  | 'set_company_status'
  | 'put_company_members'
  | 'remove_company_member'
  | 'put_company_team'
  | 'get_credit_account'
  | 'set_credit_limit'
  | 'adjust_credit'
  | 'list_budgets'
  | 'list_budget_spend'
  | 'put_budget'
  | 'set_budget_status'
  | 'list_purchase_orders'
  | 'get_purchase_order'
  | 'create_po_draft'
  | 'update_po_draft'
  | 'submit_po'
  | 'cancel_po'
  | 'list_quotes'
  | 'get_quote'
  | 'create_quote'
  | 'update_quote'
  | 'send_quote'
  | 'accept_quote'
  | 'decline_quote'
  | 'revise_quote'
  | 'expire_quote'
  | 'convert_quote'
  | 'set_member_role'
  | 'set_approval_separation'
  | 'set_plugin_enabled'
  | 'approve_plugin'
  | 'rollback_plugin'
  | 'uninstall_plugin'
  | 'run_plugin_cases'
  | 'list_audit_events'
  | 'verify_audit_trail'
  | 'list_plugins'
  | 'get_plugin_usage'
  | 'list_webhook_subscriptions'
  | 'list_webhook_deliveries'
  | 'delete_webhook_subscription'
  | 'list_integrations'
  | 'revoke_integration'
  | 'get_ucp_settings'
  | 'set_ucp_settings'
  | 'revoke_ucp_platform'
  | 'draft_cart_reply'
  | 'set_assistant_routing';

/**
 * Who may use each tool, and which ones stop for a person to confirm. Reads and drafts run
 * directly; anything that decides, moves money, cancels or publishes waits for a confirm. A tool
 * the caller's role can't use is never offered to the model, and is refused if called anyway.
 *
 * The same tools are served over MCP (`/mcp`): `title` and `description` are what an MCP client
 * shows, and `label` is the assistant panel's chip for a call.
 */
export const ASSISTANT_TOOLS: Record<
  AssistantTool,
  { role: Role; confirm: boolean; label: string; title: string; description: string }
> = {
  whoami: {
    role: 'viewer',
    confirm: false,
    label: 'Checked who is connected',
    title: 'Who am I',
    description:
      'The credential this call uses: how it signed in (an API token, an OAuth grant or a session), its role, the resource it was granted for and when it expires, and who it acts as. Never a secret.',
  },
  needs_attention: {
    role: 'viewer',
    confirm: false,
    label: 'Checked what needs attention',
    title: 'Needs attention',
    description:
      'What is waiting on people: open approvals (oldest first), orders that failed or rolled back in the last 3 days, and orders waiting on a business event for over a day.',
  },
  find_orders: {
    role: 'viewer',
    confirm: false,
    label: 'Searched orders',
    title: 'Find orders',
    description:
      'Search orders. Totals compare in USD. Returns the count and total of all matches plus up to `limit` rows.',
  },
  get_order: {
    role: 'viewer',
    confirm: false,
    label: 'Read the order',
    title: 'Get an order',
    description:
      'One order: status, what it waits on (with where each decision leads), steps run so far and recent activity.',
  },
  assess_order: {
    role: 'viewer',
    confirm: false,
    label: 'Assessed the order',
    title: 'Assess an order',
    description:
      'Ask typed questions about one order and get a probability for every option: noul (yes/no, the probability of yes), choice (pick one of 2–255 options) or score (an ordered rubric of 2–10 levels, lowest first). Optionally pass up to 4 images (the order’s R2 document keys, https or data URLs; PNG, JPEG or WebP).',
  },
  find_products: {
    role: 'viewer',
    confirm: false,
    label: 'Looked up stock',
    title: 'Find products',
    description: 'Products with stock, reserved and available quantities and reorder points.',
  },
  list_carts: {
    role: 'viewer',
    confirm: false,
    label: 'Listed carts',
    title: 'List carts',
    description:
      'Carts people are building before they become orders, most recently changed first: title, status, customer and, once submitted, its order.',
  },
  get_cart: {
    role: 'viewer',
    confirm: false,
    label: 'Read the cart',
    title: 'Get a cart',
    description:
      'One cart: its lines (with each line’s id) at the prices its flow quoted, promo codes, problems the quote found, and why it can’t be submitted yet.',
  },
  list_flows: {
    role: 'viewer',
    confirm: false,
    label: 'Listed flows',
    title: 'List flows',
    description: 'All flows and their published versions.',
  },
  get_flow: {
    role: 'viewer',
    confirm: false,
    label: 'Read the flow',
    title: 'Get a flow',
    description: 'A flow’s saved draft: its steps, connections and validation problems.',
  },
  propose_flow_change: {
    role: 'operator',
    confirm: false,
    label: 'Drafted a flow change',
    title: 'Propose a flow change',
    description:
      'Draft a change to a flow from an instruction. Nothing is saved: a person reviews the proposal in the flow editor and applies it there.',
  },
  draft_plugin: {
    role: 'admin',
    confirm: false,
    label: 'Drafted a plugin',
    title: 'Draft a business-rule plugin',
    description:
      'Draft a plugin of business-rule flow steps from an instruction (e.g. “hold orders over $5,000 shipping outside the US”), with test cases. Nothing runs: an admin reviews it on the Plugins page, runs its cases and approves it there. Give pluginId to revise a drafted plugin.',
  },
  draft_product_content: {
    role: 'operator',
    confirm: false,
    label: 'Drafted product content',
    title: 'Draft product content',
    description:
      'Draft a catalog product’s missing text (titles, descriptions, text attributes and image alt text, locale by locale) from what it says in its other locales. Name fields and locales to draft those instead. The drafts are saved on the product; nothing goes live until a person accepts and publishes them.',
  },
  get_product: {
    role: 'viewer',
    confirm: false,
    label: 'Read a product',
    title: 'Get a catalog product',
    description:
      'A catalog product as stored: its type, titles and descriptions by locale, attributes, media, variants and per-channel listing data. Use find_product_by_alias for a SKU, GTIN or slug.',
  },
  find_product_by_alias: {
    role: 'viewer',
    confirm: false,
    label: 'Found a product',
    title: 'Find a catalog product by SKU, GTIN or slug',
    description:
      'The key of the catalog product that holds an alias: sku:ABC, gtin:… or slug:en:… (a slug names its locale). Pass the key to get_product.',
  },
  get_product_sheet: {
    role: 'viewer',
    confirm: false,
    label: 'Read a product sheet',
    title: 'Get a product’s sheet',
    description:
      'A catalog product’s editing sheet: the live and feed versions, overrides, staged edits, assistant drafts, content gaps, the feed row the catalog refused, and its history.',
  },
  list_product_types: {
    role: 'viewer',
    confirm: false,
    label: 'Read product types',
    title: 'List product types',
    description: 'The latest version of each catalog product type: its fields and attributes.',
  },
  list_catalog_channels: {
    role: 'viewer',
    confirm: false,
    label: 'Read channels',
    title: 'List catalog channels',
    description:
      'The catalog’s channels: where products are published, with their currencies and locales.',
  },
  list_categories: {
    role: 'viewer',
    confirm: false,
    label: 'Read categories',
    title: 'List catalog categories',
    description: 'The catalog’s categories, each with its code, names and parent.',
  },
  list_catalog_feeds: {
    role: 'viewer',
    confirm: false,
    label: 'Read feeds',
    title: 'List catalog feeds',
    description: 'The most recent product feeds, newest first, with their state and counts.',
  },
  get_catalog_feed: {
    role: 'viewer',
    confirm: false,
    label: 'Read a feed',
    title: 'Get a catalog feed',
    description:
      'One product feed’s state: how far it has got, what it wrote, and what it refused.',
  },
  catalog_board: {
    role: 'viewer',
    confirm: false,
    label: 'Read the catalog board',
    title: 'Get the catalog board',
    description:
      'The product editor’s board: products per column (gaps, drafted, staged, published), gaps per kind, and the latest and the running feed. Use catalog_board_column for a column’s products.',
  },
  catalog_board_column: {
    role: 'viewer',
    confirm: false,
    label: 'Read a board column',
    title: 'List a catalog board column',
    description:
      'One board column’s products in key order, a page at a time: pass the cursor a page returned for the next. Narrow the gaps column to one kind of gap.',
  },
  create_cart: {
    role: 'operator',
    confirm: false,
    label: 'Opened a cart',
    title: 'Open a cart',
    description:
      'Open a cart priced by a published flow that prices orders, for a customer if given. Nothing is ordered until the cart is submitted.',
  },
  change_cart: {
    role: 'operator',
    confirm: false,
    label: 'Changed the cart',
    title: 'Change a cart',
    description:
      'Change an open cart, op by op in order: add a SKU, set a line’s quantity (0 removes it), set several lines’ quantities in one change (set_qtys, all or none), remove lines, clear it, add or remove a promo code, set or clear the ship-to address, choose a shipping option from the quote, lock, unlock or rename it. The cart’s flow prices it again; nothing is ordered.',
  },
  decide_approval: {
    role: 'approver',
    confirm: true,
    label: 'Decide an approval',
    title: 'Decide an approval',
    description:
      'Approve or reject an approval an order is waiting on. Where several people vote, this records one vote (the answer says how many so far) and the order moves on once the vote is decided; staff record a company member’s vote with onBehalfOf.',
  },
  decide_approvals: {
    role: 'approver',
    confirm: true,
    label: 'Decide approvals',
    title: 'Decide several approvals',
    description:
      'Approve or reject up to 25 open approvals at once, with one note for all (and one onBehalfOf member, for company approvals). Each is checked and decided on its own; one that can’t be decided is skipped and says why, and one that needs more votes records this one.',
  },
  deliver_event: {
    role: 'operator',
    confirm: true,
    label: 'Deliver an event',
    title: 'Deliver an event',
    description: 'Deliver a business event (e.g. payment.received) to the order waiting for it.',
  },
  cancel_order: {
    role: 'operator',
    confirm: true,
    label: 'Cancel an order',
    title: 'Cancel an order',
    description:
      'Cancel an order and undo what it did (release stock, void payment, cancel shipments).',
  },
  record_return: {
    role: 'operator',
    confirm: true,
    label: 'Record a return or claim',
    title: 'Record a return or claim',
    description:
      'Record a return or claim on an order waiting for one: the reason, the items and quantities, and optionally the amount to refund.',
  },
  submit_cart: {
    role: 'operator',
    confirm: true,
    label: 'Submit a cart',
    title: 'Submit a cart',
    description:
      'Submit a priced cart as an order of its flow, with its lines, customer and promo codes. The order is priced again by its flow when it runs, as any order is. The cart ends.',
  },
  publish_flow: {
    role: 'operator',
    confirm: true,
    label: 'Publish a flow',
    title: 'Publish a flow',
    description: 'Publish a flow’s saved draft as a new version.',
  },
  run_stock_review: {
    role: 'operator',
    confirm: true,
    label: 'Run the stock review',
    title: 'Run the stock review',
    description:
      'Run the daily stock review now; it starts reorders for SKUs at or below their reorder point.',
  },
  start_order: {
    role: 'operator',
    confirm: true,
    label: 'Start an order',
    title: 'Start an order',
    description:
      'Start a new order on a published flow: its lines (SKU and quantity), and optionally a customer or a guest contact, fulfilment (pickup and carry-out need a store), currency, title and document text for the flow to read. It runs the flow for real.',
  },
  restart_order: {
    role: 'operator',
    confirm: true,
    label: 'Restart an order',
    title: 'Restart an order',
    description:
      'Start a fresh order like an existing one: same customer, lines and fulfilment, on its flow’s current version. The old order stays as it is.',
  },
  start_scenario: {
    role: 'operator',
    // Fixed demo data, only where it is loaded, and only from its button (`PAGE_ONLY_TOOLS`).
    confirm: false,
    label: 'Ran a demo scenario',
    title: 'Run a demo scenario',
    description:
      'Start one of the workspace’s demo scenario orders by its id. Only where the demo data is loaded.',
  },
  cancel_cart: {
    role: 'operator',
    confirm: true,
    label: 'Cancel a cart',
    title: 'Cancel a cart',
    description: 'Cancel an open or locked cart. Nothing is ordered, and the cart ends.',
  },
  save_flow_draft: {
    role: 'operator',
    // The editor's Save, and only it (`PAGE_ONLY_TOOLS`): it overwrites the draft.
    confirm: false,
    label: 'Saved the draft',
    title: 'Save a flow draft',
    description: 'Save a flow’s draft as the editor shows it. Nothing runs until it is published.',
  },
  create_flow: {
    role: 'operator',
    confirm: false,
    label: 'Created a flow',
    title: 'Create a flow',
    description:
      'Create a new, unpublished flow for a commerce model: from its template, a blank start, or drafted from a description of the steps. Nothing runs until it is published.',
  },
  duplicate_flow: {
    role: 'operator',
    confirm: false,
    label: 'Duplicated a flow',
    title: 'Duplicate a flow',
    description: 'Copy a flow’s current draft as a new, unpublished flow.',
  },
  archive_flow: {
    role: 'operator',
    confirm: false,
    label: 'Archived a flow',
    title: 'Archive or restore a flow',
    description:
      'Archive (or restore) a draft that was never published, so it leaves the flows list. Published flows can’t be archived.',
  },
  test_flow: {
    role: 'operator',
    confirm: true,
    label: 'Test a flow',
    title: 'Test a flow',
    description:
      'Run a test order on a flow: publishes its saved draft first when it changed since the live version, then starts an order with a demo input where the demo data is loaded.',
  },
  // Staging and discarding change only what waits to publish, so they run at once, from the
  // Catalog page's buttons and over MCP. Accepting a draft is the page's own (`PAGE_ONLY_TOOLS`).
  stage_product_edits: {
    role: 'operator',
    confirm: false,
    label: 'Staged catalog edits',
    title: 'Stage product edits',
    description: 'Stage edits to products’ fields; nothing is live until published.',
  },
  accept_product_drafts: {
    role: 'operator',
    // The page's own button (`PAGE_ONLY_TOOLS`): a person accepts what the assistant drafted.
    confirm: false,
    label: 'Accepted the drafts',
    title: 'Accept a product’s drafts',
    description: 'Stage the assistant’s drafts for a product, as the assistant’s text.',
  },
  discard_product_edits: {
    role: 'operator',
    confirm: false,
    label: 'Discarded catalog edits',
    title: 'Discard staged edits or drafts',
    description: 'Drop staged edits or the assistant’s drafts, for one field or a whole product.',
  },
  publish_catalog: {
    role: 'operator',
    confirm: true,
    label: 'Publish catalog edits',
    title: 'Publish catalog edits',
    description:
      'Publish the staged edits of up to 500 products to the live catalog, each product all or none.',
  },
  put_catalog_products: {
    role: 'operator',
    confirm: true,
    label: 'Write catalog products',
    title: 'Write catalog products',
    description:
      'Create or update up to 500 products. This writes the live catalog, not a draft: a stored product publishes to the storefront and feeds within the minute, and a field a person edited keeps their text and becomes a conflict. Unchanged products write nothing.',
  },
  delete_catalog_products: {
    role: 'operator',
    confirm: true,
    label: 'Delete catalog products',
    title: 'Delete catalog products',
    description: 'Delete up to 500 products by key and take them off the storefront and the feeds.',
  },
  put_catalog_type: {
    role: 'operator',
    confirm: false,
    label: 'Saved a product type',
    title: 'Save a product type',
    description:
      'Add a product type, or its next version. A new version may only add to the type. Nothing is published until products use it.',
  },
  delete_catalog_type: {
    role: 'operator',
    confirm: true,
    label: 'Delete a product type',
    title: 'Delete a product type',
    description:
      'Remove every version of a product type. The catalog refuses while any product uses it.',
  },
  put_catalog_channel: {
    role: 'operator',
    confirm: false,
    label: 'Saved a channel',
    title: 'Save a catalog channel',
    description:
      'Add or change a channel: where products are published, with its currency and locales. A changed currency or locale list reaches published documents on the next reindex.',
  },
  delete_catalog_channel: {
    role: 'admin',
    confirm: true,
    label: 'Delete a channel',
    title: 'Delete a catalog channel',
    description:
      'Remove a channel and take down everything published in it. Products keep their listing data for it.',
  },
  put_catalog_categories: {
    role: 'operator',
    confirm: true,
    label: 'Write categories',
    title: 'Write catalog categories',
    description:
      'Add or change up to 500 categories. The category tree is republished live once for the call.',
  },
  delete_catalog_categories: {
    role: 'operator',
    confirm: true,
    label: 'Delete categories',
    title: 'Delete catalog categories',
    description:
      'Remove categories. The catalog refuses while one has children outside the set or products in it.',
  },
  start_catalog_feed: {
    role: 'operator',
    confirm: true,
    label: 'Start a catalog feed',
    title: 'Start a catalog feed',
    description:
      'Import products from a CSV or NDJSON file given as text (up to 256 KiB; larger files go to the REST API). The feed writes the live catalog: each product it stores publishes within the minute.',
  },
  cancel_catalog_feed: {
    role: 'operator',
    confirm: true,
    label: 'Cancel a feed',
    title: 'Cancel a catalog feed',
    description:
      'Stop a feed that has not finished. Parts already handed to the catalog still apply, so some products may have been written.',
  },
  reindex_catalog: {
    role: 'admin',
    confirm: true,
    label: 'Reindex the catalog',
    title: 'Reindex the catalog',
    description:
      'Republish every product, after a document format, channel or renderer change. It queues work for every shard and publisher.',
  },
  rebuild_catalog_gaps: {
    role: 'admin',
    confirm: true,
    label: 'Rebuild catalog gaps',
    title: 'Rebuild the catalog’s gap index',
    description:
      'Recount every product’s content gaps, after a channel’s locales change or to build the index for older products. It reads every product.',
  },
  create_promotion: {
    role: 'operator',
    confirm: true,
    label: 'Add a promotion',
    title: 'Add a promotion',
    description:
      'Add a promotion: a code buyers and staff enter on carts and at checkout, or an automatic one (no code, named) that applies to any order it fits. A percentage or amount off, free shipping, or buy X get Y (buy a quantity of some SKUs, get a quantity of the same or other SKUs free or at a percentage off, the cheapest units first), optionally limited by subtotal, SKUs, customer, end date and uses, capped per order, with a priority and exclusive or stackable combining. Active at once.',
  },
  set_promotion_status: {
    role: 'operator',
    confirm: true,
    label: 'Pause or reactivate a promotion',
    title: 'Pause or reactivate a promotion',
    description: 'Pause a promotion code so carts stop accepting it, or reactivate it.',
  },
  list_price_books: {
    role: 'viewer',
    confirm: false,
    label: 'Listed price books',
    title: 'List price books',
    description:
      'Price books by code, with their priority, status and dates, and how many books have each status. A book is in force only while it is active and inside its dates. Pass `next` back as `after` for the next page.',
  },
  get_price_book: {
    role: 'viewer',
    confirm: false,
    label: 'Read the price book',
    title: 'Get a price book',
    description:
      'One price book (by id or code): its status, dates and priority, who it is assigned to (customers and tiers), and its entries a page at a time, by SKU and quantity.',
  },
  preview_price: {
    role: 'viewer',
    confirm: false,
    label: 'Previewed prices',
    title: 'Preview prices',
    description:
      'What a customer would pay for some SKUs and quantities right now, in the base currency (USD), and what priced each line: a price book (named), a contract price, a volume tier or the list price. Leave the customer out for an anonymous buyer. Nothing is written.',
  },
  create_price_book: {
    role: 'operator',
    confirm: true,
    label: 'Add a price book',
    title: 'Add a price book',
    description:
      'Add a price book in draft: a code, a name, a priority (the higher wins among assigned books) and optional dates. It prices nothing until it has entries, is assigned and is made active.',
  },
  set_price_book_status: {
    role: 'operator',
    confirm: true,
    label: 'Change a price book’s status',
    title: 'Activate, deactivate or archive a price book',
    description:
      'Move a price book along draft → active ⇄ inactive → archived (a draft can be archived too). Activating puts its prices in force for the customers and tiers it is assigned to, inside its dates; deactivating takes them out. Archiving is for good.',
  },
  put_price_book_entries: {
    role: 'operator',
    confirm: true,
    label: 'Set price book entries',
    title: 'Set a price book’s entries',
    description:
      'Add, replace or remove up to 200 entries in a price book: a SKU at a quantity and up (volume tiers), with a unit price in USD or a percent off list. An entry for the same SKU and quantity is replaced. Prices change at once for customers the book is in force for.',
  },
  assign_price_book: {
    role: 'operator',
    confirm: true,
    label: 'Assign a price book',
    title: 'Assign a price book',
    description:
      'Assign a price book to one customer, or to every customer of a tier, or take an assignment away. Customers pay its prices while it is in force; where several books price a line the highest priority wins, then the lowest price in it.',
  },
  put_contract_prices: {
    role: 'operator',
    confirm: true,
    label: 'Set contract prices',
    title: 'Set a customer’s contract prices',
    description:
      'Set, change or remove (price null) a customer’s contract prices, a unit price in USD per SKU. They price that customer’s orders from now on, ahead of price books at the chain’s own priority.',
  },
  list_fx_rates: {
    role: 'operator',
    confirm: false,
    label: 'Listed exchange rates',
    title: 'List exchange rates',
    description:
      'Each currency’s exchange rate (units per one USD, the base currency): when it was set and by whom, the daily ECB refresh or a person. A currency the deployment names but has no rate for yet shows with none.',
  },
  set_fx_rate: {
    role: 'admin',
    confirm: true,
    label: 'Set an exchange rate',
    title: 'Set an exchange rate',
    description:
      'Set a currency’s rate, in units per one USD. It changes what buyers pay in that currency from now on; orders already priced keep their rate. The next daily ECB refresh replaces it for a currency the deployment refreshes. A change of 10% or more is flagged.',
  },
  verify_tax_certificate: {
    role: 'operator',
    confirm: true,
    label: 'Verify a tax certificate',
    title: 'Verify a tax exemption certificate',
    description:
      'Verify a customer’s tax exemption certificate, so orders they start from now are exempt in its regions. With approval separation on, whoever added it can’t verify it.',
  },
  revoke_tax_certificate: {
    role: 'operator',
    confirm: true,
    label: 'Revoke a tax certificate',
    title: 'Revoke a tax exemption certificate',
    description:
      'Revoke a customer’s tax exemption certificate, so their new orders are taxed again.',
  },
  list_companies: {
    role: 'operator',
    confirm: false,
    label: 'Listed companies',
    title: 'List companies',
    description:
      'Business customers’ companies, a page at a time by name: status, legal name, tax id and parent company. Narrow by status or a search of the name; pass the cursor a page returned for the next.',
  },
  get_company: {
    role: 'operator',
    confirm: false,
    label: 'Read a company',
    title: 'Get a company',
    description: 'One company: its status, legal name, tax id, parent and its team tree.',
  },
  list_company_members: {
    role: 'operator',
    confirm: false,
    label: 'Listed company members',
    title: 'List a company’s members',
    description:
      'A company’s members a page at a time by name: role, team, status and their own order limit. Narrow by status, role or team. Names and emails are personal data.',
  },
  create_customer: {
    role: 'operator',
    confirm: true,
    label: 'Add a customer',
    title: 'Add a customer',
    description:
      'Add a customer: a business customer (which also gets its company, active at once), a consumer or an internal account. It starts with no credit limit.',
  },
  update_customer: {
    role: 'operator',
    confirm: true,
    label: 'Change a customer',
    title: 'Change a customer',
    description:
      'Change a customer’s name, email, kind, pricing tier or payment terms. A new kind or tier applies to orders from now on; orders already priced keep their price. The credit limit isn’t changed here.',
  },
  set_company_status: {
    role: 'operator',
    confirm: true,
    label: 'Change a company’s status',
    title: 'Change a company’s status',
    description:
      'Move a company along its lifecycle: approve or reject a pending one, suspend or reinstate an active one, or close it for good. Orders from a company that is not active are declined.',
  },
  put_company_members: {
    role: 'operator',
    confirm: true,
    label: 'Add or change members',
    title: 'Add or change a company’s members',
    description:
      'Add up to 100 members by email, or change those already there (name, role, team, order limit, active or inactive). An email already a member of the company is changed rather than added twice.',
  },
  remove_company_member: {
    role: 'operator',
    confirm: true,
    label: 'Remove a member',
    title: 'Remove a company member',
    description:
      'Remove a member for good: they can no longer be the buyer on an order. Their record stays for the orders they placed.',
  },
  put_company_team: {
    role: 'operator',
    confirm: true,
    label: 'Add or change a team',
    title: 'Add or change a company team',
    description:
      'Add a team to a company, or rename or move one under another team. Teams nest up to six deep.',
  },
  get_credit_account: {
    role: 'viewer',
    confirm: false,
    label: 'Read a credit account',
    title: 'Get a customer’s credit account',
    description:
      'A business customer’s credit: the limit, the balance owed, what open orders hold, what is available, and the ledger of charges, payments, reversals and adjustments, newest first with the balance after each. Page back with after (the `next` of the last page).',
  },
  set_credit_limit: {
    role: 'admin',
    confirm: true,
    label: 'Set a credit limit',
    title: 'Set a customer’s credit limit',
    description:
      'Set a business customer’s credit limit, in the base currency. It decides what they can order on account from now on; orders already holding credit keep it. A limit under what is owed and held blocks new orders until it is paid down.',
  },
  adjust_credit: {
    role: 'admin',
    confirm: true,
    label: 'Adjust a credit balance',
    title: 'Adjust a customer’s balance',
    description:
      'Record a credit memo or a payment received off the platform (a negative amount, lowering what is owed) or a debit (positive), with a reason. It is an immutable ledger entry; undo one with another adjustment.',
  },
  list_budgets: {
    role: 'viewer',
    confirm: false,
    label: 'Listed budgets',
    title: 'List a company’s budgets',
    description:
      'A company’s budgets a page at a time by name: amount, period, strict or advisory, team and status, each with what its current window has spent and what is left. Narrow by team or status; pass the cursor a page returned for the next.',
  },
  list_budget_spend: {
    role: 'viewer',
    confirm: false,
    label: 'Listed a budget’s spend',
    title: 'List a budget’s spend',
    description:
      'A budget’s spend ledger, newest first: each order’s commit with its amount and window, and whether it was since reversed. A reversal gives the spend back; the ledger never changes a row. Pass the cursor a page returned for the next.',
  },
  put_budget: {
    role: 'operator',
    confirm: true,
    label: 'Add or change a budget',
    title: 'Add or change a budget',
    description:
      'Add a budget for a company or one of its teams (which also covers the teams under it), or change one’s name, amount or enforcement. A strict budget declines an order that would take it below zero; an advisory one only warns. Budgets count in the base currency, per calendar period.',
  },
  set_budget_status: {
    role: 'operator',
    confirm: true,
    label: 'Change a budget’s status',
    title: 'Pause, resume or archive a budget',
    description:
      'Pause a budget (orders aren’t held to it, and its spend is kept), resume it, or archive it for good.',
  },
  list_purchase_orders: {
    role: 'viewer',
    confirm: false,
    label: 'Listed purchase orders',
    title: 'List purchase orders',
    description:
      'Buyers’ purchase orders, newest first and a page at a time: PO number, company, buyer, status, source and the order each started. Narrow by company, status, buyer, a PO number search, or the dates created; pass the cursor a page returned for the next.',
  },
  get_purchase_order: {
    role: 'viewer',
    confirm: false,
    label: 'Read a purchase order',
    title: 'Get a purchase order',
    description:
      'One purchase order with its lines, ship-to, notes and the order it started, which carries its progress.',
  },
  create_po_draft: {
    role: 'operator',
    confirm: false,
    label: 'Drafted a purchase order',
    title: 'Create a purchase order draft',
    description:
      'Save a draft purchase order for a company: its PO number (unique within the company), lines, ship-to and the member buying. A draft starts nothing; submit_po sends it.',
  },
  update_po_draft: {
    role: 'operator',
    confirm: false,
    label: 'Changed a purchase order draft',
    title: 'Change a purchase order draft',
    description:
      'Change a draft purchase order: any of its number, buyer, ship-to, notes or its whole list of lines. Only a draft can be changed; a submitted one has started an order.',
  },
  submit_po: {
    role: 'operator',
    confirm: true,
    label: 'Submit a purchase order',
    title: 'Submit a purchase order',
    description:
      'Submit a draft purchase order: it starts an order on the B2B purchase order flow (credit, budget and approvals apply), and the PO’s status then follows the order. Submitting again starts nothing new.',
  },
  cancel_po: {
    role: 'operator',
    confirm: true,
    label: 'Cancel a purchase order',
    title: 'Cancel a purchase order',
    description:
      'Cancel a purchase order that hasn’t ended. If its order is running it is cancelled too, giving back its credit hold, budget spend and stock.',
  },
  list_quotes: {
    role: 'viewer',
    confirm: false,
    label: 'Listed quotes',
    title: 'List quotes',
    description:
      'Negotiated quotes, newest first and a page at a time: name, company, version, status, expiry and total. Superseded versions are left out unless you ask for a status or one negotiation’s versions (rootId). Narrow by company, status or a name search; pass the cursor a page returned for the next.',
  },
  get_quote: {
    role: 'viewer',
    confirm: false,
    label: 'Read a quote',
    title: 'Get a quote',
    description:
      'One quote with its lines (SKU, the most it covers, list and quoted price), its expiry, the other versions of the negotiation and what it was converted into.',
  },
  create_quote: {
    role: 'operator',
    confirm: false,
    label: 'Drafted a quote',
    title: 'Create a quote draft',
    description:
      'Save a draft quote for a company: a name, lines (SKU, the most the buyer may order at the price, the negotiated unit price in the base currency), the member it is for and an expiry day. A draft prices nothing; send_quote sends it.',
  },
  update_quote: {
    role: 'operator',
    confirm: false,
    label: 'Changed a quote draft',
    title: 'Change a quote draft',
    description:
      'Change a draft quote: any of its name, buyer, expiry day, notes or its whole list of lines. Only a draft can be changed; a sent quote is revised into a new version.',
  },
  send_quote: {
    role: 'operator',
    confirm: true,
    label: 'Send a quote',
    title: 'Send a quote',
    description:
      'Send a draft quote to its company. It needs an expiry day ahead and at least one line; once sent it can’t be edited, only accepted, declined, let lapse or revised.',
  },
  accept_quote: {
    role: 'operator',
    confirm: true,
    label: 'Accept a quote',
    title: 'Accept a quote',
    description:
      'Record that the company accepted a sent quote. From then until it expires, orders from that company are priced at the quoted prices, ahead of every other price source, up to each line’s quantity.',
  },
  decline_quote: {
    role: 'operator',
    confirm: true,
    label: 'Decline a quote',
    title: 'Decline a quote',
    description:
      'Record that the company declined a sent quote, or withdraw a draft. A declined quote can be revised into a new version.',
  },
  revise_quote: {
    role: 'operator',
    confirm: false,
    label: 'Revised a quote',
    title: 'Revise a quote',
    description:
      'Start the next version of a sent, declined or expired quote: a new draft with the same lines, and the old version becomes superseded and read-only. An accepted quote can’t be revised; expire it first.',
  },
  expire_quote: {
    role: 'operator',
    confirm: true,
    label: 'End a quote',
    title: 'Expire a quote',
    description:
      'End a sent or accepted quote now: an accepted quote stops pricing orders at once.',
  },
  convert_quote: {
    role: 'operator',
    confirm: true,
    label: 'Convert a quote',
    title: 'Convert a quote',
    description:
      'Turn an accepted quote into a purchase order draft when the company uses purchase orders (it has any), or straight into an order otherwise (to overrides). Converting again returns the first result and makes nothing new.',
  },
  // The Team and Plugins pages' changes, for admins. Those the pages ask a step-up for need one on
  // the card too (`ActionPreview.stepUp`).
  set_member_role: {
    role: 'admin',
    confirm: true,
    label: 'Change a role',
    title: 'Change a person’s role',
    description:
      'Change a team member’s role. Lowering it revokes their API tokens above the new role; making someone an admin needs a step-up.',
  },
  set_approval_separation: {
    role: 'admin',
    confirm: true,
    label: 'Set approval separation',
    title: 'Set approval separation',
    description:
      'Choose whether people may approve their own orders (and verify tax certificates they added).',
  },
  set_plugin_enabled: {
    role: 'admin',
    confirm: true,
    label: 'Turn a plugin on or off',
    title: 'Turn a plugin on or off',
    description:
      'Turn an installed plugin on or off. Off, flows that use it can’t be published and their running steps fail.',
  },
  approve_plugin: {
    role: 'admin',
    confirm: true,
    label: 'Install a plugin',
    title: 'Approve a plugin version',
    description:
      'Approve an uploaded or drafted plugin version so it runs. Needs a step-up; a plugin that asks for buyers’ details needs them granted.',
  },
  rollback_plugin: {
    role: 'admin',
    confirm: true,
    label: 'Roll a plugin back',
    title: 'Roll a plugin back',
    description: 'Run an earlier version of an installed plugin again. Needs a step-up.',
  },
  uninstall_plugin: {
    role: 'admin',
    confirm: true,
    label: 'Uninstall a plugin',
    title: 'Uninstall a plugin',
    description: 'Uninstall a plugin installed at runtime. Needs a step-up.',
  },
  run_plugin_cases: {
    role: 'admin',
    confirm: false,
    label: 'Ran the test cases',
    title: 'Run a plugin draft’s test cases',
    description: 'Run test cases against a plugin draft; nothing is installed.',
  },
  // The audit trail, plugins and webhooks an admin reads on their pages: the same reads as the
  // REST API's, with nothing a secret in them.
  list_audit_events: {
    role: 'admin',
    confirm: false,
    label: 'Read the audit trail',
    title: 'List audit events',
    description:
      'Read the audit trail, newest first: who signed in, changed the team or acted on orders, carts, flows and webhooks, and through which way in. Filter by group, page back with before, or give after (a seq) to read sealed events oldest first.',
  },
  verify_audit_trail: {
    role: 'admin',
    confirm: false,
    label: 'Checked the audit chain',
    title: 'Verify the audit trail',
    description:
      'Check that the audit trail’s hash chain holds: no event changed, removed or reordered. Checks a batch at a time; next says where to continue.',
  },
  list_plugins: {
    role: 'admin',
    confirm: false,
    label: 'Listed plugins',
    title: 'List plugins',
    description:
      'Every plugin this deployment runs: its runtime, where it came from, the nodes, events and built-in steps it provides, and whether it answered just now.',
  },
  get_plugin_usage: {
    role: 'admin',
    confirm: false,
    label: 'Checked a plugin’s use',
    title: 'Get where a plugin is used',
    description:
      'What still depends on a plugin: published flows, running orders and labels it couldn’t void yet. A plugin can be uninstalled once all three are empty.',
  },
  list_webhook_subscriptions: {
    role: 'admin',
    confirm: false,
    label: 'Listed webhook subscriptions',
    title: 'List webhook subscriptions',
    description:
      'The outbound webhook subscriptions: where each posts, which events it takes and whether it is on. Never a signing secret.',
  },
  list_webhook_deliveries: {
    role: 'admin',
    confirm: false,
    label: 'Listed webhook deliveries',
    title: 'List a webhook’s deliveries',
    description:
      'A subscription’s latest deliveries, newest first: the event, its payload, and whether it was delivered, with attempts and the receiver’s last status or error.',
  },
  delete_webhook_subscription: {
    role: 'admin',
    confirm: true,
    label: 'Remove a webhook subscription',
    title: 'Remove a webhook subscription',
    description:
      'Remove an outbound webhook subscription, so its URL stops receiving events. Its past deliveries go with it. Creating or rotating one is done in the app or over the REST API: its signing secret is shown once.',
  },
  list_integrations: {
    role: 'admin',
    confirm: false,
    label: 'Listed integrations',
    title: 'List integrations',
    description:
      'The external systems that sign webhooks to this workspace: what each may send, whether it starts orders and on which flows, when it was last used and whether it was revoked. Never a signing secret.',
  },
  revoke_integration: {
    role: 'admin',
    confirm: true,
    label: 'Revoke an integration',
    title: 'Revoke an integration',
    description:
      'Revoke an integration at once: its signed requests are refused from now on, and so is the secret it was rotating from. This cannot be undone; the sender needs a new integration. Creating or rotating one is done in the app or over the REST API.',
  },
  get_ucp_settings: {
    role: 'admin',
    confirm: false,
    label: 'Read agentic checkout settings',
    title: 'Get agentic checkout settings',
    description:
      'Agentic checkout (UCP): the checkout flow it runs (none while it is off), the legal links and order page buyers see, and the AI shopping platforms let in, each with when it was last used and whether it was revoked. Never a platform’s key.',
  },
  set_ucp_settings: {
    role: 'admin',
    confirm: true,
    label: 'Change agentic checkout settings',
    title: 'Change agentic checkout settings',
    description:
      'Set agentic checkout: the flow a completed checkout starts (null turns it off), the legal links and the order page URL with {id}. Replaces all three. The flow must authorize a card payment.',
  },
  revoke_ucp_platform: {
    role: 'admin',
    confirm: true,
    label: 'Revoke an AI shopping platform',
    title: 'Revoke an AI shopping platform',
    description:
      'Revoke a platform’s access to agentic checkout at once: its key stops working. Its checkouts and orders stay. This cannot be undone; the platform needs a new key from the app or the REST API.',
  },
  draft_cart_reply: {
    role: 'viewer',
    // The Cart thread's own button (`PAGE_ONLY_TOOLS`): a draft for a person to send, or not.
    confirm: false,
    label: 'Drafted a reply',
    title: 'Draft a reply in a cart’s chat',
    description:
      'Draft a staff reply to a cart’s chat from its latest messages. Nothing is sent: the draft fills the composer.',
  },
  set_assistant_routing: {
    role: 'admin',
    confirm: true,
    label: 'Set assistant routing',
    title: 'Set assistant routing',
    description:
      'Choose whether a typed request that is one exact call (cancel this order, list carts) runs without the chat model when the decision model is sure, to save model cost.',
  },
};

/**
 * The id prefix of a tool call a page made through the assistant (`act`), with no model: the panel
 * answers its confirm card with `resolve`, not as a model's approval.
 */
export const DIRECT_CALL = 'direct_';

export const isAssistantTool = (name: string): name is AssistantTool => name in ASSISTANT_TOOLS;

/**
 * Tools that save something without a confirm: nothing they save runs until someone approves it
 * (a plugin draft), publishes it (a product draft) or submits it (a cart).
 */
export const WRITES_WITHOUT_CONFIRM: readonly AssistantTool[] = [
  'draft_plugin',
  'draft_product_content',
  'create_cart',
  'change_cart',
  'create_po_draft',
  'update_po_draft',
  'create_quote',
  'update_quote',
  'revise_quote',
  'start_scenario',
  'create_flow',
  'duplicate_flow',
  'archive_flow',
  'stage_product_edits',
  'accept_product_drafts',
  'discard_product_edits',
  'put_catalog_type',
  'put_catalog_channel',
  'run_plugin_cases',
];

/**
 * Tools only a page's own button calls (`act`): never offered to the model, MCP or A2A. A demo
 * scenario starts a real order at one press; that press is the person's own, so nothing else may
 * make it without a confirm.
 */
export const PAGE_ONLY_TOOLS: readonly AssistantTool[] = [
  'start_scenario',
  'save_flow_draft',
  'accept_product_drafts',
  'run_plugin_cases',
  'draft_cart_reply',
];

export const isPageOnly = (name: AssistantTool) => PAGE_ONLY_TOOLS.includes(name);

/**
 * Actions that change what buyers pay (a price, a rate) or owe in tax, or who outside may reach the workspace: a
 * person always confirms them on a card (the panel, MCP's confirmation, A2A chat's
 * `{ confirm: true }`), never a typed A2A skill that runs as composed.
 */
export const PERSON_CONFIRMS_TOOLS: readonly AssistantTool[] = [
  'create_promotion',
  'set_promotion_status',
  'create_price_book',
  'set_price_book_status',
  'put_price_book_entries',
  'assign_price_book',
  'put_contract_prices',
  'set_fx_rate',
  'verify_tax_certificate',
  'revoke_tax_certificate',
  // What a customer may owe: their limit and balance.
  'set_credit_limit',
  'adjust_credit',
  // Who outside may reach the workspace: a webhook's receiver, an integration, an AI platform.
  'delete_webhook_subscription',
  'revoke_integration',
  'revoke_ucp_platform',
  'set_ucp_settings',
  // Who may do what: only a person on the Team page decides it.
  'set_member_role',
  'set_approval_separation',
  'set_assistant_routing',
];

/**
 * Who may do what on the team, and a return or claim (one with nothing to send back refunds at
 * once): only a person signed in to the app, through the assistant panel (or a page's own button).
 * Never offered over MCP or A2A, where a connected app (an OAuth grant, `kind: 'user'`) or a token
 * could confirm its own call.
 */
export const PANEL_ONLY_TOOLS: readonly AssistantTool[] = [
  'set_member_role',
  'set_approval_separation',
  'set_assistant_routing',
  'record_return',
];

export const isPanelOnly = (name: AssistantTool) => PANEL_ONLY_TOOLS.includes(name);

/** Whether a tool changes anything: an action, or a write that needs no confirm. */
export const isWriteTool = (name: AssistantTool) =>
  ASSISTANT_TOOLS[name].confirm || WRITES_WITHOUT_CONFIRM.includes(name);

/**
 * An action resolved against live data, shown before a person confirms it: what it is, what will
 * happen, and, when it can't go ahead, why.
 */
export type ActionPreview = {
  title: string;
  consequences: string[];
  /** Set when the action can't run as asked (already decided, wrong role, nothing to publish). */
  blocked?: string;
  /** Where to look, e.g. `/orders/ord_…`. */
  href?: string;
  /**
   * What confirming this preview is held to besides the input: what the person saw that can
   * change before they confirm (a cart's `cartVersion`). The server that showed the preview keeps
   * its own copy and hands it to the action, which refuses when it no longer holds.
   */
  bound?: Record<string, unknown>;
  /**
   * Confirming needs the person to prove it's them first (`STEP_UP_MS`): the card asks for their
   * password, a code, or single sign-on before it confirms.
   */
  stepUp?: true;
};

/** How long a step-up on a session lets it confirm a sensitive action. */
export const STEP_UP_MS = 10 * 60_000;

export const STEP_UP_NEEDED = 'Confirm it’s you first, then confirm again.';

/** What `draft_plugin` returns: a pending draft to review on the Plugins page, never running. */
export type PluginDraftResult = {
  id: string;
  sha: string;
  name: string;
  version: string;
  explanation: string;
  /** The flow steps it adds: type and label. */
  nodes: { type: string; label: string }[];
  cases: { total: number; passed: number };
  /** Where to review and approve it. */
  href: string;
};

/** What `propose_flow_change` returns: a whole graph to review in the editor, never saved. */
export type FlowProposal = {
  flowId: string;
  flowName: string;
  explanation: string;
  graph: FlowGraph;
  errors: GraphIssue[];
  warnings: GraphIssue[];
  /** Counted against the graph it started from. */
  changes: { added: number; removed: number; edited: number; rewired: number };
};

/** What changed between two graphs, ignoring layout. */
export function graphDiff(before: FlowGraph, after: FlowGraph): FlowProposal['changes'] {
  const strip = (n: FlowGraph['nodes'][number]) => JSON.stringify({ ...n, position: null });
  const b = new Map(before.nodes.map((n) => [n.id, strip(n)]));
  const a = new Map(after.nodes.map((n) => [n.id, strip(n)]));
  const eb = new Set(before.edges.map((e) => `${e.source}:${e.sourceHandle ?? ''}>${e.target}`));
  const ea = new Set(after.edges.map((e) => `${e.source}:${e.sourceHandle ?? ''}>${e.target}`));
  return {
    added: [...a.keys()].filter((id) => !b.has(id)).length,
    removed: [...b.keys()].filter((id) => !a.has(id)).length,
    edited: [...a].filter(([id, v]) => b.has(id) && b.get(id) !== v).length,
    rewired: [...ea].filter((k) => !eb.has(k)).length + [...eb].filter((k) => !ea.has(k)).length,
  };
}

/** "2 steps added, 1 edited", or null when nothing but layout changed. */
export function describeDiff(c: FlowProposal['changes']): string | null {
  const parts = [
    c.added ? `${c.added} step${c.added === 1 ? '' : 's'} added` : '',
    c.removed ? `${c.removed} removed` : '',
    c.edited ? `${c.edited} edited` : '',
    c.rewired ? `${c.rewired} connection${c.rewired === 1 ? '' : 's'} changed` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
