import { describe, expect, it } from 'vitest';
import { createRemoteFetcher } from '../../src/http-effects/remote-fetcher';

function fetchReturning(response: () => Response) {
  const inits: RequestInit[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    inits.push(init ?? {});
    return response();
  }) as typeof fetch;
  return { impl, inits };
}

describe('remote fetcher: binary bodies', () => {
  it('returns the bytes as they arrived, without following redirects', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const { impl, inits } = fetchReturning(
      () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
    );
    const file = await createRemoteFetcher(impl).getBytes('https://files.example.com/a.png', {
      maxBytes: 1024,
    });
    expect(file).toEqual({ status: 200, contentType: 'image/png', bytes });
    expect(inits[0]?.redirect).toBe('manual');
  });

  it('enforces the cap on what arrives, not only on what is declared', async () => {
    const { impl } = fetchReturning(() => new Response(new Uint8Array(64)));
    await expect(
      createRemoteFetcher(impl).getBytes('https://files.example.com/big', { maxBytes: 16 }),
    ).rejects.toThrow(/exceeds the 16 byte limit/);
  });

  it('reports a non-2xx status with an empty body', async () => {
    const { impl } = fetchReturning(
      () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }),
    );
    const file = await createRemoteFetcher(impl).getBytes('https://files.example.com/moved', {
      maxBytes: 16,
    });
    expect(file.status).toBe(302);
    expect(file.bytes.byteLength).toBe(0);
  });

  it('still reads text the same way', async () => {
    const { impl } = fetchReturning(() => new Response('{"ok":true}'));
    const doc = await createRemoteFetcher(impl).get('https://files.example.com/a.json', {
      maxBytes: 1024,
    });
    expect(doc.body).toBe('{"ok":true}');
  });
});
