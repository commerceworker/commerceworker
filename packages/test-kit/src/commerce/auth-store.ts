/**
 * The sign-in port in memory, seeded with people, sessions, tokens and recovery codes. The contract
 * in ./auth-store-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { AuthStore, AuthUser, FailureWindow } from '@commerceworker/ports/commerce';

type Session = {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  ip: string | null;
  userAgent: string | null;
  reauthAt: number | null;
};

export interface AuthFixture {
  users?: (Partial<AuthUser> & Pick<AuthUser, 'id' | 'email' | 'name' | 'role'>)[];
  sessions?: (Partial<Session> &
    Pick<Session, 'tokenHash' | 'userId' | 'createdAt' | 'expiresAt'>)[];
  tokens?: {
    id: string;
    name: string;
    prefix: string;
    tokenHash: string;
    role: string;
    revokedAt?: number | null;
    expiresAt?: number | null;
    lastUsedAt?: number | null;
  }[];
  recoveryCodes?: { userId: string; codeHash: string }[];
}

const blank = (u: NonNullable<AuthFixture['users']>[number]): AuthUser => ({
  passwordHash: null,
  externalSub: null,
  disabledAt: null,
  totpSecret: null,
  totpEnabledAt: null,
  totpLastStep: null,
  passwordChangeDue: false,
  passwordExpiresAt: null,
  ...u,
});

export class InMemoryAuthStore implements AuthStore {
  readonly users = new Map<string, AuthUser & { lastLoginAt?: number }>();
  readonly sessions = new Map<string, Session>();
  readonly tokens: NonNullable<AuthFixture['tokens']>;
  private readonly codes: NonNullable<AuthFixture['recoveryCodes']>;
  private readonly windows = new Map<string, FailureWindow>();
  private readonly challenges = new Map<string, { userId: string; expiresAt: number }>();

  constructor(fixture: AuthFixture = {}) {
    const f = structuredClone(fixture);
    for (const u of f.users ?? []) this.users.set(u.id, blank(u));
    for (const s of f.sessions ?? [])
      this.sessions.set(s.tokenHash, {
        lastSeenAt: null,
        ip: null,
        userAgent: null,
        reauthAt: null,
        ...s,
      });
    this.tokens = f.tokens ?? [];
    this.codes = f.recoveryCodes ?? [];
  }

  private plain(id: string) {
    const u = this.users.get(id);
    if (!u) return undefined;
    const { lastLoginAt: _l, ...rest } = u;
    return rest;
  }

  async userCount() {
    return this.users.size;
  }
  async userByEmail(email: string) {
    const u = [...this.users.values()].find((x) => x.email === email);
    return u ? this.plain(u.id) : undefined;
  }
  async user(id: string) {
    return this.plain(id);
  }
  async userBySub(sub: string) {
    const u = [...this.users.values()].find((x) => x.externalSub === sub);
    return u ? this.plain(u.id) : undefined;
  }
  async addSsoUser(u: {
    id: string;
    email: string;
    name: string;
    role: string;
    externalSub: string;
    createdAt: number;
  }) {
    const clash = [...this.users.values()].some(
      (x) => x.id === u.id || x.email === u.email || x.externalSub === u.externalSub,
    );
    if (clash) throw new Error('UNIQUE constraint failed: users');
    const { createdAt: _at, ...person } = u;
    this.users.set(u.id, blank(person));
  }
  async linkSub(userId: string, sub: string) {
    const u = this.users.get(userId);
    if (!u || u.externalSub) return false;
    if ([...this.users.values()].some((x) => x.externalSub === sub)) return false;
    this.users.set(userId, { ...u, externalSub: sub });
    return true;
  }
  async addUser(u: {
    id: string;
    email: string;
    name: string;
    role: string;
    passwordHash: string;
    passwordChangeDue: boolean;
    passwordExpiresAt: number | null;
  }) {
    if ([...this.users.values()].some((x) => x.id === u.id || x.email === u.email))
      throw new Error('UNIQUE constraint failed: users.email');
    this.users.set(u.id, blank(u));
  }
  async setPassword(
    id: string,
    passwordHash: string,
    temporary: { changeDue: boolean; expiresAt: number | null },
  ) {
    const u = this.users.get(id);
    if (u)
      this.users.set(id, {
        ...u,
        passwordHash,
        passwordChangeDue: temporary.changeDue,
        passwordExpiresAt: temporary.expiresAt,
      });
  }
  async addUserIfAbsent(u: { id: string; email: string; name: string; role: string }) {
    if (!this.users.has(u.id)) this.users.set(u.id, blank(u));
  }
  async rehashPassword(id: string, was: string, next: string) {
    const u = this.users.get(id);
    if (u?.passwordHash === was) this.users.set(id, { ...u, passwordHash: next });
  }
  async useTotpStep(id: string, step: number) {
    const u = this.users.get(id);
    if (!u || (u.totpLastStep !== null && u.totpLastStep >= step)) return false;
    this.users.set(id, { ...u, totpLastStep: step });
    return true;
  }
  async useRecoveryCode(userId: string, codeHash: string) {
    const i = this.codes.findIndex((c) => c.userId === userId && c.codeHash === codeHash);
    if (i < 0) return false;
    this.codes.splice(i, 1);
    return true;
  }
  async replaceRecoveryCodes(userId: string, codeHashes: readonly string[]) {
    for (let i = this.codes.length - 1; i >= 0; i--)
      if (this.codes[i]!.userId === userId) this.codes.splice(i, 1);
    for (const codeHash of codeHashes) this.codes.push({ userId, codeHash });
  }
  async enableTotp(userId: string, sealedSecret: string, at: number, step: number) {
    const u = this.users.get(userId);
    if (u)
      this.users.set(userId, {
        ...u,
        totpSecret: sealedSecret,
        totpEnabledAt: at,
        totpLastStep: step,
      });
  }
  async disableTotp(userId: string) {
    const u = this.users.get(userId);
    if (u)
      this.users.set(userId, { ...u, totpSecret: null, totpEnabledAt: null, totpLastStep: null });
    await this.replaceRecoveryCodes(userId, []);
  }
  async recoveryCodesLeft(userId: string) {
    return this.codes.filter((c) => c.userId === userId).length;
  }

  async liveSession(tokenHash: string, now: number, idleMs: number) {
    const s = this.sessions.get(tokenHash);
    const u = s && this.plain(s.userId);
    if (!s || !u || u.disabledAt) return undefined;
    const seen = s.lastSeenAt ?? s.createdAt;
    if (s.expiresAt <= now || seen <= now - idleMs) return undefined;
    return { ...u, seen };
  }
  async session(tokenHash: string) {
    const s = this.sessions.get(tokenHash);
    return s ? { userId: s.userId, reauthAt: s.reauthAt } : undefined;
  }
  private row(s: Session) {
    const { tokenHash, userAgent, ip, createdAt, lastSeenAt } = s;
    return { tokenHash, userAgent, ip, createdAt, lastSeenAt };
  }
  async sessionsOf(userId: string, now: number) {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId && s.expiresAt > now)
      .map((s) => this.row(s));
  }
  async sessionByRef(userId: string, ref: string) {
    const s = [...this.sessions.values()].find(
      (x) => x.userId === userId && x.tokenHash.startsWith(ref),
    );
    return s && this.row(s);
  }
  async startSession(s: Omit<Session, 'lastSeenAt' | 'reauthAt'>) {
    this.sessions.set(s.tokenHash, { ...s, lastSeenAt: s.createdAt, reauthAt: null });
    const u = this.users.get(s.userId);
    if (u) this.users.set(s.userId, { ...u, lastLoginAt: s.createdAt });
  }
  async touchSession(tokenHash: string, now: number, ip: string | null) {
    const s = this.sessions.get(tokenHash);
    if (s) Object.assign(s, { lastSeenAt: now, ip });
  }
  async setReauth(tokenHash: string, userId: string, at: number) {
    const s = this.sessions.get(tokenHash);
    if (s?.userId === userId) s.reauthAt = at;
  }
  async endSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
  async endSessions(userId: string, except?: string) {
    let n = 0;
    for (const [k, s] of this.sessions)
      if (s.userId === userId && k !== except) {
        this.sessions.delete(k);
        n++;
      }
    return n;
  }
  async knownPlace(email: string, ip: string, now: number) {
    return [...this.sessions.values()].some(
      (s) => s.ip === ip && s.expiresAt > now && this.users.get(s.userId)?.email === email,
    );
  }

  async liveToken(tokenHash: string) {
    const t = this.tokens.find((x) => x.tokenHash === tokenHash && !x.revokedAt);
    return t
      ? {
          id: t.id,
          name: t.name,
          prefix: t.prefix,
          role: t.role,
          lastUsedAt: t.lastUsedAt ?? null,
          expiresAt: t.expiresAt ?? null,
        }
      : undefined;
  }
  async touchToken(id: string, at: number) {
    const t = this.tokens.find((x) => x.id === id);
    if (t) t.lastUsedAt = at;
  }

  async failures(keys: readonly string[]) {
    return keys.flatMap((k) => {
      const w = this.windows.get(k);
      return w ? [{ ...w }] : [];
    });
  }
  async recordFailures(keys: readonly string[], now: number, windowMs: number) {
    for (const key of keys) {
      const w = this.windows.get(key);
      this.windows.set(
        key,
        !w || now - w.windowStart >= windowMs
          ? { key, count: 1, windowStart: now }
          : { ...w, count: w.count + 1 },
      );
    }
  }
  async clearFailures(key: string) {
    this.windows.delete(key);
  }
  async pruneFailures(before: number) {
    for (const [k, w] of this.windows) if (w.windowStart < before) this.windows.delete(k);
  }

  async startChallenge(c: {
    tokenHash: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
  }) {
    for (const [k, x] of this.challenges) if (x.expiresAt <= c.createdAt) this.challenges.delete(k);
    this.challenges.set(c.tokenHash, { userId: c.userId, expiresAt: c.expiresAt });
  }
  async challenge(tokenHash: string, now: number) {
    const c = this.challenges.get(tokenHash);
    const u = c && this.plain(c.userId);
    if (!c || !u || c.expiresAt <= now || u.disabledAt || !u.totpEnabledAt) return undefined;
    return u;
  }
  async endChallenge(tokenHash: string) {
    this.challenges.delete(tokenHash);
  }
}
