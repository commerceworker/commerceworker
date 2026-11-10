/**
 * The balances port in memory, seeded with customers' balances. Applied entries stand in for the
 * D1 store's guarded batches; the contract in ./balance-store-contract.ts holds the two to the same
 * behaviour.
 */
import { creditAvailable, money } from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import {
  type BalanceCharge,
  type BalanceEntry,
  type BalanceStore,
  balanceEntryId,
  type CreditHold,
  creditAdjustmentId,
  creditHoldId,
  type LedgerEntry,
} from '@commerceworker/ports/commerce';
import { FixedClock } from '../fakes';

export interface BalanceFixture {
  customers?: { id: string; balance?: number; creditLimit?: number }[];
}

type Hold = CreditHold & {
  status: 'held' | 'charged' | 'released' | 'expired';
};

/** A ledger row with what the account shows of it. */
type Row = BalanceEntry & Pick<LedgerEntry, 'kind' | 'reference' | 'note'> & { at: number };

export class InMemoryBalanceStore implements BalanceStore {
  private readonly balances = new Map<string, number>();
  private readonly limits = new Map<string, number>();
  private readonly ledgerRows = new Map<string, Row>();
  private readonly holds = new Map<string, Hold>();

  constructor(
    fixture: BalanceFixture = {},
    private readonly clock: Clock = new FixedClock(),
  ) {
    for (const c of fixture.customers ?? []) {
      this.balances.set(c.id, c.balance ?? 0);
      this.limits.set(c.id, c.creditLimit ?? 0);
    }
  }

  private now() {
    return this.clock.now().getTime();
  }

  /** What the customer's holds claim: the `held` ones not past their expiry. */
  private heldOf(customerId: string) {
    const at = this.now();
    let sum = 0;
    for (const h of this.holds.values())
      if (h.customerId === customerId && h.status === 'held' && h.expiresAt > at) sum += h.amount;
    return money(sum);
  }

  /** Records the entry and moves the balance, once per id. */
  private apply(entry: Row) {
    if (this.ledgerRows.get(entry.id)?.applied) return false;
    const balance = this.balances.get(entry.customerId);
    if (balance !== undefined) this.balances.set(entry.customerId, balance + entry.amount);
    this.ledgerRows.set(entry.id, { ...entry, applied: true });
    return true;
  }

  /** Takes a charge back off by its `set_` or `rev_` row, unless either already did. */
  private offset(entry: Row, prefix: 'set' | 'rev') {
    const closed = ['set', 'rev'].some((p) => this.ledgerRows.get(`${p}_${entry.id}`)?.applied);
    if (closed || !entry.applied) return false;
    return this.apply({
      ...entry,
      id: `${prefix}_${entry.id}`,
      amount: -entry.amount,
      kind: prefix === 'set' ? 'settle' : 'reverse',
      reference: entry.id,
      note: null,
      at: this.now(),
    });
  }

  async charge(c: BalanceCharge) {
    const id = balanceEntryId(c.orderId, c.stepKey);
    const existing = this.ledgerRows.get(id);
    const applied = this.apply(
      existing ?? {
        id,
        orderId: c.orderId,
        customerId: c.customerId,
        amount: c.amount,
        applied: false,
        kind: 'charge',
        reference: null,
        note: null,
        at: this.now(),
      },
    );
    // The charge stands for what the order held.
    if (applied)
      for (const h of this.holds.values())
        if (h.orderId === c.orderId && h.customerId === c.customerId && h.status === 'held')
          h.status = 'charged';
    return id;
  }

  async settle(entryId: string) {
    const entry = this.ledgerRows.get(entryId);
    return entry?.kind === 'charge' && this.offset(entry, 'set');
  }

  async reverse(orderId: string) {
    let n = 0;
    for (const e of [...this.ledgerRows.values()])
      if (e.orderId === orderId && e.kind === 'charge' && this.offset(e, 'rev')) n++;
    return n;
  }

  async hold(h: CreditHold) {
    const customer = h.customerId;
    const at = this.now();
    for (const o of this.holds.values())
      if (o.customerId === customer && o.status === 'held' && o.expiresAt <= at)
        o.status = 'expired';
    const id = creditHoldId(h.orderId, h.stepKey);
    const limit = this.limits.get(customer);
    const balance = this.balances.get(customer);
    if (limit === undefined || balance === undefined) return { held: false, available: 0 };
    const available = creditAvailable({ creditLimit: limit, balance, held: this.heldOf(customer) });
    if (!this.holds.has(id) && money(h.amount) <= available)
      this.holds.set(id, { ...h, status: 'held' });
    const own = this.holds.get(id);
    return {
      held: own?.status === 'held' || own?.status === 'charged',
      available: creditAvailable({ creditLimit: limit, balance, held: this.heldOf(customer) }),
    };
  }

  async releaseHolds(orderId: string) {
    let n = 0;
    for (const h of this.holds.values())
      if (h.orderId === orderId && h.status === 'held') {
        h.status = 'released';
        n++;
      }
    return n;
  }

  async adjust(a: { key: string; customerId: string; amount: number; reason: string; by: string }) {
    if (!this.balances.has(a.customerId)) return undefined;
    const id = creditAdjustmentId(a.key);
    this.apply({
      id,
      orderId: '',
      customerId: a.customerId,
      amount: a.amount,
      applied: false,
      kind: 'adjust',
      reference: a.by,
      note: a.reason,
      at: this.now(),
    });
    return id;
  }

  async setLimit(customerId: string, limit: number) {
    if (!this.limits.has(customerId)) return false;
    this.limits.set(customerId, limit);
    return true;
  }

  async account(customerId: string) {
    const limit = this.limits.get(customerId);
    const balance = this.balances.get(customerId);
    if (limit === undefined || balance === undefined) return undefined;
    const held = this.heldOf(customerId);
    return {
      limit,
      balance,
      held,
      available: creditAvailable({ creditLimit: limit, balance, held }),
    };
  }

  async ledger(customerId: string, cursor: { at: number; id: string } | undefined, limit: number) {
    // Newest first, ties by id, as the D1 store orders them.
    const newestFirst = (a: Row, b: Row) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    const mine = [...this.ledgerRows.values()]
      .filter((e) => e.customerId === customerId && e.applied)
      .sort(newestFirst);
    const older = cursor
      ? mine.filter((e) => e.at < cursor.at || (e.at === cursor.at && e.id < cursor.id))
      : mine;
    const page = older.slice(0, limit);
    let after = this.balances.get(customerId) ?? 0;
    for (const e of mine) if (!older.includes(e)) after -= e.amount;
    after = money(after);
    const entries: LedgerEntry[] = page.map((e) => {
      const entry: LedgerEntry = {
        id: e.id,
        at: e.at,
        kind: e.kind,
        orderId: e.orderId || null,
        amount: e.amount,
        balanceAfter: after,
        reference: e.reference,
        note: e.note,
      };
      after = money(after - e.amount);
      return entry;
    });
    const last = page.at(-1);
    return {
      entries,
      next: older.length > limit && last ? { at: last.at, id: last.id } : null,
    };
  }

  async balance(customerId: string) {
    return this.balances.get(customerId);
  }

  async entries(orderId: string) {
    return [...this.ledgerRows.values()]
      .filter((e) => e.orderId === orderId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ kind: _k, reference: _r, note: _n, at: _a, ...entry }) => entry);
  }
}
