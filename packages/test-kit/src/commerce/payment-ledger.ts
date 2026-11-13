/**
 * The payments ledger in memory, seeded with customers. The contract in
 * ./payment-ledger-contract.ts holds it to the same behaviour as the D1 ledger.
 */
import type { Clock } from '@commerceworker/ports';
import {
  type NewPayment,
  type PayingCustomer,
  PaymentClaimedError,
  type PaymentLedger,
  type PaymentRecord,
} from '@commerceworker/ports/commerce';

export interface PaymentLedgerFixture {
  customers?: PayingCustomer[];
}

const oldestFirst = (a: PaymentRecord, b: PaymentRecord) =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The rows the D1 ledger's unique index on a processor id holds to one each. */
const claims = (p: Pick<NewPayment, 'kind' | 'status' | 'externalId'>) =>
  !!p.externalId &&
  (p.kind === 'refund' || (p.kind.startsWith('authorization:') && p.status !== 'declined'));

export class InMemoryPaymentLedger implements PaymentLedger {
  private readonly rows = new Map<string, PaymentRecord>();
  private readonly accounts = new Map<string, PayingCustomer>();

  constructor(
    fixture: PaymentLedgerFixture = {},
    private readonly clock: Clock = { now: () => new Date() },
  ) {
    for (const c of fixture.customers ?? []) this.accounts.set(c.id, { ...c });
  }

  private set(id: string, change: Partial<PaymentRecord>) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, ...change });
  }

  async find(id: string) {
    return this.rows.get(id);
  }

  async findMany(ids: readonly string[]) {
    return [...new Set(ids)]
      .flatMap((id) => {
        const r = this.rows.get(id);
        return r ? [r] : [];
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async record(p: NewPayment) {
    if (!this.rows.has(p.id)) {
      if (
        claims(p) &&
        [...this.rows.values()].some((r) => r.externalId === p.externalId && claims(r))
      )
        throw new PaymentClaimedError(p.externalId!);
      this.rows.set(p.id, {
        ...p,
        ref: p.ref ?? null,
        externalId: p.externalId ?? null,
        currency: p.currency ?? null,
        createdAt: this.clock.now().getTime(),
      });
    }
    return this.rows.get(p.id)!;
  }

  async forOrder(orderId: string) {
    return [...this.rows.values()].filter((r) => r.orderId === orderId).sort(oldestFirst);
  }

  async forExternalId(externalId: string) {
    return [...this.rows.values()].filter((r) => r.externalId === externalId).sort(oldestFirst);
  }

  async voidAuthorization(id: string) {
    if (this.rows.get(id)?.status !== 'authorized') return false;
    this.set(id, { status: 'voided' });
    return true;
  }

  async voidIntent(externalId: string) {
    const open = [...this.rows.values()].filter(
      (r) => r.externalId === externalId && r.provider === 'stripe' && r.status === 'authorized',
    );
    for (const r of open) this.set(r.id, { status: 'voided' });
    return open.map((r) => r.orderId);
  }

  async capture(authorizationId: string, c: NewPayment) {
    if (this.rows.get(authorizationId)?.status === 'authorized') {
      this.set(authorizationId, { status: 'captured', ref: c.id });
      await this.record(c);
    }
    return this.rows.get(c.id);
  }

  async customer(customerId: string) {
    return this.accounts.get(customerId);
  }

  async saveCard(customerId: string, card: { paymentMethodId: string; stripeCustomerId?: string }) {
    const a = this.accounts.get(customerId);
    if (a)
      this.accounts.set(customerId, {
        ...a,
        paymentMethodId: card.paymentMethodId,
        ...(card.stripeCustomerId ? { stripeCustomerId: card.stripeCustomerId } : {}),
      });
  }

  async claimStripeCustomer(customerId: string, stripeCustomerId: string) {
    const a = this.accounts.get(customerId);
    if (!a) return stripeCustomerId;
    if (!a.stripeCustomerId) this.accounts.set(customerId, { ...a, stripeCustomerId });
    return this.accounts.get(customerId)!.stripeCustomerId!;
  }
}
