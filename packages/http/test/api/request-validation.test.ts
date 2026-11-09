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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

function makeApp() {
  const { ctx, rag, blob, ai } = wire(config);
  return createApp(ctx, config, rag, blob, ai, inMemoryEdge());
}

describe('request body validation', () => {
  it('rejects a malformed body with 422 and field issues', async () => {
    const app = makeApp();
    // topics must be an array of strings; a number is invalid.
    const res = await app.request(`${M}/webhooks`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ url: 'https://h.example/x', topics: 5, secret: 'shh' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; issues?: unknown[] } };
    expect(body.error.code).toBe('validation_failed');
    expect(Array.isArray(body.error.issues)).toBe(true);
  });

  it('rejects a missing required field with 422', async () => {
    const app = makeApp();
    // Role requires a name.
    const res = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ scopes: ['delivery:read'] }),
    });
    expect(res.status).toBe(422);
  });

  it('strips unknown keys so they cannot be mass-assigned', async () => {
    const app = makeApp();
    // An extra `revoked: true` (not part of the schema) must be ignored, not honored.
    const res = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', revoked: true, spaceId: 's2' }),
    });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    // The key authenticates (not revoked) and is bound to s1 (spaceId stripped).
    const me = await app.request('/spaces/s1/api-keys', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const onS2 = await app.request('/spaces/s2/api-keys', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(onS2.status).toBe(403);
  });

  it('bounds oversized arrays (DoS guard)', async () => {
    const app = makeApp();
    const res = await app.request(`${M}/bulk/entries/publish`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ ids: Array.from({ length: 5000 }, (_, i) => `id-${i}`) }),
    });
    expect(res.status).toBe(422);
  });
});
