import { describe, expect, it } from 'vitest';
import {
  ANY_HTTPS_FRAMER,
  CONSENT_HEADER,
  contentSecurityPolicy,
  pageHeaders,
  parseEmbed,
  redirectSource,
  TURNSTILE_ORIGIN,
  withSecurityHeaders,
} from '../src/csp';

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `));

describe('page CSP', () => {
  it('forbids framing and posts only here by default', () => {
    const csp = contentSecurityPolicy('n');
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
  });

  it('lets only a page that asks for Turnstile run its script and show its frame', () => {
    const plain = contentSecurityPolicy('n');
    expect(plain).not.toContain(TURNSTILE_ORIGIN);
    expect(directive(plain, 'frame-src')).toBeUndefined();
    const csp = contentSecurityPolicy('n', null, { turnstile: true });
    expect(directive(csp, 'script-src')).toBe(
      "script-src 'self' 'nonce-n' https://challenges.cloudflare.com",
    );
    expect(directive(csp, 'frame-src')).toBe('frame-src https://challenges.cloudflare.com');
    // Nothing else opens up: it still can't be framed, and still posts only here.
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
  });

  it('lets the consent page post to the client’s return origin, and no other page', () => {
    const consent = pageHeaders(
      new Headers({ [CONSENT_HEADER]: 'https://client.test/cb?x=1' }),
      'n',
    );
    expect(directive(consent.get('content-security-policy') ?? '', 'form-action')).toBe(
      "form-action 'self' https://client.test",
    );
    // The note is for the entry, never sent.
    expect(consent.has(CONSENT_HEADER)).toBe(false);
    expect(
      directive(
        pageHeaders(new Headers(), 'n').get('content-security-policy') ?? '',
        'form-action',
      ),
    ).toBe("form-action 'self'");
    // Only an origin, whatever the path holds.
    expect(redirectSource('https://client.test/a;b,c')).toBe('https://client.test');
  });

  it('takes a loopback return over http (RFC 8252), and no other http, scheme or credentials', () => {
    expect(redirectSource('http://127.0.0.1:53211/cb')).toBe('http://127.0.0.1:53211');
    expect(redirectSource('http://localhost:8976/callback')).toBe('http://localhost:8976');
    for (const refused of [
      'http://client.test/cb',
      'http://[::1]:8976/cb',
      'com.example.app:/oauth',
      'javascript:alert(1)',
      'https://user:pw@client.test/cb',
      'https://*/cb',
      'https://*.x.test/cb',
      'http://user:pw@127.0.0.1/cb',
      "https://x.example; script-src 'unsafe-inline'",
      'not a url',
      '',
      null,
    ])
      expect(redirectSource(refused), String(refused)).toBeNull();
  });

  it('lets an external cart be framed by its origins and post its return to its URL', () => {
    const embed = parseEmbed(
      JSON.stringify({
        frameAncestors: ['https://buyer.example', 'https://buyer.example/path?x=1'],
        formAction: ['https://buyer.example/punchout/return'],
      }),
    );
    const csp = contentSecurityPolicy('n', embed);
    expect(directive(csp, 'frame-ancestors')).toBe('frame-ancestors https://buyer.example');
    expect(directive(csp, 'form-action')).toBe(
      "form-action 'self' https://buyer.example/punchout/return",
    );
  });

  it('keeps only https sources, and nothing that could add a directive', () => {
    const embed = parseEmbed(
      JSON.stringify({
        frameAncestors: ['http://buyer.example', "https://x.example; script-src 'unsafe-inline'"],
        formAction: [
          'javascript:alert(1)',
          "https://x.example; script-src 'unsafe-inline'",
          'https://user:pw@buyer.example/return',
          // The URL parser lets these into a host; a source can't carry them.
          'https://a;b.example/return',
          'https://a,b.example/return',
          "https://a'b.example/return",
        ],
      }),
    );
    expect(embed).toEqual({ frameAncestors: [], formAction: [] });
    expect(parseEmbed('not json')).toBeNull();
  });

  it('keeps a return URL whose path or query holds the policy’s separators', () => {
    const embed = parseEmbed(
      JSON.stringify({
        frameAncestors: [],
        formAction: [
          'https://buyer.example/punchout;jsessionid=ABC',
          'https://buyer.example/ret?ids=1,2;x=3',
          "https://buyer.example/a,b/it's here",
        ],
      }),
    );
    // CSP decodes a path before matching and ignores the query, so these still admit the post.
    expect(embed?.formAction).toEqual([
      'https://buyer.example/punchout%3Bjsessionid=ABC',
      'https://buyer.example/ret',
      'https://buyer.example/a%2Cb/it%27s%20here',
    ]);
    const csp = contentSecurityPolicy('n', embed);
    expect(csp.split('; ')).toHaveLength(10);
    expect(directive(csp, 'form-action')?.split(' ')).toHaveLength(5);
  });

  it('lets any https page frame a refusal, and nothing else', () => {
    const embed = parseEmbed(JSON.stringify({ frameAncestors: [ANY_HTTPS_FRAMER] }));
    expect(embed).toEqual({ frameAncestors: ['https:'], formAction: [] });
    expect(directive(contentSecurityPolicy('n', embed), 'frame-ancestors')).toBe(
      'frame-ancestors https:',
    );
    expect(parseEmbed(JSON.stringify({ frameAncestors: 'https:' }))?.frameAncestors).toEqual([]);
  });

  it('sends X-Frame-Options only when the page can’t be framed', () => {
    const url = new URL('https://app.example/');
    const framed = withSecurityHeaders(
      new Response('', {
        headers: { 'content-security-policy': 'frame-ancestors https://buyer.example' },
      }),
      url,
    );
    expect(framed.headers.get('x-frame-options')).toBeNull();
    const closed = withSecurityHeaders(
      new Response('', { headers: { 'content-security-policy': "frame-ancestors 'none'" } }),
      url,
    );
    expect(closed.headers.get('x-frame-options')).toBe('DENY');
    expect(withSecurityHeaders(new Response(''), url).headers.get('x-frame-options')).toBe('DENY');
  });

  it('never lets a route’s notes to the entry reach the browser, a .data answer included', () => {
    const res = withSecurityHeaders(
      new Response('', { headers: { [CONSENT_HEADER]: 'https://client.test/cb' } }),
      new URL('https://app.example/oauth/authorize.data'),
    );
    expect(res.headers.has(CONSENT_HEADER)).toBe(false);
  });
});
