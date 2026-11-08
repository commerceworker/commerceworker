/**
 * One-time codes that confirm an action over MCP: issued with the preview, used once by the same
 * caller for the same tool and input before they expire. The use is the check, so two calls with
 * one code can't both run. `d1ConfirmationStore` (packages/db) and `InMemoryConfirmationStore`
 * (packages/test-kit) implement it, held to one contract.
 */

export interface ConfirmationStore {
  issue(c: {
    id: string;
    principalId: string;
    tool: string;
    inputDigest: string;
    createdAt: number;
    expiresAt: number;
    bound: Record<string, unknown> | null;
  }): Promise<void>;
  /**
   * Uses a code once, for the caller, tool and input digest it was issued for, before it expires.
   * Returns what it was held to, or null when refused.
   */
  redeem(
    code: string,
    principalId: string,
    tool: string,
    inputDigest: string,
    now: number,
  ): Promise<{ bound: Record<string, unknown> | null } | null>;
  /** Drops codes that expired before `before`. Returns how many. */
  prune(before: number): Promise<number>;
}
