/** A reset's code and asking browser are stored only as hashes. */
export interface AdminPasswordReset {
  id: string;
  userId: string;
  codeHash: string;
  browserHash: string;
  createdAt: number;
  expiresAt: number;
}
export type PasswordResetLookup = { id: string } | { email: string; browserHash: string };

export interface AdminPasswordResets {
  /** Replaces the person's codes and prunes expired ones atomically. */
  issue(reset: AdminPasswordReset): Promise<void>;
  /** Newest unspent, unexpired code of an enabled password account. */
  live(
    query: PasswordResetLookup,
    now: number,
  ): Promise<Pick<AdminPasswordReset, 'id' | 'userId' | 'codeHash'> | undefined>;
  /** Spends a code once, before setting the password. */
  claim(id: string, now: number): Promise<boolean>;
  /** One batch: password, resets, pending second-factor challenges and sessions; actual session count. */
  complete(userId: string, passwordHash: string): Promise<number>;
}
