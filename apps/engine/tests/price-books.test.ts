/**
 * Price books in the engine: an order's price step names the book that priced a line, a cart for
 * the same customer prices the same way (both run the flow's `commerce.price` node), an agentic
 * checkout never matches a book (its buyer has no customer), a book out of force prices nothing,
 * and REST runs the writes only for a person.
 */
import { env } from 'cloudflare:workers';
import {
  type CartState,
  type OrderInput,
  operationCall,
  PERSON_CONFIRMS,
  type Role,
  type RpcActor,
  withDefaults,
} from '@commerceworker/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { ensureTemplates } from '../src/flows';
import { EXECUTORS } from '../src/nodes';
import { priceBookStore } from '../src/wire';
import { signedActor } from './principal';
import { enableUcp, monitorCheckout, platform, ucp } from './ucp-helpers';

const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const staff = (role: Role, over: Partial<RpcActor> = {}): RpcActor =>
  ({ kind: 'staff', id: `usr_pb_${role}`, name: `${role}@example.com`, role, ...over }) as RpcActor;
const person = (role: Role) => staff(role, { person: true } as Partial<RpcActor>);
const run = async (tool: string, input: unknown, actor: RpcActor) =>
  api().runOperation(tool, input, await signedActor(actor, await operationCall(tool, input)));

beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
});

// Each case starts without the books the last one made (the REST cases' codes begin `rest-`).
beforeEach(async () => {
  const mine = `SELECT id FROM price_books WHERE id LIKE 'pb_eng_%' OR code LIKE 'rest-%'`;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM price_book_assignments WHERE book_id IN (${mine})`),
    env.DB.prepare(`DELETE FROM price_rules WHERE book_id IN (${mine})`),
    env.DB.prepare(`DELETE FROM price_books WHERE id LIKE 'pb_eng_%' OR code LIKE 'rest-%'`),
  ]);
});

let n = 0;
/** A live book pricing MON-27 at `price` (and 12+ units at `volume`), assigned as given. */
async function liveBook(
  over: { priority?: number; price?: number; volume?: number; status?: 'active' | 'draft' } = {},
  to: { customerId: string } | { tier: string } = { customerId: 'cus_contoso' },
) {
  n += 1;
  const id = `pb_eng_${n}`;
  const books = priceBookStore(env);
  const at = Date.now();
  await books.create({
    id,
    code: `eng-${n}`,
    name: `Engine book ${n}`,
    priority: over.priority ?? 0,
    status: 'draft',
    startsAt: null,
    endsAt: null,
    createdBy: 'test',
    createdAt: at,
    updatedAt: at,
  });
  await books.putEntries(
    id,
    [
      { sku: 'MON-27', minQty: 1, price: over.price ?? 300, discountPct: null },
      ...(over.volume
        ? [{ sku: 'MON-27', minQty: 12, price: over.volume, discountPct: null }]
        : []),
    ],
    at,
  );
  await books.assign(id, to, at);
  if ((over.status ?? 'active') === 'active') await books.transition(id, 'draft', 'active', at);
  return { id, name: `Engine book ${n}` };
}

/** A priced order's lines, as the flow's price node reports them. */
async function price(customerId: string | undefined, lines: OrderInput['lines']) {
  const order = {
    channel: 'api' as const,
    currency: 'USD',
    meta: {},
    model: 'b2b' as const,
    customerId,
    lines,
    id: 'ord_price_books',
    createdAt: Date.now(),
    subtotal: 0,
    shipping: 0,
    tax: 0,
    total: 0,
  };
  const node = {
    id: 'price',
    type: 'commerce.price',
    label: 'Price',
    config: {},
    position: { x: 0, y: 0 },
  };
  const r = await EXECUTORS['commerce.price']!({
    env,
    node,
    config: withDefaults('commerce.price', {}),
    ctx: { order, nodes: {}, vars: {}, input: {}, now: Date.now(), ref: 'test-order' },
    stepKey: 'price#1',
  });
  return {
    summary: r.summary,
    lines: (r.output as { lines: Record<string, unknown>[] }).lines,
    order: r.order!,
  };
}

describe('pricing an order from a price book', () => {
  it('names the book on each line it priced, and prices a volume tier from its quantity', async () => {
    const book = await liveBook({ price: 300, volume: 280 });
    const one = await price('cus_contoso', [{ sku: 'MON-27', qty: 2 }]);
    expect(one.lines).toEqual([
      {
        sku: 'MON-27',
        unitPrice: 300,
        by: 'price_book',
        rule: book.name,
        bookId: book.id,
      },
    ]);
    expect(one.order.subtotal).toBe(600);
    expect(one.summary).toBe(`Subtotal $600.00 · 1 price book`);
    expect((await price('cus_contoso', [{ sku: 'MON-27', qty: 12 }])).lines[0]).toMatchObject({
      unitPrice: 280,
      bookId: book.id,
    });
  });

  it('prices a customer from their tier’s book, and no one outside it', async () => {
    const book = await liveBook({ price: 290 }, { tier: 'silver' });
    expect((await price('cus_fabrikam', [{ sku: 'MON-27', qty: 1 }])).lines[0]).toMatchObject({
      unitPrice: 290,
      bookId: book.id,
    });
    // Northwind is gold and Ada a consumer: neither pays the silver book's price.
    for (const customer of ['cus_northwind', 'cus_ada', undefined])
      expect((await price(customer, [{ sku: 'MON-27', qty: 1 }])).lines[0]).toMatchObject({
        unitPrice: 349,
        by: 'list',
        bookId: null,
      });
  });

  it('prefers the higher-priority book even where another is cheaper, then the lower price', async () => {
    await liveBook({ priority: 1, price: 200 }, { customerId: 'cus_northwind' });
    const high = await liveBook({ priority: 9, price: 320 }, { customerId: 'cus_northwind' });
    const also = await liveBook({ priority: 9, price: 310 }, { customerId: 'cus_northwind' });
    const priced = (await price('cus_northwind', [{ sku: 'MON-27', qty: 1 }])).lines[0];
    expect(priced).toMatchObject({ unitPrice: 310, bookId: also.id });
    expect(priced).not.toMatchObject({ bookId: high.id });
  });

  it('prices nothing from a draft book, a deactivated one, or one assigned to someone else', async () => {
    await liveBook({ status: 'draft', price: 100 }, { customerId: 'cus_fabrikam' });
    const off = await liveBook({ price: 100 }, { customerId: 'cus_fabrikam' });
    await priceBookStore(env).transition(off.id, 'active', 'inactive', Date.now());
    await liveBook({ price: 100 }, { customerId: 'cus_contoso' });
    const priced = (await price('cus_fabrikam', [{ sku: 'MON-27', qty: 1 }])).lines[0];
    expect(priced).toMatchObject({ unitPrice: 349, by: 'list' });
  });
});

describe('a cart and an agentic checkout', () => {
  it('prices a cart for the customer from the same book as the order, and a UCP buyer from none', async () => {
    const book = await liveBook({ price: 300 }, { customerId: 'cus_contoso' });
    const made = await api().createCart({
      title: 'Monitors',
      flowId: 'tpl-b2b-order',
      customerId: 'cus_contoso',
      createdBy: 'usr_pb_operator',
    });
    if (!made.ok) throw new Error(made.error);
    const adder = {
      kind: 'staff' as const,
      id: 'usr_pb_operator',
      name: 'op',
      role: 'operator' as const,
    };
    const added = await api().changeCart(
      made.id,
      { op: 'add', sku: 'MON-27', qty: 2 },
      await signedActor(adder, `cart:${made.id}`),
    );
    expect(added).toMatchObject({ ok: true });
    const cart = ((await api().cartSnapshot(made.id)) as CartState).cart!;
    const ordered = await price('cus_contoso', [{ sku: 'MON-27', qty: 2 }]);
    expect(cart.quote!.lines[0]).toMatchObject({ sku: 'MON-27', qty: 2, unitPrice: 300 });
    expect(cart.quote!.subtotal).toBe(ordered.order.subtotal);
    expect(ordered.lines[0]).toMatchObject({ bookId: book.id });

    // An agentic checkout is priced by the same flow nodes, for a buyer who has no customer, so no
    // book is assigned to it: the monitor stays at its list price.
    const shopper = await platform('pb_platform');
    const checkout = await ucp(shopper, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    expect(checkout.status).toBe(201);
    expect(checkout.body.line_items[0].item.price).toBe(34900);
  });
});

describe('REST writes', () => {
  it('lets a viewer read books and refuses a token every write, for what buyers pay', async () => {
    const created = await run(
      'create_price_book',
      { code: 'rest-book', name: 'REST book', priority: 2 },
      person('operator'),
    );
    expect(created).toMatchObject({ ok: true, value: { id: expect.stringMatching(/^pb_/) } });
    expect(await run('list_price_books', {}, staff('viewer'))).toMatchObject({
      ok: true,
      value: { books: expect.any(Array), total: expect.any(Number) },
    });
    expect(await run('get_price_book', { bookId: 'rest-book' }, staff('viewer'))).toMatchObject({
      ok: true,
      value: { book: { code: 'rest-book', status: 'draft' }, entryTotal: 0, next: null },
    });
    expect(await run('get_price_book', { bookId: 'nope' }, staff('viewer'))).toEqual({
      ok: false,
      error: 'No such price book.',
    });
    expect(
      await run('preview_price', { lines: [{ sku: 'MON-27' }] }, staff('viewer')),
    ).toMatchObject({ ok: true, value: { lines: [{ unitPrice: 349, source: 'list' }] } });

    const writes: [string, unknown][] = [
      ['create_price_book', { code: 'rest-token', name: 'Token' }],
      ['set_price_book_status', { bookId: 'rest-book', status: 'active' }],
      ['put_price_book_entries', { bookId: 'rest-book', entries: [{ sku: 'MON-27', price: 1 }] }],
      ['assign_price_book', { bookId: 'rest-book', tier: 'gold' }],
      ['put_contract_prices', { customerId: 'cus_contoso', prices: [{ sku: 'MON-27', price: 1 }] }],
    ];
    for (const [tool, input] of writes) {
      // A token, even an admin's, never changes what buyers pay.
      expect(await run(tool, input, staff('admin')), tool).toEqual({
        ok: false,
        status: 403,
        error: PERSON_CONFIRMS,
      });
      expect(await run(tool, input, person('viewer')), tool).toEqual({
        ok: false,
        error: 'This needs the Operator role.',
      });
    }
    // Nothing the refused calls asked for happened.
    expect(await priceBookStore(env).find('rest-token')).toBeUndefined();
    expect((await priceBookStore(env).find('rest-book'))?.status).toBe('draft');
  });

  it('runs the writes for a person and holds the lifecycle and the book’s own rules', async () => {
    const op = person('operator');
    const book = (await run('create_price_book', { code: 'rest-run', name: 'REST run' }, op)) as {
      value: { id: string };
    };
    const bookId = book.value.id;
    expect(
      await run('put_price_book_entries', { bookId, entries: [{ sku: 'MON-27', price: 305 }] }, op),
    ).toMatchObject({ ok: true });
    expect(await run('assign_price_book', { bookId, customerId: 'cus_contoso' }, op)).toMatchObject(
      {
        ok: true,
      },
    );
    expect(await run('assign_price_book', { bookId, customerId: 'cus_contoso' }, op)).toMatchObject(
      {
        ok: false,
        error: expect.stringMatching(/already assigned/),
      },
    );
    expect(await run('set_price_book_status', { bookId, status: 'inactive' }, op)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/can't become inactive/),
    });
    expect(await run('set_price_book_status', { bookId, status: 'active' }, op)).toMatchObject({
      ok: true,
    });
    expect(
      (await price('cus_contoso', [{ sku: 'MON-27', qty: 1 }])).lines[0]?.unitPrice,
    ).toBeLessThanOrEqual(305);
    expect(await run('set_price_book_status', { bookId, status: 'inactive' }, op)).toMatchObject({
      ok: true,
    });
    expect(await run('set_price_book_status', { bookId, status: 'archived' }, op)).toMatchObject({
      ok: true,
    });
    // Archived is for good.
    expect(await run('set_price_book_status', { bookId, status: 'active' }, op)).toMatchObject({
      ok: false,
    });
    expect(
      await run('put_price_book_entries', { bookId, entries: [{ sku: 'MON-27', price: 1 }] }, op),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/archived/) });
    // A body the tool won't take.
    expect(await run('set_price_book_status', { bookId, status: 'draft' }, op)).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
