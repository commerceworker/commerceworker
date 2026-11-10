/**
 * The web app's composition root for its own D1 reads and writes: the one place that binds the D1
 * adapters (@commerceworker/db) to the ports (@commerceworker/ports/commerce), as
 * apps/engine/src/wire.ts does for the engine. Everything else in the web app asks for a port.
 * Tests swap a port for its in-memory twin in @commerceworker/test-kit/commerce.
 */
import { env } from 'cloudflare:workers';
import { createDb, probeDb } from '@commerceworker/db';
import { d1AddressBook } from '@commerceworker/db/address-book';
import { d1AuditLog } from '@commerceworker/db/audit-log';
import { d1AuthStore } from '@commerceworker/db/auth-store';
import { d1BackOffice } from '@commerceworker/db/back-office';
import { d1BalanceStore } from '@commerceworker/db/balance-store';
import { d1CartRecords } from '@commerceworker/db/cart-records';
import { d1CompanyDirectory } from '@commerceworker/db/company-directory';
import { d1FlowStore } from '@commerceworker/db/flow-store';
import { d1IntegrationStore } from '@commerceworker/db/integration-store';
import { d1WebhookReceipts } from '@commerceworker/db/logs';
import { d1OrderBoard } from '@commerceworker/db/order-board';
import { d1OrderRecords } from '@commerceworker/db/order-records';
import { d1PasskeyStore } from '@commerceworker/db/passkey-store';
import { d1PluginInstallStore } from '@commerceworker/db/plugin-install-store';
import { d1PricingStore } from '@commerceworker/db/pricing-store';
import { d1ScimDirectory } from '@commerceworker/db/scim-directory';
import { d1UcpStore } from '@commerceworker/db/ucp-store';
import { d1WebhookOutbox } from '@commerceworker/db/webhook-outbox';
import { d1WorkspaceStore } from '@commerceworker/db/workspace-store';
import type { Clock } from '@commerceworker/ports';
import type {
  AddressBook,
  AuditLog,
  AuthStore,
  BackOffice,
  BalanceStore,
  CartRecords,
  CompanyDirectory,
  FlowStore,
  IntegrationStore,
  OrderBoard,
  OrderRecords,
  PasskeyStore,
  PluginInstallStore,
  PricingStore,
  ScimDirectory,
  UcpStore,
  WebhookOutbox,
  WebhookReceipts,
  WorkspaceStore,
} from '@commerceworker/ports/commerce';

/** Wall-clock time. */
const systemClock: Clock = { now: () => new Date() };

/** The workspace's members, their API tokens and its settings. */
export const workspaceStore = (): WorkspaceStore => d1WorkspaceStore(env.DB, systemClock);

/** Customers, products, promotions and the price chain. */
export const pricingStore = (): PricingStore => d1PricingStore(env.DB, systemClock);

/** A business customer's credit: its limit, balance, holds and ledger. */
export const balanceStore = (): BalanceStore => d1BalanceStore(env.DB, systemClock);

/** The carts index: one row per cart. */
export const cartRecords = (): CartRecords => d1CartRecords(env.DB, systemClock);

/** The places customers' orders ship to. */
export const addressBook = (): AddressBook => d1AddressBook(env.DB);

/** Companies, their teams and members, and the customer accounts they hang off. */
export const companyDirectory = (): CompanyDirectory => d1CompanyDirectory(env.DB);

/** People, sessions, API tokens, failed-attempt windows and two-factor challenges. */
export const authStore = (): AuthStore => d1AuthStore(env.DB);

/** People's passkeys and the challenges registering or signing in with one answers. */
export const passkeyStore = (): PasskeyStore => d1PasskeyStore(env.DB);

/** The orders index and each order's records, as the admin reads them. */
export const orderBoard = (): OrderBoard => d1OrderBoard(env.DB);

/** Flows: drafts, published versions and templates. */
export const flowStore = (): FlowStore => d1FlowStore(env.DB, systemClock);

/** The Commerce page's lists, the pickers' records and the currencies. */
export const backOffice = (): BackOffice => d1BackOffice(env.DB);

/** The people and groups SCIM provisioning manages. */
export const scimDirectory = (): ScimDirectory => d1ScimDirectory(env.DB);

/** Agentic checkout's platforms, their keys and profiles. */
export const ucpStore = (): UcpStore => d1UcpStore(env.DB);

/** Outbound webhook subscriptions and their deliveries. */
export const webhookOutbox = (): WebhookOutbox => d1WebhookOutbox(env.DB);

/** Installed plugins, their secrets and their errors. */
export const pluginInstalls = (): PluginInstallStore => d1PluginInstallStore(env.DB);

/** The external systems that sign webhooks, with their sealed secrets and scope. */
export const integrationStore = (): IntegrationStore => d1IntegrationStore(env.DB);

/** Orders' own records: who started one, the channel it came in on. */
export const orderRecords = (): OrderRecords => d1OrderRecords(env.DB, systemClock);

/** The audit trail's hash chain. */
export const auditLog = (): AuditLog => d1AuditLog(env.DB);

/** The signed health check's write to D1 and back (`probeDb`). */
export const d1Writable = (id: string) => probeDb(createDb(env.DB), id);

/** Signed webhooks already taken, so a replayed signature is refused. */
export const webhookReceipts = (): WebhookReceipts => d1WebhookReceipts(env.DB);
