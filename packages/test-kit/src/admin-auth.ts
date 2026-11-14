import type { AdminAuth } from '@commerceworker/ports';
import type { FailureWindow } from '@commerceworker/ports/commerce';
import { InMemoryAuthStore } from './commerce/auth-store';

/** Same human credential rules as commerce, in Studio's own persistence boundary. */
export class InMemoryAdminAuth extends InMemoryAuthStore implements AdminAuth {
  private readonly commerceLinks = new Map<string, string>();
  async userByCommerceSubject(subject: string) {
    const id = this.commerceLinks.get(subject);
    return id ? this.user(id) : undefined;
  }
  async commerceSubjectForUser(userId: string) {
    return [...this.commerceLinks].find(([, id]) => id === userId)?.[0];
  }
  async linkCommerceSubject(userId: string, subject: string) {
    if (
      !this.users.has(userId) ||
      this.commerceLinks.has(subject) ||
      [...this.commerceLinks.values()].includes(userId)
    )
      return false;
    this.commerceLinks.set(subject, userId);
    return true;
  }
  async countAttempts(keys: readonly string[], now: number, windowMs: number) {
    const rows: FailureWindow[] = [];
    for (const key of keys) {
      const old = this.windows.get(key);
      const row =
        !old || now - old.windowStart >= windowMs
          ? { key, count: 1, windowStart: now }
          : { ...old, count: old.count + 1 };
      this.windows.set(key, row);
      rows.push({ ...row });
    }
    return rows;
  }
}
