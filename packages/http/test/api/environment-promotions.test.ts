import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { testConfig } from './config.js';
import { wire } from './wire.js';

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
const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
const STAGING = '/spaces/s1/environments/staging';

let app: ReturnType<typeof createApp>;
let entryId: string;

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
  await app.request('/spaces/s1/environments', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ id: 'staging' }),
  });
  const note = {
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
  };
  for (const env of ['staging', 'main']) {
    const base = `/spaces/s1/environments/${env}`;
    await app.request(`${base}/content-types`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify(note),
    });
    await app.request(`${base}/content-types/note/published`, { method: 'POST', headers: admin });
  }
  const created = await app.request(`${STAGING}/entries`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ contentTypeApiId: 'note', fields: { title: { 'en-US': 'Ship it' } } }),
  });
  entryId = ((await created.json()) as { entry: { id: string } }).entry.id;
  await app.request(`${STAGING}/entries/${entryId}/published`, { method: 'POST', headers: admin });
});

type P = { id: string; status: string; risk: { reasons: string[] }; decidedBy?: string };

describe('promotions over HTTP', () => {
  it('waits for approval into main, which an API key cannot give and the admin token can', async () => {
    const req = await app.request('/spaces/s1/promotions', {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ source: 'staging', target: 'main', entries: [entryId] }),
    });
    expect(req.status).toBe(201);
    const p = (await req.json()) as P;
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The target is main');

    const byKey = await app.request(`/spaces/s1/promotions/${p.id}/approve`, {
      method: 'POST',
      headers: cma,
    });
    expect(byKey.status).toBe(403);
    const byAdmin = await app.request(`/spaces/s1/promotions/${p.id}/approve`, {
      method: 'POST',
      headers: admin,
    });
    expect(byAdmin.status).toBe(200);
    expect((await byAdmin.json()) as P).toMatchObject({
      status: 'completed',
      decidedBy: 'admin-token',
    });

    const listed = await app.request('/spaces/s1/promotions?status=completed', { headers: admin });
    expect(((await listed.json()) as { items: P[] }).items.map((x) => x.id)).toEqual([p.id]);
    const one = await app.request(`/spaces/s1/promotions/${p.id}`, { headers: admin });
    expect(one.status).toBe(200);
  });

  it('shows promotions to whoever can decide them, not to a preview key', async () => {
    const preview = await app.request('/spaces/s1/promotions', {
      headers: { Authorization: 'Bearer cpa' },
    });
    expect(preview.status).toBe(403);
    expect((await app.request('/spaces/s1/promotions', { headers: admin })).status).toBe(200);
  });

  it('refuses a delivery key', async () => {
    const res = await app.request('/spaces/s1/promotions', {
      method: 'POST',
      headers: cda,
      body: JSON.stringify({ source: 'staging', target: 'main' }),
    });
    expect(res.status).toBe(403);
  });
});
