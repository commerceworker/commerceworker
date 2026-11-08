import { describe, expect, it, vi } from 'vitest';
import { createManagementClient } from '../src/index.js';

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cma' };

describe('@commerceworker/sdk-management entry SEO', () => {
  it('patches one locale of the entry’s SEO metadata', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(input)} ${init?.body}`);
      return Response.json({ entry: { id: 'e1' }, fields: {} });
    }) as unknown as typeof fetch;
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    await client.entries.setSeo('e1', { locale: 'de', title: 'Hallo', ogImage: null });
    expect(calls).toEqual([
      'PATCH https://cms.test/spaces/s1/environments/main/entries/e1/seo {"locale":"de","title":"Hallo","ogImage":null}',
    ]);
  });
});
