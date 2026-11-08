import type { ApiConfig } from '@commerceworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { scalarBundleUrl } from '../../src/api/docs/openapi';
import { testConfig } from './config';
import { wire } from './wire';

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
}) as ApiConfig;

function makeApp() {
  const { ctx, rag, blob, ai, bus } = wire(config);
  return createApp(ctx, config, rag, blob, ai, bus);
}

describe('OpenAPI spec + docs UI', () => {
  it('serves a 3.x spec whose paths cover the mounted surface', async () => {
    const app = makeApp();
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes?: Record<string, unknown> };
    };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('CommerceWorker API');
    expect(spec.components.securitySchemes).toHaveProperty('bearerAuth');

    const paths = Object.keys(spec.paths);
    // Full inventory: management + delivery + preview mount >100 routes.
    expect(paths.length).toBeGreaterThan(80);
    expect(paths).toContain('/delivery/{space}/{env}/entries/{id}');
    expect(paths).toContain('/preview/{space}/{env}/entries/{id}');
    expect(paths).toContain('/spaces/{space}/environments/{env}/entries');
    expect(paths).toContain('/auth/me');
    // The spec never documents itself or the UI.
    expect(paths).not.toContain('/openapi.json');
    expect(paths).not.toContain('/docs');
  });

  it('keeps the Delivery routes free of the docs stack, so the delivery Worker stays small', async () => {
    // The delivery Worker serves these routes but no API docs. Importing the docs (zod,
    // hono-openapi, the response schemas) from the routes module would put ~40% back on its script;
    // the descriptions live in docs/delivery-docs.ts, which only the api mounts.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      decodeURIComponent(new URL('../../src/api/routes/delivery.ts', import.meta.url).pathname),
      'utf8',
    );
    const imports = [...source.matchAll(/^import (?!type )[^;]*?from '([^']+)'/gms)].map(
      (m) => m[1],
    );
    for (const banned of ['zod', 'hono-openapi', '../docs/openapi', '../docs/delivery-docs']) {
      expect(imports, banned).not.toContain(banned);
    }
    // The response schemas are one file per area, so no import from that folder at all.
    expect(imports.filter((i) => i?.startsWith('../docs/schemas'))).toEqual([]);
  });

  it('describes response schemas, not just paths', async () => {
    const app = makeApp();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };

    // A path list can look complete while every schema behind it has quietly
    // become empty, which is the shape a zod-openapi major could take. Schemas
    // are inlined per operation rather than registered under
    // `components.schemas`, so that is where to look.
    const entry = spec.paths['/delivery/{space}/{env}/entries/{id}']?.get?.responses as {
      '200'?: { content?: Record<string, { schema?: unknown }> };
    };
    expect(entry?.['200']?.content?.['application/json']?.schema).toBeTruthy();
  });

  it('describes request bodies, and describes them from the schema that parses them', async () => {
    const app = makeApp();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };

    const bodies = Object.values(spec.paths)
      .flatMap((path) => Object.values(path))
      .filter((op) => 'requestBody' in (op ?? {}));
    expect(bodies.length).toBeGreaterThan(15);

    // Not merely present: the shape has to be the route's real input. A body
    // documented as a bare `object` is a path list wearing a schema.
    const create = spec.paths['/spaces/{space}/environments/{env}/entries']?.post?.requestBody as {
      required?: boolean;
      content?: Record<string, { schema?: { properties?: Record<string, unknown> } }>;
    };
    expect(create?.required).toBe(true);
    const properties = create?.content?.['application/json']?.schema?.properties ?? {};
    expect(Object.keys(properties)).toContain('contentTypeApiId');
    expect(Object.keys(properties)).toContain('fields');
  });

  it('describes a body as what the caller sends, not what the handler receives', async () => {
    const app = makeApp();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };

    // `io: 'input'`: a schema with defaults would otherwise document the
    // post-parse shape, telling a client it must send fields it need not.
    const body = spec.paths['/spaces/{space}/environments/{env}/imports']?.post?.requestBody as {
      content?: Record<string, { schema?: { required?: string[] } }>;
    };
    const required = body?.content?.['application/json']?.schema?.required ?? [];
    expect(required).toContain('source');
    expect(required).not.toContain('conflicts');
  });

  it('spec reflects ROLE gating (delivery-only deployment has no management paths)', async () => {
    const { ctx, rag, blob, ai, bus } = wire({ ...config, role: 'delivery' });
    const app = createApp(ctx, { ...config, role: 'delivery' }, rag, blob, ai, bus);
    const res = await app.request('/openapi.json');
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths);
    expect(paths.some((p) => p.startsWith('/delivery/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/spaces/'))).toBe(false);
  });

  it('tags every operation and groups tags for the sidebar', async () => {
    const app = makeApp();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
      tags: { name: string }[];
      'x-tagGroups': { name: string; tags: string[] }[];
    };
    const declared = new Set(spec.tags.map((t) => t.name));
    const grouped = new Set(spec['x-tagGroups'].flatMap((g) => g.tags));
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op.tags?.length, `${method.toUpperCase()} ${path} has a tag`).toBeGreaterThan(0);
        for (const tag of op.tags ?? []) {
          expect(declared.has(tag), `tag "${tag}" declared (${path})`).toBe(true);
          expect(grouped.has(tag), `tag "${tag}" grouped (${path})`).toBe(true);
        }
      }
    }
    // Role-gated deployments never render empty groups.
    expect(spec['x-tagGroups'].every((g) => g.tags.length > 0)).toBe(true);
  });

  it('describes every asset, collection, zip, rendition and share-link operation with a response', async () => {
    const app = makeApp();
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>
      >;
    };
    const asset = /\/(assets|asset-[a-z]+|share-links)(\/|$)/;
    const undescribed: string[] = [];
    let checked = 0;
    for (const [path, ops] of Object.entries(spec.paths)) {
      if (!asset.test(path)) continue;
      for (const [method, op] of Object.entries(ops)) {
        checked++;
        const responses = Object.entries(op.responses ?? {}).filter(([s]) => /^[23]/.test(s));
        // A 204 or a redirect has no body to describe; any other success must say what it
        // returns. A bare inventory entry (no doc()) has one 200 with no content.
        const described = responses.some(
          ([status, r]) =>
            status === '204' ||
            status.startsWith('3') ||
            r.content?.['application/json'] !== undefined,
        );
        if (!described) undescribed.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(undescribed).toEqual([]);
  });

  it('serves the Scalar UI at /docs', async () => {
    const app = makeApp();
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('openapi.json');
    // The explorer comes from this deployment's own vendored copy, never a third-party CDN.
    expect(html).toContain('<script src="/vendor/scalar/standalone.js"');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).toMatch(/"withDefaultFonts": ?false/);
  });

  it('loads the explorer from the admin origin when the api runs on its own host', () => {
    expect(scalarBundleUrl({ oauthIssuer: 'https://acme.commerceworker.com' })).toBe(
      'https://acme.commerceworker.com/vendor/scalar/standalone.js',
    );
    expect(scalarBundleUrl({})).toBe('/vendor/scalar/standalone.js');
  });
});
