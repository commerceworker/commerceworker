import type { EntryContext, RouterContextProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import handleRequest from '../app/entry.server';
import { EMBED_HEADER, FRAME_HEADER } from '../app/lib/csp';

describe('a document’s policy headers', () => {
  it('never sends a route’s embed or frame policy, not even in a HEAD answer', async () => {
    const headers = new Headers({
      [EMBED_HEADER]: JSON.stringify({ frameAncestors: ['https://buyer.example'], formAction: [] }),
      [FRAME_HEADER]: JSON.stringify(['https://site.example']),
    });
    const res = await handleRequest(
      new Request('https://app.example/content', { method: 'HEAD' }),
      200,
      headers,
      {} as EntryContext,
      {} as RouterContextProvider,
    );
    expect(res.status).toBe(200);
    expect(res.headers.has(EMBED_HEADER)).toBe(false);
    expect(res.headers.has(FRAME_HEADER)).toBe(false);
  });
});
