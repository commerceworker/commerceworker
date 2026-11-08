import {
  ConflictError,
  ForbiddenError,
  hostAllowed,
  NotFoundError,
  type PluginCapability,
  type PluginManifest,
  type Principal,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  getPlugin,
  installPlugin,
  listPlugins,
  loadPluginBundle,
  setPluginEnabled,
  uninstallPlugin,
  upgradePlugin,
} from '../src/index';

const SPACE = 's1';
let ctx: AppContext;
let blob: FakeBlobStore;

/** A principal holding every scope — the "can delegate anything" case. */
const admin: Principal = {
  spaceId: '*',
  kind: 'admin',
  scopes: Object.values(SCOPES),
};

/** An editor who can write but not publish. */
const editor: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.contentWrite, SCOPES.previewRead, SCOPES.searchRead],
};

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'com.example.seo',
  name: 'SEO helper',
  version: '1.0.0',
  capabilities: ['content:read'],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
  ...over,
});

const BUNDLE = 'export default { async onEntryBeforeSave(p) { return p; } };';

beforeEach(() => {
  blob = new FakeBlobStore();
  ctx = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('p'),
  };
});

const install = (
  principal: Principal,
  over: Partial<PluginManifest> = {},
  approved?: readonly PluginCapability[],
) => {
  const m = manifest(over);
  return installPlugin(ctx, blob, principal, SPACE, {
    manifest: m,
    bundle: BUNDLE,
    approvedCapabilities: approved ?? m.capabilities,
  });
};

describe('installing a plugin', () => {
  it('stores the manifest, the grant and a checksum, disabled', async () => {
    const plugin = await install(admin);
    expect(plugin.id).toBe('com.example.seo');
    expect(plugin.approvedCapabilities).toEqual(['content:read']);
    expect(plugin.checksum).toMatch(/^[a-f0-9]{64}$/);
    // Approving a capability list and starting to run code are two decisions.
    expect(plugin.enabled).toBe(false);
  });

  it('records who installed it', async () => {
    const plugin = await install({ ...admin, subject: 'alice@example.com' });
    expect(plugin.installedBy).toBe('alice@example.com');
  });

  it('refuses to install the same plugin twice', async () => {
    await install(admin);
    await expect(install(admin)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses an empty bundle', async () => {
    await expect(
      installPlugin(ctx, blob, admin, SPACE, {
        manifest: manifest(),
        bundle: '   ',
        approvedCapabilities: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('capabilities intersect RBAC', () => {
  it('refuses to grant authority the installer does not hold', async () => {
    // The whole point: installing a plugin must not be a privilege-escalation
    // ladder for someone who cannot publish.
    await expect(install(editor, { capabilities: ['content:publish'] })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('allows what the installer does hold', async () => {
    await expect(install(editor, { capabilities: ['content:write'] })).resolves.toBeTruthy();
  });

  it('names the capability and the scope it needed', async () => {
    const err = await install(editor, { capabilities: ['content:publish'] }).catch((e) => e);
    expect((err as Error).message).toContain('content:publish');
    expect((err as Error).message).toContain(SCOPES.contentPublish);
  });

  it('does not gate capabilities that reach no platform data', async () => {
    // network:request is bounded by allowedHosts and kv:storage is namespaced
    // per plugin, so neither implies a content scope.
    await expect(
      install(editor, {
        capabilities: ['network:request', 'kv:storage'],
        allowedHosts: ['api.example.com'],
      }),
    ).resolves.toBeTruthy();
  });
});

describe('consent', () => {
  it('may approve less than the plugin asked for', async () => {
    const plugin = await install(admin, { capabilities: ['content:read', 'content:write'] }, [
      'content:read',
    ]);
    expect(plugin.approvedCapabilities).toEqual(['content:read']);
  });

  it('may not approve something the plugin never asked for', async () => {
    // The manifest is what was reviewed; a grant that exceeds it means the two
    // disagree.
    await expect(
      install(admin, { capabilities: ['content:read'] }, ['content:publish']),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('manifest validation', () => {
  const bad = (over: Partial<PluginManifest>) => install(admin, over);

  it('rejects a malformed id', async () => {
    await expect(bad({ id: 'Not An Id' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects unknown capabilities and hooks', async () => {
    await expect(
      bad({ capabilities: ['content:destroy' as PluginCapability] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(bad({ hooks: ['entry:afterEverything' as never] })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('requires an allowlist when network access is requested', async () => {
    // "Any host" has to be stated, never arrived at by omission.
    await expect(
      bad({ capabilities: ['network:request'], allowedHosts: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an allowlist without the capability', async () => {
    await expect(bad({ allowedHosts: ['example.com'] })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a URL where a hostname belongs', async () => {
    await expect(
      bad({ capabilities: ['network:request'], allowedHosts: ['https://example.com/api'] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the host allowlist', () => {
  it('matches exactly', () => {
    expect(hostAllowed(['api.example.com'], 'api.example.com')).toBe(true);
    expect(hostAllowed(['api.example.com'], 'evil.com')).toBe(false);
  });

  it('matches subdomains under a wildcard but not the apex', () => {
    // A wildcard that silently included the apex would grant more than it
    // appears to.
    expect(hostAllowed(['*.example.com'], 'api.example.com')).toBe(true);
    expect(hostAllowed(['*.example.com'], 'example.com')).toBe(false);
  });

  it('is not fooled by a suffix that merely ends the same way', () => {
    expect(hostAllowed(['*.example.com'], 'notexample.com')).toBe(false);
    expect(hostAllowed(['example.com'], 'evil-example.com')).toBe(false);
  });
});

describe('the bundle and its checksum', () => {
  it('verifies the bytes on load, not only at install', async () => {
    const plugin = await install(admin);
    const loaded = await loadPluginBundle(ctx, blob, SPACE, plugin.id);
    expect(loaded.bundle).toBe(BUNDLE);
  });

  it('refuses to load bytes that no longer match what was approved', async () => {
    const plugin = await install(admin);
    // Someone swapped the object in the blob store.
    await blob.put(plugin.bundleKey, 'export default { onEntryBeforeSave: steal };');

    const err = await loadPluginBundle(ctx, blob, SPACE, plugin.id).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain('checksum');
  });

  it('reports a missing bundle rather than running nothing silently', async () => {
    const plugin = await install(admin);
    await blob.delete(plugin.bundleKey);
    await expect(loadPluginBundle(ctx, blob, SPACE, plugin.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('upgrading', () => {
  it('carries the grant forward when the new version asks for no more', async () => {
    const plugin = await install(admin, { capabilities: ['content:read'] });
    await setPluginEnabled(ctx, SPACE, plugin.id, true);

    const upgraded = await upgradePlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({ version: '1.1.0', capabilities: ['content:read'] }),
      bundle: 'export default { v: 2 };',
    });
    expect(upgraded.manifest.version).toBe('1.1.0');
    expect(upgraded.approvedCapabilities).toEqual(['content:read']);
    // No capability change, so it keeps running.
    expect(upgraded.enabled).toBe(true);
    expect(upgraded.checksum).not.toBe(plugin.checksum);
  });

  it('drops authority the new version stopped asking for', async () => {
    await install(admin, { capabilities: ['content:read', 'content:write'] });
    const upgraded = await upgradePlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({ version: '2.0.0', capabilities: ['content:read'] }),
      bundle: 'export default {};',
    });
    expect(upgraded.approvedCapabilities).toEqual(['content:read']);
  });

  it('demands fresh consent when the new version wants more', async () => {
    await install(admin, { capabilities: ['content:read'] });
    // An upgrade must never be a way to acquire capabilities quietly.
    await expect(
      upgradePlugin(ctx, blob, admin, SPACE, {
        manifest: manifest({ version: '2.0.0', capabilities: ['content:read', 'content:publish'] }),
        bundle: 'export default {};',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('disables the plugin when capabilities widen, even with consent', async () => {
    const plugin = await install(admin, { capabilities: ['content:read'] });
    await setPluginEnabled(ctx, SPACE, plugin.id, true);

    const upgraded = await upgradePlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({ version: '2.0.0', capabilities: ['content:read', 'content:publish'] }),
      bundle: 'export default {};',
      approvedCapabilities: ['content:read', 'content:publish'],
    });
    // The operator re-enables once they have seen what changed.
    expect(upgraded.enabled).toBe(false);
  });

  it('still refuses authority the upgrader does not hold', async () => {
    await install(admin, { capabilities: ['content:read'] });
    await expect(
      upgradePlugin(ctx, blob, editor, SPACE, {
        manifest: manifest({ version: '2.0.0', capabilities: ['content:read', 'content:publish'] }),
        bundle: 'export default {};',
        approvedCapabilities: ['content:read', 'content:publish'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('404s on a plugin that is not installed', async () => {
    await expect(
      upgradePlugin(ctx, blob, admin, SPACE, { manifest: manifest(), bundle: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('lifecycle', () => {
  it('enables and disables without touching the grant', async () => {
    const plugin = await install(admin);
    const on = await setPluginEnabled(ctx, SPACE, plugin.id, true);
    expect(on.enabled).toBe(true);
    expect(on.approvedCapabilities).toEqual(plugin.approvedCapabilities);
    expect((await setPluginEnabled(ctx, SPACE, plugin.id, false)).enabled).toBe(false);
  });

  it('uninstalls the record and the bundle', async () => {
    const plugin = await install(admin);
    await uninstallPlugin(ctx, blob, SPACE, plugin.id);
    await expect(getPlugin(ctx, SPACE, plugin.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listPlugins(ctx, SPACE)).toHaveLength(0);
  });

  it('scopes plugins to a space', async () => {
    await install(admin);
    // A grant approved for one space does not travel to another.
    expect(await listPlugins(ctx, 's2')).toHaveLength(0);
  });
});
