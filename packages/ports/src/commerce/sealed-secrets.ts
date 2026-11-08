/**
 * Every secret stored sealed with the deployment's `DATA_KEY`, across the columns that hold one,
 * so the daily sweep can move each onto the current key. A value is replaced only while it is
 * still the one read, so a rotation that lands in between isn't undone. `d1SealedSecrets`
 * (packages/db) and `InMemorySealedSecrets` (packages/test-kit) implement it, held to one contract.
 */

/** The columns that hold a sealed secret. */
export const SEALED_COLUMNS = [
  'users.totp_secret',
  'webhook_subscriptions.secret',
  'webhook_subscriptions.previous_secret',
  'integrations.secret',
  'integrations.previous_secret',
  'plugin_secrets.value',
] as const;

export type SealedColumn = (typeof SEALED_COLUMNS)[number];

/** One stored value. A plugin secret's id is `<pluginId>/<name>`. */
export interface SealedValue {
  readonly column: SealedColumn;
  readonly id: string;
  readonly value: string;
}

export interface SealedSecretStore {
  /** Every value stored in a column (empty ones left out). */
  values(column: SealedColumn): Promise<SealedValue[]>;
  /** Writes `next` over a value only if it is still `was`. Returns whether it did. */
  replace(column: SealedColumn, id: string, was: string, next: string): Promise<boolean>;
}
