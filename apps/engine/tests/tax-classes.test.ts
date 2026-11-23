import { env } from 'cloudflare:workers';
import { type Order, type RunContext, withDefaults } from '@commerceworker/core';
import { createDb, publishFlow } from '@commerceworker/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../src/flows';
import { EXECUTORS } from '../src/nodes';
import { startOrder } from '../src/orders';
import { edge, node, settled } from './plugin-helpers';

const shipTo = {
  line1: '1 High St',
  city: 'Leeds',
  region: 'ENG',
  postalCode: 'LS1 1AA',
  country: 'GB',
};

/** Prices then taxes an order: 20% standard in GB, 5% for `reduced`, nothing for `gift-card`. */
const flow = (id: string, tax: Record<string, unknown>) =>
  publishFlow(createDb(env.DB), {
    id,
    name: 'Tax by class',
    description: '',
    model: 'd2c',
    channels: [],
    nodes: [
      node('start', 'trigger.manual'),
      node('price', 'commerce.price'),
      node('tax', 'commerce.tax', { rate: 0.1, includeShipping: false, ...tax }),
      node('done', 'control.end', { outcome: 'completed', reason: 'priced' }),
    ],
    edges: [edge('start', 'price'), edge('price', 'tax'), edge('tax', 'done')],
  });

const start = (flowId: string) =>
  startOrder(env, {
    flowId,
    input: {
      model: 'd2c',
      channel: 'api',
      currency: 'USD',
      lines: [
        { sku: 'TXC-STD', qty: 1 },
        { sku: 'TXC-BOOK', qty: 2 },
        { sku: 'TXC-GIFT', qty: 1 },
      ],
      meta: { shipTo },
    },
  });

beforeAll(async () => {
  await ensureTemplates(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM products WHERE sku LIKE 'TXC-%'"),
    env.DB.prepare(
      `INSERT INTO products (sku, name, price, cost, stock, tax_class) VALUES
        ('TXC-STD', 'Mug', 100, 1, 10, NULL),
        ('TXC-BOOK', 'Book', 50, 1, 10, 'reduced'),
        ('TXC-GIFT', 'Gift card', 100, 0, 10, 'gift-card')`,
    ),
  ]);
});

describe('an order of products in different tax classes', () => {
  it('is taxed line by line, and keeps each SKU’s rate on the order', async () => {
    await flow('test-tax-classes', {
      regions: [
        { country: 'GB', rate: 0.2 },
        { country: 'GB', class: 'reduced', rate: 0.05 },
      ],
      classes: { 'gift-card': 0 },
    });
    const { orderId } = await start('test-tax-classes');
    const done = await settled(orderId, 30_000, { rollback: false });
    expect(done.status).toBe('completed');
    // 100 × 20% + 100 × 5% + 100 × 0%.
    expect(done.order).toMatchObject({ subtotal: 300, tax: 25, total: 325, taxRate: 0.2 });
    expect(done.order?.taxRates).toEqual({ 'TXC-BOOK': 0.05, 'TXC-GIFT': 0 });
    expect(done.nodes.tax?.output).toMatchObject({
      rate: 0.2,
      byClass: [
        { sku: 'TXC-BOOK', taxClass: 'reduced', rate: 0.05 },
        { sku: 'TXC-GIFT', taxClass: 'gift-card', rate: 0 },
      ],
    });
  });

  it('is taxed at one rate by a tax node that rates no class', async () => {
    await flow('test-tax-one-rate', { regions: [{ country: 'GB', rate: 0.2 }] });
    const { orderId } = await start('test-tax-one-rate');
    const done = await settled(orderId, 30_000, { rollback: false });
    expect(done.order).toMatchObject({ subtotal: 300, tax: 60, total: 360 });
    expect(done.order?.taxRates).toBeUndefined();
    expect(done.nodes.tax?.output).not.toHaveProperty('byClass');
  });

  it('refuses settings it can’t read, instead of taxing at the fallback rate', async () => {
    const order = {
      id: 'ord_txc_bad',
      model: 'd2c',
      channel: 'api',
      currency: 'USD',
      lines: [{ sku: 'TXC-BOOK', qty: 1, unitPrice: 50 }],
      meta: { shipTo },
      createdAt: 0,
      subtotal: 50,
      shipping: 0,
      tax: 0,
      total: 50,
    } as Order;
    const ctx: RunContext = {
      order,
      nodes: {},
      vars: {},
      input: {},
      now: Date.now(),
      ref: order.id,
    };
    const run = (config: Record<string, unknown>) =>
      EXECUTORS['commerce.tax']!({
        env,
        node: node('tax', 'commerce.tax'),
        config: withDefaults('commerce.tax', config),
        ctx,
        stepKey: 'tax#1',
      });
    await expect(run({ classes: { reduced: 5 } })).rejects.toThrow(/Invalid tax classes/);
    // An emptied field is unset, as it is when the flow is checked.
    expect((await run({ classes: '', regions: '' })).order).toMatchObject({
      tax: 4,
      taxRate: 0.08,
    });
    await expect(run({ regions: [{ country: 'gb', rate: 0.2 }] })).rejects.toThrow(
      /Invalid tax regions/,
    );
  });
});
