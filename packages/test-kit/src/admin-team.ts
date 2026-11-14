import type { AdminTeam } from '@commerceworker/ports';
import { InMemoryAdminAuth } from './admin-auth';

/** One in-memory team and auth store so changes are visible through either port. */
export class InMemoryAdminTeam extends InMemoryAdminAuth implements AdminTeam {
  async people() {
    return [...this.users.values()]
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        disabledAt: u.disabledAt,
        createdAt: u.createdAt ?? 0,
        lastLoginAt: u.lastLoginAt ?? null,
        twoFactorAt: u.totpEnabledAt,
        passwordChangeDue: u.passwordChangeDue,
      }));
  }
  async hasOtherAdmin(id: string) {
    return this.otherAdmin(id);
  }
  private otherAdmin(id: string) {
    return [...this.users.values()].some(
      (u) => u.id !== id && u.role === 'admin' && u.disabledAt === null,
    );
  }
  async setRole(id: string, role: string) {
    const user = this.users.get(id);
    if (!user || (role !== 'admin' && !this.otherAdmin(id))) return false;
    this.users.set(id, { ...user, role });
    return true;
  }
  async setDisabled(id: string, at: number | null) {
    const user = this.users.get(id);
    if (!user || (at !== null && !this.otherAdmin(id))) return false;
    this.users.set(id, { ...user, disabledAt: at });
    return true;
  }
  async admins(limit: number) {
    return [...this.users.values()]
      .filter((u) => u.role === 'admin' && u.disabledAt === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(({ name, email }) => ({ name, email }));
  }
}
