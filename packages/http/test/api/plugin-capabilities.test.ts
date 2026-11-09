import type { PluginManifest } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/** Capability manifests over HTTP: the grant in the summary, and the approve route. */

const MANIFEST = {
  id: 'com.example.seo',
  name: 'SEO helper',
  version: '1.0.0',
  capabilities: ['content:read', 'content:write'],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
};

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };

let app: ReturnType<typeof createApp>;
let ctx: ReturnType<typeof wire>['ctx'];

beforeEach(() => {
  const wired = wire(config);
  ctx = wired.ctx;
  app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
});

const send = (method: string, path: string, body?: unknown, headers = admin) =>
  app.request(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });

async function install(manifest: Record<string, unknown> = MANIFEST, approved = ['content:read']) {
  const res = await send('POST', '/spaces/s1/plugins', {
    manifest,
    bundle: 'export class Plugin {}',
    approvedCapabilities: approved,
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<Record<string, unknown>>;
}

describe('plugin capabilities over HTTP', () => {
  it('summarises requested, approved and granted capabilities', async () => {
    const plugin = await install();
    expect(plugin).toMatchObject({
      requestedCapabilities: ['content:read', 'content:write'],
      approvedCapabilities: ['content:read'],
      grantedCapabilities: ['content:read'],
      needsReapproval: false,
      enabled: false,
    });
  });

  it('refuses a manifest without a capabilities field', async () => {
    const { capabilities: _c, ...noCaps } = MANIFEST;
    const res = await send('POST', '/spaces/s1/plugins', {
      manifest: noCaps,
      bundle: 'export class Plugin {}',
      approvedCapabilities: [],
    });
    expect(res.status).toBe(422);
  });

  it('approves a previously declined capability, and lands disabled', async () => {
    await install();
    await send('POST', '/spaces/s1/plugins/com.example.seo/enabled', { enabled: true });
    const res = await send('POST', '/spaces/s1/plugins/com.example.seo/capabilities', {
      approvedCapabilities: ['content:read', 'content:write'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      grantedCapabilities: ['content:read', 'content:write'],
      enabled: false,
    });
  });

  it('refuses to approve something the manifest never requested', async () => {
    await install();
    const res = await send('POST', '/spaces/s1/plugins/com.example.seo/capabilities', {
      approvedCapabilities: ['content:publish'],
    });
    expect(res.status).toBe(422);
  });

  it('is space-admin only', async () => {
    await install();
    const res = await send(
      'POST',
      '/spaces/s1/plugins/com.example.seo/capabilities',
      { approvedCapabilities: [] },
      cda,
    );
    expect(res.status).toBe(403);
  });

  it('flags a legacy plugin, refuses to enable it, and clears the flag on approval', async () => {
    await install(MANIFEST, ['content:read']);
    const stored = await ctx.store.plugins.get('s1', 'com.example.seo');
    if (!stored) throw new Error('not installed');
    const { capabilities: _c, ...legacy } = stored.manifest;
    await ctx.store.plugins.save({ ...stored, manifest: legacy as unknown as PluginManifest });

    const listed = (await (await send('GET', '/spaces/s1/plugins')).json()) as {
      items: Record<string, unknown>[];
    };
    expect(listed.items[0]).toMatchObject({
      needsReapproval: true,
      requestedCapabilities: ['content:read'],
    });

    expect(
      (await send('POST', '/spaces/s1/plugins/com.example.seo/enabled', { enabled: true })).status,
    ).toBe(409);
    const approved = await send('POST', '/spaces/s1/plugins/com.example.seo/capabilities', {
      approvedCapabilities: ['content:read'],
    });
    expect(await approved.json()).toMatchObject({ needsReapproval: false });
    expect(
      (await send('POST', '/spaces/s1/plugins/com.example.seo/enabled', { enabled: true })).status,
    ).toBe(200);
  });

  it('keeps an upgrade asking for new capabilities on the old version', async () => {
    await install();
    const res = await send('PUT', '/spaces/s1/plugins/com.example.seo', {
      manifest: {
        ...MANIFEST,
        version: '2.0.0',
        capabilities: [...MANIFEST.capabilities, 'kv:storage'],
      },
      bundle: 'export class Plugin {} // v2',
    });
    expect(res.status).toBe(422);
    const current = (await (await send('GET', '/spaces/s1/plugins/com.example.seo')).json()) as {
      version: string;
    };
    expect(current.version).toBe('1.0.0');
  });
});
