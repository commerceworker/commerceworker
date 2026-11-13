/**
 * Copying the commerce database out and back: `DatabaseExport` reads it a page at a time,
 * `DatabaseRestoreTarget` rebuilds it in another database, and `BackupStore` is the object store
 * the copy waits in. The daily backup and the restore drill (packages/application,
 * `database-backup.ts`) take these ports; `d1DatabaseExport` and `d1RestoreTarget` (packages/db)
 * and `InMemoryDatabaseCopy` (packages/test-kit) implement the first two, held to one contract.
 */

/** A row as a backup holds it: JSON values only. */
export type CopyRow = Record<string, string | number | null>;

export interface CopyTable {
  readonly name: string;
  /** The `CREATE TABLE` statement. */
  readonly ddl: string;
  readonly columns: readonly string[];
}

/** A search index (an FTS5 virtual table) that is rebuilt from its content table after a restore. */
export interface CopySearchIndex {
  readonly name: string;
  readonly ddl: string;
  /** What `INSERT INTO <name>(<name>, <key>) VALUES(<key>, <value>)` set on it, such as `rank`. */
  readonly config: Readonly<Record<string, string>>;
}

/** The shape of the database: what a restore creates before and after it loads the rows. */
export interface CopySchema {
  /** Tables of record, parents before the tables that reference them. */
  readonly tables: readonly CopyTable[];
  readonly search: readonly CopySearchIndex[];
  /** Created after the rows load, so a trigger never fires on a restored row. */
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
  readonly views: readonly string[];
}

/** One page: `next` is the cursor to continue from, `more` whether rows remain after it. */
export interface CopyPage {
  readonly rows: CopyRow[];
  readonly next: number;
  readonly more: boolean;
}

export interface DatabaseExport {
  schema(): Promise<CopySchema>;
  /** Up to `limit` rows of `table` after `cursor` (0 starts), in a stable order. */
  page(table: string, cursor: number, limit: number): Promise<CopyPage>;
  /** The newest applied migration (`d1_migrations`), null where there is none. */
  migrationHead(): Promise<string | null>;
}

/** The backup a restore is about to load: what a target is checked against before it is wiped. */
export interface RestoreSource {
  /** The backup's newest applied migration (`BackupManifest.migrationHead`). */
  readonly migrationHead: string | null;
  /** The backup's date, recorded in the target's marker. */
  readonly backup: string;
}

export interface DatabaseRestoreTarget {
  /**
   * Empties the target and marks it as a restore's, recording when and from which backup. Refuses
   * a database that looks live, so a binding pointed at the live database can't be wiped: one
   * that holds tables and wasn't made by a restore, one whose migration head is newer than the
   * backup's (it has been migrated past it), and one holding writes newer than its own marker
   * (a standby that was promoted and took traffic).
   */
  reset(from: RestoreSource): Promise<void>;
  /** Creates the tables and search indexes, with no rows. */
  createTables(schema: CopySchema): Promise<void>;
  /** Writes rows keyed as the source had them (a row that exists is replaced: a retry is safe). */
  load(table: string, columns: readonly string[], rows: readonly CopyRow[]): Promise<number>;
  /** Creates indexes, triggers and views, then rebuilds the search indexes from their tables. */
  finish(schema: CopySchema): Promise<void>;
  rowCount(table: string): Promise<number>;
  migrationHead(): Promise<string | null>;
  /** Rows that break a foreign key (`PRAGMA foreign_key_check`). */
  foreignKeyViolations(): Promise<number>;
  /** Tables of record now there, the restore's own marker left out. */
  tableNames(): Promise<string[]>;
  /** Documents a search index holds, for a check that its rebuild covered its content table. */
  indexedRows(index: string): Promise<number>;
}

export interface StoredObject {
  readonly customMetadata?: Record<string, string>;
}

/** The part of an R2 bucket the backups use; a bucket binds to it as is. */
export interface BackupStore {
  head(key: string): Promise<StoredObject | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<StoredObject | null>;
  list(options: { prefix: string; delimiter?: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    delimitedPrefixes: string[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * A backup or restore that must not go on: a chunk that is missing or doesn't match its hash, no
 * manifest, a target that holds something else. Retrying can't fix it.
 */
export class BackupRefusal extends Error {
  override name = 'BackupRefusal';
}
