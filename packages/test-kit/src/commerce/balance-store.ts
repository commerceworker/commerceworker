/**
 * The balances port in memory, seeded with customers' balances. Applied entries stand in for the
 * D1 store's guarded batches; the contract in ./balance-store-contract.ts holds the two to the same
 * behaviour.
 */
import {
  type BalanceCharge,
  type BalanceEntry,
  type BalanceStore,
  balanceEntryId,
} from '@commerceworker/ports/commerce';

export interface BalanceFixture {
  customers?: { id: string; balance?: number }[];
}

export class InMemoryBalanceStore implements BalanceStore {
  private readonly balances = new Map<string, number>();
  private readonly ledger = new Map<string, BalanceEntry>();

  constructor(fixture: BalanceFixture = {}) {
    for (const c of fixture.customers ?? []) this.balances.set(c.id, c.balance ?? 0);
  }

  /** Records the entry and moves the balance, once per id. */
  private apply(entry: BalanceEntry) {
    if (this.ledger.get(entry.id)?.applied) return false;
    const balance = this.balances.get(entry.customerId);
    if (balance !== undefined) this.balances.set(entry.customerId, balance + entry.amount);
    this.ledger.set(entry.id, { ...entry, applied: true });
    return true;
  }

  /** Takes a charge back off by its `set_` or `rev_` row, unless either already did. */
  private offset(entry: BalanceEntry, prefix: 'set' | 'rev') {
    const closed = ['set', 'rev'].some((p) => this.ledger.get(`${p}_${entry.id}`)?.applied);
    if (closed || !entry.applied) return false;
    return this.apply({ ...entry, id: `${prefix}_${entry.id}`, amount: -entry.amount });
  }

  async charge(c: BalanceCharge) {
    const id = balanceEntryId(c.orderId, c.stepKey);
    const existing = this.ledger.get(id);
    this.apply(
      existing ?? {
        id,
        orderId: c.orderId,
        customerId: c.customerId,
        amount: c.amount,
        applied: false,
      },
    );
    return id;
  }

  async settle(entryId: string) {
    const entry = this.ledger.get(entryId);
    return !!entry && entry.amount > 0 && this.offset(entry, 'set');
  }

  async reverse(orderId: string) {
    let n = 0;
    for (const e of [...this.ledger.values()])
      if (e.orderId === orderId && e.amount > 0 && this.offset(e, 'rev')) n++;
    return n;
  }

  async balance(customerId: string) {
    return this.balances.get(customerId);
  }

  async entries(orderId: string) {
    return [...this.ledger.values()]
      .filter((e) => e.orderId === orderId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
