import { describe, expect, it, vi } from 'vitest';
import { createDeliveryClient, type DeliveredRedirect } from '../src/index.js';
import { applyRedirects, createRedirectHandler, createRedirectMatcher } from '../src/redirects.js';

let n = 0;
const r = (
  source: string,
  destination: string,
  over: Partial<DeliveredRedirect> = {},
): DeliveredRedirect => ({ id: `r${++n}`, source, destination, status: 301, ...over });

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cda' };

describe('redirect matching', () => {
  it('prefers exact, then the most specific pattern, and fills captures', () => {
    const m = createRedirectMatcher([
      r('/[...all]', '/catch/[...all]'),
      r('/docs/[page]', '/p/[page]'),
      r('/docs/intro', '/start'),
      r('/docs/[...rest]', '/d/[...rest]'),
    ]);
    expect(m.match('/docs/intro')?.location).toBe('/start');
    expect(m.match('/docs/a/')?.location).toBe('/p/a');
    expect(m.match('/docs/a/b?x=1')?.location).toBe('/d/a/b?x=1');
    expect(m.match('/z')?.location).toBe('/catch/z');
  });

  it('applies a locale’s redirects only to it', () => {
    const m = createRedirectMatcher([r('/a', '/de', { locale: 'de' }), r('/a', '/any')]);
    expect(m.match('/a', 'de')?.location).toBe('/de');
    expect(m.match('/a')?.location).toBe('/any');
  });
});

describe('applying redirects in front of a site', () => {
  it('answers a matched request with the status and an absolute location', () => {
    const res = applyRedirects(new Request('https://site.test/old?utm=1'), [
      r('/old', '/new', { status: 308 }),
      r('/away', 'https://elsewhere.test/x'),
    ]);
    expect(res?.status).toBe(308);
    expect(res?.headers.get('location')).toBe('https://site.test/new?utm=1');
    expect(
      applyRedirects(new Request('https://site.test/away'), [
        r('/away', 'https://elsewhere.test/x'),
      ])?.headers.get('location'),
    ).toBe('https://elsewhere.test/x');
    expect(applyRedirects(new Request('https://site.test/kept'), [r('/old', '/new')])).toBeNull();
  });

  it('fetches the set once, refreshes it after the TTL and keeps it when a refresh fails', async () => {
    vi.useFakeTimers();
    try {
      let sets = 0;
      let fail = false;
      const source = vi.fn(async () => {
        sets++;
        if (fail) throw new Error('delivery down');
        return sets === 1 ? [r('/a', '/b')] : [r('/a', '/c')];
      });
      const handle = createRedirectHandler(source, { ttlMs: 1000 });
      const loc = async () =>
        (await handle(new Request('https://site.test/a')))?.headers.get('location');
      expect(await loc()).toBe('https://site.test/b');
      expect(await loc()).toBe('https://site.test/b');
      expect(source).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1500);
      // Stale: still answered from the last set while the refresh runs.
      expect(await loc()).toBe('https://site.test/b');
      await vi.runAllTimersAsync();
      expect(await loc()).toBe('https://site.test/c');
      fail = true;
      vi.advanceTimersByTime(1500);
      await loc();
      await vi.runAllTimersAsync();
      expect(await loc()).toBe('https://site.test/c');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a failure when there is no set yet', async () => {
    const handle = createRedirectHandler(async () => {
      throw new Error('delivery down');
    });
    await expect(handle(new Request('https://site.test/a'))).rejects.toThrow('delivery down');
  });
});

describe('the delivery client', () => {
  it('reads the set and resolves a path, null when nothing redirects it', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/redirects/resolve') && url.includes('none')) {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
          status: 404,
        });
      }
      if (url.includes('/redirects/resolve')) {
        return Response.json({ redirect: r('/a', '/b'), status: 301, location: '/b' });
      }
      return Response.json({ items: [r('/a', '/b')], total: 1 });
    }) as unknown as typeof fetch;
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    expect((await client.redirects()).map((x) => x.source)).toEqual(['/a']);
    expect((await client.resolveRedirect('/a', { locale: 'de' }))?.location).toBe('/b');
    expect(await client.resolveRedirect('/none')).toBeNull();
    expect(urls).toEqual([
      'https://cms.test/delivery/s1/main/redirects',
      'https://cms.test/delivery/s1/main/redirects/resolve?path=%2Fa&locale=de',
      'https://cms.test/delivery/s1/main/redirects/resolve?path=%2Fnone',
    ]);
  });
});
