import {
  createContentType,
  createEntry,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { createDeliveryClient } from '@commerceworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { renderSitemapXml, sitemapBase } from '../../src/api/sitemap-xml';
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
    locales: ['en-US', 'de'],
    scale: 1,
  },
});

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda' };
const D = '/delivery/s1/main';
const M = '/spaces/s1/environments/main';
const scope = { spaceId: 's1', environmentId: 'main' };

const field = (apiId: string, type: FieldDefinition['type'], position: number) =>
  ({ apiId, name: apiId, type, localized: false, required: false, position }) as FieldDefinition;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Published `article` (/blog/{slug}, with a Seo field) and `author` (/people/{slug}, without). */
async function setup() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
  await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    urlPattern: '/blog/{slug}',
    fields: [
      field('title', 'Symbol', 0),
      field('slug', 'Slug', 1),
      field('seo', 'Seo', 2),
      field('internalNotes', 'Text', 3),
    ],
  });
  await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
    apiId: 'author',
    name: 'Author',
    displayField: 'title',
    urlPattern: '/people/{slug}',
    fields: [field('title', 'Symbol', 0), field('slug', 'Slug', 1)],
  });
  await publishContentType(wired.ctx, scope, 'article');
  await publishContentType(wired.ctx, scope, 'author');
  const publish = async (type: string, slug: string, seo?: Record<string, unknown>) => {
    const { entry } = await createEntry(wired.ctx, scope, {
      contentTypeApiId: type,
      fields: {
        title: { 'en-US': slug },
        slug: { 'en-US': slug },
        ...(type === 'article' ? { internalNotes: { 'en-US': 'Do not share' } } : {}),
        ...(seo ? { seo: { 'en-US': seo } } : {}),
      },
    });
    await publishEntry(wired.ctx, scope, entry.id);
    return entry.id;
  };
  const hello = await publish('article', 'hello', { title: 'Hello | Blog' });
  await publish('article', 'hidden', { noindex: true });
  const ada = await publish('author', 'ada');
  return { app, wired, hello, ada, publish };
}

async function keyFor(
  app: Awaited<ReturnType<typeof setup>>['app'],
  kind: 'cda' | 'cma',
  grants: unknown[],
  scopes: string[],
) {
  const role = await json<{ id: string }>(
    await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ name: `r-${Math.random()}`, scopes, contentGrants: grants }),
    }),
  );
  const { token } = await json<{ token: string }>(
    await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind, roleId: role.id }),
    }),
  );
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('the sitemap over Delivery', () => {
  it('lists published pages by entry id, without noindex ones', async () => {
    const { app, hello, ada } = await setup();
    const res = await app.request(`${D}/sitemap`, { headers: cda });
    expect(res.status).toBe(200);
    const body = await json<{ items: { entryId: string; urls: unknown[] }[]; next: unknown }>(res);
    expect(body.next).toBeNull();
    expect(body.items.map((e) => e.entryId)).toEqual([hello, ada].sort());
    expect(body.items.find((e) => e.entryId === hello)).toEqual({
      entryId: hello,
      contentType: 'article',
      lastmod: expect.any(String),
      urls: [{ path: '/blog/hello', locale: 'en-US' }],
    });
  });

  it('pages with from and next, a noindex entry still taking its place in a page', async () => {
    const { app, hello, ada } = await setup();
    const seen: string[] = [];
    let from = '';
    let pages = 0;
    do {
      const page = await json<{ items: { entryId: string }[]; next: string | null }>(
        await app.request(`${D}/sitemap?limit=1${from ? `&from=${from}` : ''}`, { headers: cda }),
      );
      seen.push(...page.items.map((e) => e.entryId));
      from = page.next ?? '';
      pages++;
    } while (from);
    expect(pages).toBe(3);
    expect(seen.sort()).toEqual([hello, ada].sort());
  });

  it('serves XML for crawlers at the site’s base URL', async () => {
    const { app } = await setup();
    const res = await app.request(`${D}/sitemap.xml?base=https://www.example.com/`, {
      headers: cda,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const xml = await res.text();
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset /);
    expect(xml).toContain('<loc>https://www.example.com/blog/hello</loc>');
    expect(xml).toContain('<loc>https://www.example.com/people/ada</loc>');
    expect(xml).not.toContain('hidden');
    expect(xml).toMatch(/<lastmod>\d{4}-\d\d-\d\dT/);
  });

  it('refuses the XML without an absolute http(s) base', async () => {
    const { app } = await setup();
    for (const q of [
      '',
      '?base=example.com',
      '?base=ftp://example.com',
      '?base=https://x.com/?a=1',
    ]) {
      const res = await app.request(`${D}/sitemap.xml${q}`, { headers: cda });
      expect(res.status, q).toBe(422);
    }
  });

  it('judges a canonical URL under the base’s path prefix', async () => {
    const { app, publish } = await setup();
    await publish('article', 'setup', { canonicalUrl: 'https://ex.com/docs/blog/setup/' });
    const xml = await (
      await app.request(`${D}/sitemap.xml?base=https://ex.com/docs`, { headers: cda })
    ).text();
    expect(xml).toContain('<loc>https://ex.com/docs/blog/setup</loc>');
    const other = await (
      await app.request(`${D}/sitemap.xml?base=https://ex.com/site`, { headers: cda })
    ).text();
    expect(other).not.toContain('/blog/setup');
  });

  it('leaves out a page canonical on another site when told the site', async () => {
    const { app, publish } = await setup();
    await publish('article', 'copy', { canonicalUrl: 'https://partner.example/blog/copy' });
    const paths = async (q: string) =>
      (
        await json<{ items: { urls: { path: string }[] }[] }>(
          await app.request(`${D}/sitemap${q}`, { headers: cda }),
        )
      ).items.flatMap((e) => e.urls.map((u) => u.path));
    expect(await paths('')).toContain('/blog/copy');
    expect(await paths('?base=https://www.example.com')).not.toContain('/blog/copy');
  });

  it('shows a key limited to some content types only theirs, and needs a key', async () => {
    const { app, ada } = await setup();
    const authorsOnly = await keyFor(
      app,
      'cda',
      [{ contentTypeApiId: 'author', actions: ['read'] }],
      ['delivery:read'],
    );
    const body = await json<{ items: { entryId: string }[] }>(
      await app.request(`${D}/sitemap`, { headers: authorsOnly }),
    );
    expect(body.items.map((e) => e.entryId)).toEqual([ada]);
    expect((await app.request(`${D}/sitemap`)).status).toBe(401);
    expect((await app.request(`${D}/sitemap.xml?base=https://x.com`)).status).toBe(401);
  });
});

describe('the SDK', () => {
  it('reads the sitemap Delivery serves', async () => {
    const { app, hello, ada } = await setup();
    const client = createDeliveryClient({
      baseUrl: 'http://localhost',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        app.request(String(url), init)) as typeof fetch,
    });
    const page = await client.sitemap();
    expect(page.items.map((e) => e.entryId)).toEqual([hello, ada].sort());
    expect(page.next).toBeNull();
  });
});

describe('SEO metadata over the Management API', () => {
  it('changes one locale’s SEO as a draft, delivered once published', async () => {
    const { app, hello } = await setup();
    const res = await app.request(`${M}/entries/${hello}/seo`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ description: 'A first post', title: null }),
    });
    expect(res.status).toBe(200);
    const view = await json<{ entry: { status: string }; fields: { seo: unknown } }>(res);
    expect(view.entry.status).toBe('changed');
    expect(view.fields.seo).toEqual({ 'en-US': { description: 'A first post' } });
    await app.request(`${M}/entries/${hello}/published`, { method: 'POST', headers: admin });
    const delivered = await json<{ fields: { seo: unknown } }>(
      await app.request(`${D}/entries/${hello}?locale=en-US`, { headers: cda }),
    );
    expect(delivered.fields.seo).toEqual({ description: 'A first post' });
  });

  it('refuses a bad value, a type without a Seo field, and a locale the field doesn’t have', async () => {
    const { app, hello, ada } = await setup();
    const patch = (id: string, body: unknown) =>
      app.request(`${M}/entries/${id}/seo`, {
        method: 'PATCH',
        headers: admin,
        body: JSON.stringify(body),
      });
    const bad = await patch(hello, { canonicalUrl: 'javascript:alert(1)' });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain('seo.canonicalUrl');
    expect((await patch(hello, { noindex: 'yes' })).status).toBe(422);
    expect((await patch(ada, { title: 'Ada' })).status).toBe(422);
    expect((await patch(hello, { title: 'Hallo', locale: 'de' })).status).toBe(422);
  });

  it('holds a role to its field rules on the Seo field', async () => {
    const { app, hello } = await setup();
    const readOnlySeo = await keyFor(
      app,
      'cma',
      [{ contentTypeApiId: 'article', actions: ['read', 'write'], readOnlyFields: ['seo'] }],
      ['content:write', 'preview:read'],
    );
    const res = await app.request(`${M}/entries/${hello}/seo`, {
      method: 'PATCH',
      headers: readOnlySeo,
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(403);
    const writer = await keyFor(
      app,
      'cma',
      [{ contentTypeApiId: 'article', actions: ['read', 'write'] }],
      ['content:write', 'preview:read'],
    );
    const ok = await app.request(`${M}/entries/${hello}/seo`, {
      method: 'PATCH',
      headers: writer,
      body: JSON.stringify({ title: 'x' }),
    });
    expect(ok.status).toBe(200);
  });

  it('answers with only the fields the role may read, keeping the denied ones saved', async () => {
    const { app, hello } = await setup();
    const masked = await keyFor(
      app,
      'cma',
      [
        {
          contentTypeApiId: 'article',
          actions: ['read', 'write'],
          deniedFields: ['internalNotes'],
        },
      ],
      ['content:write', 'preview:read'],
    );
    const res = await app.request(`${M}/entries/${hello}/seo`, {
      method: 'PATCH',
      headers: masked,
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(200);
    const view = await json<{ fields: Record<string, unknown> }>(res);
    expect(view.fields).not.toHaveProperty('internalNotes');
    expect(view.fields.seo).toEqual({ 'en-US': { title: 'x' } });
    const full = await json<{ fields: Record<string, unknown> }>(
      await app.request(`${M}/entries/${hello}`, { headers: admin }),
    );
    expect(full.fields.internalNotes).toEqual({ 'en-US': 'Do not share' });
  });

  it('previews the sitemap Delivery serves', async () => {
    const { app } = await setup();
    const res = await app.request(`${M}/sitemap`, { headers: admin });
    expect(res.status).toBe(200);
    expect((await json<{ items: unknown[] }>(res)).items).toHaveLength(2);
  });
});

describe('renderSitemapXml', () => {
  it('lists every locale’s URL with its alternates, escaped', () => {
    const xml = renderSitemapXml(
      {
        kind: 'urlset',
        items: [
          {
            entryId: 'e1',
            contentType: 'article',
            lastmod: '2026-01-01T00:00:00.000Z',
            urls: [
              { path: '/en/a&b', locale: 'en-US' },
              { path: '/de/a', locale: 'de' },
            ],
          },
        ],
      },
      'https://example.com',
    );
    expect(xml).toContain('<loc>https://example.com/en/a&amp;b</loc>');
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/a"/>',
    );
    expect(xml.match(/<url>/g)).toHaveLength(2);
  });

  it('names an index’s pages at the site’s sitemap.xml', () => {
    const xml = renderSitemapXml(
      { kind: 'index', pages: ['a', 'b c'] },
      'https://example.com/docs',
    );
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://example.com/docs/sitemap.xml?page=b%20c</loc>');
  });

  it('keeps a base URL’s path prefix, without its trailing slash', () => {
    expect(sitemapBase('https://example.com/docs/')).toEqual({
      base: 'https://example.com/docs',
      origin: 'https://example.com',
      prefix: '/docs',
    });
  });
});
