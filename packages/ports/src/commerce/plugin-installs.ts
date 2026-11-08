/**
 * Plugins an admin installs at runtime: each uploaded version's row (pending, active, disabled,
 * superseded or uninstalled), the secrets an admin entered for it (sealed, never read back out by
 * people), and a sandboxed plugin's latest exceptions. One version of an id runs at a time:
 * activating one supersedes the one before in the same transaction, and every change is guarded by
 * the status it expects, so two admins acting at once can't leave two running.
 * `d1PluginInstallStore` (packages/db) and `InMemoryPluginInstallStore` (packages/test-kit)
 * implement it, held to one contract.
 */

export type PluginInstallStatus = 'pending' | 'active' | 'disabled' | 'superseded' | 'uninstalled';

export interface PluginInstallRecord {
  readonly id: string;
  readonly sha: string;
  readonly version: string;
  readonly publisher: string;
  /** The manifest, as JSON. */
  readonly manifest: string;
  readonly status: string;
  /** 1 when an admin granted it buyer details. */
  readonly personalDataGranted: number;
  readonly uploadedBy: string;
  readonly uploadedAt: number;
  readonly approvedBy: string | null;
  readonly approvedAt: number | null;
  /** An assistant draft's: the admin's instruction. */
  readonly request: string | null;
  /** An assistant draft's test cases and their last results, as JSON. */
  readonly cases: string | null;
}

export interface PluginInstallStore {
  /** Every version of a plugin id. */
  versions(id: string): Promise<PluginInstallRecord[]>;
  /** Every version of every plugin. */
  all(): Promise<PluginInstallRecord[]>;
  /** The active version of each plugin. */
  active(): Promise<{ id: string; sha: string; personalData: boolean; publisher: string }[]>;
  /** The sha of a plugin's active version, read now. */
  activeSha(id: string): Promise<string | undefined>;
  /**
   * Records an uploaded version as pending. Replaces only an uninstalled row of the same file.
   * `conflict` when another upload of that version got in first.
   */
  upload(row: PluginInstallRecord): Promise<'ok' | 'conflict'>;
  /**
   * Makes a version the one that runs, if it is still `from`, superseding the one that ran: one
   * transaction. False when it changed meanwhile.
   */
  activate(
    v: { id: string; sha: string },
    from: PluginInstallStatus,
    set: { approvedBy?: string; approvedAt?: number; personalDataGranted?: number },
  ): Promise<boolean>;
  /** Moves a version between statuses, if it is still `from`. */
  setStatus(id: string, sha: string, from: string, to: PluginInstallStatus): Promise<boolean>;
  /** Replaces a draft's cases, if they are still `prev`. */
  setCases(id: string, sha: string, prev: string | null, next: string): Promise<boolean>;
  /** Marks every version uninstalled and deletes its secrets: one transaction. */
  uninstall(id: string): Promise<void>;
  /** A secret's sealed value. */
  secret(id: string, name: string): Promise<string | undefined>;
  /** Sets a secret's sealed value. */
  setSecret(id: string, name: string, sealed: string, by: string): Promise<void>;
  /** A sandboxed plugin's latest exceptions, newest first. */
  errors(id: string, limit: number): Promise<{ id: string; message: string; at: number }[]>;
  /** Records a sandboxed plugin's exceptions, keeping only its latest `keep`. */
  recordErrors(
    id: string,
    errors: readonly { message: string; at: number }[],
    keep: number,
  ): Promise<void>;
}
