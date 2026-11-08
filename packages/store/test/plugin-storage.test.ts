import {
  createSecretSealer,
  resealSecrets,
  secretContext,
  withSealedSecrets,
} from '@commerceworker/application';
import type { PluginSettings } from '@commerceworker/domain';
import type { ContentStore, StoredSecretRepo } from '@commerceworker/ports';
import { afterAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * The plugin tables against D1: `kv:storage` keeps each plugin's keys apart by
 * plugin and by environment in every statement, caps the key count in the same
 * statement that writes, and pages past the 100-parameter cap; plugin settings
 * save by compare-and-set and their secrets join the reseal sweep.
 */
const store = createD1Store(testDb);
const run = `pkv-${crypto.randomUUID()}`;
const main = { spaceId: run, environmentId: 'main' };
const staging = { spaceId: run, environmentId: 'staging' };
const at = new Date('2026-01-01T00:00:00.000Z');

afterAll(async () => {
  await testDb.prepare('delete from plugin_kv where space_id = ?').bind(run).run();
  await testDb.prepare('delete from plugin_settings where space_id = ?').bind(run).run();
});

describe('plugin kv (D1 contract)', () => {
  const kv = store.pluginStorage;

  it('keeps plugins and environments apart in every operation', async () => {
    expect(await kv.put(main, 'com.a', 'k', '"a-main"', { maxKeys: 10, at })).toBe(true);
    expect(await kv.put(staging, 'com.a', 'k', '"a-staging"', { maxKeys: 10, at })).toBe(true);
    expect(await kv.put(main, 'com.b', 'k', '"b-main"', { maxKeys: 10, at })).toBe(true);

    expect(await kv.get(main, 'com.a', 'k')).toBe('"a-main"');
    expect(await kv.get(staging, 'com.a', 'k')).toBe('"a-staging"');
    expect(await kv.get(main, 'com.b', 'k')).toBe('"b-main"');
    expect(await kv.get(main, 'com.c', 'k')).toBeNull();
    expect(await kv.list(main, 'com.c', { limit: 100 })).toEqual([]);

    expect(await kv.delete(main, 'com.b', 'k')).toBe(true);
    expect(await kv.delete(main, 'com.b', 'k')).toBe(false);
    expect(await kv.get(main, 'com.a', 'k')).toBe('"a-main"');
  });

  it('overwrites in place and refuses a new key at the cap, in one statement', async () => {
    const opts = { maxKeys: 3, at };
    for (const k of ['x1', 'x2', 'x3'])
      expect(await kv.put(main, 'com.cap', k, '1', opts)).toBe(true);
    expect(await kv.put(main, 'com.cap', 'x4', '1', opts)).toBe(false);
    expect(await kv.get(main, 'com.cap', 'x4')).toBeNull();
    expect(await kv.put(main, 'com.cap', 'x2', '"new"', opts)).toBe(true);
    expect(await kv.get(main, 'com.cap', 'x2')).toBe('"new"');

    // Racing new keys cannot overshoot: each put's count and insert are one statement.
    const racers = await Promise.all(
      ['r1', 'r2', 'r3', 'r4'].map((k) => kv.put(main, 'com.race', k, '1', { maxKeys: 2, at })),
    );
    expect(racers.filter(Boolean)).toHaveLength(2);
    expect(await kv.list(main, 'com.race', { limit: 100 })).toHaveLength(2);
  });

  it('lists by prefix in byte order, past 100 keys, without LIKE wildcards', async () => {
    const opts = { maxKeys: 1000, at };
    for (let i = 0; i < 130; i++) {
      await kv.put(main, 'com.list', `doc:${String(i).padStart(3, '0')}`, '1', opts);
    }
    await kv.put(main, 'com.list', 'doc_x', '1', opts);
    await kv.put(main, 'com.list', 'a%b', '1', opts);

    const first = await kv.list(main, 'com.list', { prefix: 'doc:', limit: 100 });
    expect(first).toHaveLength(100);
    const rest = await kv.list(main, 'com.list', {
      prefix: 'doc:',
      after: first.at(-1),
      limit: 100,
    });
    expect(rest).toHaveLength(30);
    expect(rest.at(-1)).toBe('doc:129');
    // `_` and `%` are ordinary characters in a prefix.
    expect(await kv.list(main, 'com.list', { prefix: 'doc_', limit: 100 })).toEqual(['doc_x']);
    expect(await kv.list(main, 'com.list', { prefix: 'a%', limit: 100 })).toEqual(['a%b']);
  });

  it('deleteAll clears one plugin in every environment of the space, and nothing else', async () => {
    await kv.put(main, 'com.gone', 'k', '1', { maxKeys: 10, at });
    await kv.put(staging, 'com.gone', 'k', '1', { maxKeys: 10, at });
    await kv.deleteAll(run, 'com.gone');
    expect(await kv.get(main, 'com.gone', 'k')).toBeNull();
    expect(await kv.get(staging, 'com.gone', 'k')).toBeNull();
    expect(await kv.get(main, 'com.a', 'k')).toBe('"a-main"');
  });
});

describe('plugin settings (D1 contract)', () => {
  const KEY = 'contract-test-data-key-0123456789abcdef01234';
  const OLD = 'contract-test-old-data-key-0123456789abcdef0';
  const sealer = createSecretSealer({ current: KEY });
  const record = (over: Partial<PluginSettings> = {}): PluginSettings => ({
    spaceId: run,
    pluginId: 'com.settings',
    values: { maxLength: 80, strict: true },
    secrets: { apiKey: 'sk_d1' },
    version: 1,
    updatedAt: at.toISOString(),
    updatedBy: 'usr_1',
    ...over,
  });
  const rawSecrets = async (pluginId: string) => {
    const row = await testDb
      .prepare('select secrets from plugin_settings where space_id = ? and plugin_id = ?')
      .bind(run, pluginId)
      .first<{ secrets: string }>();
    return row ? (JSON.parse(row.secrets) as Record<string, string>) : undefined;
  };

  it('saves by compare-and-set on the version', async () => {
    const sealed = withSealedSecrets(store, sealer);
    expect(await sealed.pluginSettings.save(record(), 0)).toBe(true);
    // A second first-save loses: the row exists.
    expect(await sealed.pluginSettings.save(record(), 0)).toBe(false);
    expect(await sealed.pluginSettings.save(record({ version: 2 }), 5)).toBe(false);
    expect(
      await sealed.pluginSettings.save(record({ version: 2, values: { strict: false } }), 1),
    ).toBe(true);
    expect(await sealed.pluginSettings.get(run, 'com.settings')).toEqual(
      record({ version: 2, values: { strict: false } }),
    );
    // At rest the secret is sealed, bound to this space and plugin.
    const stored = (await rawSecrets('com.settings'))?.apiKey ?? '';
    expect(stored.startsWith(await sealer.currentPrefix())).toBe(true);
    expect(
      await sealer.open(stored, secretContext.pluginSetting(run, 'com.settings', 'apiKey')),
    ).toBe('sk_d1');
  });

  /** `storedSecrets` restricted to this run's plugin settings. */
  const mine = (repo: StoredSecretRepo): StoredSecretRepo => ({
    scan: async (column, opts) => {
      if (column !== 'plugin_settings.secrets') return [];
      const after = opts.after && opts.after.id >= run ? opts.after : { id: run, key: undefined };
      const rows = await repo.scan(column, { ...opts, after });
      return rows.filter((r) => r.id.startsWith(`${run}/`));
    },
    replace: (ref, was, next) => repo.replace(ref, was, next),
  });

  it('scans, compare-and-sets and reseals plugin secrets', async () => {
    const old = withSealedSecrets(store, createSecretSealer({ current: OLD }));
    await old.pluginSettings.save(
      record({ pluginId: 'com.rotate', secrets: { b: 'sk_b', a: 'sk_a' } }),
      0,
    );
    const repo = mine(store.storedSecrets);
    const excludePrefix = await sealer.currentPrefix();
    const page = await repo.scan('plugin_settings.secrets', { excludePrefix, limit: 100 });
    expect(page.map((r) => [r.id, r.key])).toEqual([
      [`${run}/com.rotate`, 'a'],
      [`${run}/com.rotate`, 'b'],
    ]);
    const after = await repo.scan('plugin_settings.secrets', {
      excludePrefix,
      limit: 100,
      after: { id: `${run}/com.rotate`, key: 'a' },
    });
    expect(after.map((r) => r.key)).toEqual(['b']);

    const ref = { column: 'plugin_settings.secrets' as const, id: `${run}/com.rotate`, key: 'a' };
    expect(await store.storedSecrets.replace(ref, 'stale', 'x')).toBe(false);

    const rotated = createSecretSealer({ current: KEY, previous: OLD });
    const swept = { ...store, storedSecrets: repo } as ContentStore;
    expect(await resealSecrets({ store: swept, sealer: rotated })).toMatchObject({
      resealed: 2,
      unreadable: 0,
      complete: true,
    });
    for (const v of Object.values((await rawSecrets('com.rotate')) ?? {})) {
      expect(v.startsWith(excludePrefix)).toBe(true);
    }
    const opened = await withSealedSecrets(store, sealer).pluginSettings.get(run, 'com.rotate');
    expect(opened?.secrets).toEqual({ a: 'sk_a', b: 'sk_b' });
    // A reseal is not an edit: the version an operator read still wins its save.
    expect(opened?.version).toBe(1);
    expect(await resealSecrets({ store: swept, sealer: rotated })).toMatchObject({ examined: 0 });
  });

  it('deletes one plugin’s settings', async () => {
    await store.pluginSettings.delete(run, 'com.rotate');
    expect(await store.pluginSettings.get(run, 'com.rotate')).toBeNull();
  });
});
