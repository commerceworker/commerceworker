import { PLUGIN_KV_LIMITS, type Scope } from '@commerceworker/domain';
import type { AppContext } from './context';

/**
 * The `kv:storage` capability: a key/value store of the plugin's own, per
 * environment.
 *
 * Isolation is structural, not a check. The plugin id is bound here, from the
 * installed-plugin record the host loaded, and every store call carries it;
 * nothing a plugin passes can name another plugin's namespace, because no
 * argument reaches that part of the key. The scope is the hook's, so a plugin
 * running in staging never sees what it wrote in production.
 *
 * Errors are plain `Error`s with the message a plugin author needs: they cross
 * the RPC boundary into the sandbox, where an error's class does not survive.
 */

export interface PluginKv {
  get(key: unknown): Promise<unknown>;
  put(key: unknown, value: unknown): Promise<void>;
  delete(key: unknown): Promise<boolean>;
  list(options?: unknown): Promise<{ keys: string[]; cursor?: string }>;
}

export function pluginKvCapability(ctx: AppContext, scope: Scope, pluginId: string): PluginKv {
  const repo = ctx.store.pluginStorage;
  return {
    async get(key) {
      const raw = await repo.get(scope, pluginId, checkKey(key));
      return raw === null ? null : JSON.parse(raw);
    },
    async put(key, value) {
      const k = checkKey(key);
      const encoded = encodeValue(value);
      const written = await repo.put(scope, pluginId, k, encoded, {
        maxKeys: PLUGIN_KV_LIMITS.maxKeys,
        at: ctx.clock.now(),
      });
      if (!written) {
        throw new Error(
          `kv_limit: this plugin already holds ${PLUGIN_KV_LIMITS.maxKeys} keys here; delete some before adding "${k}"`,
        );
      }
    },
    async delete(key) {
      return repo.delete(scope, pluginId, checkKey(key));
    },
    async list(options) {
      const opts = (options ?? {}) as { prefix?: unknown; cursor?: unknown; limit?: unknown };
      const prefix = opts.prefix === undefined ? undefined : checkKey(opts.prefix, 'prefix', true);
      const after = opts.cursor === undefined ? undefined : checkKey(opts.cursor, 'cursor');
      const limit =
        typeof opts.limit === 'number' && Number.isInteger(opts.limit) && opts.limit > 0
          ? Math.min(opts.limit, PLUGIN_KV_LIMITS.maxListLimit)
          : PLUGIN_KV_LIMITS.maxListLimit;
      const keys = await repo.list(scope, pluginId, {
        ...(prefix ? { prefix } : {}),
        ...(after !== undefined ? { after } : {}),
        limit,
      });
      const last = keys[keys.length - 1];
      return keys.length === limit && last !== undefined ? { keys, cursor: last } : { keys };
    },
  };
}

function checkKey(key: unknown, name = 'key', allowEmpty = false): string {
  if (typeof key !== 'string' || (!allowEmpty && key.length === 0)) {
    throw new Error(`kv_invalid: ${name} must be a non-empty string`);
  }
  if (key.length > PLUGIN_KV_LIMITS.maxKeyLength) {
    throw new Error(
      `kv_invalid: ${name} is longer than ${PLUGIN_KV_LIMITS.maxKeyLength} characters`,
    );
  }
  return key;
}

/** JSON, so a plugin stores structured state and reads back the same shape. */
function encodeValue(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    encoded = undefined;
  }
  if (encoded === undefined) {
    throw new Error('kv_invalid: value must be JSON-serializable (use delete to remove a key)');
  }
  const bytes = new TextEncoder().encode(encoded).length;
  if (bytes > PLUGIN_KV_LIMITS.maxValueBytes) {
    throw new Error(
      `kv_limit: value is ${bytes} bytes encoded; the limit is ${PLUGIN_KV_LIMITS.maxValueBytes}`,
    );
  }
  return encoded;
}
