/**
 * The data subject port in memory, seeded with the rows a request reads, reduced to what it reads.
 * The contract in ./subject-store-contract.ts holds it to the same behaviour as the D1 store.
 */
import {
  type CheckoutSession,
  ERASED,
  erasedCustomerEmail,
  TERMINAL_ORDER_STATUSES,
} from '@commerceworker/core';
import type { Subject, SubjectOrder, SubjectStore } from '@commerceworker/ports/commerce';

export interface SubjectFixture {
  customers?: { id: string; name: string; email: string }[];
  users?: { id: string; email: string }[];
  orders?: {
    id: string;
    title: string;
    status: string;
    contactEmail: string | null;
    customerId: string | null;
  }[];
  inboundEmails?: { id: string; sender: string; orderId: string | null; r2Key: string | null }[];
  messages?: { id: string; orderId: string; recipient: string }[];
  documents?: { orderId: string; key: string; kind: string }[];
  taxCertificates?: { id: string; customerId: string; regions: string }[];
  addresses?: { id: string; customerId: string }[];
  companies?: { customerId: string; legalName: string; taxId: string | null }[];
  companyMembers?: {
    id: string;
    companyId: string;
    name: string;
    email: string;
    status: string;
  }[];
  purchaseOrders?: {
    id: string;
    companyId: string;
    buyerId: string | null;
    poNumber: string;
    status: string;
    shipTo: Record<string, string> | null;
    notes: string | null;
  }[];
  quotes?: {
    id: string;
    companyId: string;
    buyerId: string | null;
    name: string;
    status: string;
    notes: string | null;
    createdBy?: string | null;
  }[];
  checkouts?: { id: string; email: string; orderId: string | null; customerId?: string }[];
  carts?: {
    id: string;
    buyerId: string | null;
    customerId: string | null;
    pluginId: string | null;
    orderId: string | null;
  }[];
  audit?: { id: string; action: string; target: string }[];
}

type Order = NonNullable<SubjectFixture['orders']>[number] & {
  erasedAt: number | null;
  reason: string | null;
};

const lower = (s: string | null) => (s ?? '').toLowerCase();

export class InMemorySubjectStore implements SubjectStore {
  private readonly f: Required<Omit<SubjectFixture, 'orders'>> & { orders: Order[] };

  constructor(fixture: SubjectFixture = {}) {
    const c = structuredClone(fixture);
    this.f = {
      customers: c.customers ?? [],
      users: c.users ?? [],
      orders: (c.orders ?? []).map((o) => ({ ...o, erasedAt: null, reason: 'Named them' })),
      inboundEmails: c.inboundEmails ?? [],
      messages: c.messages ?? [],
      documents: c.documents ?? [],
      taxCertificates: c.taxCertificates ?? [],
      addresses: c.addresses ?? [],
      companies: c.companies ?? [],
      companyMembers: c.companyMembers ?? [],
      purchaseOrders: c.purchaseOrders ?? [],
      quotes: c.quotes ?? [],
      checkouts: c.checkouts ?? [],
      carts: c.carts ?? [],
      audit: c.audit ?? [],
    };
  }

  private session(c: NonNullable<SubjectFixture['checkouts']>[number]) {
    return {
      id: c.id,
      ownerId: 'platform',
      status: c.orderId ? 'completed' : 'incomplete',
      currency: 'USD',
      lines: [],
      buyer: c.email ? { email: c.email } : {},
      ...(c.customerId ? { customerId: c.customerId } : {}),
      fulfillment: 'ship',
      shipTo: null,
      shippingOption: null,
      quote: null,
      issues: [],
      orderId: c.orderId,
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
      version: 1,
    } as unknown as CheckoutSession;
  }

  async subject(email: string): Promise<Subject> {
    return {
      email,
      accounts: this.f.customers.filter((c) => lower(c.email) === email),
      viaEmail: this.f.inboundEmails.flatMap((r) =>
        lower(r.sender) === email && r.orderId ? [r.orderId] : [],
      ),
      teamMember: this.f.users.some((u) => lower(u.email) === email),
    };
  }

  async orders(s: Subject, opts: { active?: boolean; limit: number }): Promise<SubjectOrder[]> {
    const ids = new Set(s.accounts.map((c) => c.id));
    return this.f.orders
      .filter(
        (o) =>
          o.erasedAt === null &&
          (lower(o.contactEmail) === s.email ||
            (o.customerId !== null && ids.has(o.customerId)) ||
            s.viaEmail.includes(o.id)) &&
          (!opts.active || !(TERMINAL_ORDER_STATUSES as readonly string[]).includes(o.status)),
      )
      .slice(0, opts.limit)
      .map((o) => ({
        id: o.id,
        title: o.title,
        status: o.status,
        channel: 'api',
        externalId: null,
        createdAt: 0,
        customerId: o.customerId,
        currency: 'USD',
        total: 0,
      }));
  }

  async rows(s: Subject, orderIds: readonly string[]) {
    const accounts = new Set(s.accounts.map((c) => c.id));
    const messages = this.f.messages.filter(
      (m) => orderIds.includes(m.orderId) || lower(m.recipient) === s.email,
    );
    return {
      messages,
      documents: this.f.documents
        .filter((d) => orderIds.includes(d.orderId))
        .map((d) => ({ key: d.key, kind: d.kind, contentType: 'text/html', createdAt: 0 })),
      inboundEmails: this.f.inboundEmails.filter((r) => lower(r.sender) === s.email),
      taxCertificates: this.f.taxCertificates.filter((c) => accounts.has(c.customerId)),
      addresses: this.f.addresses.filter((a) => accounts.has(a.customerId)),
      companies: this.f.companies.filter((c) => accounts.has(c.customerId)),
      companyMembers: this.f.companyMembers.filter((m) => lower(m.email) === s.email),
      purchaseOrders: this.theirPos(s).map((p) => structuredClone(p)),
      quotes: this.theirQuotes(s).map((q) => structuredClone(q)),
    };
  }

  async checkouts(email: string, customerIds: readonly string[], limit: number) {
    return this.f.checkouts
      .filter(
        (c) =>
          lower(c.email) === email.toLowerCase() ||
          (c.customerId !== undefined && customerIds.includes(c.customerId)),
      )
      .slice(0, limit)
      .map((c) => this.session(c));
  }

  async buyerCarts(email: string, limit: number) {
    if (!email) return [];
    return this.f.carts
      .filter((c) => c.buyerId === email)
      .slice(0, limit)
      .map((c) => c.id);
  }

  async customerCarts(customerIds: readonly string[], limit: number) {
    return this.f.carts
      .filter((c) => c.customerId && customerIds.includes(c.customerId) && !c.pluginId)
      .slice(0, limit)
      .map((c) => c.id);
  }

  async orderCarts(orderIds: readonly string[]) {
    return this.f.carts.filter((c) => c.orderId && orderIds.includes(c.orderId)).map((c) => c.id);
  }

  async wasErased(target: string) {
    return this.f.audit.some((a) => a.action === 'personal_data.erased' && a.target === target);
  }

  async markOrderErased(
    orderId: string,
    erased: { title: string; clearReason: boolean },
    at: number,
  ) {
    const o = this.f.orders.find((x) => x.id === orderId);
    if (!o) return;
    Object.assign(o, {
      contactEmail: null,
      title: erased.title,
      erasedAt: at,
      ...(erased.clearReason ? { reason: null } : {}),
    });
  }

  async eraseOrderRows(orderIds: readonly string[]) {
    for (const c of this.f.checkouts) if (c.orderId && orderIds.includes(c.orderId)) c.email = '';
    this.f.documents = this.f.documents.filter((d) => !orderIds.includes(d.orderId));
    let messages = 0;
    for (const m of this.f.messages)
      if (orderIds.includes(m.orderId)) {
        m.recipient = ERASED;
        messages++;
      }
    let inboundEmails = 0;
    for (const r of this.f.inboundEmails)
      if (r.orderId && orderIds.includes(r.orderId)) {
        Object.assign(r, { sender: ERASED, r2Key: null });
        inboundEmails++;
      }
    return { messages, inboundEmails };
  }

  async unlinkedFiles(email: string) {
    return this.f.inboundEmails.flatMap((r) =>
      lower(r.sender) === email && r.r2Key ? [r.r2Key] : [],
    );
  }

  async eraseUnlinked(email: string) {
    let inboundEmails = 0;
    for (const r of this.f.inboundEmails)
      if (lower(r.sender) === email) {
        Object.assign(r, { sender: ERASED, r2Key: null });
        inboundEmails++;
      }
    let messages = 0;
    for (const m of this.f.messages)
      if (lower(m.recipient) === email) {
        m.recipient = ERASED;
        messages++;
      }
    this.f.checkouts = this.f.checkouts.filter((c) => c.orderId || lower(c.email) !== email);
    return { messages, inboundEmails };
  }

  async eraseAccount(customerId: string) {
    const certs = this.f.taxCertificates.filter((c) => c.customerId === customerId).length;
    const addrs = this.f.addresses.filter((a) => a.customerId === customerId).length;
    this.f.taxCertificates = this.f.taxCertificates.filter((c) => c.customerId !== customerId);
    this.f.addresses = this.f.addresses.filter((a) => a.customerId !== customerId);
    this.f.checkouts = this.f.checkouts.filter((k) => k.orderId || k.customerId !== customerId);
    const c = this.f.customers.find((x) => x.id === customerId);
    if (c) Object.assign(c, { name: 'Erased customer', email: erasedCustomerEmail(customerId) });
    for (const co of this.f.companies)
      if (co.customerId === customerId) Object.assign(co, { legalName: ERASED, taxId: null });
    const members = this.f.companyMembers.filter(
      (m) => m.companyId === customerId && m.name !== ERASED,
    );
    for (const m of members) Object.assign(m, { name: ERASED, email: ERASED, status: 'removed' });
    return { taxCertificates: certs, addresses: addrs, companyMembers: members.length };
  }

  /** POs of the subject's accounts' companies and those placed by a member with their email. */
  private theirPos(s: Subject) {
    const accounts = new Set(s.accounts.map((c) => c.id));
    const members = new Set(
      this.f.companyMembers.filter((m) => lower(m.email) === s.email).map((m) => m.id),
    );
    return this.f.purchaseOrders.filter(
      (p) => accounts.has(p.companyId) || (p.buyerId !== null && members.has(p.buyerId)),
    );
  }

  async erasePurchaseOrders(s: Subject) {
    const mine = this.theirPos(s);
    for (const p of mine) {
      p.notes = null;
      p.buyerId = null;
      if (p.shipTo) {
        const { name: _n, line2: _l, ...rest } = p.shipTo;
        p.shipTo = { ...rest, line1: '' };
      }
    }
    return mine.length;
  }

  /** Quotes of the subject's accounts' companies and those for a member with their email. */
  private theirQuotes(s: Subject) {
    const accounts = new Set(s.accounts.map((c) => c.id));
    const members = new Set(
      this.f.companyMembers.filter((m) => lower(m.email) === s.email).map((m) => m.id),
    );
    return this.f.quotes.filter(
      (q) => accounts.has(q.companyId) || (q.buyerId !== null && members.has(q.buyerId)),
    );
  }

  async eraseQuotes(s: Subject) {
    const mine = this.theirQuotes(s);
    for (const q of mine) {
      q.notes = null;
      q.buyerId = null;
    }
    return mine.length;
  }

  async eraseMembers(email: string) {
    const mine = this.f.companyMembers.filter((m) => lower(m.email) === email);
    for (const m of mine) Object.assign(m, { name: ERASED, email: ERASED, status: 'removed' });
    return mine.length;
  }
}
