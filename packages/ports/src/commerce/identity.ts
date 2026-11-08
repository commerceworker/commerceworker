/**
 * Who a caller is, as the workspace's records say now: whether anyone has an account yet, whether
 * an API token still holds, and a person's live session. Agents re-read a principal through this
 * before acting, so signing out, a disabled account, a role change or a revoked token applies to a
 * page that is already open. `d1IdentityStore` (packages/db) and `InMemoryIdentityStore`
 * (packages/test-kit) implement it, held to one contract.
 */

export interface LiveSession {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  /** When the session was last used (its creation, if never). */
  readonly seen: number;
  /** When its person last signed in again at the identity provider, for a step-up. */
  readonly reauthAt: number | null;
}

export interface IdentityStore {
  /** Whether any account exists (local dev runs open until one does). */
  anyone(): Promise<boolean>;
  /** A token's standing: its role, when it was revoked and when it expires. */
  token(
    id: string,
  ): Promise<{ role: string; revokedAt: number | null; expiresAt: number | null } | undefined>;
  /**
   * A session that hasn't expired at `now` nor been idle since `now - idleMs`, with its person,
   * who isn't disabled.
   */
  session(tokenHash: string, now: number, idleMs: number): Promise<LiveSession | undefined>;
  /** Counts a session as used at `now`. */
  touchSession(tokenHash: string, now: number): Promise<void>;
  /** When a person was disabled, null while active, or undefined for no such person. */
  disabledAt(userId: string): Promise<number | null | undefined>;
}
