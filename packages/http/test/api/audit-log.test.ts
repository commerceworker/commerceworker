import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import type { AuditEntry } from '@commerceworker/ports';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { routeTargetType } from '../../src/api/auth';
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
const cpa = { Authorization: 'Bearer cpa' };

interface Page {
  items: AuditEntry[];
  nextCursor?: string;
}

describe('GET /spaces/:space/audit-log', () => {
  let wired: ReturnType<typeof wire>;
  let app: ReturnType<typeof createApp>;
  const get = (qs = '', headers: Record<string, string> = admin) =>
    app.request(`/spaces/s1/audit-log${qs}`, { headers });
  const page = async (qs = '') => (await (await get(qs)).json()) as Page;

  const row = (n: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
    id: `a-${String(n).padStart(3, '0')}`,
    spaceId: 's1',
    environmentId: 'main',
    actor: n % 2 ? 'usr_ada' : 'usr_grace',
    action: n % 2 ? 'PUT /entries/:id' : 'POST /releases',
    targetType: n % 2 ? 'entry' : 'release',
    targetId: `t${n % 3}`,
    status: 200,
    at: new Date(Date.UTC(2026, 0, 1 + n)).toISOString(),
    ...over,
  });

  beforeEach(async () => {
    wired = wire(config);
    app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
    for (let n = 0; n < 6; n++) await wired.ctx.store.audit.append(row(n));
    await wired.ctx.store.audit.append(row(9, { spaceId: 's2', actor: 'usr_ada' }));
  });

  it('keeps answering what it always took: no query, environment and limit', async () => {
    const all = await page();
    expect(all.items.map((e) => e.id)).toEqual([
      'a-005',
      'a-004',
      'a-003',
      'a-002',
      'a-001',
      'a-000',
    ]);
    expect(all.nextCursor).toBeUndefined();
    expect((await page('?limit=2')).items).toHaveLength(2);
    expect((await page('?environment=staging')).items).toEqual([]);
    expect((await page('?environment=main')).items).toHaveLength(6);
    // Lenient as it always was: bad limits clamp, empty ones and ?skip are ignored.
    expect((await page('?limit=abc')).items).toHaveLength(1);
    expect((await page('?limit=0')).items).toHaveLength(1);
    expect((await page('?limit=')).items).toHaveLength(6);
    expect((await page('?skip=2')).items).toHaveLength(6);
  });

  it('filters by actor, action, target and date range', async () => {
    const ids = async (qs: string) => (await page(qs)).items.map((e) => e.id);
    expect(await ids('?actor=usr_ada')).toEqual(['a-005', 'a-003', 'a-001']);
    expect(await ids(`?action=${encodeURIComponent('POST /releases')}`)).toEqual([
      'a-004',
      'a-002',
      'a-000',
    ]);
    expect(await ids('?targetType=entry&targetId=t0')).toEqual(['a-003']);
    expect(await ids('?from=2026-01-02&to=2026-01-03')).toEqual(['a-002', 'a-001']);
    expect(await ids('?actor=usr_ada&from=2026-01-03')).toEqual(['a-005', 'a-003']);
  });

  it('walks the filtered log with nextCursor', async () => {
    const first = await page('?actor=usr_ada&limit=2');
    expect(first.items.map((e) => e.id)).toEqual(['a-005', 'a-003']);
    const next = await page(
      `?actor=usr_ada&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    expect(next.items.map((e) => e.id)).toEqual(['a-001']);
    expect(next.nextCursor).toBeUndefined();
  });

  it('answers 422 for a date, a range or a cursor it cannot read', async () => {
    for (const qs of [
      '?from=soon',
      '?to=2026-02-31',
      '?from=2026-02-02&to=2026-02-01',
      '?cursor=x',
    ]) {
      expect((await get(qs)).status, qs).toBe(422);
    }
  });

  it('stays space:admin, and shows one space', async () => {
    expect((await get('', cpa)).status).toBe(403);
    const { items } = await page('?actor=usr_ada');
    expect(items.every((e) => e.spaceId === 's1')).toBe(true);
  });

  it('refuses a space:admin key of another space', async () => {
    await app.request('/spaces', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ spaceId: 's2', name: 'Second', defaultLocale: 'en-US' }),
    });
    const mint = await app.request('/spaces/s2/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', name: 's2 admin' }),
    });
    const { token } = (await mint.json()) as { token: string };
    const other = { Authorization: `Bearer ${token}` };
    expect((await app.request('/spaces/s2/audit-log', { headers: other })).status).toBe(200);
    expect((await get('?actor=usr_ada', other)).status).toBe(403);
  });

  it('records what a REST write targeted, so the log can be filtered by it', async () => {
    const created = await app.request('/spaces/s1/environment-aliases/live', {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ targetEnvironmentId: 'main' }),
    });
    expect(created.status).toBeLessThan(300);
    const { items } = await page('?targetType=environment_alias&targetId=live');
    expect(items.map((e) => e.action)).toEqual(['PUT /spaces/:space/environment-aliases/:alias']);
  });
});

describe('routeTargetType', () => {
  it.each([
    ['/spaces/:space/environments/:env/entries/:id/published', 'id', 'entry'],
    ['/spaces/:space/environments/:env/content-types/:apiId', 'apiId', 'content_type'],
    ['/spaces/:space/environment-aliases/:alias', 'alias', 'environment_alias'],
    ['/spaces/:space/api-keys/:id', 'id', 'api_key'],
    ['/spaces/:space/environments/:env/releases/:id', 'id', 'release'],
    ['/spaces/:space/environments/:env/workflow-runs/:id', 'id', 'workflow_run'],
  ])('%s', (route, param, type) => {
    expect(routeTargetType(route, param)).toBe(type);
  });

  it('names nothing for a parameter the route does not have', () => {
    expect(routeTargetType('/spaces/:space/webhooks', 'id')).toBeUndefined();
  });
});
