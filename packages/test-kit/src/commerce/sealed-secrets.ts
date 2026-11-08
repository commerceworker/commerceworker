/**
 * The sealed secrets port in memory, seeded with values per column. The contract in
 * ./sealed-secrets-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { SealedColumn, SealedSecretStore } from '@commerceworker/ports/commerce';

export type SealedFixture = Partial<Record<SealedColumn, Record<string, string | null>>>;

export class InMemorySealedSecrets implements SealedSecretStore {
  private readonly cols: Map<SealedColumn, Map<string, string | null>>;

  constructor(fixture: SealedFixture = {}) {
    this.cols = new Map(
      Object.entries(fixture).map(([c, rows]) => [
        c as SealedColumn,
        new Map(Object.entries(rows ?? {})),
      ]),
    );
  }

  async values(column: SealedColumn) {
    return [...(this.cols.get(column) ?? new Map()).entries()].flatMap(([id, value]) =>
      value ? [{ column, id, value }] : [],
    );
  }

  async replace(column: SealedColumn, id: string, was: string, next: string) {
    const rows = this.cols.get(column);
    if (rows?.get(id) !== was) return false;
    rows.set(id, next);
    return true;
  }
}
