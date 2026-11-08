import { ValidationError } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import { assertSafeExternalUrl } from '../src/url-safety';

describe('assertSafeExternalUrl (SSRF guard)', () => {
  const blocked = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://localhost/hook',
    'https://localhost:8443/hook',
    'http://127.0.0.1/x',
    'http://127.9.9.9/x',
    'http://0.0.0.0/x',
    'http://10.0.0.5:6379/x',
    'http://192.168.1.10/x',
    'http://172.16.0.1/x',
    'http://172.31.255.255/x',
    'http://100.64.0.1/x', // CGNAT
    'http://internal.local/x',
    'http://svc.internal/x',
    'http://[::1]/x',
    'http://[fd00::1]/x', // unique-local
    'http://[fe80::1]/x', // link-local
    'http://[::ffff:127.0.0.1]/x', // ipv4-mapped loopback
    'ftp://example.com/x', // non-http scheme
    'file:///etc/passwd',
    'not-a-url',
  ];

  for (const url of blocked) {
    it(`rejects ${url}`, () => {
      expect(() => assertSafeExternalUrl(url)).toThrow(ValidationError);
    });
  }

  const allowed = [
    'https://hooks.example.com/cw',
    'http://example.com/x',
    'https://a/', // public single-label placeholder
    'https://api.stripe.com/v1/x',
    'http://172.15.0.1/x', // just outside private range
    'http://172.32.0.1/x',
    'http://8.8.8.8/x',
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(() => assertSafeExternalUrl(url)).not.toThrow();
    });
  }

  it('reports the given field name', () => {
    try {
      assertSafeExternalUrl('http://127.0.0.1', 'entryUrl');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).issues[0]?.field).toBe('entryUrl');
    }
  });
});
