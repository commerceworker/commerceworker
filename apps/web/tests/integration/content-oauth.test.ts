import { describe, expect, it } from 'vitest';
import { contentOAuthResponse } from '../../app/lib/content-oauth';

describe('content OAuth forms on the shared admin origin', () => {
  it('uses the native HTMLRewriter to namespace only content OAuth form actions', async () => {
    const response = contentOAuthResponse(
      new Response(
        '<form method="post" action="/oauth/authorize"><input name="consent" value="signed"></form>' +
          '<form action="/oauth/device"></form><form action="/account"></form>' +
          '<form action="https://client.example/return"></form>',
        {
          headers: { 'content-type': 'text/html', 'content-security-policy': "form-action 'self'" },
        },
      ),
    );
    const html = await response.text();
    expect(html).toContain('action="/content-api/oauth/authorize"');
    expect(html).toContain('action="/content-api/oauth/device"');
    expect(html).toContain('name="consent" value="signed"');
    expect(html).toContain('action="/account"');
    expect(html).toContain('action="https://client.example/return"');
    expect(response.headers.get('content-security-policy')).toBe("form-action 'self'");
  });

  it('namespaces local OAuth redirects while preserving a validated external client redirect', () => {
    const local = contentOAuthResponse(
      new Response(null, {
        status: 303,
        headers: { location: '/oauth/device?user_code=ABC' },
      }),
    );
    expect(local.status).toBe(303);
    expect(local.headers.get('location')).toBe('/content-api/oauth/device?user_code=ABC');
    const external = contentOAuthResponse(
      new Response(null, {
        status: 303,
        headers: { location: 'https://client.example/return?code=one-time' },
      }),
    );
    expect(external.headers.get('location')).toBe('https://client.example/return?code=one-time');
  });
});
