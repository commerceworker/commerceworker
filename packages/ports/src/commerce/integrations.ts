/**
 * Integrations: the external systems that sign webhooks to the workspace, each with its own sealed
 * secret and scope (the events it may send, whether it starts orders and on which flows, the
 * channel it is bound to). Verifying signatures and the scope checks are the web app's and core's;
 * this port only reads and writes. `d1IntegrationStore` (packages/db) and `InMemoryIntegrationStore`
 * (packages/test-kit) implement it, held to one contract.
 */

/** An integration as the admin API shows it: never a secret. */
export interface IntegrationView {
  readonly id: string;
  readonly name: string;
  /** The events it may send, as JSON. */
  readonly events: string;
  readonly startOrders: boolean;
  /** The flows it may start orders on, as JSON. */
  readonly flows: string;
  /** The channel it is bound to, if any. */
  readonly channel: string | null;
  readonly createdAt: number;
  readonly createdBy: string | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
  /** Until when the secret before a rotation still works, if one was rotated. */
  readonly previousExpiresAt: number | null;
}

/** A live integration with its secrets, sealed with `DATA_KEY` for its row. */
export interface IntegrationRecord extends IntegrationView {
  readonly secret: string;
  readonly previousSecret: string | null;
}

export interface IntegrationStore {
  /** Up to `limit` integrations, newest first. */
  list(limit: number): Promise<IntegrationView[]>;
  add(i: {
    id: string;
    name: string;
    secret: string;
    events: string;
    startOrders: boolean;
    flows: string;
    channel: string | null;
    createdAt: number;
    createdBy: string | null;
  }): Promise<void>;
  /**
   * Gives a live integration a new sealed secret, its current one working too until
   * `previousUntil`. One write, so two rotations at once can't leave the sender a secret it never
   * saw. Undefined for an unknown or revoked integration.
   */
  rotate(id: string, secret: string, previousUntil: number): Promise<IntegrationView | undefined>;
  /** Revokes a live integration and both its secrets; undefined when it already was, or isn't. */
  revoke(id: string, at: number): Promise<IntegrationView | undefined>;
  /** A live integration with its sealed secrets. */
  active(id: string): Promise<IntegrationRecord | undefined>;
  /** Records when it last sent something. */
  touch(id: string, at: number): Promise<void>;
}
