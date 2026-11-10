import { describe, expect, it } from 'vitest';
import { bearerApiCall, isLocalHost } from '../app/lib/origin';

const ORIGIN = 'https://commerceworker.com';

describe('bearerApiCall', () => {
  const call = (path: string, auth?: string) => {
    const url = new URL(path, ORIGIN);
    const headers: Record<string, string> = { origin: 'https://evil.example', cookie: 's=1' };
    if (auth) headers.authorization = auth;
    return bearerApiCall(new Request(url, { method: 'POST', headers }), url);
  };

  it('exempts only a REST API call with a bearer token', () => {
    expect(call('/api/v1/orders', 'Bearer cmw_live_x')).toBe(true);
    expect(call('/api/v1/orders')).toBe(false);
    // A page's action reads the cookie whatever else is sent, so a bearer header buys nothing.
    expect(call('/team', 'Bearer x')).toBe(false);
    expect(call('/orders/ord_1', 'bearer x')).toBe(false);
    expect(call('/api/v1/orders', 'Basic eDp4')).toBe(false);
  });
});

describe('isLocalHost', () => {
  it('is true only for local development hosts', () => {
    for (const u of [
      'http://localhost:5173/',
      'http://127.0.0.1/',
      'http://[::1]:8787/',
      'http://app.localhost/',
    ])
      expect(isLocalHost(new URL(u))).toBe(true);
    for (const u of [
      'https://commerceworker.com/',
      'https://commerceworker-web.example.workers.dev/',
      'http://localhost.evil.example/',
    ])
      expect(isLocalHost(new URL(u))).toBe(false);
  });
});
