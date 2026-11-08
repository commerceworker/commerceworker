/**
 * The confirmations port in memory. The contract in ./confirmation-store-contract.ts holds it to
 * the same behaviour as the D1 store.
 */
import type { ConfirmationStore } from '@commerceworker/ports/commerce';

type Code = Parameters<ConfirmationStore['issue']>[0] & { usedAt: number | null };

export class InMemoryConfirmationStore implements ConfirmationStore {
  private readonly codes = new Map<string, Code>();

  async issue(c: Parameters<ConfirmationStore['issue']>[0]) {
    if (this.codes.has(c.id)) throw new Error('UNIQUE constraint failed: action_confirmations.id');
    this.codes.set(c.id, { ...structuredClone(c), usedAt: null });
  }

  async redeem(code: string, principalId: string, tool: string, inputDigest: string, now: number) {
    const c = this.codes.get(code);
    if (
      !c ||
      c.principalId !== principalId ||
      c.tool !== tool ||
      c.inputDigest !== inputDigest ||
      c.usedAt !== null ||
      c.expiresAt <= now
    )
      return null;
    c.usedAt = now;
    return { bound: c.bound ? structuredClone(c.bound) : null };
  }

  async prune(before: number) {
    let n = 0;
    for (const [id, c] of this.codes)
      if (c.expiresAt < before) {
        this.codes.delete(id);
        n++;
      }
    return n;
  }
}
