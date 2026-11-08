import { createRedirectMatcher as domainMatcher, type Redirect } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { createDeliveryClient } from '@commerceworker/sdk-core';
import { createRedirectHandler, createRedirectMatcher } from '@commerceworker/sdk-core/redirects';
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
    locales: ['en-US', 'de'],
    scale: 1,
  },
});

const AT = '2026-01-01T00:00:00.000Z';
let n = 0;
const r = (source: string, destination: string, over: Partial<Redirect> = {}): Redirect => ({
  id: `r${String(++n).padStart(3, '0')}`,
  source,
  destination,
  status: 301,
  enabled: true,
  origin: 'manual',
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

/**
 * The SDK's matcher is a copy of the domain's (an SDK depends on no server code), so the two are
 * held together here: every path in the table resolves the same through both.
 */
describe('the SDK’s redirect matching against the server’s', () => {
  const set = [
    r('/a', '/b'),
    r('/a', '/de-a', { locale: 'de' }),
    r('/docs/[page]', '/p/[page]'),
    r('/docs/intro', '/start?x=1'),
    r('/docs/[...rest]', '/d/[...rest]'),
    r('/[x]/z', '/one', { id: 'zz' }),
    r('/[y]/z', '/two', { id: 'aa' }),
    r('/[y]/z', '/de-z', { locale: 'de' }),
    r('/%C3%BCber', '/about'),
    r('/[...all]', 'https://elsewhere.test/[...all]'),
    r('/blog/[slug]', '/posts/[slug]#top'),
  ];
  const paths = [
    '/a',
    '/a/',
    '/a?utm=1',
    '/docs/intro?y=2',
    '/docs/x',
    '/docs/x/y/z',
    '/q/z',
    '/über',
    '/%C3%BCber',
    '/anything/else',
    '/blog/hi?ref=1',
    '/',
    '//a//',
  ];
  it.each(
    paths.flatMap(
      (p) =>
        [
          [p, undefined],
          [p, 'de'],
        ] as const,
    ),
  )('%s (%s)', (path, locale) => {
    const server = domainMatcher(set).match(path, locale);
    const sdk = createRedirectMatcher(
      set.map(({ id, source, destination, status, locale: l }) => ({
        id,
        source,
        destination,
        status,
        ...(l ? { locale: l } : {}),
      })),
    ).match(path, locale);
    expect(sdk?.location ?? null).toBe(server?.location ?? null);
    expect(sdk?.redirect.id ?? null).toBe(server?.redirect.id ?? null);
  });
});

describe('@commerceworker/sdk-core redirects against the live Delivery API (in-process)', () => {
  it('reads the set, resolves a path and applies it in front of a site', async () => {
    const wired = wire(config);
    const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
    const res = await app.request('/spaces/s1/environments/main/redirects/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'json',
        data: [
          { source: '/old', destination: '/new' },
          { source: '/blog/[slug]', destination: '/posts/[slug]', status: 308 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const client = createDeliveryClient({
      baseUrl: 'http://localhost',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        app.request(String(url), init)) as typeof fetch,
    });
    expect((await client.redirects()).map((x) => x.source)).toEqual(['/blog/[slug]', '/old']);
    expect((await client.resolveRedirect('/blog/hi'))?.location).toBe('/posts/hi');
    expect(await client.resolveRedirect('/nothing')).toBeNull();
    const handle = createRedirectHandler(() => client.redirects());
    const answer = await handle(new Request('https://site.test/blog/hi?ref=x'));
    expect(answer?.status).toBe(308);
    expect(answer?.headers.get('location')).toBe('https://site.test/posts/hi?ref=x');
    expect(await handle(new Request('https://site.test/kept'))).toBeNull();
  });
});
