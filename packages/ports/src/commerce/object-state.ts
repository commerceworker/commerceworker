/**
 * What the engine's Durable Objects offer a restore: a bookmark for a time, a rewind to a bookmark,
 * and an export of live state. `ObjectState` is the one port for the four classes (orders, carts,
 * A2A callers, plugin storage); `ActiveObjects` lists the orders and carts worth a nightly copy.
 * The restore and snapshot use-cases (packages/application, `objects-restore.ts`) take these;
 * point-in-time recovery does not run in local dev or workerd, so their tests inject a fake and
 * the engine binds the real stubs only in `apps/engine/src/wire.ts`.
 */

export const OBJECT_CLASSES = ['OrderAgent', 'CartAgent', 'A2AAgent', 'PluginStorage'] as const;
export type ObjectClass = (typeof OBJECT_CLASSES)[number];

/** The classes the nightly snapshot walks: the ones whose live objects D1 indexes. */
export const SNAPSHOT_CLASSES = ['OrderAgent', 'CartAgent'] as const;
export type SnapshotClass = (typeof SNAPSHOT_CLASSES)[number];

/** An object's tables as rows of JSON values (a blob is `{ "$base64" }`). */
export type ObjectExport = { tables: Record<string, Record<string, unknown>[]> };

export interface ObjectState {
  /** The bookmark for `at` (ms): within the last 30 days, or the object throws. */
  pitrBookmark(cls: ObjectClass, name: string, at: number): Promise<string>;
  /**
   * Sets the object to restart on `bookmark`'s storage, keeps the bookmark that undoes it at
   * `undoKey` in the backups bucket, and aborts the object. The call itself fails as the object
   * aborts: the caller reads `undoKey` to know it took.
   */
  restoreTo(cls: ObjectClass, name: string, bookmark: string, undoKey: string): Promise<void>;
  exportState(cls: ObjectClass, name: string): Promise<ObjectExport>;
  /** Brings what D1 indexes of the object (an order's row, a cart's row) back in step with it. */
  reindex(cls: ObjectClass, name: string): Promise<void>;
}

export interface ActiveObjectPage {
  names: string[];
  /** The cursor to continue from. */
  next: string;
  more: boolean;
}

export interface ActiveObjects {
  /** Up to `limit` live objects of `cls` with a name after `after` (`''` starts), in name order. */
  page(cls: SnapshotClass, after: string, limit: number): Promise<ActiveObjectPage>;
}
