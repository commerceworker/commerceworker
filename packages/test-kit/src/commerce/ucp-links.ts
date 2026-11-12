/**
 * The identity-linking port in memory. The contract in ./ucp-links-contract.ts holds it to the same
 * behaviour as the D1 store; each method is one synchronous step, so two callers racing on a code
 * or a refresh token are ordered as D1's guarded statements order them.
 */
import type {
  LinkCode,
  LinkedPlatform,
  LinkGrant,
  LinkToken,
  RefreshRead,
  UcpLinks,
} from '@commerceworker/ports/commerce';

type StoredCode = LinkCode & { usedAt: number | null; replayedAt: number | null };
type StoredToken = LinkToken & { usedAt: number | null; successor: string | null };

export class InMemoryUcpLinks implements UcpLinks {
  private readonly codes = new Map<string, StoredCode>();
  private readonly grants = new Map<string, LinkGrant>();
  private readonly tokens = new Map<string, StoredToken>();

  private live(g: LinkGrant, now: number) {
    return g.revokedAt === null && g.expiresAt > now;
  }

  async issueCode(code: LinkCode) {
    if (this.codes.has(code.codeHash)) throw new Error('UNIQUE constraint failed: ucp_link_codes');
    this.codes.set(code.codeHash, { ...code, usedAt: null, replayedAt: null });
  }

  async spendCode(codeHash: string, now: number) {
    const c = this.codes.get(codeHash);
    if (!c) return null;
    if (c.usedAt === null && c.expiresAt > now) {
      c.usedAt = now;
      const { usedAt: _used, replayedAt: _replayed, ...code } = c;
      return { kind: 'spent' as const, code };
    }
    if (c.usedAt === null) return null;
    c.replayedAt ??= now;
    return { kind: 'replayed' as const, grantId: c.grantId };
  }

  async createGrant(
    grant: LinkGrant,
    tokens: readonly LinkToken[],
    now: number,
    codeHash: string | null,
  ) {
    if (codeHash && this.codes.get(codeHash)?.replayedAt != null) return false;
    for (const [id, g] of this.grants)
      if (g.platformId === grant.platformId && g.email === grant.email && g.revokedAt === null)
        this.grants.set(id, { ...g, revokedAt: now });
    this.grants.set(grant.id, { ...grant, revokedAt: null });
    for (const t of tokens) this.tokens.set(t.tokenHash, { ...t, usedAt: null, successor: null });
    return true;
  }

  async access(tokenHash: string, now: number) {
    const t = this.tokens.get(tokenHash);
    const g = t && this.grants.get(t.grantId);
    if (!t || !g || t.kind !== 'access' || t.expiresAt <= now || !this.live(g, now)) return null;
    return { grant: g, scope: t.scope };
  }

  async refresh(tokenHash: string): Promise<RefreshRead | null> {
    const t = this.tokens.get(tokenHash);
    const g = t && this.grants.get(t.grantId);
    if (!t || !g || t.kind !== 'refresh') return null;
    return { grant: g, scope: t.scope, spent: t.usedAt !== null, expiresAt: t.expiresAt };
  }

  async rotate(tokenHash: string, next: readonly LinkToken[], now: number) {
    const successor = next.find((t) => t.kind === 'refresh')?.tokenHash;
    if (!successor) throw new Error('A rotation issues a refresh token');
    const t = this.tokens.get(tokenHash);
    if (!t || t.kind !== 'refresh') return 'unknown' as const;
    const g = this.grants.get(t.grantId);
    if (t.usedAt === null && t.expiresAt > now && g && this.live(g, now)) {
      t.usedAt = now;
      t.successor = successor;
      for (const n of next) this.tokens.set(n.tokenHash, { ...n, usedAt: null, successor: null });
      return 'rotated' as const;
    }
    return t.usedAt !== null ? ('reused' as const) : ('unknown' as const);
  }

  async grantOfToken(tokenHash: string) {
    const t = this.tokens.get(tokenHash);
    return (t && this.grants.get(t.grantId)) || null;
  }

  async grant(id: string) {
    return this.grants.get(id) ?? null;
  }

  async revokeGrant(id: string, now: number) {
    const g = this.grants.get(id);
    if (!g || !this.live(g, now)) return false;
    this.grants.set(id, { ...g, revokedAt: now });
    return true;
  }

  async forShopper(email: string, now: number): Promise<LinkedPlatform[]> {
    return [...this.grants.values()]
      .filter((g) => g.email === email && this.live(g, now))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({
        id: g.id,
        platformId: g.platformId,
        // The store has no platforms; the D1 one joins their names, and falls back to the id.
        platformName: g.platformId,
        scope: g.scope,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
      }));
  }

  async revokeForShopper(email: string, grantId: string, now: number) {
    const g = this.grants.get(grantId);
    return g?.email === email ? this.revokeGrant(grantId, now) : false;
  }

  async exportFor(email: string) {
    return [...this.grants.values()]
      .filter((g) => g.email === email)
      .map((g) => ({
        id: g.id,
        platformId: g.platformId,
        email: g.email,
        scope: g.scope,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
      }));
  }

  async eraseFor(email: string) {
    const mine = [...this.grants.values()].filter((g) => g.email === email);
    for (const g of mine) this.grants.delete(g.id);
    for (const [h, t] of this.tokens)
      if (mine.some((g) => g.id === t.grantId)) this.tokens.delete(h);
    for (const [h, c] of this.codes) if (c.email === email) this.codes.delete(h);
    return mine.length;
  }

  async prune(before: { codes: number; grants: number; tokens: number; spent: number }) {
    let codes = 0;
    let grants = 0;
    let tokens = 0;
    for (const [h, c] of this.codes)
      if (c.expiresAt < before.codes) {
        this.codes.delete(h);
        codes++;
      }
    for (const g of [...this.grants.values()])
      if ((g.revokedAt !== null && g.revokedAt < before.grants) || g.expiresAt < before.grants) {
        this.grants.delete(g.id);
        grants++;
        for (const [h, t] of this.tokens)
          if (t.grantId === g.id) {
            this.tokens.delete(h);
            tokens++;
          }
      }
    // Of the links left: access tokens that have expired, and spent refresh tokens older than the
    // cut but for each link's latest spent one.
    const latest = new Map<string, number>();
    for (const t of this.tokens.values())
      if (t.kind === 'refresh' && t.usedAt !== null)
        latest.set(t.grantId, Math.max(latest.get(t.grantId) ?? 0, t.usedAt));
    for (const [h, t] of this.tokens) {
      const expired = t.kind === 'access' && t.expiresAt < before.tokens;
      const stale =
        t.kind === 'refresh' &&
        t.usedAt !== null &&
        t.usedAt < before.spent &&
        t.usedAt < (latest.get(t.grantId) ?? 0);
      if (expired || stale) {
        this.tokens.delete(h);
        tokens++;
      }
    }
    return { codes, grants, tokens };
  }
}
