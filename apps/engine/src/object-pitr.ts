/**
 * A Durable Object's half of a point-in-time restore, shared by the four classes a restore reaches
 * (OrderAgent, CartAgent, A2AAgent, PluginStorage) and the drill's HealthProbe: the bookmark for a
 * time, the rewind, and an export of the object's tables. Each class exposes them as the RPCs
 * `pitrBookmark`, `restoreTo` and `exportState`, which only the engine's own stubs (namespaces.ts)
 * can call: no route reaches them, and nothing here is `@callable`. The Workflows in objects.ts
 * drive them (docs/operations.md, "Restoring an order's or cart's live state"). Point-in-time
 * recovery doesn't run in local dev or workerd, so the use-cases are tested against a fake port.
 */
import { putOnce } from '@commerceworker/application/commerce';
import type { ObjectExport } from '@commerceworker/ports/commerce';

/** What an object hands the helpers: its storage, its abort, and the bucket the undo is kept in. */
export type PitrObject = {
  storage: Pick<
    DurableObjectStorage,
    'sql' | 'getBookmarkForTime' | 'getCurrentBookmark' | 'onNextSessionRestoreBookmark'
  >;
  blockConcurrencyWhile: <T>(work: () => Promise<T>) => Promise<T>;
  abort: (reason: string) => void;
  backups: R2Bucket;
};

export const bookmarkForTime = (o: PitrObject, at: number) => o.storage.getBookmarkForTime(at);
export const currentBookmark = (o: PitrObject) => o.storage.getCurrentBookmark();

/**
 * Sets the object to restart on `bookmark`'s storage, keeps the bookmark that undoes it at `key`
 * (its metadata `undo`) and aborts, which restarts the object restored. Run under
 * `blockConcurrencyWhile` so no request or alarm runs between the three. The key is written before
 * the abort, so a caller that finds it knows the rewind is set; it is the caller's mark that this
 * call, which fails as the object aborts, took.
 */
export async function restoreInPlace(o: PitrObject, bookmark: string, key: string): Promise<void> {
  await o.blockConcurrencyWhile(async () => {
    const undo = await o.storage.onNextSessionRestoreBookmark(bookmark);
    await putOnce(o.backups, key, JSON.stringify({ undo }), { undo });
    o.abort('restoring a bookmark');
  });
}

const base64 = (bytes: ArrayBuffer) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Every table of the object as rows: its own, and the Agents SDK's state table (`cf_agents_state`,
 * which holds an agent's synced state). The SDK's schedules, connections and queue are left out:
 * they are rebuilt from the state, and a copy of a socket is no use. A blob becomes `{ $base64 }`.
 */
export function exportTables(sql: SqlStorage): ObjectExport {
  const names = sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         AND (name NOT LIKE 'cf\\_agents\\_%' ESCAPE '\\' OR name = 'cf_agents_state')
       ORDER BY name`,
    )
    .toArray()
    .map((r) => r.name);
  const tables: ObjectExport['tables'] = {};
  for (const name of names)
    tables[name] = sql
      .exec(`SELECT * FROM "${name.replace(/"/g, '""')}"`)
      .toArray()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            v instanceof ArrayBuffer ? { $base64: base64(v) } : v,
          ]),
        ),
      );
  return { tables };
}

/** The object's half of a restore, over its own storage and the backups bucket. */
export const pitrObject = (ctx: DurableObjectState, env: Pick<Env, 'BACKUPS'>): PitrObject => ({
  storage: ctx.storage,
  blockConcurrencyWhile: (work) => ctx.blockConcurrencyWhile(work),
  abort: (reason) => ctx.abort(reason),
  backups: env.BACKUPS,
});
