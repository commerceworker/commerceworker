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

function makeApp() {
  const { ctx, rag, blob, ai } = wire(config);
  return createApp(ctx, config, rag, blob, ai, inMemoryEdge());
}

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';

describe('API vertical slice over HTTP', () => {
  it('models, authors, publishes, and delivers an entry', async () => {
    const app = makeApp();

    // Create + publish a content type.
    const ctRes = await app.request(`${M}/content-types`, {
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
        ],
      }),
    });
    expect(ctRes.status).toBe(201);
    await app.request(`${M}/content-types/article/published`, { method: 'POST', headers: cma });

    // Create an entry.
    const entryRes = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ contentTypeApiId: 'article', fields: { title: { 'en-US': 'Hi' } } }),
    });
    expect(entryRes.status).toBe(201);
    const { entry } = (await entryRes.json()) as { entry: { id: string } };

    // Not yet on Delivery.
    const before = await app.request(`/delivery/s1/main/entries/${entry.id}`, { headers: cda });
    expect(before.status).toBe(404);

    // Publish, then read back from Delivery.
    const pub = await app.request(`${M}/entries/${entry.id}/published`, {
      method: 'POST',
      headers: cma,
    });
    expect(pub.status).toBe(200);

    const delivered = await app.request(`/delivery/s1/main/entries/${entry.id}`, {
      headers: cda,
    });
    expect(delivered.status).toBe(200);
    const body = (await delivered.json()) as { fields: { title: Record<string, string> } };
    expect(body.fields.title['en-US']).toBe('Hi');
  });

  it('publishes normally through the pre-publish moderation gate when content is clean', async () => {
    // Gate on: publish runs moderation first. The stub classifier does not flag,
    // so a clean entry still publishes (the gate only blocks flagged content).
    const gated: ApiConfig = { ...config, moderateBeforePublish: true };
    const { ctx, rag, blob, ai } = wire(gated);
    const app = createApp(ctx, gated, rag, blob, ai, inMemoryEdge());
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
        ],
      }),
    });
    await app.request(`${M}/content-types/article/published`, { method: 'POST', headers: cma });
    const entryRes = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ contentTypeApiId: 'article', fields: { title: { 'en-US': 'Hi' } } }),
    });
    const { entry } = (await entryRes.json()) as { entry: { id: string } };
    const pub = await app.request(`${M}/entries/${entry.id}/published`, {
      method: 'POST',
      headers: cma,
    });
    expect(pub.status).toBe(200);
  });

  it('rejects writes without a key (401)', async () => {
    const app = makeApp();
    const res = await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a delivery (CDA) key writing to the Management API (403)', async () => {
    const app = makeApp();
    const res = await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: { Authorization: 'Bearer cda', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiId: 'x',
        name: 'X',
        displayField: 'a',
        fields: [
          { apiId: 'a', name: 'A', type: 'Symbol', localized: false, required: true, position: 0 },
        ],
      }),
    });
    expect(res.status).toBe(403); // CDA lacks content:manage
  });

  it('rejects a key acting outside its space (403)', async () => {
    const app = makeApp();
    // dev keys are scoped to s1; hitting space s2 is forbidden.
    const res = await app.request('/spaces/s2/environments/main/content-types', {
      method: 'POST',
      headers: { Authorization: 'Bearer cma', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiId: 'x',
        name: 'X',
        displayField: 'a',
        fields: [
          { apiId: 'a', name: 'A', type: 'Symbol', localized: false, required: true, position: 0 },
        ],
      }),
    });
    expect(res.status).toBe(403);
  });

  it('never leaks api key hashes or webhook secrets in responses', async () => {
    const app = makeApp();

    // API key list must not expose the stored hash.
    const keys = (
      (await (await app.request('/spaces/s1/api-keys', { headers: cma })).json()) as {
        items: unknown[];
      }
    ).items;
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).not.toHaveProperty('hashedToken');

    // Creating + listing webhooks must not echo the signing secret.
    const created = await (
      await app.request(`${M}/webhooks`, {
        method: 'POST',
        headers: cma,
        body: JSON.stringify({ url: 'https://h.example/x', topics: ['*'], secret: 'shh' }),
      })
    ).json();
    expect(created).not.toHaveProperty('secret');
    const hooks = (
      (await (await app.request(`${M}/webhooks`, { headers: cma })).json()) as { items: unknown[] }
    ).items;
    for (const h of hooks) expect(h).not.toHaveProperty('secret');
  });

  it('admin token can provision; CMA key cannot create spaces', async () => {
    const app = makeApp();
    const denied = await app.request('/spaces', {
      method: 'POST',
      headers: { Authorization: 'Bearer cma', 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId: 's9', name: 'Nine', defaultLocale: 'en-US' }),
    });
    expect(denied.status).toBe(403);
    const ok = await app.request('/spaces', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId: 's9', name: 'Nine', defaultLocale: 'en-US' }),
    });
    expect(ok.status).toBe(201);
  });

  it('lists spaces scoped to the principal: admin sees all, a scoped key sees its own', async () => {
    const app = makeApp();
    await app.request('/spaces', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId: 's2', name: 'Two', defaultLocale: 'en-US' }),
    });
    const adminList = (await (await app.request('/spaces', { headers: cma })).json()) as {
      items: { id: string }[];
    };
    // The dev "cma" key is scoped to s1, so it only sees s1.
    expect(adminList.items.map((s) => s.id)).toEqual(['s1']);

    const all = (await (
      await app.request('/spaces', { headers: { Authorization: 'Bearer admin' } })
    ).json()) as { items: { id: string }[] };
    expect(all.items.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('returns 422 on invalid content', async () => {
    const app = makeApp();
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        apiId: 'note',
        name: 'Note',
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
      }),
    });
    const res = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ contentTypeApiId: 'note', fields: {} }),
    });
    expect(res.status).toBe(422);
  });
});
