/**
 * The behaviour every `SubjectStore` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). The subject is `ada@example.com`; ids start `sc2_`.
 */
import { ERASED } from '@commerceworker/core';
import type { SubjectStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { SubjectFixture } from './subject-store';

const ADA = 'ada@example.com';

export const SUBJECT_FIXTURE: SubjectFixture = {
  customers: [
    { id: 'sc2_acct', name: 'Ada Lovelace', email: 'Ada@Example.com' },
    { id: 'sc2_other', name: 'Grace', email: 'grace@example.com' },
  ],
  users: [{ id: 'sc2_user', email: ADA }],
  orders: [
    // By their account, by their contact email, and started by an email they sent.
    {
      id: 'sc2_o_acct',
      title: 'Ada’s order',
      status: 'completed',
      contactEmail: null,
      customerId: 'sc2_acct',
    },
    {
      id: 'sc2_o_guest',
      title: 'Guest',
      status: 'completed',
      contactEmail: 'ADA@example.com',
      customerId: null,
    },
    {
      id: 'sc2_o_mail',
      title: 'By email',
      status: 'running',
      contactEmail: null,
      customerId: null,
    },
    {
      id: 'sc2_o_grace',
      title: 'Not hers',
      status: 'completed',
      contactEmail: null,
      customerId: 'sc2_other',
    },
  ],
  inboundEmails: [
    { id: 'sc2_in_1', sender: ADA, orderId: 'sc2_o_mail', r2Key: 'inbound/sc2_in_1.eml' },
    { id: 'sc2_in_2', sender: ADA, orderId: null, r2Key: 'inbound/sc2_in_2.eml' },
  ],
  messages: [
    { id: 'sc2_m_1', orderId: 'sc2_o_acct', recipient: 'billing@corp.example' },
    { id: 'sc2_m_2', orderId: 'sc2_o_grace', recipient: ADA },
  ],
  documents: [{ orderId: 'sc2_o_acct', key: 'orders/sc2_o_acct/invoice/a.html', kind: 'invoice' }],
  taxCertificates: [{ id: 'sc2_cert', customerId: 'sc2_acct', regions: '["US-NY"]' }],
  addresses: [{ id: 'sc2_addr', customerId: 'sc2_acct' }],
  companies: [{ customerId: 'sc2_acct', legalName: 'Lovelace Engines Ltd', taxId: 'GB123' }],
  companyMembers: [
    // Ada is a member of another company, and Charles one of her own company's.
    {
      id: 'sc2_mem_ada',
      companyId: 'sc2_other',
      name: 'Ada',
      email: 'ADA@Example.com',
      status: 'active',
    },
    {
      id: 'sc2_mem_charles',
      companyId: 'sc2_acct',
      name: 'Charles',
      email: 'charles@corp.example',
      status: 'active',
    },
  ],
  purchaseOrders: [
    // One of her company's, placed by Charles; one Ada placed for another company; one not hers.
    {
      id: 'sc2_po_acct',
      companyId: 'sc2_acct',
      buyerId: 'sc2_mem_charles',
      poNumber: 'A-1',
      status: 'ordered',
      shipTo: {
        name: 'Charles',
        line1: '1 Dock Rd',
        line2: 'Bay 2',
        city: 'York',
        postalCode: 'Y1',
        country: 'GB',
      },
      notes: 'Call Charles on arrival',
    },
    {
      id: 'sc2_po_ada',
      companyId: 'sc2_other',
      buyerId: 'sc2_mem_ada',
      poNumber: 'G-1',
      status: 'fulfilled',
      shipTo: { line1: '2 Mill Ln', city: 'Leeds', postalCode: 'L1', country: 'GB' },
      notes: 'Ada’s note',
    },
    {
      id: 'sc2_po_grace',
      companyId: 'sc2_other',
      buyerId: null,
      poNumber: 'G-2',
      status: 'submitted',
      shipTo: { name: 'Grace', line1: '3 Quay', city: 'Hull', postalCode: 'H1', country: 'GB' },
      notes: 'Grace’s note',
    },
  ],
  quotes: [
    // One for her company, for Charles; one for Ada at another company; one not hers.
    {
      id: 'sc2_qt_acct',
      companyId: 'sc2_acct',
      buyerId: 'sc2_mem_charles',
      name: 'Spring deal',
      status: 'accepted',
      notes: 'Charles wants net 60',
      createdBy: 'usr_staff',
    },
    {
      id: 'sc2_qt_ada',
      companyId: 'sc2_other',
      buyerId: 'sc2_mem_ada',
      name: 'Autumn deal',
      status: 'sent',
      notes: 'Ada’s terms',
    },
    {
      id: 'sc2_qt_grace',
      companyId: 'sc2_other',
      buyerId: null,
      name: 'Winter deal',
      status: 'draft',
      notes: 'Grace’s note',
    },
  ],
  checkouts: [
    { id: 'sc2_chk_placed', email: ADA, orderId: 'sc2_o_guest' },
    { id: 'sc2_chk_open', email: ADA, orderId: null },
    // Hosted checkouts name their customer, and may carry no email yet.
    { id: 'sc2_chk_acct', email: '', orderId: null, customerId: 'sc2_acct' },
    { id: 'sc2_chk_acct_placed', email: '', orderId: 'sc2_o_acct', customerId: 'sc2_acct' },
    { id: 'sc2_chk_other', email: '', orderId: null, customerId: 'sc2_other' },
  ],
  carts: [
    { id: 'sc2_cart_ext', buyerId: ADA, customerId: null, pluginId: 'shop', orderId: null },
    {
      id: 'sc2_cart_staff',
      buyerId: null,
      customerId: 'sc2_acct',
      pluginId: null,
      orderId: 'sc2_o_acct',
    },
  ],
  audit: [{ id: 'sc2_audit', action: 'personal_data.erased', target: 'hash:ada' }],
};

export function describeSubjectStoreContract(
  name: string,
  make: (fixture: SubjectFixture) => Promise<SubjectStore>,
) {
  describe(`${name}: the data subject store contract`, () => {
    const fresh = () => make(SUBJECT_FIXTURE);

    it('finds a person by email: accounts, orders their email started, and a team member', async () => {
      const s = await fresh();
      const ada = await s.subject(ADA);
      expect(ada.accounts.map((a) => a.id)).toEqual(['sc2_acct']);
      expect(ada.viaEmail).toEqual(['sc2_o_mail']);
      expect(ada.teamMember).toBe(true);
      expect((await s.subject('nobody@example.com')).teamMember).toBe(false);
    });

    it('lists their orders not yet erased, and the running ones on their own', async () => {
      const s = await fresh();
      const ada = await s.subject(ADA);
      expect((await s.orders(ada, { limit: 10 })).map((o) => o.id).sort()).toEqual([
        'sc2_o_acct',
        'sc2_o_guest',
        'sc2_o_mail',
      ]);
      expect((await s.orders(ada, { active: true, limit: 10 })).map((o) => o.id)).toEqual([
        'sc2_o_mail',
      ]);
      await s.markOrderErased('sc2_o_guest', { title: 'Guest', clearReason: true }, 5);
      expect((await s.orders(ada, { limit: 10 })).map((o) => o.id).sort()).toEqual([
        'sc2_o_acct',
        'sc2_o_mail',
      ]);
    });

    it('reads what is held about them, and their carts and checkouts', async () => {
      const s = await fresh();
      const ada = await s.subject(ADA);
      const rows = await s.rows(ada, ['sc2_o_acct']);
      expect(rows.messages.map((m) => m.id).sort()).toEqual(['sc2_m_1', 'sc2_m_2']);
      expect(rows.documents.map((d) => d.key)).toEqual(['orders/sc2_o_acct/invoice/a.html']);
      expect(rows.inboundEmails).toHaveLength(2);
      expect(rows.taxCertificates).toHaveLength(1);
      expect(rows.addresses).toHaveLength(1);
      expect(rows.companies.map((c) => c.customerId)).toEqual(['sc2_acct']);
      expect(rows.companyMembers.map((m) => m.id)).toEqual(['sc2_mem_ada']);
      // Her company's POs, and the one she placed; not Grace's.
      expect(rows.purchaseOrders.map((p) => p.id).sort()).toEqual(['sc2_po_acct', 'sc2_po_ada']);
      // Her company's quotes, and the one for her; not Grace's.
      expect(rows.quotes.map((q) => q.id).sort()).toEqual(['sc2_qt_acct', 'sc2_qt_ada']);
      expect((await s.checkouts(ADA, [], 10)).map((c) => c.id).sort()).toEqual([
        'sc2_chk_open',
        'sc2_chk_placed',
      ]);
      // With their accounts, the checkouts made for them too; not another account's.
      expect((await s.checkouts(ADA, ['sc2_acct'], 10)).map((c) => c.id).sort()).toEqual([
        'sc2_chk_acct',
        'sc2_chk_acct_placed',
        'sc2_chk_open',
        'sc2_chk_placed',
      ]);
      expect(await s.buyerCarts(ADA, 10)).toEqual(['sc2_cart_ext']);
      expect(await s.buyerCarts('', 10)).toEqual([]);
      expect(await s.customerCarts(['sc2_acct'], 10)).toEqual(['sc2_cart_staff']);
      expect(await s.orderCarts(['sc2_o_acct'])).toEqual(['sc2_cart_staff']);
      expect(await s.wasErased('hash:ada')).toBe(true);
      expect(await s.wasErased('hash:other')).toBe(false);
    });

    it('blanks the people in their purchase orders, keeping number, status and the rest of the address', async () => {
      const s = await fresh();
      const ada = await s.subject(ADA);
      const grace = await s.subject('grace@example.com');
      const shipOf = (p: Record<string, unknown>) =>
        typeof p.shipTo === 'string' ? JSON.parse(p.shipTo) : p.shipTo;
      // Her company's PO and the one she placed; Grace's own is not hers.
      expect(await s.erasePurchaseOrders(ada)).toBe(2);
      const mine = (await s.rows(ada, [])).purchaseOrders;
      // The one she placed no longer names her, so only her company's is found by her.
      expect(mine.map((p) => p.id)).toEqual(['sc2_po_acct']);
      expect(mine[0]).toMatchObject({
        poNumber: 'A-1',
        status: 'ordered',
        buyerId: null,
        notes: null,
      });
      expect(shipOf(mine[0] as Record<string, unknown>)).toEqual({
        line1: '',
        city: 'York',
        postalCode: 'Y1',
        country: 'GB',
      });
      const theirs = (await s.rows(grace, [])).purchaseOrders;
      const byId = new Map(theirs.map((p) => [p.id, p]));
      expect(byId.get('sc2_po_ada')).toMatchObject({
        buyerId: null,
        notes: null,
        status: 'fulfilled',
      });
      expect(shipOf(byId.get('sc2_po_ada') as Record<string, unknown>)).toEqual({
        line1: '',
        city: 'Leeds',
        postalCode: 'L1',
        country: 'GB',
      });
      // Not hers: untouched.
      expect(byId.get('sc2_po_grace')).toMatchObject({ notes: 'Grace’s note' });
      expect(shipOf(byId.get('sc2_po_grace') as Record<string, unknown>)).toMatchObject({
        name: 'Grace',
        line1: '3 Quay',
      });
      // Again: her company's is still hers and is blanked (as it already is); hers is not.
      expect(await s.erasePurchaseOrders(ada)).toBe(1);
    });

    it('blanks the people in their quotes, keeping name, status and the rest', async () => {
      const s = await fresh();
      const ada = await s.subject(ADA);
      const grace = await s.subject('grace@example.com');
      expect(await s.eraseQuotes(ada)).toBe(2);
      const mine = (await s.rows(ada, [])).quotes;
      // The one for her no longer names her, so only her company's is found by her.
      expect(mine.map((q) => q.id)).toEqual(['sc2_qt_acct']);
      expect(mine[0]).toMatchObject({
        name: 'Spring deal',
        status: 'accepted',
        buyerId: null,
        notes: null,
      });
      const byId = new Map((await s.rows(grace, [])).quotes.map((q) => [q.id, q]));
      expect(byId.get('sc2_qt_ada')).toMatchObject({
        name: 'Autumn deal',
        status: 'sent',
        buyerId: null,
        notes: null,
      });
      // Not hers: untouched.
      expect(byId.get('sc2_qt_grace')).toMatchObject({ notes: 'Grace’s note' });
      expect(await s.eraseQuotes(ada)).toBe(1);
    });

    it('blanks the company members with their email, keeping the rows, once', async () => {
      const s = await fresh();
      const ada = await s.subject(ADA);
      expect(await s.eraseMembers(ADA)).toBe(1);
      expect((await s.rows(ada, [])).companyMembers).toEqual([]);
      expect(await s.eraseMembers(ADA)).toBe(0);
    });

    it("erases their orders' rows, then what isn't tied to an order, then their accounts", async () => {
      const s = await fresh();
      expect(await s.eraseOrderRows(['sc2_o_acct', 'sc2_o_mail', 'sc2_o_guest'])).toEqual({
        messages: 1,
        inboundEmails: 1,
      });
      const ada = await s.subject(ADA);
      const after = await s.rows(ada, ['sc2_o_acct']);
      expect(after.documents).toEqual([]);
      // The order's message stays, blanked; the one sent to them on another order is erased later.
      expect(after.messages.map((m) => [m.id, m.recipient]).sort()).toEqual([
        ['sc2_m_1', ERASED],
        ['sc2_m_2', ADA],
      ]);
      expect((await s.checkouts(ADA, [], 10)).map((c) => c.id)).toEqual(['sc2_chk_open']);
      expect(await s.unlinkedFiles(ADA)).toEqual(['inbound/sc2_in_2.eml']);
      expect(await s.eraseUnlinked(ADA)).toEqual({ messages: 1, inboundEmails: 1 });
      expect(await s.checkouts(ADA, [], 10)).toEqual([]);
      expect(await s.unlinkedFiles(ADA)).toEqual([]);
      // The account's own unplaced checkout goes with the account, and one that placed an order stays.
      expect((await s.checkouts(ADA, ['sc2_acct'], 10)).map((c) => c.id).sort()).toEqual([
        'sc2_chk_acct',
        'sc2_chk_acct_placed',
      ]);
      expect(await s.eraseAccount('sc2_acct')).toEqual({
        taxCertificates: 1,
        addresses: 1,
        companyMembers: 1,
      });
      expect(
        (await s.checkouts('nobody@example.com', ['sc2_acct', 'sc2_other'], 10))
          .map((c) => c.id)
          .sort(),
      ).toEqual(['sc2_chk_acct_placed', 'sc2_chk_other']);
      expect((await s.subject(ADA)).accounts).toEqual([]);
      // Her own company's people and legal details are blanked, and not twice.
      const after2 = await s.rows(await s.subject('charles@corp.example'), []);
      expect(after2.companyMembers).toEqual([]);
      expect((await s.eraseAccount('sc2_acct')).companyMembers).toBe(0);
      const left = await s.rows(await s.subject('grace@example.com'), ['sc2_o_grace']);
      expect(left.messages.map((m) => m.recipient)).toEqual([ERASED]);
    });
  });
}
