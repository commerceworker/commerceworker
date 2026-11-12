import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SECURITY_CONTACT,
  SECURITY_POLICY,
  SECURITY_TXT_PATH,
  SECURITY_TXT_VALIDITY_DAYS,
  securityTxt,
  securityTxtResponse,
} from '../src/security-txt';

const NOW = new Date('2026-11-11T15:30:45.123Z');
const url = (host: string, protocol = 'https:') =>
  new URL(`${protocol}//${host}${SECURITY_TXT_PATH}`);
const field = (text: string, name: string) => text.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1];

describe('securityTxt', () => {
  it('names the reporting channel, the policy and the language, and ends with a newline', () => {
    const text = securityTxt(url('acme.commerceworker.com'), NOW);
    expect(field(text, 'Contact')).toBe(SECURITY_CONTACT);
    expect(field(text, 'Policy')).toBe(SECURITY_POLICY);
    expect(field(text, 'Preferred-Languages')).toBe('en');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('expires 364 days ahead, cut to the day, as an RFC 3339 date-time', () => {
    const text = securityTxt(url('acme.commerceworker.com'), NOW);
    expect(field(text, 'Expires')).toBe('2027-11-10T00:00:00Z');
    // Within one day the body doesn't change; the next day it moves.
    const later = new Date('2026-11-11T23:59:59.999Z');
    expect(securityTxt(url('acme.commerceworker.com'), later)).toBe(text);
    expect(
      field(
        securityTxt(url('acme.commerceworker.com'), new Date('2026-11-12T00:00:00Z')),
        'Expires',
      ),
    ).toBe('2027-11-11T00:00:00Z');
    // RFC 9116 §2.5.5: less than a year.
    expect(SECURITY_TXT_VALIDITY_DAYS).toBeLessThan(365);
  });

  it('echoes the request’s https origin as Canonical, and only that', () => {
    expect(field(securityTxt(url('shop.acme.com'), NOW), 'Canonical')).toBe(
      'https://shop.acme.com/.well-known/security.txt',
    );
    // Plain http, a port, an address or a bare name could be anything: left out.
    for (const u of [
      url('localhost:5173', 'http:'),
      url('acme.commerceworker.com', 'http:'),
      url('acme.commerceworker.com:8443'),
      url('127.0.0.1'),
      url('localhost'),
      new URL('https://user:pw@acme.commerceworker.com/.well-known/security.txt'),
    ])
      expect(field(securityTxt(u, NOW), 'Canonical'), u.href).toBeUndefined();
  });
});

describe('securityTxtResponse', () => {
  it('answers a GET as UTF-8 plain text that a cache may keep for an hour', async () => {
    const res = securityTxtResponse(new Request(`https://a.example.com${SECURITY_TXT_PATH}`), NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await res.text()).toBe(securityTxt(url('a.example.com'), NOW));
  });

  it('answers a HEAD with the headers and no body, and refuses a write', async () => {
    const head = securityTxtResponse(
      new Request(`https://a.example.com${SECURITY_TXT_PATH}`, { method: 'HEAD' }),
      NOW,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = securityTxtResponse(
      new Request(`https://a.example.com${SECURITY_TXT_PATH}`, { method: 'POST' }),
      NOW,
    );
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('the docs site’s static file', () => {
  const file = readFileSync(
    new URL('../../../apps/docs/public/.well-known/security.txt', import.meta.url),
    'utf8',
  );

  it('says what the shared helper says, apart from its own Expires', () => {
    const generated = securityTxt(new URL('https://docs.commerceworker.com/x'), NOW);
    const without = (t: string) => t.replace(/^Expires: .*\n/m, '');
    expect(without(file)).toBe(without(generated));
  });

  // A static file has no clock. This goes red 60 days before the date, so renewing it (push
  // `Expires` out to under a year from the day you do) is a task, never an outage.
  it('does not expire within 60 days', () => {
    const expires = field(file, 'Expires');
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
    const ms = Date.parse(expires as string) - Date.now();
    expect(ms, `docs security.txt expires ${expires}: renew it`).toBeGreaterThan(60 * 86_400_000);
  });
});
