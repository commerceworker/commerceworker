import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1ActiveObjects } from '../src/active-objects';
import { createDb } from '../src/index';
import { carts, orders } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

const order = (id: string, status: string) => ({
  id,
  model: 'b2b',
  status,
  flowId: 'f',
  flowVersion: 1,
  createdAt: 1,
  updatedAt: 1,
});
const cart = (id: string, status: string, purgedAt: number | null = null) => ({
  id,
  title: id,
  status,
  flowId: 'f',
  createdBy: 'test',
  createdAt: 1,
  updatedAt: 1,
  purgedAt,
});

describe('the live orders and carts the nightly copy walks', () => {
  beforeEach(async () => {
    const db = createDb(DB);
    await db.delete(orders);
    await db.delete(carts);
    await db
      .insert(orders)
      .values([
        order('o3', 'running'),
        order('o1', 'waiting'),
        order('o2', 'completed'),
        order('o4', 'cancelled'),
        order('o5', 'running'),
      ]);
    await db
      .insert(carts)
      .values([
        cart('c1', 'open'),
        cart('c2', 'submitted'),
        cart('c3', 'open', 5),
        cart('c4', 'open'),
      ]);
  });

  it('lists orders that have not reached a terminal status, by id', async () => {
    const active = d1ActiveObjects(DB);
    expect(await active.page('OrderAgent', '', 10)).toEqual({
      names: ['o1', 'o3', 'o5'],
      next: 'o5',
      more: false,
    });
  });

  it('pages by keyset and says whether another page follows', async () => {
    const active = d1ActiveObjects(DB);
    const first = await active.page('OrderAgent', '', 2);
    expect(first).toEqual({ names: ['o1', 'o3'], next: 'o3', more: true });
    expect(await active.page('OrderAgent', first.next, 2)).toEqual({
      names: ['o5'],
      next: 'o5',
      more: false,
    });
    // Past the end: nothing, and the cursor stays.
    expect(await active.page('OrderAgent', 'o5', 2)).toEqual({
      names: [],
      next: 'o5',
      more: false,
    });
  });

  it('lists open carts, leaving out final and purged ones', async () => {
    expect(await d1ActiveObjects(DB).page('CartAgent', '', 10)).toEqual({
      names: ['c1', 'c4'],
      next: 'c4',
      more: false,
    });
  });
});
