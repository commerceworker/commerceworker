/**
 * The identity port in memory, seeded with people, tokens and sessions. The contract in
 * ./identity-store-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { IdentityStore } from '@commerceworker/ports/commerce';

export interface IdentityFixture {
  users?: { id: string; email: string; name: string; role: string; disabledAt?: number | null }[];
  tokens?: { id: string; role: string; revokedAt?: number | null; expiresAt?: number | null }[];
  sessions?: {
    tokenHash: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
    lastSeenAt?: number | null;
    reauthAt?: number | null;
  }[];
}

export class InMemoryIdentityStore implements IdentityStore {
  private readonly f: Required<IdentityFixture>;

  constructor(fixture: IdentityFixture = {}) {
    const c = structuredClone(fixture);
    this.f = { users: c.users ?? [], tokens: c.tokens ?? [], sessions: c.sessions ?? [] };
  }

  async anyone() {
    return this.f.users.length > 0;
  }

  async token(id: string) {
    const t = this.f.tokens.find((x) => x.id === id);
    return t
      ? { role: t.role, revokedAt: t.revokedAt ?? null, expiresAt: t.expiresAt ?? null }
      : undefined;
  }

  async session(tokenHash: string, now: number, idleMs: number) {
    const s = this.f.sessions.find((x) => x.tokenHash === tokenHash);
    const u = s && this.f.users.find((x) => x.id === s.userId);
    if (!s || !u || u.disabledAt) return undefined;
    const seen = s.lastSeenAt ?? s.createdAt;
    if (s.expiresAt <= now || seen <= now - idleMs) return undefined;
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      seen,
      reauthAt: s.reauthAt ?? null,
    };
  }

  async touchSession(tokenHash: string, now: number) {
    const s = this.f.sessions.find((x) => x.tokenHash === tokenHash);
    if (s) s.lastSeenAt = now;
  }

  async disabledAt(userId: string) {
    const u = this.f.users.find((x) => x.id === userId);
    return u ? (u.disabledAt ?? null) : undefined;
  }
}
