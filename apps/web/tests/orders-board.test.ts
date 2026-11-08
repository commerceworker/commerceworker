import { SCENARIO_CUSTOMERS, SCENARIO_SKUS } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/** The board, pricing and flows the order pages read, in memory. */
const { InMemoryOrderBoard, InMemoryPricingStore, PRICING_FIXTURE } = await import(
  '@commerceworker/test-kit/commerce'
);
let board = new InMemoryOrderBoard();
const clock = { now: () => new Date() };
let pricing = new InMemoryPricingStore(PRICING_FIXTURE, clock);
vi.mock('~/lib/wire.server', () => ({ orderBoard: () => board, pricingStore: () => pricing }));

const { countOrders, customerIdByEmail, customerNames, listOrders, runningByFlow, WITHIN } =
  await import('~/lib/orders.server');

const order = (id: string, updatedAt: number, over: Record<string, unknown> = {}) => ({
  id,
  status: 'waiting',
  createdAt: updatedAt,
  updatedAt,
  ...over,
});

beforeEach(() => {
  board = new InMemoryOrderBoard();
  pricing = new InMemoryPricingStore(PRICING_FIXTURE, clock);
});

describe('the order pages over the board', () => {
  it('reads a window as the orders updated since it began', async () => {
    const now = Date.now();
    board = new InMemoryOrderBoard({
      orders: [order('ord_new', now - 1000), order('ord_old', now - WITHIN['24h'] - 60_000)],
    });
    expect((await listOrders({ within: '24h' })).map((o) => o.id)).toEqual(['ord_new']);
    expect(await countOrders({ within: '7d' })).toEqual({ n: 2, more: false });
  });

  it('counts open orders by flow, then version', async () => {
    board = new InMemoryOrderBoard({
      orders: [
        order('o1', 1, { flowId: 'f_a', flowVersion: 1 }),
        order('o2', 2, { flowId: 'f_a', flowVersion: 2 }),
        order('o3', 3, { flowId: 'f_a', flowVersion: 2 }),
      ],
    });
    expect(await runningByFlow()).toEqual({ f_a: { 1: 1, 2: 2 } });
  });

  it('names customers by id, and finds one only by their exact email, in any case', async () => {
    const [ada] = PRICING_FIXTURE.customers!;
    expect(await customerNames([ada!.id, null, 'pc_nobody', ada!.id])).toEqual({
      [ada!.id]: ada!.name,
    });
    expect(await customerNames([])).toEqual({});
    expect(await customerIdByEmail(` ${ada!.email.toUpperCase()} `)).toBe(ada!.id);
    // Another address at the same domain is not theirs.
    const domain = ada!.email.split('@')[1];
    expect(await customerIdByEmail(`someone-else@${domain}`)).toBeUndefined();
    expect(await customerIdByEmail(null)).toBeUndefined();
  });

  it('says the demo is loaded only when every scenario customer and SKU exists', async () => {
    const [someone] = PRICING_FIXTURE.customers!;
    const [item] = PRICING_FIXTURE.products!;
    const demo = (customers: readonly string[], skus: readonly string[]) =>
      new InMemoryPricingStore(
        {
          ...PRICING_FIXTURE,
          customers: customers.map((id) => ({ ...someone!, id, email: `${id}@example.com` })),
          products: skus.map((sku) => ({ ...item!, sku })),
        },
        clock,
      );
    // Remembered for a minute per isolate: a fresh module per answer.
    const ask = async () => {
      vi.resetModules();
      return (await import('~/lib/orders.server')).demoAvailable();
    };
    pricing = demo(SCENARIO_CUSTOMERS, SCENARIO_SKUS);
    expect(await ask()).toBe(true);
    pricing = demo(SCENARIO_CUSTOMERS, SCENARIO_SKUS.slice(1));
    expect(await ask()).toBe(false);
    pricing = demo(SCENARIO_CUSTOMERS.slice(1), SCENARIO_SKUS);
    expect(await ask()).toBe(false);
  });
});
