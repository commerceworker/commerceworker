import { describe, expect, it, vi } from 'vitest';
import { createEdgeClient } from '../src/index.js';

function fakeFetch(body: unknown) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const base = {
  baseUrl: 'https://cms.test',
  space: 's1',
  environment: 'main',
  token: 't',
  locale: 'en-US',
};

describe('@commerceworker/sdk-edge', () => {
  it('always requests the configured locale and projects fields', async () => {
    const { fn, calls } = fakeFetch({
      id: 'e1',
      contentType: 'ticker',
      fields: { title: 'Hi', body: 'long', icon: 'x' },
    });
    const client = createEdgeClient({ ...base, fetch: fn });

    const e = await client.get('e1', ['title', 'icon']);
    expect(calls[0]).toBe('https://cms.test/delivery/s1/main/entries/e1?locale=en-US');
    // Projected to the requested fields only — compact payload for the device.
    expect(e.fields).toEqual({ title: 'Hi', icon: 'x' });
    expect(e.fields.body).toBeUndefined();
  });

  it('lists with content_type + locale', async () => {
    const { fn, calls } = fakeFetch({
      items: [{ id: 'a', contentType: 'ticker', fields: { title: 'A' } }],
    });
    const client = createEdgeClient({ ...base, fetch: fn });
    const items = await client.list('ticker', { limit: 5 });
    expect(items).toHaveLength(1);
    expect(calls[0]).toContain('content_type=ticker');
    expect(calls[0]).toContain('locale=en-US');
    expect(calls[0]).toContain('limit=5');
  });
});
