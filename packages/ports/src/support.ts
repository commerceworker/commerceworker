/**
 * Small infrastructure ports that keep the application layer deterministic and
 * testable. Adapters bind these at the composition root.
 */

/** Abstracts the wall clock so use-cases and tests are deterministic. */
export interface Clock {
  now(): Date;
}

/** Abstracts identifier generation (UUIDs in production, counters in tests). */
export interface IdGenerator {
  newId(): string;
}

/** One-way hash for API tokens (SHA-256 in production). */
export interface Hasher {
  hash(value: string): string;
}

/**
 * Encrypts secrets stored at rest (webhook signing secrets, webhook header
 * values) and opens them again. `context` names where the value lives (table,
 * column, row id) and is bound to the ciphertext as associated data, so a value
 * copied into another row does not open.
 *
 * `open` throws when a value is not in the sealed format or opens under none
 * of the deployment's keys (wrong key, or tampered).
 */
export interface SecretSealer {
  seal(plaintext: string, context: string): Promise<string>;
  open(stored: string, context: string): Promise<string>;
  /**
   * The prefix every value sealed under the CURRENT key starts with. A stored
   * value without it was sealed under a previous key (or is unreadable) —
   * exactly the values a reseal sweep has work to do on.
   */
  currentPrefix(): Promise<string>;
}
