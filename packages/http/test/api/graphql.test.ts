import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
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
});

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

async function gql(app: ReturnType<typeof createApp>, query: string) {
  const res = await app.request('/delivery/s1/main/graphql', {
    method: 'POST',
    headers: { Authorization: 'Bearer cda', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] },
  };
}

describe('GraphQL Delivery (generated from content types)', () => {
  it('serves a generated schema and resolves published content', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());

    // Author + publish an article via the Management API.
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
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
          {
            apiId: 'views',
            name: 'Views',
            type: 'Integer',
            localized: false,
            required: false,
            position: 1,
          },
        ],
      }),
    });
    await app.request(`${M}/content-types/article/published`, { method: 'POST', headers: cma });
    const created = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        contentTypeApiId: 'article',
        fields: { title: { 'en-US': 'GraphQL works' }, views: { 'en-US': 7 } },
      }),
    });
    const { entry } = (await created.json()) as { entry: { id: string } };
    await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: cma });

    // Query it through the generated GraphQL schema.
    const one = await gql(
      app,
      `{ article(id: "${entry.id}", locale: "en-US") { _sys { id contentType } title views } }`,
    );
    expect(one.status).toBe(200);
    expect(one.body.errors).toBeUndefined();
    const a = (one.body.data as { article: Record<string, unknown> }).article;
    expect((a._sys as { id: string }).id).toBe(entry.id);
    expect(a.title).toBe('GraphQL works');
    expect(a.views).toBe(7);

    const list = await gql(app, '{ articleCollection(locale: "en-US") { _sys { id } title } }');
    expect((list.body.data as { articleCollection: unknown[] }).articleCollection).toHaveLength(1);

    // Naming no locale reads the space's default one: a String field is never a locale map.
    const plain = await gql(
      app,
      `{ article(id: "${entry.id}") { title } articleCollection { title } }`,
    );
    expect(plain.body.errors).toBeUndefined();
    const data = plain.body.data as {
      article: { title: unknown };
      articleCollection: { title: unknown }[];
    };
    expect(data.article.title).toBe('GraphQL works');
    expect(data.articleCollection.map((e) => e.title)).toEqual(['GraphQL works']);
  });

  it('never serves one principal the resolvers of another (cache is principal-free)', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };

    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        apiId: 'post',
        name: 'Post',
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
          {
            apiId: 'internalNotes',
            name: 'Internal notes',
            type: 'Text',
            localized: false,
            required: false,
            position: 1,
          },
        ],
      }),
    });
    await app.request(`${M}/content-types/post/published`, { method: 'POST', headers: cma });
    const created = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'Public' }, internalNotes: { 'en-US': 'secret' } },
      }),
    });
    const { entry } = (await created.json()) as { entry: { id: string } };
    await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: cma });

    // Granular role reading EVERY type (same visible shape as the full CDA
    // key — the two principals share a schema-cache slot) but with a
    // field-level deny on post.internalNotes.
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Reader without notes',
        scopes: ['delivery:read'],
        contentGrants: [
          { contentTypeApiId: 'post', actions: ['read'], deniedFields: ['internalNotes'] },
          { contentTypeApiId: 'article', actions: ['read'] },
          { contentTypeApiId: 'author', actions: ['read'] },
        ],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cda', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };

    const q = `{ post(id: "${entry.id}", locale: "en-US") { title internalNotes } postCollection(locale: "en-US") { internalNotes } }`;
    const gqlAs = async (bearer: string) => {
      const res = await app.request('/delivery/s1/main/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      return (await res.json()) as {
        data?: {
          post: { title: string; internalNotes: string | null };
          postCollection: { internalNotes: string | null }[];
        };
        errors?: unknown[];
      };
    };

    // Full-access key first: warms the cache slot for this shape.
    const full = await gqlAs('cda');
    expect(full.data?.post.internalNotes).toBe('secret');
    expect(full.data?.postCollection[0]?.internalNotes).toBe('secret');

    // The granular key must get ITS OWN masking, not the warm schema's
    // full-access closures — on the single entry AND the collection.
    const granular = await gqlAs(token);
    expect(granular.errors).toBeUndefined();
    expect(granular.data?.post.title).toBe('Public');
    expect(granular.data?.post.internalNotes).toBeNull();
    expect(granular.data?.postCollection[0]?.internalNotes).toBeNull();

    // And the full key is not poisoned in the other direction.
    const fullAgain = await gqlAs('cda');
    expect(fullAgain.data?.post.internalNotes).toBe('secret');
  });

  it('requires the delivery scope', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    const res = await app.request('/delivery/s1/main/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // no token
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an over-deep query', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    // Nest __typename well past MAX_GQL_DEPTH (12) using aliased introspection.
    let q = '__typename';
    for (let i = 0; i < 20; i++) q = `__type(name: "Query") { ${q} }`;
    const res = await gql(app, `{ ${q} }`);
    expect(res.status).toBe(400);
    expect(
      res.body.errors?.some((e) => /maximum depth/i.test((e as { message: string }).message)),
    ).toBe(true);
  });

  it('serves GraphiQL from pinned, integrity-checked assets', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    const html = await (await app.request('/graphiql/s1/main')).text();
    const assets = [...html.matchAll(/(?:src|href)="(https:[^"]+)"/g)].map((m) => m[1] as string);
    expect(assets.length).toBe(4);
    // Exact versions only (a bare package name or a major tag can change under the page).
    for (const url of assets) expect(url, url).toMatch(/@\d+\.\d+\.\d+\//);
    expect(html.match(/integrity="sha384-/g)?.length).toBe(4);
  });

  it('keeps a hostile space or environment name inside the GraphiQL script', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    const html = await (
      await app.request('/graphiql/s1/%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E')
    ).text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('sets baseline security headers', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    const res = await app.request('/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
