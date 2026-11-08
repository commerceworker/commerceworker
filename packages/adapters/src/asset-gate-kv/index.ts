import type { Scope } from '@commerceworker/domain';
import type { AssetGate, AssetGateEntry } from '@commerceworker/ports';

/** The subset of a Workers KV namespace binding the gate uses. */
export interface KvGateBinding {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: readonly { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/**
 * How long a colo may keep a gate read (KV's minimum). A removal reaches every colo within it,
 * which is why the engine purges a revoked asset's media a second time once it has passed.
 */
export const GATE_READ_TTL_SECONDS = 60;

/** The KV key prefix of one environment's gate entries. */
export const assetGatePrefix = (scope: Scope) =>
  `asset-gate:${scope.spaceId}:${scope.environmentId}:`;

/** The KV key of one published asset's gate entry. */
export const assetGateKey = (scope: Scope, assetId: string) =>
  `${assetGatePrefix(scope)}${assetId}`;

function parse(raw: string): AssetGateEntry | null {
  try {
    const e = JSON.parse(raw) as Partial<AssetGateEntry>;
    if (
      typeof e.v === 'number' &&
      typeof e.r2Key === 'string' &&
      typeof e.contentType === 'string' &&
      typeof e.fileName === 'string'
    ) {
      return e as AssetGateEntry;
    }
  } catch {
    // Falls through: an unreadable entry gates nothing.
  }
  return null;
}

/**
 * The published-asset gate in Workers KV. The engine writes and removes entries from the asset's
 * events; the media Worker only reads them, on a cache miss. Entries never expire on their own:
 * an asset leaves the gate when it leaves Delivery.
 */
export function createKvAssetGate(kv: KvGateBinding): AssetGate {
  return {
    async get(scope, assetId) {
      const raw = await kv.get(assetGateKey(scope, assetId), { cacheTtl: GATE_READ_TTL_SECONDS });
      return raw === null ? null : parse(raw);
    },
    async put(scope, assetId, entry) {
      await kv.put(assetGateKey(scope, assetId), JSON.stringify(entry));
    },
    async delete(scope, assetId) {
      await kv.delete(assetGateKey(scope, assetId));
    },
    async deleteScope(scope) {
      // A page at a time (KV lists at most 1000 keys), deleting as it goes; a retry after a
      // failure lists what is left. An environment id may hold ':' (`a` and `a:b` share a
      // prefix), and an asset id never does, so only keys with no ':' past the prefix are this
      // scope's.
      const prefix = assetGatePrefix(scope);
      let cursor: string | undefined;
      do {
        const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
        const own = page.keys.filter((k) => !k.name.slice(prefix.length).includes(':'));
        await Promise.all(own.map((k) => kv.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    },
  };
}
