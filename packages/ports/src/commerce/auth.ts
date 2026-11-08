/**
 * The web app's sign-in records: people and their credentials, browser sessions, API tokens, the
 * windows of failed attempts that throttle guessing, and the challenge between a correct password
 * and a correct two-factor code. The rules (idle limits, when two-factor sign-in is due, which
 * step-up a person gets) are the web app's; this port only reads and writes. Every change that
 * must happen once (a code step used, a recovery code spent) is one guarded write, so two requests
 * racing can't both win. `d1AuthStore` (packages/db) and `InMemoryAuthStore` (packages/test-kit)
 * implement it, held to one contract.
 */

/** A person with what signing in checks. */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly passwordHash: string | null;
  readonly externalSub: string | null;
  readonly disabledAt: number | null;
  /** Sealed with `DATA_KEY`. */
  readonly totpSecret: string | null;
  readonly totpEnabledAt: number | null;
  /** The last authenticator step used, so a code works once. */
  readonly totpLastStep: number | null;
  readonly passwordChangeDue: boolean;
  readonly passwordExpiresAt: number | null;
}

/** A browser session as its person sees it on their Account page. */
export interface SessionRow {
  readonly tokenHash: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
}

export interface FailureWindow {
  readonly key: string;
  readonly count: number;
  readonly windowStart: number;
}

export interface AuthStore {
  /** How many people have an account. */
  userCount(): Promise<number>;
  /** A person by their email (already normalized). */
  userByEmail(email: string): Promise<AuthUser | undefined>;
  user(id: string): Promise<AuthUser | undefined>;
  /** A person by the subject their identity provider gave them. */
  userBySub(sub: string): Promise<AuthUser | undefined>;
  /** Adds a person single sign-on brought, already linked to their subject. */
  addSsoUser(u: {
    id: string;
    email: string;
    name: string;
    role: string;
    externalSub: string;
    createdAt: number;
  }): Promise<void>;
  /**
   * Links a person to an identity provider's subject, only while they have none and no one else
   * has it. Returns whether it did.
   */
  linkSub(userId: string, sub: string): Promise<boolean>;
  /** Adds a person with a password. Throws when their email is already on the team. */
  addUser(u: {
    id: string;
    email: string;
    name: string;
    role: string;
    passwordHash: string;
    /** A temporary password: they must change it, before `passwordExpiresAt`. */
    passwordChangeDue: boolean;
    passwordExpiresAt: number | null;
    createdAt: number;
  }): Promise<void>;
  /** Sets a person's password hash, and whether it is temporary (and until when). */
  setPassword(
    id: string,
    passwordHash: string,
    temporary: { changeDue: boolean; expiresAt: number | null },
  ): Promise<void>;
  /** Adds a person unless their id exists (the demo visitor). */
  addUserIfAbsent(u: {
    id: string;
    email: string;
    name: string;
    role: string;
    createdAt: number;
  }): Promise<void>;
  /** Stores a password's new hash, only while the old one is still `was`. */
  rehashPassword(id: string, was: string, next: string): Promise<void>;
  /** Uses a code step: only if later than the last one used. Returns whether it did. */
  useTotpStep(id: string, step: number): Promise<boolean>;
  /** Spends a recovery code of the person's. Returns whether it was theirs and unspent. */
  useRecoveryCode(userId: string, codeHash: string): Promise<boolean>;
  /** Replaces a person's recovery codes with these (hashed). */
  replaceRecoveryCodes(userId: string, codeHashes: readonly string[], now: number): Promise<void>;
  /** Turns two-factor sign-in on with a sealed secret, the step of the code that confirmed it used. */
  enableTotp(userId: string, sealedSecret: string, at: number, step: number): Promise<void>;
  /** Turns two-factor sign-in off: the secret and every recovery code go. */
  disableTotp(userId: string): Promise<void>;
  /** How many recovery codes a person has left. */
  recoveryCodesLeft(userId: string): Promise<number>;

  /**
   * A session not expired at `now` nor idle since `now - idleMs`, with its person, who isn't
   * disabled. `seen` is when it was last used (its creation, if never).
   */
  liveSession(
    tokenHash: string,
    now: number,
    idleMs: number,
  ): Promise<(AuthUser & { seen: number }) | undefined>;
  /** A session as stored. */
  session(tokenHash: string): Promise<{ userId: string; reauthAt: number | null } | undefined>;
  /** A person's sessions not expired at `now` (idle ones included: the caller knows the limit). */
  sessionsOf(userId: string, now: number): Promise<SessionRow[]>;
  /** A person's session whose token hash starts with `ref` (its reference on the Account page). */
  sessionByRef(userId: string, ref: string): Promise<SessionRow | undefined>;
  /** Starts a session and records the person's sign-in time. */
  startSession(s: {
    tokenHash: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void>;
  /** Counts a session as used, from `ip`. */
  touchSession(tokenHash: string, now: number, ip: string | null): Promise<void>;
  /** Records when the session's person last proved it was them (a step-up). */
  setReauth(tokenHash: string, userId: string, at: number): Promise<void>;
  endSession(tokenHash: string): Promise<void>;
  /** Ends every session of a person, but `except`. Returns how many. */
  endSessions(userId: string, except?: string): Promise<number>;
  /** Whether a live session of the person with this email was last seen from `ip`. */
  knownPlace(email: string, ip: string, now: number): Promise<boolean>;

  /** A token that hasn't been revoked, by its hash. */
  liveToken(tokenHash: string): Promise<
    | {
        id: string;
        name: string;
        prefix: string;
        role: string;
        lastUsedAt: number | null;
        expiresAt: number | null;
      }
    | undefined
  >;
  touchToken(id: string, at: number): Promise<void>;

  /** The failure windows under these keys. */
  failures(keys: readonly string[]): Promise<FailureWindow[]>;
  /** Counts a failure under each key, starting a fresh window where the old one ended. */
  recordFailures(keys: readonly string[], now: number, windowMs: number): Promise<void>;
  /** Clears a key's window (a success). */
  clearFailures(key: string): Promise<void>;
  /** Drops windows that started before `before`. */
  pruneFailures(before: number): Promise<void>;

  /** Starts the two-factor step for a person, dropping challenges already over. */
  startChallenge(c: {
    tokenHash: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;
  /** A live challenge's person: not disabled, with two-factor sign-in on. */
  challenge(tokenHash: string, now: number): Promise<AuthUser | undefined>;
  endChallenge(tokenHash: string): Promise<void>;
}
