/**
 * The integrations port in memory. The contract in ./integration-store-contract.ts holds it to
 * the same behaviour as the D1 store.
 */
import type {
  IntegrationRecord,
  IntegrationStore,
  IntegrationView,
} from '@commerceworker/ports/commerce';

export interface IntegrationFixture {
  integrations?: (Pick<IntegrationRecord, 'id' | 'name' | 'secret'> & Partial<IntegrationRecord>)[];
}

const view = ({ secret: _s, previousSecret: _p, ...v }: IntegrationRecord): IntegrationView => ({
  ...v,
});

export class InMemoryIntegrationStore implements IntegrationStore {
  private readonly rows = new Map<string, IntegrationRecord>();

  constructor(f: IntegrationFixture = {}) {
    for (const i of structuredClone(f.integrations ?? []))
      this.rows.set(i.id, {
        events: '[]',
        startOrders: false,
        flows: '[]',
        channel: null,
        createdAt: 0,
        createdBy: null,
        lastUsedAt: null,
        revokedAt: null,
        previousSecret: null,
        previousExpiresAt: null,
        ...i,
      });
  }

  private live(id: string) {
    const r = this.rows.get(id);
    return r && r.revokedAt === null ? r : undefined;
  }

  async list(limit: number) {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(view);
  }
  async add(i: Parameters<IntegrationStore['add']>[0]) {
    if (this.rows.has(i.id)) throw new Error('UNIQUE constraint failed: integrations.id');
    this.rows.set(i.id, {
      ...i,
      lastUsedAt: null,
      revokedAt: null,
      previousSecret: null,
      previousExpiresAt: null,
    });
  }
  async rotate(id: string, secret: string, previousUntil: number) {
    const r = this.live(id);
    if (!r) return undefined;
    const next = { ...r, previousSecret: r.secret, secret, previousExpiresAt: previousUntil };
    this.rows.set(id, next);
    return view(next);
  }
  async revoke(id: string, at: number) {
    const r = this.live(id);
    if (!r) return undefined;
    const next = { ...r, revokedAt: at, previousSecret: null, previousExpiresAt: null };
    this.rows.set(id, next);
    return view(next);
  }
  async active(id: string) {
    const r = this.live(id);
    return r && { ...r };
  }
  async touch(id: string, at: number) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, lastUsedAt: at });
  }
}
