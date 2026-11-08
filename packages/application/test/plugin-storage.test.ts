import {
  PLUGIN_KV_LIMITS,
  type PluginManifest,
  type Principal,
  SCOPES,
} from '@commerceworker/domain';
import type { PluginCapabilities, PluginRuntime } from '@commerceworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createPluginHookDispatcher,
  installPlugin,
  type PluginKv,
  pluginKvCapability,
  setPluginEnabled,
  uninstallPlugin,
} from '../src/index';

/**
 * `kv:storage`: a key/value store per plugin per environment, handed to a
 * plugin only when granted, and namespaced by the installed record's id so one
 * plugin can never name another's keys.
 */

const SPACE = 's1';
const main = { spaceId: SPACE, environmentId: 'main' };
const staging = { spaceId: SPACE, environmentId: 'staging' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

let ctx: AppContext;
let store: InMemoryContentStore;
let blob: FakeBlobStore;

const manifest = (id: string, capabilities: PluginManifest['capabilities']): PluginManifest => ({
  id,
  name: id,
  version: '1.0.0',
  capabilities,
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
});

async function installEnabled(id: string, capabilities: PluginManifest['capabilities']) {
  await installPlugin(ctx, blob, admin, SPACE, {
    manifest: manifest(id, capabilities),
    bundle: `// ${id}`,
    approvedCapabilities: capabilities,
  });
  await setPluginEnabled(ctx, SPACE, id, true);
}

/** Runs one hook and hands each plugin's capabilities, by plugin id, to `body`. */
async function withCaps(
  scope: typeof main,
  body: (pluginId: string, caps: PluginCapabilities) => Promise<void>,
) {
  const runtime: PluginRuntime = {
    async invoke(inv, caps) {
      await body(inv.pluginId, caps);
      return { payload: inv.payload };
    },
  };
  await createPluginHookDispatcher(ctx, blob, runtime, {
    onError: (m) => {
      throw new Error(m);
    },
  }).dispatch('entry:beforeSave', {}, scope);
}

beforeEach(() => {
  blob = new FakeBlobStore();
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('k') };
});

describe('kv:storage through the hook dispatcher', () => {
  it('is handed only to a plugin granted it', async () => {
    await installEnabled('com.example.a', ['kv:storage']);
    await installEnabled('com.example.b', []);
    const seen: Record<string, unknown> = {};
    await withCaps(main, async (id, caps) => {
      seen[id] = caps.kv;
    });
    expect(seen['com.example.a']).toBeDefined();
    expect(seen['com.example.b']).toBeUndefined();
  });

  it('keeps each plugin’s keys its own, whatever key it asks for', async () => {
    await installEnabled('com.example.a', ['kv:storage']);
    await installEnabled('com.example.b', ['kv:storage']);
    const reads: Record<string, unknown> = {};
    // Plugins run in id order: a writes, then b looks for the same key.
    await withCaps(main, async (id, caps) => {
      const kv = caps.kv as PluginKv;
      if (id === 'com.example.a') await kv.put('token', { owner: 'a' });
      reads[id] = await kv.get('token');
      reads[`${id}:list`] = (await kv.list()).keys;
    });
    expect(reads).toEqual({
      'com.example.a': { owner: 'a' },
      'com.example.a:list': ['token'],
      'com.example.b': null,
      'com.example.b:list': [],
    });
  });

  it('keeps environments apart', async () => {
    await installEnabled('com.example.a', ['kv:storage']);
    await withCaps(main, async (_id, caps) => (caps.kv as PluginKv).put('cursor', 1));
    let inStaging: unknown = 'unset';
    await withCaps(staging, async (_id, caps) => {
      inStaging = await (caps.kv as PluginKv).get('cursor');
    });
    expect(inStaging).toBeNull();
    expect(await pluginKvCapability(ctx, main, 'com.example.a').get('cursor')).toBe(1);
  });

  it('is cleared, with the plugin’s settings, when the plugin is uninstalled', async () => {
    await installEnabled('com.example.a', ['kv:storage']);
    await pluginKvCapability(ctx, main, 'com.example.a').put('k', 'v');
    await pluginKvCapability(ctx, staging, 'com.example.a').put('k', 'v');
    await installEnabled('com.example.b', ['kv:storage']);
    await pluginKvCapability(ctx, main, 'com.example.b').put('k', 'kept');

    await uninstallPlugin(ctx, blob, SPACE, 'com.example.a');
    // Reinstalling the same id starts clean.
    await installEnabled('com.example.a', ['kv:storage']);
    expect(await pluginKvCapability(ctx, main, 'com.example.a').get('k')).toBeNull();
    expect(await pluginKvCapability(ctx, staging, 'com.example.a').get('k')).toBeNull();
    expect(await pluginKvCapability(ctx, main, 'com.example.b').get('k')).toBe('kept');
  });
});

describe('the kv methods', () => {
  let kv: PluginKv;
  beforeEach(() => {
    kv = pluginKvCapability(ctx, main, 'com.example.a');
  });

  it('stores JSON and reads back the same shape; delete reports what it removed', async () => {
    await kv.put('state', { n: 1, tags: ['x'] });
    expect(await kv.get('state')).toEqual({ n: 1, tags: ['x'] });
    await kv.put('state', 'replaced');
    expect(await kv.get('state')).toBe('replaced');
    expect(await kv.delete('state')).toBe(true);
    expect(await kv.delete('state')).toBe(false);
    expect(await kv.get('state')).toBeNull();
  });

  it('refuses bad keys and values with a message a plugin author can act on', async () => {
    await expect(kv.put('', 1)).rejects.toThrow(/kv_invalid: key/);
    await expect(kv.put(42, 1)).rejects.toThrow(/kv_invalid: key/);
    await expect(kv.put('k'.repeat(PLUGIN_KV_LIMITS.maxKeyLength + 1), 1)).rejects.toThrow(
      /kv_invalid/,
    );
    await expect(kv.put('k', undefined)).rejects.toThrow(/JSON-serializable/);
    const big = 'x'.repeat(PLUGIN_KV_LIMITS.maxValueBytes);
    await expect(kv.put('k', big)).rejects.toThrow(/kv_limit: value is \d+ bytes/);
    expect(await kv.get('k')).toBeNull();
  });

  it('caps the key count, but an overwrite at the cap still succeeds', async () => {
    for (let i = 0; i < PLUGIN_KV_LIMITS.maxKeys; i++) {
      await store.pluginStorage.put(main, 'com.example.a', `k${i}`, '1', {
        maxKeys: PLUGIN_KV_LIMITS.maxKeys,
        at: new Date(),
      });
    }
    await expect(kv.put('one-more', 1)).rejects.toThrow(/kv_limit: .*1000 keys/);
    await kv.put('k0', 'overwritten');
    expect(await kv.get('k0')).toBe('overwritten');
    // The cap is per plugin: another plugin's space is untouched by this one's.
    await pluginKvCapability(ctx, main, 'com.example.b').put('k', 1);
    expect(await kv.delete('k1')).toBe(true);
    await kv.put('one-more', 1);
  });

  it('lists by prefix in pages, with a cursor', async () => {
    for (let i = 0; i < 130; i++) await kv.put(`doc:${String(i).padStart(3, '0')}`, i);
    await kv.put('other', 1);
    const first = await kv.list({ prefix: 'doc:' });
    expect(first.keys).toHaveLength(PLUGIN_KV_LIMITS.maxListLimit);
    expect(first.keys[0]).toBe('doc:000');
    const second = await kv.list({ prefix: 'doc:', cursor: first.cursor });
    expect(second.keys).toHaveLength(30);
    expect(second.cursor).toBeUndefined();
    expect(second.keys.at(-1)).toBe('doc:129');
    expect((await kv.list({ prefix: 'oth', limit: 5 })).keys).toEqual(['other']);
  });
});
