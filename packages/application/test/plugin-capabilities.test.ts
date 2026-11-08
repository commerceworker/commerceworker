import {
  type InstalledPlugin,
  type PluginCapability,
  type PluginManifest,
  type Principal,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import type { PluginCapabilities, PluginInvocation, PluginRuntime } from '@commerceworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  approvePluginCapabilities,
  createContentType,
  createEntry,
  createPluginHookDispatcher,
  getPlugin,
  installPlugin,
  listAuditLog,
  listPlugins,
  publishContentType,
  recordPluginCapabilityDenial,
  SYSTEM_CALLER,
  setPluginEnabled,
  upgradePlugin,
} from '../src/index';

/**
 * Capability manifests: what a plugin declares, what a human approves, and the
 * effective grant (declared ∩ approved) that is all it ever runs with.
 */

const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };
let ctx: AppContext;
let store: InMemoryContentStore;
let blob: FakeBlobStore;

const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const editor: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.spaceAdmin, SCOPES.contentWrite, SCOPES.previewRead],
};

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'com.example.one',
  name: 'One',
  version: '1.0.0',
  capabilities: ['content:read'],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
  ...over,
});

function fakeRuntime(
  answer?: (inv: PluginInvocation, caps: PluginCapabilities) => unknown | Promise<unknown>,
): PluginRuntime & { calls: { inv: PluginInvocation; caps: PluginCapabilities }[] } {
  const calls: { inv: PluginInvocation; caps: PluginCapabilities }[] = [];
  return {
    calls,
    async invoke(inv, caps) {
      calls.push({ inv, caps });
      await answer?.(inv, caps);
      return { payload: inv.payload };
    },
  };
}

async function install(over: Partial<PluginManifest> = {}, approved?: PluginCapability[]) {
  const m = manifest(over);
  return installPlugin(ctx, blob, admin, SPACE, {
    manifest: m,
    bundle: `// ${m.id} ${m.version}`,
    approvedCapabilities: approved ?? m.capabilities,
  });
}

/** Writes a stored record as an older release would have left it. */
async function seedLegacy(approved: PluginCapability[], enabled: boolean) {
  const plugin = await install({ capabilities: approved }, approved);
  const { capabilities: _dropped, ...oldManifest } = plugin.manifest;
  await store.plugins.save({
    ...plugin,
    manifest: oldManifest as unknown as PluginManifest,
    enabled,
  });
  return plugin;
}

beforeEach(async () => {
  blob = new FakeBlobStore();
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: SPACE, defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'article');
});

describe('the effective grant at call time', () => {
  it('is declared ∩ approved, even when the stored approval says more', async () => {
    const plugin = await install({ capabilities: ['content:read'] });
    // A record whose approval outgrew its manifest (a bug, a bad migration, a
    // hand edit) must not run with the extra authority.
    await store.plugins.save({
      ...plugin,
      approvedCapabilities: ['content:read', 'content:write', 'content:publish'],
      enabled: true,
    } as InstalledPlugin);

    const runtime = fakeRuntime();
    await createPluginHookDispatcher(ctx, blob, runtime).dispatch('entry:beforeSave', {}, scope);

    expect(runtime.calls[0]?.inv.capabilities).toEqual(['content:read']);
    const content = runtime.calls[0]?.caps.content as Record<string, unknown>;
    expect(content.create).toBeUndefined();
    expect(content.publish).toBeUndefined();
  });

  it('tells the runtime where the hook fired, so a denial can be audited', async () => {
    const plugin = await install();
    await setPluginEnabled(ctx, SPACE, plugin.id, true);
    const runtime = fakeRuntime();
    await createPluginHookDispatcher(ctx, blob, runtime).dispatch('entry:beforeSave', {}, scope);
    expect(runtime.calls[0]?.inv.scope).toEqual(scope);
  });
});

describe('capabilities wired to use-cases', () => {
  it('content:publish publishes through the publishing use-case', async () => {
    const plugin = await install({ capabilities: ['content:publish'] });
    await setPluginEnabled(ctx, SPACE, plugin.id, true);
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' } },
    });

    let published: unknown;
    const runtime = fakeRuntime(async (_inv, caps) => {
      const content = caps.content as { publish: (id: string) => Promise<unknown> };
      published = await content.publish(entry.id);
    });
    await createPluginHookDispatcher(ctx, blob, runtime).dispatch('entry:beforeSave', {}, scope);

    expect(published).toMatchObject({ id: entry.id });
    expect(await store.entries.getPublished(scope, entry.id)).not.toBeNull();
  });

  it('assets:read and taxonomy:write each get only their own methods', async () => {
    const plugin = await install({ capabilities: ['assets:read', 'taxonomy:write'] });
    await setPluginEnabled(ctx, SPACE, plugin.id, true);

    let tag: unknown;
    let assets: unknown;
    const runtime = fakeRuntime(async (_inv, caps) => {
      const taxonomy = caps.taxonomy as Record<string, (...a: unknown[]) => Promise<unknown>>;
      tag = await taxonomy.createTag?.({ name: 'news' });
      assets = await (caps.assets as { list: () => Promise<unknown> }).list();
      expect(taxonomy.listTags).toBeUndefined();
      expect(caps.content).toBeUndefined();
    });
    await createPluginHookDispatcher(ctx, blob, runtime).dispatch('entry:beforeSave', {}, scope);

    expect(tag).toMatchObject({ name: 'news' });
    expect(assets).toEqual({ items: [] });
  });
});

describe('upgrading against a capability manifest', () => {
  it('stays on the installed version until new capabilities are approved', async () => {
    const before = await install();
    await setPluginEnabled(ctx, SPACE, before.id, true);

    await expect(
      upgradePlugin(ctx, blob, admin, SPACE, {
        manifest: manifest({ version: '2.0.0', capabilities: ['content:read', 'content:write'] }),
        bundle: '// v2',
      }),
    ).rejects.toMatchObject({
      issues: [
        { field: 'approvedCapabilities', message: expect.stringContaining('content:write') },
      ],
    });

    const after = await getPlugin(ctx, SPACE, before.id);
    expect(after.manifest.version).toBe('1.0.0');
    expect(after.checksum).toBe(before.checksum);
    expect(after.enabled).toBe(true);
  });

  it('does not re-ask for a capability that was declined and is still requested', async () => {
    const plugin = await install({ capabilities: ['content:read', 'content:write'] }, [
      'content:read',
    ]);
    await setPluginEnabled(ctx, SPACE, plugin.id, true);

    const upgraded = await upgradePlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({ version: '1.1.0', capabilities: ['content:read', 'content:write'] }),
      bundle: '// 1.1',
    });
    // The decline carries; nothing widened, so it keeps running.
    expect(upgraded.approvedCapabilities).toEqual(['content:read']);
    expect(upgraded.enabled).toBe(true);
  });

  it('lands disabled when the approval grows the grant', async () => {
    const plugin = await install({ capabilities: ['content:read', 'content:write'] }, [
      'content:read',
    ]);
    await setPluginEnabled(ctx, SPACE, plugin.id, true);
    const upgraded = await upgradePlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({ version: '1.1.0', capabilities: ['content:read', 'content:write'] }),
      bundle: '// 1.1',
      approvedCapabilities: ['content:read', 'content:write'],
    });
    expect(upgraded.approvedCapabilities).toEqual(['content:read', 'content:write']);
    expect(upgraded.enabled).toBe(false);
  });

  it('refuses a new version whose manifest omits capabilities', async () => {
    await install();
    const { capabilities: _c, ...noCaps } = manifest({ version: '2.0.0' });
    await expect(
      upgradePlugin(ctx, blob, admin, SPACE, {
        manifest: noCaps as unknown as PluginManifest,
        bundle: '// v2',
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('approving capabilities on an installed plugin', () => {
  it('narrows the grant without touching the code, and keeps it running', async () => {
    const plugin = await install({ capabilities: ['content:read', 'content:write'] });
    await setPluginEnabled(ctx, SPACE, plugin.id, true);
    const next = await approvePluginCapabilities(ctx, admin, SPACE, plugin.id, ['content:read']);
    expect(next.approvedCapabilities).toEqual(['content:read']);
    expect(next.checksum).toBe(plugin.checksum);
    expect(next.enabled).toBe(true);
  });

  it('grants a previously declined capability, and disables until re-enabled', async () => {
    const plugin = await install({ capabilities: ['content:read', 'content:write'] }, [
      'content:read',
    ]);
    await setPluginEnabled(ctx, SPACE, plugin.id, true);
    const next = await approvePluginCapabilities(ctx, admin, SPACE, plugin.id, [
      'content:read',
      'content:write',
    ]);
    expect(next.approvedCapabilities).toEqual(['content:read', 'content:write']);
    expect(next.enabled).toBe(false);
  });

  it('refuses anything the manifest did not declare', async () => {
    const plugin = await install();
    await expect(
      approvePluginCapabilities(ctx, admin, SPACE, plugin.id, ['content:publish']),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses to delegate authority the approver does not hold', async () => {
    const plugin = await install({ capabilities: ['content:read', 'content:publish'] }, [
      'content:read',
    ]);
    await expect(
      approvePluginCapabilities(ctx, editor, SPACE, plugin.id, ['content:read', 'content:publish']),
    ).rejects.toThrow(/content:publish/);
  });

  it('in narrow-only mode may confirm or reduce, never widen', async () => {
    const plugin = await install({ capabilities: ['content:read', 'content:write'] }, [
      'content:read',
    ]);
    await expect(
      approvePluginCapabilities(ctx, admin, SPACE, plugin.id, ['content:read', 'content:write'], {
        narrowOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const same = await approvePluginCapabilities(ctx, admin, SPACE, plugin.id, ['content:read'], {
      narrowOnly: true,
    });
    expect(same.approvedCapabilities).toEqual(['content:read']);
  });
});

describe('plugins installed before capability manifests', () => {
  it('are listed as requesting their current access, flagged for re-approval', async () => {
    await seedLegacy(['content:read', 'taxonomy:read'], true);
    const [listed] = await listPlugins(ctx, SPACE);
    expect(listed?.manifest.capabilities).toEqual(['content:read', 'taxonomy:read']);
    expect(listed?.approvedCapabilities).toEqual(['content:read', 'taxonomy:read']);
    expect(listed?.needsReapproval).toBe(true);
  });

  it('keep running on exactly the grant they had — no wider, no narrower', async () => {
    await seedLegacy(['content:read'], true);
    const runtime = fakeRuntime();
    await createPluginHookDispatcher(ctx, blob, runtime).dispatch('entry:beforeSave', {}, scope);
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.inv.capabilities).toEqual(['content:read']);
  });

  it('cannot be switched on again until re-approved', async () => {
    const plugin = await seedLegacy(['content:read'], false);
    await expect(setPluginEnabled(ctx, SPACE, plugin.id, true)).rejects.toThrow(
      /approve its capabilities/,
    );
    // Switching off is always allowed, and does not clear the flag.
    const off = await setPluginEnabled(ctx, SPACE, plugin.id, false);
    expect(off.needsReapproval).toBe(true);
  });

  it('re-approval persists the declaration, clears the flag, and cannot widen', async () => {
    const plugin = await seedLegacy(['content:read'], false);
    await expect(
      approvePluginCapabilities(ctx, admin, SPACE, plugin.id, ['content:read', 'content:write']),
    ).rejects.toThrow(ValidationError);

    const approved = await approvePluginCapabilities(ctx, admin, SPACE, plugin.id, [
      'content:read',
    ]);
    expect(approved.needsReapproval).toBeUndefined();
    const stored = await store.plugins.get(SPACE, plugin.id);
    expect(stored?.manifest.capabilities).toEqual(['content:read']);
    expect((await setPluginEnabled(ctx, SPACE, plugin.id, true)).enabled).toBe(true);
  });

  it('can be upgraded to a manifest that declares capabilities', async () => {
    const plugin = await seedLegacy(['content:read'], true);
    const upgraded = await upgradePlugin(ctx, blob, admin, SPACE, {
      manifest: manifest({ version: '2.0.0', capabilities: ['content:read'] }),
      bundle: '// v2',
    });
    expect(upgraded.needsReapproval).toBeUndefined();
    expect(upgraded.approvedCapabilities).toEqual(['content:read']);
    expect(upgraded.enabled).toBe(true);
    expect(upgraded.id).toBe(plugin.id);
  });
});

describe('auditing a denied capability call', () => {
  it('records the plugin, the capability and the method on the space trail', async () => {
    await recordPluginCapabilityDenial(ctx, {
      pluginId: 'com.example.one',
      capability: 'content:write',
      method: 'content.create',
      reason: 'not-granted',
      hook: 'entry:beforeSave',
      spaceId: SPACE,
      environmentId: 'main',
    });
    const [entry] = (await listAuditLog(ctx, SPACE)).items;
    expect(entry).toMatchObject({
      actor: 'plugin:com.example.one',
      targetType: 'plugin',
      targetId: 'com.example.one',
      environmentId: 'main',
      status: 403,
    });
    expect(entry?.action).toContain('content:write');
    expect(entry?.action).toContain('caps.content.create');
  });

  it('skips a denial it cannot attribute to a space', async () => {
    await recordPluginCapabilityDenial(ctx, {
      pluginId: 'p',
      capability: 'kv:storage',
      method: 'kv.get',
      reason: 'not-provided',
    });
    expect((await listAuditLog(ctx, SPACE)).items).toEqual([]);
  });
});
