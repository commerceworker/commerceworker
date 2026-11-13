import { loadConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { wire } from './wire';

// Hono's default router is RegExpRouter; before 4.13.16 it could skip a wildcard
// middleware (GHSA-h7mg-cq63-vhpq), and the management routes get their auth from
// `app.use('/spaces/*', …)`. Every management route must refuse a caller with no
// credential, whichever router matched it.
const config = loadConfig({
  ROLE: 'all',
  ADMIN_TOKEN: 'admin',
  CMA_KEY: 'cma',
  CDA_KEY: 'cda',
  CPA_KEY: 'cpa',
  SEED_SPACE_ID: 's1',
  PRINCIPAL_KEY: 'test-principal-key-0123456789abcdef',
} as NodeJS.ProcessEnv);

const guarded = /^\/(spaces|guides|deployment|starters)(\/|$)/;

describe('wildcard auth middleware on the content API', () => {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());

  const routes = app.routes
    .filter((r) => r.method !== 'ALL' && guarded.test(r.path))
    .map((r) => ({ method: r.method, url: r.path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, 'x') }));

  it('finds the management routes to check', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('answers 401 to every one of them without a credential', async () => {
    const open: string[] = [];
    for (const { method, url } of routes) {
      const res = await app.request(url, { method });
      if (res.status !== 401) open.push(`${method} ${url} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it('answers 401 to a deep or unknown path under a guarded prefix', async () => {
    for (const url of [
      '/spaces/s1/environments/main/entries/a/b/c/d',
      '/spaces/s1/environments/main/nothing-here',
      '/spaces/s1/x/y/z',
      '/guides/a/b',
      '/deployment/x/y',
    ]) {
      expect((await app.request(url)).status, url).toBe(401);
    }
  });
});
