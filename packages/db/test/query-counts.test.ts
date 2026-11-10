import { env } from 'cloudflare:workers';
import {
  priceOrder,
  routeFulfillment,
  schedulePayouts,
  splitBySeller,
} from '@commerceworker/application/commerce';
import {
  FULFILLMENT_FIXTURE,
  INVENTORY_FIXTURE,
  MARKETPLACE_FIXTURE,
  PRICING_FIXTURE,
} from '@commerceworker/test-kit/commerce';
import {
  type CountingD1,
  countingD1,
  countsOf,
  formatQueryCounts,
  type QueryLog,
  queryCountDrift,
} from '@commerceworker/test-kit/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import { d1BackOffice } from '../src/back-office';
import { d1BalanceStore } from '../src/balance-store';
import { d1CartRecords } from '../src/cart-records';
import { d1CheckoutSessions } from '../src/checkout-sessions';
import { d1CompanyDirectory } from '../src/company-directory';
import { d1FulfillmentStore } from '../src/fulfillment-store';
import { d1InventoryStore } from '../src/inventory-store';
import { d1InvoiceStore } from '../src/invoice-store';
import { d1MarketplaceStore } from '../src/marketplace-store';
import { d1OrderBoard } from '../src/order-board';
import { d1OrderQueries } from '../src/order-queries';
import { d1OrderRecords } from '../src/order-records';
import { d1PaymentLedger } from '../src/payment-ledger';
import { d1PricingStore } from '../src/pricing-store';
import { d1ShippingStore } from '../src/shipping-store';
import committed from './query-counts.json';
import { seedFulfillment, seedInventory, seedMarketplace, seedPricing } from './seeds';

/**
 * D1 statements and round trips per representative commerce request, against the committed
 * snapshot (query-counts.json). Each runs the use-case or port call a node, an agent or checkout
 * makes, over the real D1 stores. The counts depend on the code path, never on timing or row
 * counts: an order id is fresh on every run.
 *
 * Any change fails until the snapshot is rewritten
 * (`pnpm --filter @commerceworker/db test:query-counts:update`). Read paths may only go down; a
 * PR that raises one says why (AGENTS.md, "D1 limits").
 */

const SNAPSHOT = './query-counts.json';
const DRIFT = {
  file: 'packages/db/test/query-counts.json',
  update: 'pnpm --filter @commerceworker/db test:query-counts:update',
  rule: 'Read paths may only go down; a PR that raises one states why.',
};

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };
const now = clock.now().getTime();
const run = crypto.randomUUID().slice(0, 8);
const id = (name: string) => `qc_${run}_${name}`;

let counter: CountingD1;
let ports: ReturnType<typeof stores>;

function stores(d1: D1Database) {
  return {
    pricing: d1PricingStore(d1, clock),
    inventory: d1InventoryStore(d1, clock),
    fulfillment: d1FulfillmentStore(d1, clock),
    marketplace: d1MarketplaceStore(d1, clock),
    balances: d1BalanceStore(d1, clock),
    ledger: d1PaymentLedger(d1, clock),
    invoices: d1InvoiceStore(d1, clock),
    shipping: d1ShippingStore(d1, clock),
    orders: d1OrderRecords(d1, clock),
    orderQueries: d1OrderQueries(d1),
    board: d1OrderBoard(d1),
    office: d1BackOffice(d1),
    carts: d1CartRecords(d1, clock),
    checkouts: d1CheckoutSessions(d1),
    companies: d1CompanyDirectory(d1),
  };
}

const ALL = { all: true } as const;

const priced = [
  { sku: 'PC-SKU-1', qty: 2 },
  { sku: 'PC-SKU-2', qty: 1 },
];
const stocked = [
  { sku: 'IC-TEE', qty: 1 },
  { sku: 'IC-ONE', qty: 1 },
];
const chain = { basis: 'auto', useContracts: true, usePriceRules: true, now } as const;

/** Each request, as the node, agent or checkout runs it. Names say who calls it. */
const REQUESTS: [string, () => Promise<unknown>][] = [
  [
    'commerce.price: price 2 lines for a contract customer',
    () =>
      priceOrder(
        ports,
        { lines: priced, currency: 'USD', customerId: 'pc_northwind', model: 'b2b' },
        chain,
      ),
  ],
  [
    'commerce.price: price 2 lines in another currency',
    () =>
      priceOrder(
        ports,
        { lines: priced, currency: 'EUR', customerId: 'pc_northwind', model: 'b2b' },
        chain,
      ),
  ],
  [
    'commerce.price: price a buy-side order at cost',
    () => priceOrder(ports, { lines: priced, currency: 'USD', model: 'procurement' }, chain),
  ],
  [
    'commerce.route_fulfillment: ship 2 lines',
    () => routeFulfillment(ports, { lines: stocked, fulfillment: null, meta: {} } as never, 'ship'),
  ],
  [
    'commerce.reserve: hold 2 lines',
    () => ports.inventory.reserve({ id: id('reserve'), lines: stocked }, 'reserve#1'),
  ],
  [
    'commerce.reserve: retried after holding',
    () => ports.inventory.reserve({ id: id('reserve'), lines: stocked }, 'reserve#1'),
  ],
  ['rollback commerce.reserve: release', () => ports.inventory.release(id('reserve'))],
  [
    'commerce.split_by_seller: 2 first-party lines',
    () => splitBySeller(ports, { id: id('split'), lines: priced }),
  ],
  [
    'commerce.payout: no third-party sellers',
    () => schedulePayouts(ports, { id: id('split'), total: 45 }, 'payout#1', 0),
  ],
  [
    'commerce.invoice: charge the account',
    () =>
      ports.balances.charge({
        orderId: id('invoice'),
        stepKey: 'invoice#1',
        customerId: 'pc_northwind',
        amount: 45,
      }),
  ],
  ['rollback commerce.invoice: reverse the charge', () => ports.balances.reverse(id('invoice'))],
  ['commerce.invoice: paid so far', () => ports.ledger.forOrder(id('invoice'))],
  ['ucp: order shipments', () => ports.shipping.booked(id('invoice'))],
  ['ucp: load a checkout', () => ports.checkouts.load('qc_platform', id('checkout'))],
  ['carts: find a cart', () => ports.carts.find(id('cart'))],
  ['orders: list an order’s approvals', () => ports.orders.approvals(id('invoice'))],
  ['assistant: needs attention', () => ports.orderQueries.attention(now, 6)],
  [
    'assistant: find orders by customer and total',
    () => ports.orderQueries.find({ customer: 'north', minTotal: 10, limit: 20 }, now),
  ],
  ['assistant: resolve an order reference', () => ports.orderQueries.resolveId('abc123')],
  [
    'admin orders: a filtered page',
    () => ports.board.list({ status: 'failed', q: 'north', sort: 'updated' }, 200),
  ],
  ['admin orders: count a filter', () => ports.board.count({ attention: true }, 10_000)],
  ['admin overview', () => ports.board.overview(now)],
  [
    'admin approvals: a later page of the queue',
    () => ports.board.approvals('pending', { requestedAt: 0, id: '' }, 50, 'live'),
  ],
  ['admin approvals: pending counts', () => ports.board.pendingApprovalCounts()],
  ['admin order: its records', () => ports.board.records(id('invoice'))],
  ['admin events: orders waiting on an event', () => ports.board.waitingOnEvents(50, now)],
  ['admin records: the latest of each kind', () => ports.board.recentRecords('', 30)],
  ['admin records: a search', () => ports.board.recentRecords('north', 30)],
  ['admin performance: 30 days', () => ports.board.performance(now - 30 * 86_400_000)],
  [
    'admin commerce: a page of every list',
    () => ports.office.page('', () => 1, { list: 25, group: 10 }),
  ],
  [
    'admin commerce: a search',
    () => ports.office.page('contract', () => 1, { list: 25, group: 10 }),
  ],
  [
    'admin commerce: customers filtered by status',
    () => ports.office.page('', () => 1, { list: 25, group: 10 }, { status: 'active' }),
  ],
  ['companies: a page', () => ports.companies.companies(ALL, { limit: 25 })],
  [
    'companies: a page by status and search',
    () => ports.companies.companies(ALL, { limit: 25, status: 'active', search: 'qc' }),
  ],
  ['companies: one company', () => ports.companies.company(ALL, id('co'))],
  ['companies: a company’s teams', () => ports.companies.teams(ALL, id('co'))],
  [
    'companies: a page of members',
    () => ports.companies.members(ALL, { companyId: id('co'), limit: 25 }),
  ],
  ['companies: one member', () => ports.companies.member(ALL, id('co'), id('mem'))],
  [
    'companies: members by email',
    () => ports.companies.membersByEmail(ALL, id('co'), ['qc@example.test']),
  ],
  ['companies: its parents', () => ports.companies.ancestry(ALL, id('co'))],
  ['companies: a customer by email', () => ports.companies.customerByEmail(ALL, 'qc@example.test')],
  ['commerce.validate: the company only', () => ports.companies.access(ALL, id('co'))],
  [
    'commerce.validate: the company and its buyer',
    () => ports.companies.access(ALL, id('co'), id('mem')),
  ],
  ['admin new order: every record for the pickers', () => ports.office.everything()],
  ['admin: currencies', () => ports.office.currencies()],
];

describe('commerce D1 query counts', () => {
  beforeAll(async () => {
    await seedPricing(PRICING_FIXTURE);
    await seedInventory(INVENTORY_FIXTURE);
    await seedFulfillment(FULFILLMENT_FIXTURE);
    await seedMarketplace(MARKETPLACE_FIXTURE);
    const companies = d1CompanyDirectory(DB);
    await companies.createCustomer(
      {
        id: id('co'),
        name: 'QC Co',
        email: 'qc@example.test',
        kind: 'business',
        tier: 'standard',
        terms: 'net_30',
      },
      {
        customerId: id('co'),
        status: 'active',
        legalName: 'QC Co Ltd',
        taxId: null,
        parentCompanyId: null,
        createdAt: 1,
        updatedAt: 1,
      },
    );
    await companies.upsertMembers(
      id('co'),
      [
        {
          id: id('mem'),
          name: 'QC',
          email: 'qc@example.test',
          role: 'buyer',
          teamId: null,
          status: 'active',
          orderLimit: null,
        },
      ],
      1,
    );
    counter = countingD1(DB);
    ports = stores(counter.d1);
  }, 60_000);

  it('match the committed snapshot', async () => {
    const logs: Record<string, QueryLog> = {};
    for (const [name, request] of REQUESTS) logs[name] = await counter.measure(request);
    await expect(
      formatQueryCounts(countsOf(logs)),
      queryCountDrift(committed, logs, DRIFT),
    ).toMatchFileSnapshot(SNAPSHOT);
  });
});
