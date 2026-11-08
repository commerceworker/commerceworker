import type { ApiConfig } from '@commerceworker/platform/config';
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
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

function makeApp() {
  const wired = wire(config);
  return createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
}

const put = (app: ReturnType<typeof makeApp>, body: unknown, headers = admin) =>
  app.request(`${M}/trash-settings`, { method: 'PUT', headers, body: JSON.stringify(body) });

describe('trash retention over HTTP', () => {
  it('is off by default, and set and cleared with PUT', async () => {
    const app = makeApp();
    const read = async () =>
      (await app.request(`${M}/trash-settings`, { headers: cpa })).json() as Promise<unknown>;
    expect(await read()).toEqual({ retentionDays: null });

    const set = await put(app, { retentionDays: 30 });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ retentionDays: 30 });
    expect(await read()).toEqual({ retentionDays: 30 });

    expect(await (await put(app, { retentionDays: null })).json()).toEqual({ retentionDays: null });
    expect(await read()).toEqual({ retentionDays: null });
  });

  it('refuses a window out of range, and a caller without space:admin', async () => {
    const app = makeApp();
    for (const retentionDays of [0, 3651, 2.5, 'week']) {
      expect((await put(app, { retentionDays })).status).toBe(422);
    }
    expect((await put(app, {})).status).toBe(422);
    expect((await put(app, { retentionDays: 7 }, cpa)).status).toBe(403);
  });
});
