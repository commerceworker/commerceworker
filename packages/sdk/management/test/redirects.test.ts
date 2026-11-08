import { describe, expect, it, vi } from 'vitest';
import { createManagementClient } from '../src/index.js';

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cma' };

describe('@commerceworker/sdk-management redirects', () => {
  it('sends each call to its route, and resolves a missing path to null', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(
        `${init?.method ?? 'GET'} ${url.replace('https://cms.test/spaces/s1/environments/main', '')}${init?.body ? ` ${init.body}` : ''}`,
      );
      if (url.includes('/resolve')) {
        return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ redirect: { id: 'r1' }, chains: [], items: [], updated: 0 });
    }) as unknown as typeof fetch;
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    await client.redirects.list({ q: 'blog' });
    await client.redirects.create({ source: '/a', destination: '/b' });
    await client.redirects.update('r1', { enabled: false });
    await client.redirects.delete('r1');
    await client.redirects.import({ format: 'csv', data: 'source,destination\n/a,/b\n' });
    expect(await client.redirects.resolve('/x', { locale: 'de' })).toBeNull();
    await client.redirects.analyze();
    await client.redirects.collapseChains();
    expect(calls).toEqual([
      'GET /redirects?q=blog',
      'POST /redirects {"source":"/a","destination":"/b"}',
      'PATCH /redirects/r1 {"enabled":false}',
      'DELETE /redirects/r1',
      'POST /redirects/import {"format":"csv","data":"source,destination\\n/a,/b\\n"}',
      'GET /redirects/resolve?path=%2Fx&locale=de',
      'GET /redirects/analysis',
      'POST /redirects/collapse-chains',
    ]);
  });
});
