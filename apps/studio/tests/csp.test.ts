import { describe, expect, it } from 'vitest';
import {
  ANY_HTTPS_FRAMER,
  contentSecurityPolicy,
  frameSources,
  parseEmbed,
  parseFrames,
  withSecurityHeaders,
} from '../app/lib/csp';

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `));

describe('page CSP', () => {
  it('forbids framing and posts only here by default', () => {
    const csp = contentSecurityPolicy('n');
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
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
    expect(csp.split('; ')).toHaveLength(11);
    expect(directive(csp, 'form-action')?.split(' ')).toHaveLength(5);
  });

  it('frames only this origin by default', () => {
    expect(directive(contentSecurityPolicy('n'), 'frame-src')).toBe("frame-src 'self'");
  });

  it('frames a customer’s frontend origins, https or a local dev server', () => {
    const csp = contentSecurityPolicy('n', null, [
      'https://site.example',
      'https://site.example/__preview?entry=1',
      'http://localhost:3000',
      'http://127.0.0.1:4321/p',
    ]);
    expect(directive(csp, 'frame-src')).toBe(
      "frame-src 'self' https://site.example http://localhost:3000 http://127.0.0.1:4321",
    );
  });

  it('drops a framed source that isn’t https, carries credentials or could add a directive', () => {
    expect(
      frameSources([
        'http://site.example',
        'http://localhost.evil.example',
        'javascript:alert(1)',
        'data:text/html,hi',
        'https://user:pw@site.example',
        "https://x.example; script-src 'unsafe-inline'",
        'https://a;b.example',
        'https://a,b.example',
        "https://a'b.example",
        '*',
        'https://*',
        'https://*.example',
        'https://a_b.example',
        "'unsafe-inline'",
        42,
      ]),
    ).toEqual([]);
    expect(frameSources('https://site.example')).toEqual([]);
    const csp = contentSecurityPolicy('n', null, ["https://x.example; script-src 'unsafe-inline'"]);
    expect(csp.split('; ')).toHaveLength(11);
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-n'");
  });

  it('reads framed origins back from the route header, and nothing from a bad one', () => {
    expect(parseFrames(JSON.stringify(['https://site.example/x', 'http://bad.example']))).toEqual([
      'https://site.example',
    ]);
    expect(parseFrames('not json')).toEqual([]);
    expect(parseFrames(null)).toEqual([]);
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

  it('keeps its own HSTS over a forwarded Worker’s weaker one, and sends none over http', () => {
    const forwarded = new Response('', {
      headers: { 'strict-transport-security': 'max-age=31536000' },
    });
    expect(
      withSecurityHeaders(
        forwarded,
        new URL('https://app.example/delivery/s/e/entries'),
      ).headers.get('strict-transport-security'),
    ).toBe('max-age=31536000; includeSubDomains');
    expect(
      withSecurityHeaders(new Response(''), new URL('http://localhost/')).headers.get(
        'strict-transport-security',
      ),
    ).toBeNull();
  });
});
