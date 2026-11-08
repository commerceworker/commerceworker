import {
  ConflictError,
  type PluginManifest,
  type Principal,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import type { PluginRuntime } from '@commerceworker/ports';
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
  createSecretSealer,
  getPluginSettings,
  installPlugin,
  isSealedSecret,
  resealSecrets,
  setPluginEnabled,
  setPluginSettings,
  uninstallPlugin,
  upgradePlugin,
  withSealedSecrets,
} from '../src/index';

/**
 * Plugin settings: declared by the manifest, set by an operator, read by the
 * plugin. Secrets are sealed at rest and never come back out of a read API.
 */

const KEY = 'current-data-key-0123456789abcdef0123456789';
const OLD = 'previous-data-key-0123456789abcdef012345678';
const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const ID = 'com.example.seo';
const admin: Principal = {
  spaceId: '*',
  kind: 'admin',
  subject: 'usr_admin',
  scopes: Object.values(SCOPES),
};

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: ID,
  name: 'SEO',
  version: '1.0.0',
  capabilities: [],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
  settings: [
    { key: 'apiKey', label: 'API key', type: 'string', secret: true, required: true },
    { key: 'maxLength', label: 'Max length', type: 'number', default: 120 },
  ],
  ...over,
});

let raw: InMemoryContentStore;
let ctx: AppContext;
let blob: FakeBlobStore;

beforeEach(async () => {
  raw = new InMemoryContentStore();
  blob = new FakeBlobStore();
  // Sealed as production wires it: the use-cases see plaintext, the store holds ciphertext.
  ctx = {
    store: withSealedSecrets(raw, createSecretSealer({ current: KEY })),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('p'),
  };
  await installPlugin(ctx, blob, admin, SPACE, {
    manifest: manifest(),
    bundle: '// seo',
    approvedCapabilities: [],
  });
});

describe('setting and reading a plugin’s settings', () => {
  it('starts at version 0 with defaults, and refuses a save missing a required field', async () => {
    expect(await getPluginSettings(ctx, SPACE, ID)).toMatchObject({
      values: { maxLength: 120 },
      secretsSet: [],
      version: 0,
    });
    await expect(
      setPluginSettings(ctx, admin, SPACE, ID, { values: { maxLength: 80 } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('seals secrets at rest and never returns them', async () => {
    const saved = await setPluginSettings(ctx, admin, SPACE, ID, {
      values: { apiKey: 'sk_live_123', maxLength: 80 },
    });
    expect(saved).toMatchObject({
      values: { maxLength: 80 },
      secretsSet: ['apiKey'],
      version: 1,
      updatedBy: 'usr_admin',
    });
    expect(JSON.stringify(saved)).not.toContain('sk_live_123');
    expect(JSON.stringify(await getPluginSettings(ctx, SPACE, ID))).not.toContain('sk_live_123');

    const stored = await raw.pluginSettings.get(SPACE, ID);
    expect(stored?.values).toEqual({ maxLength: 80 });
    expect(isSealedSecret(stored?.secrets.apiKey ?? '')).toBe(true);
    expect(stored?.secrets.apiKey).not.toContain('sk_live_123');
  });

  it('keeps a secret when a patch leaves it out, and clears a value with null', async () => {
    await setPluginSettings(ctx, admin, SPACE, ID, { values: { apiKey: 'sk', maxLength: 80 } });
    const next = await setPluginSettings(ctx, admin, SPACE, ID, { values: { maxLength: null } });
    expect(next).toMatchObject({ values: { maxLength: 120 }, secretsSet: ['apiKey'], version: 2 });
  });

  it('refuses a stale expectedVersion', async () => {
    await setPluginSettings(ctx, admin, SPACE, ID, { values: { apiKey: 'sk' } });
    await expect(
      setPluginSettings(ctx, admin, SPACE, ID, { values: { maxLength: 1 }, expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('loses a concurrent race as a ConflictError, never a silently dropped field', async () => {
    await setPluginSettings(ctx, admin, SPACE, ID, { values: { apiKey: 'sk' } });
    // Another writer saves between this call's read and its write.
    const save = raw.pluginSettings.save;
    raw.pluginSettings.save = async (settings, expected) => {
      raw.pluginSettings.save = save;
      const current = await raw.pluginSettings.get(SPACE, ID);
      if (current) await save({ ...current, version: current.version + 1 }, current.version);
      return save(settings, expected);
    };
    await expect(
      setPluginSettings(ctx, admin, SPACE, ID, { values: { maxLength: 5 } }),
    ).rejects.toMatchObject({ code: 'conflict', details: { version: 2 } });
    expect((await getPluginSettings(ctx, SPACE, ID)).values).toEqual({ maxLength: 120 });
  });

  it('is not found for a plugin that is not installed', async () => {
    await expect(getPluginSettings(ctx, SPACE, 'com.example.none')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('follows the manifest across an upgrade, and is gone after an uninstall', async () => {
    await setPluginSettings(ctx, admin, SPACE, ID, { values: { apiKey: 'sk', maxLength: 80 } });
    await upgradePlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({
        version: '2.0.0',
        settings: [{ key: 'apiKey', label: 'API key', type: 'string', secret: true }],
      }),
      bundle: '// seo v2',
    });
    expect(await getPluginSettings(ctx, SPACE, ID)).toMatchObject({
      values: {},
      secretsSet: ['apiKey'],
    });

    await uninstallPlugin(ctx, blob, SPACE, ID);
    expect(await raw.pluginSettings.get(SPACE, ID)).toBeNull();
  });
});

describe('caps.settings.get()', () => {
  it('hands the plugin its own settings, secrets in plaintext, with no capability', async () => {
    await installPlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({ id: 'com.example.other', settings: [] }),
      bundle: '// other',
      approvedCapabilities: [],
    });
    await setPluginEnabled(ctx, SPACE, ID, true);
    await setPluginEnabled(ctx, SPACE, 'com.example.other', true);
    await setPluginSettings(ctx, admin, SPACE, ID, { values: { apiKey: 'sk_live_123' } });

    const seen: Record<string, unknown> = {};
    const runtime: PluginRuntime = {
      async invoke(inv, caps) {
        expect(inv.capabilities).toEqual([]);
        seen[inv.pluginId] = await (caps.settings as { get: () => Promise<unknown> }).get();
        return { payload: inv.payload };
      },
    };
    await createPluginHookDispatcher(ctx, blob, runtime).dispatch('entry:beforeSave', {}, scope);
    expect(seen).toEqual({
      [ID]: { apiKey: 'sk_live_123', maxLength: 120 },
      // Another plugin gets its own (empty) settings, never this one's.
      'com.example.other': {},
    });
  });
});

describe('the reseal sweep', () => {
  it('moves plugin secrets sealed under the previous key onto the current one', async () => {
    const old = {
      ...ctx,
      store: withSealedSecrets(raw, createSecretSealer({ current: OLD })),
    };
    await setPluginSettings(old, admin, SPACE, ID, { values: { apiKey: 'sk_rotated' } });

    const rotated = createSecretSealer({ current: KEY, previous: OLD });
    const summary = await resealSecrets({ store: raw, sealer: rotated });
    expect(summary).toMatchObject({ resealed: 1, unreadable: 0, complete: true });
    const prefix = await rotated.currentPrefix();
    expect((await raw.pluginSettings.get(SPACE, ID))?.secrets.apiKey?.startsWith(prefix)).toBe(
      true,
    );
    // The sweep is not an edit: the version an operator read still saves.
    const view = await getPluginSettings(ctx, SPACE, ID);
    expect(view.version).toBe(1);
    await setPluginSettings(ctx, admin, SPACE, ID, {
      values: { maxLength: 9 },
      expectedVersion: 1,
    });

    // A ciphertext copied to another plugin's row does not open there.
    await installPlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({ id: 'com.example.thief' }),
      bundle: '// thief',
      approvedCapabilities: [],
    });
    const sealed = (await raw.pluginSettings.get(SPACE, ID))?.secrets.apiKey ?? '';
    await raw.pluginSettings.save(
      {
        spaceId: SPACE,
        pluginId: 'com.example.thief',
        values: {},
        secrets: { apiKey: sealed },
        version: 1,
        updatedAt: new Date().toISOString(),
      },
      0,
    );
    await expect(getPluginSettings(ctx, SPACE, 'com.example.thief')).rejects.toMatchObject({
      name: 'SecretUnreadableError',
    });
  });
});
