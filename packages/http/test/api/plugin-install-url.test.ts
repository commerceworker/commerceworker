import { createHash } from 'node:crypto';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const BUNDLE = 'export class Plugin {}';
const CHECKSUM = createHash('sha256').update(BUNDLE).digest('hex');

const MANIFEST = {
  id: 'com.example.seo',
  name: 'SEO helper',
  version: '1.0.0',
  capabilities: ['content:read'],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
};

const PACKAGE_URL = 'https://plugins.example.com/seo.json';
const BUNDLE_URL = 'https://plugins.example.com/seo.js';

/** Stands in for the network so the route is what is under test. */
function stubFetch(over: { bundle?: string; pkg?: Record<string, unknown> } = {}) {
  return vi.fn(async (url: string | URL) => {
    const href = String(url);
    const body = href.endsWith('.json')
      ? JSON.stringify({
          manifest: MANIFEST,
          bundleUrl: BUNDLE_URL,
          checksum: CHECKSUM,
          publishedAt: '2026-01-01T00:00:00.000Z',
          ...over.pkg,
        })
      : (over.bundle ?? BUNDLE);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  });
}

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
const realFetch = globalThis.fetch;

/**
 * The fetcher captures `globalThis.fetch` when the app is built, so the stub
 * has to be in place first — a detail worth stating, since a stub installed
 * afterwards silently lets the test hit the real network.
 */
const withNetwork = (stub: ReturnType<typeof stubFetch>) => {
  globalThis.fetch = stub as unknown as typeof fetch;
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
  return stub;
};

beforeEach(() => {
  withNetwork(stubFetch());
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const install = (body: Record<string, unknown> = {}) =>
  app.request('/spaces/s1/plugins/from-url', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({
      packageUrl: PACKAGE_URL,
      approvedCapabilities: ['content:read'],
      ...body,
    }),
  });

describe('installing a plugin from a URL over HTTP', () => {
  it('fetches, verifies and installs disabled', async () => {
    const res = await install();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: 'com.example.seo',
      checksum: CHECKSUM,
      enabled: false,
    });
  });

  it('refuses bytes that do not match the declared checksum', async () => {
    withNetwork(stubFetch({ bundle: 'export class Plugin {} // swapped' }));
    const res = await install();
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/checksum/i);
  });

  it('refuses a pin that disagrees with the package', async () => {
    const res = await install({ expectedChecksum: 'a'.repeat(64) });
    expect(res.status).toBe(422);
  });

  it('refuses a URL pointing at an internal address before fetching it', async () => {
    const fetchSpy = withNetwork(stubFetch());
    const res = await install({ packageUrl: 'https://127.0.0.1/pkg.json' });
    expect(res.status).toBe(422);
    // Screened before the request, not after.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('needs space:admin', async () => {
    // A CMA key holds space:admin by design, so the meaningful check is a key
    // that does not: installing code is not a delivery client's business.
    const res = await app.request('/spaces/s1/plugins/from-url', {
      method: 'POST',
      headers: cda,
      body: JSON.stringify({ packageUrl: PACKAGE_URL, approvedCapabilities: ['content:read'] }),
    });
    expect(res.status).toBe(403);
  });
});
