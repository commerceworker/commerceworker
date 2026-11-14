import type { AdminAuth } from '@commerceworker/ports';
import type { FailureWindow } from '@commerceworker/ports/commerce';
import { InMemoryAuthStore } from './commerce/auth-store';

/** Same human credential rules as commerce, in Studio's own persistence boundary. */
export class InMemoryAdminAuth extends InMemoryAuthStore implements AdminAuth {
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
