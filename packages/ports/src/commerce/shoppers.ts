/**
 * A storefront shopper's sign-in: the emailed code and link that prove a mailbox, and the session
 * a redemption starts (`shopper.ts` in @commerceworker/application, the rules in core's
 * `shopper.ts`). A shopper is a verified email address. Only hashes are stored: of the code, of
 * the link's token and of the session's secret. `d1ShopperAuth` (packages/db) and
 * `InMemoryShopperAuth` (packages/test-kit) implement it, held to one contract; D1 matters here,
 * since a use must be one atomic write: two redemptions of one code or link can't both win.
 */

/** What an address's one live sign-in holds. */
export interface ShopperSignIn {
  readonly email: string;
  readonly codeHash: string;
  readonly linkHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** What `issueSignIn` holds a new sign-in to. */
export interface ShopperSignInLimits {
  /** No new sign-in within this long of the address's last. */
  readonly cooldownMs: number;
  /**
   * None either while the address's failures in this window (counted across its codes: a new one
   * keeps them unless the last try was longer ago than this, or the sign-in was used) have reached
   * `maxAttempts`, until this long after its last try.
   */
  readonly lockoutMs: number;
  readonly maxAttempts: number;
  /** At most `dailyMax` sign-ins to one address in any `dayMs` (the window opens at its first). */
  readonly dailyMax: number;
  readonly dayMs: number;
}

export interface ShopperSessionRow {
  readonly email: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number | null;
}

export interface ShopperAuth {
  /**
   * Replaces the address's sign-in (one is live per address: a new one ends the old, its code and
   * its link), unless the last was made within the cooldown, the address is locked out, or it has
   * had its sign-ins for the day. False when refused. One write, so two requests can't both pass.
   * The tries made against the old one carry over to the new, which is what makes the lockout hold.
   */
  issueSignIn(s: ShopperSignIn, limits: ShopperSignInLimits): Promise<boolean>;
  /**
   * Counts a try against the address's live sign-in (unused, unexpired, under `maxAttempts`) and
   * returns the code hash to compare, or null when there is none to try. Every try is counted
   * before it is compared, a right one too, and stamps the time the lockout runs from.
   */
  spendAttempt(email: string, now: number, maxAttempts: number): Promise<string | null>;
  /**
   * Uses the sign-in once, if its code hash is `codeHash` and it is live. True for the one caller
   * that used it.
   */
  consumeCode(email: string, codeHash: string, now: number): Promise<boolean>;
  /**
   * Uses the sign-in whose link hash this is, once, if live; the address it was sent to, or null.
   * It never reads the tries: a link still works after its code was locked out.
   */
  consumeLink(linkHash: string, now: number): Promise<string | null>;
  /** The address an unspent, unexpired link is for, or null. Writes nothing. */
  linkEmail(linkHash: string, now: number): Promise<string | null>;
  createSession(s: {
    tokenHash: string;
    email: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;
  /** The live session for a secret's hash, or null. A read: it writes nothing. */
  session(tokenHash: string, now: number): Promise<ShopperSessionRow | null>;
  /** Records a use of the session, if its last was before `before`. */
  touchSession(tokenHash: string, now: number, before: number): Promise<void>;
  /** Ends a session. True if there was one. */
  endSession(tokenHash: string): Promise<boolean>;
  /** An address's sign-ins and sessions as stored, without a hash, for a data subject export. */
  exportFor(email: string): Promise<{
    signIns: Record<string, unknown>[];
    sessions: Record<string, unknown>[];
  }>;
  /** Deletes an address's sign-ins and sessions, ending every session. */
  eraseFor(email: string): Promise<{ signIns: number; sessions: number }>;
  /** Deletes sign-ins that expired before `signInsBefore` and sessions that expired before `sessionsBefore`. */
  prune(before: {
    signIns: number;
    sessions: number;
  }): Promise<{ signIns: number; sessions: number }>;
}
