/**
 * The engine's composition root for commerce storage: the one place that binds D1 adapters to the
 * ports the nodes, agents and checkout read through (@commerceworker/ports/commerce). Everything
 * else asks for a port, never a table.
 */

import { createDb, probeDb } from '@commerceworker/db';
import { d1AddressBook } from '@commerceworker/db/address-book';
import { d1AuditLog } from '@commerceworker/db/audit-log';
import { d1BalanceStore } from '@commerceworker/db/balance-store';
import { d1CartRecords } from '@commerceworker/db/cart-records';
import { d1CheckoutSessions } from '@commerceworker/db/checkout-sessions';
import { d1CompanyDirectory } from '@commerceworker/db/company-directory';
import { d1ConfirmationStore } from '@commerceworker/db/confirmation-store';
import { d1DocumentStore, d1MessageStore } from '@commerceworker/db/document-store';
import { d1FlowStore } from '@commerceworker/db/flow-store';
import { d1FulfillmentStore } from '@commerceworker/db/fulfillment-store';
import { d1IdentityStore } from '@commerceworker/db/identity-store';
import { d1IntegrationStore } from '@commerceworker/db/integration-store';
import { d1InventoryStore } from '@commerceworker/db/inventory-store';
import { d1InvoiceStore } from '@commerceworker/db/invoice-store';
import { d1IntakeLog, d1PaymentEventLog, d1UsageStore } from '@commerceworker/db/logs';
import { d1MarketplaceStore } from '@commerceworker/db/marketplace-store';
import { d1OrderQueries } from '@commerceworker/db/order-queries';
import { d1OrderRecords } from '@commerceworker/db/order-records';
import { d1PaymentLedger } from '@commerceworker/db/payment-ledger';
import { d1PluginInstallStore } from '@commerceworker/db/plugin-install-store';
import { d1PricingStore } from '@commerceworker/db/pricing-store';
import { d1ProductIndexStore } from '@commerceworker/db/product-index-store';
import { d1RetentionStore } from '@commerceworker/db/retention-store';
import { d1SealedSecrets } from '@commerceworker/db/sealed-secrets';
import { d1ShippingStore } from '@commerceworker/db/shipping-store';
import { d1SubjectStore } from '@commerceworker/db/subject-store';
import { d1TaxCertificateStore } from '@commerceworker/db/tax-certificate-store';
import { d1UcpStore } from '@commerceworker/db/ucp-store';
import { d1WebhookOutbox } from '@commerceworker/db/webhook-outbox';
import { d1WorkspaceStore } from '@commerceworker/db/workspace-store';
import type { Clock } from '@commerceworker/ports';
import type {
  AddressBook,
  AuditArchive,
  AuditLog,
  BalanceStore,
  CartRecords,
  CartRuntime,
  CheckoutSessionStore,
  CompanyDirectory,
  ConfirmationStore,
  DocumentStore,
  FlowStore,
  FulfillmentStore,
  IdentityStore,
  IntakeLog,
  IntegrationStore,
  InventoryStore,
  InvoiceStore,
  LabelService,
  MarketplaceStore,
  MessageStore,
  ObjectStore,
  OrderQueries,
  OrderRecords,
  OrderRuntime,
  PaymentEventLog,
  PaymentLedger,
  PluginInstallStore,
  PricingStore,
  ProductIndexStore,
  RetentionStore,
  SealedSecretStore,
  ShippingStore,
  SubjectCarts,
  SubjectStore,
  TaxCertificateStore,
  UcpStore,
  UsageStore,
  WebhookOutbox,
  WorkspaceStore,
} from '@commerceworker/ports/commerce';
import { cartAgent, orderAgent } from './namespaces';
import { provide } from './providers';

/** Wall-clock time. Workflow code reads it only inside a step, as every effect does. */
export const systemClock: Clock = { now: () => new Date() };

const pricingStores = new WeakMap<D1Database, PricingStore>();

/** Customers, products, promotions, exchange rates and the price chain, for this deployment. */
export function pricingStore(env: Pick<Env, 'DB'>): PricingStore {
  let store = pricingStores.get(env.DB);
  if (!store) {
    store = d1PricingStore(env.DB, systemClock);
    pricingStores.set(env.DB, store);
  }
  return store;
}

const inventoryStores = new WeakMap<D1Database, InventoryStore>();

/** Stock and reservations: holds, settlements and restocks, each applied once. */
export function inventoryStore(env: Pick<Env, 'DB'>): InventoryStore {
  let store = inventoryStores.get(env.DB);
  if (!store) {
    store = d1InventoryStore(env.DB, systemClock);
    inventoryStores.set(env.DB, store);
  }
  return store;
}

const fulfillmentStores = new WeakMap<D1Database, FulfillmentStore>();

/** Stores, pickups, hand-overs and digital codes. */
export function fulfillmentStore(env: Pick<Env, 'DB'>): FulfillmentStore {
  let store = fulfillmentStores.get(env.DB);
  if (!store) {
    store = d1FulfillmentStore(env.DB, systemClock);
    fulfillmentStores.set(env.DB, store);
  }
  return store;
}

const balanceStores = new WeakMap<D1Database, BalanceStore>();

/** Customer balances: account charges, their settlement and their reversal, each applied once. */
export function balanceStore(env: Pick<Env, 'DB'>): BalanceStore {
  let store = balanceStores.get(env.DB);
  if (!store) {
    store = d1BalanceStore(env.DB, systemClock);
    balanceStores.set(env.DB, store);
  }
  return store;
}

const marketplaceStores = new WeakMap<D1Database, MarketplaceStore>();

/** Sellers, the part of each order they fulfil, and their payouts. */
export function marketplaceStore(env: Pick<Env, 'DB'>): MarketplaceStore {
  let store = marketplaceStores.get(env.DB);
  if (!store) {
    store = d1MarketplaceStore(env.DB, systemClock);
    marketplaceStores.set(env.DB, store);
  }
  return store;
}

const shippingStores = new WeakMap<D1Database, ShippingStore>();

/** Shipments and what became of their labels. */
export function shippingStore(env: Pick<Env, 'DB'>): ShippingStore {
  let store = shippingStores.get(env.DB);
  if (!store) {
    store = d1ShippingStore(env.DB, systemClock);
    shippingStores.set(env.DB, store);
  }
  return store;
}

const documentStores = new WeakMap<R2Bucket, DocumentStore>();

/** An order's documents: bodies in R2 (`DOCS`), records in D1. */
export function documentStore(env: Pick<Env, 'DB' | 'DOCS'>): DocumentStore {
  let store = documentStores.get(env.DOCS);
  if (!store) {
    store = d1DocumentStore(env.DB, env.DOCS, systemClock);
    documentStores.set(env.DOCS, store);
  }
  return store;
}

const messageStores = new WeakMap<D1Database, MessageStore>();

/** An order's outbox of messages, one per order and step. */
export function messageStore(env: Pick<Env, 'DB'>): MessageStore {
  let store = messageStores.get(env.DB);
  if (!store) {
    store = d1MessageStore(env.DB, systemClock);
    messageStores.set(env.DB, store);
  }
  return store;
}

const paymentLedgers = new WeakMap<D1Database, PaymentLedger>();

/** Every authorization, capture, charge and refund, and the cards customers saved. */
export function paymentLedger(env: Pick<Env, 'DB'>): PaymentLedger {
  let ledger = paymentLedgers.get(env.DB);
  if (!ledger) {
    ledger = d1PaymentLedger(env.DB, systemClock);
    paymentLedgers.set(env.DB, ledger);
  }
  return ledger;
}

const invoiceStores = new WeakMap<D1Database, InvoiceStore>();

/** The invoices orders issue, and what became of each. */
export function invoiceStore(env: Pick<Env, 'DB'>): InvoiceStore {
  let store = invoiceStores.get(env.DB);
  if (!store) {
    store = d1InvoiceStore(env.DB, systemClock);
    invoiceStores.set(env.DB, store);
  }
  return store;
}

const orderRecordStores = new WeakMap<D1Database, OrderRecords>();

/** The order read model the OrderAgent projects: index rows, step timings, approvals. */
export function orderRecords(env: Pick<Env, 'DB'>): OrderRecords {
  let store = orderRecordStores.get(env.DB);
  if (!store) {
    store = d1OrderRecords(env.DB, systemClock);
    orderRecordStores.set(env.DB, store);
  }
  return store;
}

const cartRecordStores = new WeakMap<D1Database, CartRecords>();

/** The carts index the CartAgent projects: one row per cart. */
export function cartRecords(env: Pick<Env, 'DB'>): CartRecords {
  let store = cartRecordStores.get(env.DB);
  if (!store) {
    store = d1CartRecords(env.DB, systemClock);
    cartRecordStores.set(env.DB, store);
  }
  return store;
}

const checkoutSessionStores = new WeakMap<D1Database, CheckoutSessionStore>();

/** Agentic checkout (UCP) sessions, each written over the version it was read at. */
export function checkoutSessions(env: Pick<Env, 'DB'>): CheckoutSessionStore {
  let store = checkoutSessionStores.get(env.DB);
  if (!store) {
    store = d1CheckoutSessions(env.DB);
    checkoutSessionStores.set(env.DB, store);
  }
  return store;
}

/** What the retention sweep finds and deletes across the deployment's tables. */
export const retentionStore = (env: Pick<Env, 'DB'>): RetentionStore => d1RetentionStore(env.DB);

/** Audit events archived to R2 (`DOCS`, under `audit/`, which the bucket locks). */
export function auditArchive(env: Pick<Env, 'DOCS'>): AuditArchive {
  return {
    has: async (key) => !!(await env.DOCS.head(key)),
    async put(key, rows) {
      await env.DOCS.put(key, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, {
        httpMetadata: { contentType: 'application/x-ndjson' },
        customMetadata: { events: String(rows.length) },
      });
    },
  };
}

/** The cart agents the retention sweep wakes. */
export function cartRuntime(env: Env): CartRuntime {
  return {
    purge: (id) => cartAgent(env, id).purge(),
    reindex: (id) => cartAgent(env, id).reindex(),
  };
}

/** What a data subject request reads and erases across the deployment's tables. */
export const subjectStore = (env: Pick<Env, 'DB'>): SubjectStore => d1SubjectStore(env.DB);

/** The R2 bucket (`DOCS`) the deployment's files are in. */
export function objectStore(env: Pick<Env, 'DOCS'>): ObjectStore {
  return {
    async deletePrefix(prefix) {
      let deleted = 0;
      let cursor: string | undefined;
      do {
        const page = await env.DOCS.list({ prefix, cursor });
        const keys = page.objects.map((o) => o.key);
        if (keys.length) await env.DOCS.delete(keys);
        deleted += keys.length;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return deleted;
    },
  };
}

/** The order agents a data subject request reaches. */
export function orderRuntime(env: Env): OrderRuntime {
  return {
    snapshot: async (id) => (await orderAgent(env, id).snapshot()) as never,
    erasePersonalData: async (id, terms) =>
      (await orderAgent(env, id).erasePersonalData(terms)) as {
        held: boolean;
        title: string;
      } | null,
  };
}

/** What a data subject request asks of the cart agents. */
export function subjectCarts(env: Env): SubjectCarts {
  return {
    subjectExport: async (id) => (await cartAgent(env, id).subjectExport()) as never,
    customerExport: async (id) => (await cartAgent(env, id).customerExport()) as never,
    eraseSubject: (id, terms) => cartAgent(env, id).eraseSubject(terms),
    eraseShipTo: (id) => cartAgent(env, id).eraseShipTo(),
    eraseFromEvents: (id, terms) => cartAgent(env, id).eraseFromEvents(terms),
  };
}

/** Questions about many orders at once, for the assistant and A2A. */
export const orderQueries = (env: Pick<Env, 'DB'>): OrderQueries => d1OrderQueries(env.DB);

/** Flows: drafts and their published versions. */
export const flowStore = (env: Pick<Env, 'DB'>): FlowStore => d1FlowStore(env.DB, systemClock);

/** The workspace's members, their API tokens and its settings. */
export const workspaceStore = (env: Pick<Env, 'DB'>): WorkspaceStore =>
  d1WorkspaceStore(env.DB, systemClock);

/** Plugins installed at runtime: their versions, sealed secrets and latest errors. */
export const pluginInstalls = (env: Pick<Env, 'DB'>): PluginInstallStore =>
  d1PluginInstallStore(env.DB);

/** Every secret stored sealed with `DATA_KEY`, for the daily resealing. */
export const sealedSecrets = (env: Pick<Env, 'DB'>): SealedSecretStore => d1SealedSecrets(env.DB);

/** Customers' tax exemption certificates. */
export const taxCertificateStore = (env: Pick<Env, 'DB'>): TaxCertificateStore =>
  d1TaxCertificateStore(env.DB);

/** Companies, their teams and members, and the customer accounts they hang off. */
export const companyDirectory = (env: Pick<Env, 'DB'>): CompanyDirectory =>
  d1CompanyDirectory(env.DB);

/** The places customers' orders ship to. */
export const addressBook = (env: Pick<Env, 'DB'>): AddressBook => d1AddressBook(env.DB);

/** Who a caller is now: accounts, tokens and sessions. */
export const identityStore = (env: Pick<Env, 'DB'>): IdentityStore => d1IdentityStore(env.DB);

/** One-time codes that confirm an action over MCP. */
export const confirmationStore = (env: Pick<Env, 'DB'>): ConfirmationStore =>
  d1ConfirmationStore(env.DB);

/** Agentic checkout's idempotency keys and platform profiles. */
export const ucpStore = (env: Pick<Env, 'DB'>): UcpStore => d1UcpStore(env.DB);

/** The external systems that sign webhooks to the workspace, each with its sealed secret. */
export const integrationStore = (env: Pick<Env, 'DB'>): IntegrationStore =>
  d1IntegrationStore(env.DB);

/** Outbound webhook subscriptions and every delivery of every event. */
export const webhookOutbox = (env: Pick<Env, 'DB'>): WebhookOutbox => d1WebhookOutbox(env.DB);

/** Every inbound order email, accepted or not. */
export const intakeLog = (env: Pick<Env, 'DB'>): IntakeLog => d1IntakeLog(env.DB);

/** The payment processor's events already handled. */
export const paymentEventLog = (env: Pick<Env, 'DB'>): PaymentEventLog => d1PaymentEventLog(env.DB);

/** Each person's assistant usage per day. */
export const usageStore = (env: Pick<Env, 'DB'>): UsageStore => d1UsageStore(env.DB);

/** The semantic product index's bookkeeping: what to embed, what is gone, the reindex lease. */
export const productIndexStore = (env: Pick<Env, 'DB'>): ProductIndexStore =>
  d1ProductIndexStore(env.DB);

/** The audit trail's hash chain. */
export const auditLog = (env: Pick<Env, 'DB'>): AuditLog => d1AuditLog(env.DB);

/** The health check's read of D1: the binding answers. */
export const d1Reachable = (env: Pick<Env, 'DB'>) => env.DB.prepare('select 1').first();

/** The signed health check's write to D1 and back (`probeDb`). */
export const d1Writable = (env: Pick<Env, 'DB'>, id: string) => probeDb(createDb(env.DB), id);

/** Labels from the provider plugin a node names, through the plugin host (./providers). */
export function labelService(env: Env): LabelService {
  return {
    async create(providerId, caller, order, input) {
      const r = await provide(env, providerId, {
        surface: 'shipping.labels',
        op: 'create',
        nodeId: caller.nodeId,
        stepKey: caller.stepKey,
        orderId: order.id,
        config: caller.config,
        order,
        input,
      });
      return r.labels;
    },
    async void(providerId, orderId, stepKey, labels) {
      await provide(env, providerId, {
        surface: 'shipping.labels',
        op: 'void',
        nodeId: stepKey.split('#')[0] ?? stepKey,
        stepKey,
        orderId,
        config: {},
        input: { labels: labels.map(({ ref, id }) => ({ ref, id })) },
      });
    },
  };
}

/** The commerce ports, together, for the use-cases that read across them. */
export const commercePorts = (env: Env) => ({
  pricing: pricingStore(env),
  inventory: inventoryStore(env),
  fulfillment: fulfillmentStore(env),
  balances: balanceStore(env),
  marketplace: marketplaceStore(env),
  shipping: shippingStore(env),
  labels: labelService(env),
});
