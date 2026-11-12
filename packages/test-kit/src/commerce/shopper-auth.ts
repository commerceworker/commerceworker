/**
 * The shopper sign-in port in memory. The contract in ./shopper-auth-contract.ts holds it to the
 * same behaviour as the D1 store.
 */
import type {
  ShopperAuth,
  ShopperSessionRow,
  ShopperSignIn,
  ShopperSignInLimits,
} from '@commerceworker/ports/commerce';

interface SignInRow extends ShopperSignIn {
  attempts: number;
  lastAttemptAt: number | null;
  usedAt: number | null;
  dayStartedAt: number;
  sentToday: number;
}

type SessionRow = { -readonly [K in keyof ShopperSessionRow]: ShopperSessionRow[K] } & {
  tokenHash: string;
};

export class InMemoryShopperAuth implements ShopperAuth {
  private readonly signIns = new Map<string, SignInRow>();
  private readonly sessions = new Map<string, SessionRow>();

  async issueSignIn(s: ShopperSignIn, limits: ShopperSignInLimits) {
    const last = this.signIns.get(s.email);
    let attempts = 0;
    let dayStartedAt = s.createdAt;
    let sentToday = 1;
    if (last) {
      if (last.createdAt > s.createdAt - limits.cooldownMs) return false;
      const recent =
        last.lastAttemptAt !== null && last.lastAttemptAt > s.createdAt - limits.lockoutMs;
      if (last.attempts >= limits.maxAttempts && recent) return false;
      const dayOver = last.dayStartedAt <= s.createdAt - limits.dayMs;
      if (!dayOver && last.sentToday >= limits.dailyMax) return false;
      // The tries go with the address, not the code.
      attempts = last.usedAt !== null || !recent ? 0 : last.attempts;
      dayStartedAt = dayOver ? s.createdAt : last.dayStartedAt;
      sentToday = dayOver ? 1 : last.sentToday + 1;
    }
    this.signIns.set(s.email, {
      ...s,
      attempts,
      lastAttemptAt: last?.lastAttemptAt ?? null,
      usedAt: null,
      dayStartedAt,
      sentToday,
    });
    return true;
  }

  async spendAttempt(email: string, now: number, maxAttempts: number) {
    const row = this.signIns.get(email);
    if (!row || row.usedAt !== null || row.expiresAt <= now || row.attempts >= maxAttempts)
      return null;
    row.attempts++;
    row.lastAttemptAt = now;
    return row.codeHash;
  }

  async consumeCode(email: string, codeHash: string, now: number) {
    const row = this.signIns.get(email);
    if (!row || row.codeHash !== codeHash || row.usedAt !== null || row.expiresAt <= now)
      return false;
    row.usedAt = now;
    return true;
  }

  async consumeLink(linkHash: string, now: number) {
    for (const row of this.signIns.values())
      if (row.linkHash === linkHash) {
        if (row.usedAt !== null || row.expiresAt <= now) return null;
        row.usedAt = now;
        return row.email;
      }
    return null;
  }

  async linkEmail(linkHash: string, now: number) {
    for (const row of this.signIns.values())
      if (row.linkHash === linkHash && row.usedAt === null && row.expiresAt > now) return row.email;
    return null;
  }

  async createSession(s: {
    tokenHash: string;
    email: string;
    createdAt: number;
    expiresAt: number;
  }) {
    this.sessions.set(s.tokenHash, { ...s, lastSeenAt: null });
  }

  async session(tokenHash: string, now: number) {
    const row = this.sessions.get(tokenHash);
    if (!row || row.expiresAt <= now) return null;
    const { tokenHash: _hash, ...view } = row;
    return view;
  }

  async touchSession(tokenHash: string, now: number, before: number) {
    const row = this.sessions.get(tokenHash);
    if (row && (row.lastSeenAt === null || row.lastSeenAt < before)) row.lastSeenAt = now;
  }

  async endSession(tokenHash: string) {
    return this.sessions.delete(tokenHash);
  }

  async exportFor(email: string) {
    return {
      signIns: [...this.signIns.values()]
        .filter((r) => r.email === email)
        .map((r) => ({
          email: r.email,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          attempts: r.attempts,
          usedAt: r.usedAt,
        })),
      sessions: [...this.sessions.values()]
        .filter((r) => r.email === email)
        .map((r) => ({
          email: r.email,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          lastSeenAt: r.lastSeenAt,
        })),
    };
  }

  async eraseFor(email: string) {
    let signIns = 0;
    let sessions = 0;
    if (this.signIns.delete(email)) signIns++;
    for (const [h, r] of this.sessions)
      if (r.email === email) {
        this.sessions.delete(h);
        sessions++;
      }
    return { signIns, sessions };
  }

  async prune(before: { signIns: number; sessions: number }) {
    let signIns = 0;
    let sessions = 0;
    for (const [e, r] of this.signIns)
      if (r.expiresAt < before.signIns) {
        this.signIns.delete(e);
        signIns++;
      }
    for (const [h, r] of this.sessions)
      if (r.expiresAt < before.sessions) {
        this.sessions.delete(h);
        sessions++;
      }
    return { signIns, sessions };
  }

  /** Every stored hash and email, for a test to prove nothing but hashes is kept. */
  stored() {
    return {
      signIns: [...this.signIns.values()],
      sessions: [...this.sessions.values()],
    };
  }
}
