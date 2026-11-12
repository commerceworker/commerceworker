/**
 * The order-view credentials port in memory. The contract in ./order-view-tokens-contract.ts holds
 * it to the same behaviour as the D1 store.
 */
import type { OrderViewTokens } from '@commerceworker/ports/commerce';

interface Row {
  readonly orderId: string;
  readonly expiresAt: number;
}

export class InMemoryOrderViewTokens implements OrderViewTokens {
  private readonly rows = new Map<string, Row>();

  async issue(orderId: string, tokenHash: string, now: number, expiresAt: number) {
    for (const [h, r] of this.rows) if (r.expiresAt <= now) this.rows.delete(h);
    if (!this.rows.has(tokenHash)) this.rows.set(tokenHash, { orderId, expiresAt });
  }

  async live(orderId: string, now: number) {
    return [...this.rows]
      .filter(([, r]) => r.orderId === orderId && r.expiresAt > now)
      .map(([h]) => h);
  }

  async revoke(orderIds: readonly string[]) {
    let n = 0;
    for (const [h, r] of this.rows)
      if (orderIds.includes(r.orderId)) {
        this.rows.delete(h);
        n++;
      }
    return n;
  }

  /** Every stored hash, for a test to prove a token itself is never kept. */
  hashes() {
    return [...this.rows.keys()];
  }
}
