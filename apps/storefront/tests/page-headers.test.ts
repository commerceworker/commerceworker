import { EMBED_HEADER, TURNSTILE_HEADER, withSecurityHeaders } from '@commerceworker/security/csp';
import { createElement } from 'react';
import { createRequestHandler, type ServerBuild } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as entry from '../app/entry.server';

/**
 * React Router with the app's own entry.server.tsx and one route whose `headers` asks for
 * an embed policy, as an external cart's page does: what a page, a HEAD and a `.data` request
 * answer, once `withSecurityHeaders` (as workers/app.ts applies it) has run.
 */
const embed = {
  [EMBED_HEADER]: JSON.stringify({ frameAncestors: ['https://buyer.example'] }),
};
/** What the route asks for: an embed policy, as a cart page does, or Turnstile, as the sign-in page does. */
let asked: Record<string, string> = embed;

const route = {
  id: 'root',
  path: '',
  module: {
    default: () => createElement('p', null, 'Your cart'),
    loader: () => ({ ok: true }),
    headers: () => asked,
  },
};
const build = {
  entry: { module: entry },
  routes: { root: route },
  assets: {
    entry: { module: '/entry.client.js', imports: [] },
    routes: {
      root: {
        id: 'root',
        path: '',
        module: '/root.js',
        hasLoader: true,
        hasAction: false,
        hasClientAction: false,
        hasClientLoader: false,
        hasClientMiddleware: false,
        hasErrorBoundary: false,
        imports: [],
        css: [],
      },
    },
    url: '/manifest.js',
    version: '1',
  },
  publicPath: '/',
  assetsBuildDirectory: 'build/client',
  future: {},
  ssr: true,
  isSpaMode: false,
  prerender: [],
  routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
} as unknown as ServerBuild;
const handler = createRequestHandler(build, 'production');

const answer = async (path: string, method = 'GET') => {
  const url = `https://acme.commerceworker.com${path}`;
  return withSecurityHeaders(await handler(new Request(url, { method })), new URL(url));
};

afterEach(() => {
  vi.unstubAllEnvs();
  asked = embed;
});

describe("a route's notes to entry.server", () => {
  it('fold into the page’s policy, which then admits the buyer’s framers and nothing else', async () => {
    vi.stubEnv('DEV', false);
    const res = await answer('/');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain('frame-ancestors https://buyer.example');
    // Nothing a cart's page loads comes from anywhere but here: Turnstile is the sign-in page's alone.
    expect(csp).not.toContain('challenges.cloudflare.com');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('never reach the client, on a page, a HEAD or a .data answer', async () => {
    // React Router hands a `.data` answer the route's headers without entry.server.
    const raw = await handler(new Request('https://acme.commerceworker.com/_.data'));
    expect(raw.headers.has(EMBED_HEADER)).toBe(true);
    for (const res of [await answer('/'), await answer('/', 'HEAD'), await answer('/_.data')]) {
      expect(res.headers.has(EMBED_HEADER)).toBe(false);
    }
  });

  it('are dropped by the HEAD answer itself, before workers/app.ts sees it', async () => {
    const res = await handler(new Request('https://acme.commerceworker.com/', { method: 'HEAD' }));
    expect(res.headers.has(EMBED_HEADER)).toBe(false);
  });
});

describe('Turnstile on the sign-in page', () => {
  it('lets that page load its script and frame, and strips the note before the client sees it', async () => {
    vi.stubEnv('DEV', false);
    asked = { [TURNSTILE_HEADER]: '1' };
    const res = await answer('/');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(res.headers.has(TURNSTILE_HEADER)).toBe(false);
    // And it gives that page no framers.
    expect(csp).not.toContain('buyer.example');
  });
});
