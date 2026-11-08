import { EMPTY_ORDER_STATE, type OrderState } from '@commerceworker/core';
import { InMemorySubjectStore, SUBJECT_FIXTURE } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { eraseDataSubject, exportDataSubject, type SubjectPorts } from '../src/commerce';

const now = Date.UTC(2026, 10, 8);

function ports(running = new Set<string>(['sc2_o_mail'])) {
  const deleted: string[] = [];
  const cartCalls: string[] = [];
  const p: SubjectPorts = {
    subjects: new InMemorySubjectStore(SUBJECT_FIXTURE),
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
  return { p, deleted, cartCalls, running };
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
    expect(x.checkouts).toHaveLength(2);
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
