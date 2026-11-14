import type {
  AdminPasswordReset,
  AdminPasswordResets,
  PasswordResetLookup,
} from '@commerceworker/ports';
import { InMemoryAdminAuth } from './admin-auth';

/** Shared auth state makes revocation visible through the auth and reset ports. */
export class InMemoryAdminPasswordResets extends InMemoryAdminAuth implements AdminPasswordResets {
  readonly resets = new Map<string, AdminPasswordReset & { usedAt: number | null }>();
  async issue(reset: AdminPasswordReset) {
    const collision = this.resets.get(reset.id);
    if (collision && collision.userId !== reset.userId && collision.expiresAt > reset.createdAt)
      throw new Error('UNIQUE constraint failed: password_resets.id');
    for (const [id, old] of this.resets)
      if (old.userId === reset.userId || old.expiresAt <= reset.createdAt) this.resets.delete(id);
    this.resets.set(reset.id, { ...reset, usedAt: null });
  }
  async live(query: PasswordResetLookup, now: number) {
    const reset = [...this.resets.values()]
      .filter((r) => {
        const user = this.users.get(r.userId);
        return (
          user &&
          user.disabledAt === null &&
          user.passwordHash !== null &&
          r.usedAt === null &&
          r.expiresAt > now &&
          ('id' in query
            ? r.id === query.id
            : user.email === query.email && r.browserHash === query.browserHash)
        );
      })
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return reset ? { id: reset.id, userId: reset.userId, codeHash: reset.codeHash } : undefined;
  }
  async claim(id: string, now: number) {
    const reset = this.resets.get(id);
    if (!reset || reset.usedAt !== null) return false;
    this.resets.set(id, { ...reset, usedAt: now });
    return true;
  }
  async complete(userId: string, passwordHash: string) {
    const user = this.users.get(userId);
    if (user)
      this.users.set(userId, {
        ...user,
        passwordHash,
        passwordChangeDue: false,
        passwordExpiresAt: null,
      });
    for (const [id, reset] of this.resets) if (reset.userId === userId) this.resets.delete(id);
    for (const [id, challenge] of this.challenges)
      if (challenge.userId === userId) this.challenges.delete(id);
    let ended = 0;
    for (const [id, session] of this.sessions)
      if (session.userId === userId) {
        this.sessions.delete(id);
        ended++;
      }
    return ended;
  }
}
