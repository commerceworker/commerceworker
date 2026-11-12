import { describe, expect, it } from 'vitest';
import {
  ANY_HTTPS_FRAMER,
  CONSENT_HEADER,
  contentSecurityPolicy,
  PERMISSIONS_POLICY,
  pageHeaders,
  parseEmbed,
  redirectSource,
  STRIPE_HEADER,
  TURNSTILE_HEADER,
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

  it('lets only a page that asks for Stripe load Stripe.js, frame its elements and call its API', () => {
    const plain = contentSecurityPolicy('n');
    expect(plain).not.toContain('stripe.com');
    expect(directive(plain, 'connect-src')).toBe("connect-src 'self'");
    const csp = contentSecurityPolicy('n', null, { stripe: true });
    expect(directive(csp, 'script-src')).toBe(
      "script-src 'self' 'nonce-n' https://js.stripe.com https://*.js.stripe.com",
    );
    expect(directive(csp, 'frame-src')).toBe(
      'frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com',
    );
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' https://api.stripe.com");
    // Nothing else opens up.
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    // With Turnstile too (the payment page), both frames and both scripts, each once.
    const both = contentSecurityPolicy('n', null, { stripe: true, turnstile: true });
    expect(directive(both, 'frame-src')).toBe(
      `frame-src ${TURNSTILE_ORIGIN} https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com`,
    );
    expect(directive(both, 'script-src')).toBe(
      `script-src 'self' 'nonce-n' ${TURNSTILE_ORIGIN} https://js.stripe.com https://*.js.stripe.com`,
    );
  });

  it('folds a route’s Stripe note into its policy and Permissions-Policy, and no other page gets either', () => {
    const card = pageHeaders(new Headers({ [STRIPE_HEADER]: '1', [TURNSTILE_HEADER]: '1' }), 'n');
    expect(card.has(STRIPE_HEADER)).toBe(false);
    expect(card.get('content-security-policy')).toContain('https://js.stripe.com');
    expect(card.get('permissions-policy')).toContain('payment=(self "https://js.stripe.com")');
    // Sent through the Worker's headers, the page's own Permissions-Policy stands.
    const sent = withSecurityHeaders(
      new Response('x', { headers: card }),
      new URL('https://shop.test/checkout/chk_1'),
    );
    expect(sent.headers.get('permissions-policy')).toContain('payment=(self');
    expect(sent.headers.get('permissions-policy')).toContain('camera=()');
    // Every other page, and a HEAD answer's, keep payment denied and Stripe out of the policy.
    for (const nonce of ['n', undefined]) {
      const other = pageHeaders(new Headers(), nonce);
      expect(other.get('content-security-policy') ?? '').not.toContain('stripe.com');
      expect(other.has('permissions-policy')).toBe(false);
    }
    const other = withSecurityHeaders(new Response('x'), new URL('https://shop.test/cart/c_1'));
    expect(other.headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
    expect(PERMISSIONS_POLICY).toContain('payment=()');
    // The note reaches no client, even on a .data answer that never passes the entry.
    const data = withSecurityHeaders(
      new Response('x', { headers: { [STRIPE_HEADER]: '1' } }),
      new URL('https://shop.test/checkout/chk_1.data'),
    );
    expect(data.headers.has(STRIPE_HEADER)).toBe(false);
    expect(data.headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
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
