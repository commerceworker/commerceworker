import { describe, expect, it } from 'vitest';
import { loader } from '../app/routes/security-txt';

const get = (method = 'GET') =>
  loader({
    request: new Request('https://shop.acme.com/.well-known/security.txt', { method }),
  } as never);

describe('/.well-known/security.txt on the storefront', () => {
  it('answers 200 as UTF-8 plain text, with a future Expires and its own host as Canonical', async () => {
    const res = get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = await res.text();
    expect(text).toContain(
      'Contact: https://github.com/commerceworker/commerceworker/security/advisories/new',
    );
    expect(text).toContain('Canonical: https://shop.acme.com/.well-known/security.txt');
    expect(Date.parse(text.match(/^Expires: (.+)$/m)![1]!)).toBeGreaterThan(Date.now());
  });

  it('is registered as a route', async () => {
    const { default: routes } = await import('../app/routes');
    expect(routes.some((r) => r.path === '.well-known/security.txt')).toBe(true);
  });
});
