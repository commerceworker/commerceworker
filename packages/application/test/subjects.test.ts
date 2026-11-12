import { EMPTY_ORDER_STATE, type OrderState, subjectTarget } from '@commerceworker/core';
import {
  InMemoryShopperAuth,
  InMemorySubjectStore,
  SUBJECT_FIXTURE,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  eraseDataSubject,
  eraseIfErased,
  eraseOrders,
  exportDataSubject,
  type SubjectPorts,
} from '../src/commerce';

const now = Date.UTC(2026, 10, 8);

function ports(running = new Set<string>(['sc2_o_mail'])) {
  const shoppers = new InMemoryShopperAuth();
  const deleted: string[] = [];
  const cartCalls: string[] = [];
  const p: SubjectPorts = {
    subjects: new InMemorySubjectStore(SUBJECT_FIXTURE),
    shoppers,
    files: {
      deletePrefix: async (prefix) => {
        deleted.push(prefix);
        return 1;
      },
    },
    orders: {
      snapshot: async () => ({ ...EMPTY_ORDER_STATE }) as OrderState,
      erasePersonalData: async (id) => (running.has(id) ? null : { held: true, title: 'Erased' }),
    },
    carts: {
      subjectExport: async (id) => ({ id }),
      customerExport: async (id) => ({ id, shipTo: { city: 'London' } }),
      eraseSubject: async (id) => cartCalls.push(`erase ${id}`),
      eraseShipTo: async (id) => {
        cartCalls.push(`shipTo ${id}`);
        return true;
      },
      eraseFromEvents: async (id) => cartCalls.push(`events ${id}`),
    },
  };
  return { p, deleted, cartCalls, running, shoppers };
}

describe('data subject requests', () => {
  it('exports what is held about a person, including their carts and checkouts', async () => {
    const { p } = ports();
    const x = await exportDataSubject(p, ' Ada@Example.com ', now);
    expect(x).toMatchObject({
      email: 'ada@example.com',
      exportedAt: now,
      teamMember: true,
      truncated: false,
    });
    expect(x.orders.map((o) => o.id).sort()).toEqual(['sc2_o_acct', 'sc2_o_guest', 'sc2_o_mail']);
    expect(x.carts).toEqual([
      { id: 'sc2_cart_ext' },
      { id: 'sc2_cart_staff', shipTo: { city: 'London' } },
    ]);
    // Hers by email, and those opened for her account (a hosted checkout names its customer).
    expect(x.checkouts.map((c) => c.id).sort()).toEqual([
      'sc2_chk_acct',
      'sc2_chk_acct_placed',
      'sc2_chk_open',
      'sc2_chk_placed',
    ]);
    // Her account's company, and the member rows with her email.
    expect(x.companies).toMatchObject([
      { customerId: 'sc2_acct', legalName: 'Lovelace Engines Ltd' },
    ]);
    expect(x.companyMembers).toMatchObject([{ id: 'sc2_mem_ada' }]);
    // Her company's purchase orders and the one she placed, with what they say of people.
    expect(x.purchaseOrders.map((o) => o.id).sort()).toEqual(['sc2_po_acct', 'sc2_po_ada']);
    expect(x.purchaseOrders.find((o) => o.id === 'sc2_po_acct')).toMatchObject({
      notes: 'Call Charles on arrival',
      poNumber: 'A-1',
    });
    expect(x.quotes.map((q) => q.id).sort()).toEqual(['sc2_qt_acct', 'sc2_qt_ada']);
    // Who in the team drafted it isn't the subject's to be given.
    expect(x.quotes.every((q) => !('createdBy' in q))).toBe(true);
    expect(x.quotes.find((q) => q.id === 'sc2_qt_acct')).toMatchObject({
      notes: 'Charles wants net 60',
      name: 'Spring deal',
    });
    expect(x.inboundEmails.every((r) => !('r2Key' in r))).toBe(true);
  });

  it('refuses while one of their orders is still running', async () => {
    const { p } = ports();
    expect(await eraseDataSubject(p, 'ada@example.com', now)).toEqual({
      ok: false,
      reason: 'active_orders',
      orders: ['sc2_o_mail'],
    });
  });

  it('erases their orders, carts, files and accounts once nothing runs', async () => {
    const { p, deleted, cartCalls, running } = ports();
    running.clear();
    // The index says running: mark it ended for this case.
    const store = p.subjects as InMemorySubjectStore;
    (store as unknown as { f: { orders: { id: string; status: string }[] } }).f.orders.find(
      (o) => o.id === 'sc2_o_mail',
    )!.status = 'completed';
    const r = await eraseDataSubject(p, 'ada@example.com', now);
    expect(r).toMatchObject({
      ok: true,
      done: true,
      orders: 3,
      customers: 1,
      carts: 2,
      taxCertificates: 1,
      addresses: 1,
      // Charles, of her own company, and Ada herself in another one.
      companyMembers: 2,
      // Her company's PO and the one she placed.
      purchaseOrders: 2,
      // Her company's quote and the one for her.
      quotes: 2,
    });
    // Their words are gone from them; the number and status stay.
    const after = (await p.subjects.rows(await p.subjects.subject('grace@example.com'), []))
      .purchaseOrders;
    expect(after.find((o) => o.id === 'sc2_po_ada')).toMatchObject({
      notes: null,
      buyerId: null,
      poNumber: 'G-1',
      status: 'fulfilled',
    });
    const quotesAfter = (await p.subjects.rows(await p.subjects.subject('grace@example.com'), []))
      .quotes;
    expect(quotesAfter.find((q) => q.id === 'sc2_qt_ada')).toMatchObject({
      notes: null,
      buyerId: null,
      name: 'Autumn deal',
      status: 'sent',
    });
    expect(deleted).toContain('orders/sc2_o_acct/');
    expect(deleted).toContain('inbound/sc2_in_2.eml');
    expect(deleted).toContain('customers/sc2_acct/tax-certificates/');
    expect(cartCalls).toEqual([
      'erase sc2_cart_ext',
      'shipTo sc2_cart_staff',
      'events sc2_cart_staff',
      'events sc2_cart_staff',
    ]);
    expect(
      await p.subjects.orders(await p.subjects.subject('ada@example.com'), { limit: 10 }),
    ).toEqual([]);
  });
});

describe('a shopper’s sign-in in a data subject request', () => {
  async function seeded() {
    const t = ports(new Set());
    // Nothing of Ada's is running, so her erasure goes ahead.
    (t.p.subjects as unknown as { f: { orders: { id: string; status: string }[] } }).f.orders.find(
      (o) => o.id === 'sc2_o_mail',
    )!.status = 'completed';
    // Ada and Grace each signed in on the storefront: a pending sign-in and a session.
    for (const [email, c] of [
      ['ada@example.com', 'a'],
      ['grace@example.com', 'b'],
    ] as const) {
      await t.shoppers.issueSignIn(
        {
          email,
          codeHash: c.repeat(64),
          linkHash: `l${c}`.padEnd(64, '0'),
          createdAt: now - 1000,
          expiresAt: now + 1000,
        },
        { cooldownMs: 0, lockoutMs: 0, maxAttempts: 5 },
      );
      await t.shoppers.createSession({
        tokenHash: `s${c}`.padEnd(64, '0'),
        email,
        createdAt: now - 1000,
        expiresAt: now + 1e6,
      });
    }
    return t;
  }

  it('exports their sign-ins and sessions, with no hash and no one else’s', async () => {
    const { p } = await seeded();
    const x = await exportDataSubject(p, 'Ada@Example.com', now);
    expect(x.shopperSignIns).toEqual([
      {
        email: 'ada@example.com',
        createdAt: now - 1000,
        expiresAt: now + 1000,
        attempts: 0,
        usedAt: null,
      },
    ]);
    expect(x.shopperSessions).toEqual([
      { email: 'ada@example.com', createdAt: now - 1000, expiresAt: now + 1e6, lastSeenAt: null },
    ]);
    expect(JSON.stringify(x)).not.toMatch(/a{64}|sa0{62}|la0{62}/);
  });

  it('erases them, ends every session, and leaves other shoppers signed in', async () => {
    const { p, shoppers } = await seeded();
    const r = await eraseDataSubject(p, 'ada@example.com', now);
    expect(r).toMatchObject({ ok: true, shopperSignIns: 1, shopperSessions: 1 });
    expect(await shoppers.session(`sa`.padEnd(64, '0'), now)).toBeNull();
    expect(await shoppers.session(`sb`.padEnd(64, '0'), now)).not.toBeNull();
    expect((await exportDataSubject(p, 'ada@example.com', now)).shopperSessions).toEqual([]);
    // A second request finds nothing left to delete.
    expect(await eraseDataSubject(p, 'ada@example.com', now)).toMatchObject({
      shopperSignIns: 0,
      shopperSessions: 0,
    });
  });

  it('keeps them while an order still runs, as it keeps everything', async () => {
    const t = ports();
    await t.shoppers.createSession({
      tokenHash: 'c'.repeat(64),
      email: 'ada@example.com',
      createdAt: now,
      expiresAt: now + 1e6,
    });
    expect(await eraseDataSubject(t.p, 'ada@example.com', now)).toMatchObject({ ok: false });
    expect(await t.shoppers.session('c'.repeat(64), now)).not.toBeNull();
  });
});

describe('erasure after the fact', () => {
  it("erases a cart that names someone already erased, and nobody else's", async () => {
    const { p, cartCalls } = ports();
    expect(await eraseIfErased(p, 'sc2_cart_new', 'ada@example.com')).toBe(false);
    // The erasure's audit event, which the caller writes once the erasure is done.
    const erased = {
      ...p,
      subjects: new InMemorySubjectStore({
        ...SUBJECT_FIXTURE,
        audit: [
          {
            id: 'aud_1',
            action: 'personal_data.erased',
            target: await subjectTarget('ada@example.com'),
          },
        ],
      }),
    };
    expect(await eraseIfErased(erased, 'sc2_cart_new', 'ada@example.com')).toBe(true);
    expect(cartCalls).toEqual(['erase sc2_cart_new']);
    expect(await eraseIfErased(erased, 'sc2_cart_new', 'grace@example.com')).toBe(false);
    expect(await eraseIfErased(erased, 'sc2_cart_new', '')).toBe(false);
  });

  it("erases finished orders' files and rows, skipping one that runs again", async () => {
    const { p, deleted } = ports(new Set(['sc2_o_mail']));
    const r = await eraseOrders(
      p,
      [
        { id: 'sc2_o_acct', title: 'Ada’s order' },
        { id: 'sc2_o_mail', title: 'By email' },
      ],
      ['Ada'],
      now,
    );
    expect(r).toMatchObject({ orders: 1, documents: 1, refused: ['sc2_o_mail'] });
    expect(deleted).toEqual(['orders/sc2_o_acct/']);
  });

  it("takes an order no agent holds off the subject's words by its indexed title", async () => {
    const { p } = ports();
    const unheld = {
      ...p,
      orders: { ...p.orders, erasePersonalData: async () => ({ held: false, title: '' }) },
    };
    const marked: unknown[] = [];
    const store = p.subjects as InMemorySubjectStore;
    const mark = store.markOrderErased.bind(store);
    store.markOrderErased = async (id, set, at) => {
      marked.push([id, set]);
      return mark(id, set, at);
    };
    await eraseOrders(unheld, [{ id: 'sc2_o_acct', title: 'Ada’s order for Ada' }], ['Ada'], now);
    const [[id, set]] = marked as [[string, { title: string; clearReason: boolean }]];
    expect(id).toBe('sc2_o_acct');
    expect(set.clearReason).toBe(true);
    expect(set.title).not.toContain('Ada');
  });
});
