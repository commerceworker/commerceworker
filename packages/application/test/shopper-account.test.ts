import {
  type BuyerOrderView,
  hashShopperSecret,
  SHOPPER_ADDRESS_ORDERS,
  SHOPPER_ORDERS_PAGE,
  SHOPPER_SESSION_TTL_MS,
} from '@commerceworker/core';
import {
  InMemoryAddressBook,
  InMemoryOrderQueries,
  InMemoryShopperAuth,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  forgetShopperAddress,
  type ShopperAccountPorts,
  shopperAddresses,
  shopperOrder,
  shopperOrders,
} from '../src/commerce';

const now = 1_800_000_000_000;
const DAY = 86_400_000;

const PAT = 'pat@example.com';
const SECRET = 'a'.repeat(64);

type OrderSeed = {
  id: string;
  contactEmail: string | null;
  createdAt: number;
  erasedAt?: number | null;
  shipTo?: unknown;
};

const address = (line1: string, name = 'Pat Buyer') => ({
  name,
  line1,
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'US',
});

async function setup(
  seed: OrderSeed[] = [],
  customers: { id: string; email: string; kind: string }[] = [],
) {
  const shoppers = new InMemoryShopperAuth();
  const tokenHash = await hashShopperSecret(SECRET);
  await shoppers.createSession({
    tokenHash,
    email: PAT,
    createdAt: now - DAY,
    expiresAt: now - DAY + SHOPPER_SESSION_TTL_MS,
  });
  const book = new InMemoryAddressBook({ customers });
  const viewed: string[] = [];
  const ports: ShopperAccountPorts = {
    shoppers,
    orders: new InMemoryOrderQueries({
      orders: seed.map((o) => ({
        id: o.id,
        title: o.id,
        status: 'completed',
        model: 'b2c',
        channel: 'web',
        customerId: null,
        total: 25,
        currency: 'USD',
        fxRate: 1,
        waitingOn: null,
        updatedAt: o.createdAt,
        ...o,
      })),
    }),
    addresses: book,
    views: {
      async read(orderId) {
        viewed.push(orderId);
        const view: BuyerOrderView = {
          id: orderId,
          ref: `#${orderId.slice(-6)}`,
          status: 'completed',
          placedAt: now,
          currency: 'USD',
          lines: [],
          subtotal: 25,
          shipping: 0,
          tax: 0,
          total: 25,
          shipTo: [],
          shipments: [],
        };
        return { view, recipient: PAT };
      },
    },
    shipTos: { read: async (id) => seed.find((o) => o.id === id)?.shipTo ?? null },
  };
  return { ports, book, shoppers, tokenHash, viewed };
}

const mine = (n: number, over: Partial<OrderSeed> = {}): OrderSeed => ({
  id: `ord_mine_${String(n).padStart(3, '0')}`,
  contactEmail: PAT,
  createdAt: now - n * 1000,
  ...over,
});

describe('a shopper’s orders', () => {
  it('lists only the orders placed under the session’s address, newest first', async () => {
    const { ports, tokenHash } = await setup([
      mine(2),
      mine(1),
      { id: 'ord_other', contactEmail: 'other@example.com', createdAt: now },
      { id: 'ord_none', contactEmail: null, createdAt: now },
      mine(3, { erasedAt: now }),
    ]);
    const page = await shopperOrders(ports, tokenHash, undefined, now);
    expect(page).toEqual({
      email: PAT,
      orders: [
        {
          id: 'ord_mine_001',
          ref: '#ne_001',
          placedAt: now - 1000,
          status: 'completed',
          currency: 'USD',
          total: 25,
        },
        expect.objectContaining({ id: 'ord_mine_002' }),
      ],
      next: null,
    });
  });

  it('pages by keyset and walks every order once', async () => {
    const total = SHOPPER_ORDERS_PAGE + 5;
    const { ports, tokenHash } = await setup(Array.from({ length: total }, (_, i) => mine(i + 1)));
    const first = await shopperOrders(ports, tokenHash, undefined, now);
    expect(first!.orders).toHaveLength(SHOPPER_ORDERS_PAGE);
    expect(first!.next).not.toBeNull();
    const second = await shopperOrders(ports, tokenHash, first!.next, now);
    expect(second!.orders).toHaveLength(5);
    expect(second!.next).toBeNull();
    const ids = [...first!.orders, ...second!.orders].map((o) => o.id);
    expect(new Set(ids).size).toBe(total);
  });

  it('starts over from the top for a cursor that is not one', async () => {
    const { ports, tokenHash } = await setup([mine(1)]);
    for (const bad of ['nope', '1:../x', 5, null, { createdAt: 0 }]) {
      const page = await shopperOrders(ports, tokenHash, bad, now);
      expect(page!.orders.map((o) => o.id)).toEqual(['ord_mine_001']);
    }
  });

  it('answers nothing with no session: unknown, ended and expired alike', async () => {
    const { ports, tokenHash, shoppers } = await setup([mine(1)]);
    expect(
      await shopperOrders(ports, await hashShopperSecret('b'.repeat(64)), undefined, now),
    ).toBeNull();
    // What is stored is a hash, not a secret: presenting the stored hash as a secret hashes again.
    expect(
      await shopperOrders(ports, await hashShopperSecret(tokenHash), undefined, now),
    ).toBeNull();
    expect(
      await shopperOrders(ports, tokenHash, undefined, now - DAY + SHOPPER_SESSION_TTL_MS),
    ).toBeNull();
    await shoppers.endSession(tokenHash);
    expect(await shopperOrders(ports, tokenHash, undefined, now)).toBeNull();
  });
});

describe('one of a shopper’s orders', () => {
  it('shows the buyer-safe view of an order placed under the address', async () => {
    const { ports, tokenHash } = await setup([mine(1, { contactEmail: 'PAT@example.com' })]);
    expect(await shopperOrder(ports, tokenHash, 'ord_mine_001', now)).toMatchObject({
      id: 'ord_mine_001',
      total: 25,
    });
  });

  it('answers another address’s order, an erased one and an unknown id the same, and reads nothing', async () => {
    const { ports, tokenHash, viewed } = await setup([
      { id: 'ord_other', contactEmail: 'other@example.com', createdAt: now },
      mine(1, { erasedAt: now }),
    ]);
    const answers = [
      await shopperOrder(ports, tokenHash, 'ord_other', now),
      await shopperOrder(ports, tokenHash, 'ord_mine_001', now),
      await shopperOrder(ports, tokenHash, 'ord_unknown', now),
      await shopperOrder(ports, tokenHash, '', now),
      await shopperOrder(ports, tokenHash, 'x'.repeat(101), now),
      await shopperOrder(ports, tokenHash, { id: 'ord_other' }, now),
      await shopperOrder(ports, tokenHash, ['ord_other'], now),
    ];
    expect(answers).toEqual(Array(answers.length).fill(null));
    expect(viewed).toEqual([]);
  });

  it('answers nothing for a session that has ended, even for the shopper’s own order', async () => {
    const { ports, tokenHash, shoppers } = await setup([mine(1)]);
    await shoppers.endSession(tokenHash);
    expect(await shopperOrder(ports, tokenHash, 'ord_mine_001', now)).toBeNull();
  });
});

describe('a shopper’s addresses', () => {
  it('lists the places of their own orders once each, newest first', async () => {
    const { ports, tokenHash } = await setup([
      mine(3, { shipTo: address('1 Main St') }),
      mine(1, { shipTo: address('9 Oak Ave', 'Pat') }),
      // The same place as the oldest, typed differently: one place.
      mine(2, { shipTo: { ...address('1 MAIN ST'), name: 'P. Buyer' } }),
      mine(4, { shipTo: 'a string is no address' }),
      mine(5, { shipTo: null }),
      {
        id: 'ord_other',
        contactEmail: 'other@example.com',
        createdAt: now,
        shipTo: address('2 Elm'),
      },
      mine(6, { erasedAt: now, shipTo: address('3 Erased Rd') }),
    ]);
    const out = await shopperAddresses(ports, tokenHash, now);
    expect(out!.email).toBe(PAT);
    expect(out!.addresses.map((a) => [a.line1, a.source, a.id])).toEqual([
      ['9 Oak Ave', 'order', 'order:ord_mine_001'],
      ['1 MAIN ST', 'order', 'order:ord_mine_002'],
    ]);
  });

  it('adds the address book’s entries for a consumer customer with the email, never a business’s', async () => {
    const { ports, tokenHash, book } = await setup(
      [mine(1, { shipTo: address('9 Oak Ave') })],
      [
        { id: 'cus_consumer', email: PAT, kind: 'consumer' },
        { id: 'cus_business', email: PAT, kind: 'business' },
      ],
    );
    const remember = (customerId: string, line1: string, at: number) =>
      book.remember({
        customerId,
        orderId: `ord_${line1}`,
        key: line1.toLowerCase(),
        address: { ...address(line1), line1 } as never,
        at,
      });
    await remember('cus_consumer', '5 Pine Rd', now - 10 * DAY);
    await remember('cus_business', '77 Dock St', now);
    const out = await shopperAddresses(ports, tokenHash, now);
    expect(out!.addresses.map((a) => [a.line1, a.source])).toEqual([
      ['9 Oak Ave', 'order'],
      ['5 Pine Rd', 'book'],
    ]);
    expect(out!.addresses.find((a) => a.source === 'book')!.id).toMatch(/^book:/);
  });

  it('keeps the book’s entry when an order shipped to the same place', async () => {
    const { ports, tokenHash, book } = await setup(
      [mine(1, { shipTo: address('9 Oak Ave') })],
      [{ id: 'cus_consumer', email: PAT, kind: 'consumer' }],
    );
    await book.remember({
      customerId: 'cus_consumer',
      orderId: 'ord_old',
      key: ['9 oak ave', '', 'springfield', 'il', '62701', 'us'].join('|'),
      address: address('9 Oak Ave') as never,
      at: now - 5 * DAY,
    });
    const out = await shopperAddresses(ports, tokenHash, now);
    expect(out!.addresses.map((a) => [a.line1, a.source])).toEqual([['9 Oak Ave', 'book']]);
  });

  it('reads the ship-to of only the newest few orders', async () => {
    const many = SHOPPER_ADDRESS_ORDERS + 5;
    const seed = Array.from({ length: many }, (_, i) =>
      mine(i + 1, { shipTo: address(`${i + 1} Long Rd`) }),
    );
    const { ports, tokenHash } = await setup(seed);
    const read: string[] = [];
    const out = await shopperAddresses(
      {
        ...ports,
        shipTos: {
          read: async (id) => {
            read.push(id);
            return ports.shipTos.read(id);
          },
        },
      },
      tokenHash,
      now,
    );
    expect(read).toHaveLength(SHOPPER_ADDRESS_ORDERS);
    expect(out!.addresses).toHaveLength(SHOPPER_ADDRESS_ORDERS);
  });

  it('answers nothing with no session', async () => {
    const { ports, shoppers, tokenHash } = await setup([mine(1, { shipTo: address('9 Oak Ave') })]);
    await shoppers.endSession(tokenHash);
    expect(await shopperAddresses(ports, tokenHash, now)).toBeNull();
  });
});

describe('forgetting an address', () => {
  const seeded = async () => {
    const s = await setup(
      [mine(1, { shipTo: address('9 Oak Ave') })],
      [
        { id: 'cus_consumer', email: PAT, kind: 'consumer' },
        { id: 'cus_business', email: PAT, kind: 'business' },
        { id: 'cus_other', email: 'other@example.com', kind: 'consumer' },
      ],
    );
    const keep = async (customerId: string, line1: string) => {
      await s.book.remember({
        customerId,
        orderId: `ord_${line1}`,
        key: line1.toLowerCase(),
        address: address(line1) as never,
        at: now - DAY,
      });
      return (await s.book.addresses(customerId))[0]!.id;
    };
    return { ...s, keep };
  };

  it('forgets a book entry once, and the repeat does nothing', async () => {
    const { ports, tokenHash, keep } = await seeded();
    const id = `book:${await keep('cus_consumer', '5 Pine Rd')}`;
    expect(await forgetShopperAddress(ports, tokenHash, id, now)).toBe(true);
    expect(await forgetShopperAddress(ports, tokenHash, id, now)).toBe(false);
    const out = await shopperAddresses(ports, tokenHash, now);
    expect(out!.addresses.map((a) => a.line1)).toEqual(['9 Oak Ave']);
  });

  it('forgets nothing it was not scoped to: another’s, a business’s, an order’s or a forged id', async () => {
    const { ports, tokenHash, book, keep } = await seeded();
    const other = `book:${await keep('cus_other', '1 Other St')}`;
    const business = `book:${await keep('cus_business', '2 Biz St')}`;
    for (const id of [
      other,
      business,
      'order:ord_mine_001',
      'book:',
      'book:nope',
      'nope',
      7,
      null,
    ]) {
      expect(await forgetShopperAddress(ports, tokenHash, id, now)).toBe(false);
    }
    expect(await book.addresses('cus_other')).toHaveLength(1);
    expect(await book.addresses('cus_business')).toHaveLength(1);
  });

  it('forgets nothing without a session', async () => {
    const { ports, tokenHash, shoppers, keep } = await seeded();
    const id = `book:${await keep('cus_consumer', '5 Pine Rd')}`;
    await shoppers.endSession(tokenHash);
    expect(await forgetShopperAddress(ports, tokenHash, id, now)).toBe(false);
  });
});
