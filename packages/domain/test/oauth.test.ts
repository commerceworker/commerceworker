import { describe, expect, it } from 'vitest';
import {
  assertPkcePresent,
  assertRegisterableRedirectUri,
  bearerChallenge,
  normalizeUserCode,
  OAuthError,
  parseScopeString,
  resolveRedirectUri,
  resourceMetadataPaths,
  resourceMetadataUrl,
  verifyPkce,
} from '../src/index';

describe('RFC 9728 resource metadata URLs', () => {
  it('inserts the well-known segment between host and path, not after it', () => {
    // Appending instead would point every client at a 404.
    expect(resourceMetadataUrl('https://cms.example.com/mcp')).toBe(
      'https://cms.example.com/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('handles a resource with no path', () => {
    expect(resourceMetadataUrl('https://cms.example.com')).toBe(
      'https://cms.example.com/.well-known/oauth-protected-resource',
    );
  });

  it('preserves a non-default port', () => {
    expect(resourceMetadataUrl('http://localhost:8794/mcp')).toBe(
      'http://localhost:8794/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('ignores a trailing slash on the resource', () => {
    expect(resourceMetadataUrl('https://cms.example.com/mcp/')).toBe(
      'https://cms.example.com/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('serves both the suffixed and bare paths so either probe resolves', () => {
    expect(resourceMetadataPaths('https://cms.example.com/mcp')).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
    expect(resourceMetadataPaths('https://cms.example.com')).toEqual([
      '/.well-known/oauth-protected-resource',
    ]);
  });

  it('builds a challenge a client can parse', () => {
    expect(bearerChallenge('https://x/.well-known/oauth-protected-resource')).toBe(
      'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"',
    );
    expect(bearerChallenge('https://x/m', 'expired')).toContain('error="invalid_token"');
  });
});

describe('redirect URI policy', () => {
  it('accepts https, loopback http, and private-use schemes', () => {
    expect(() => assertRegisterableRedirectUri('https://app.example.com/cb')).not.toThrow();
    expect(() => assertRegisterableRedirectUri('http://127.0.0.1:0/cb')).not.toThrow();
    expect(() => assertRegisterableRedirectUri('http://localhost/cb')).not.toThrow();
    expect(() => assertRegisterableRedirectUri('com.example.app:/done')).not.toThrow();
  });

  it('rejects plaintext http to a non-loopback host', () => {
    expect(() => assertRegisterableRedirectUri('http://evil.example.com/cb')).toThrow(OAuthError);
  });

  it('rejects fragments and non-absolute URIs', () => {
    expect(() => assertRegisterableRedirectUri('https://x.example.com/cb#f')).toThrow(OAuthError);
    expect(() => assertRegisterableRedirectUri('/relative')).toThrow(OAuthError);
  });

  it('matches exactly — a shared prefix is not a match', () => {
    const client = { redirectUris: ['https://app.example.com/cb'] };
    expect(resolveRedirectUri(client, 'https://app.example.com/cb')).toBe(
      'https://app.example.com/cb',
    );
    expect(() => resolveRedirectUri(client, 'https://app.example.com/cb.evil.com')).toThrow(
      OAuthError,
    );
    expect(() => resolveRedirectUri(client, 'https://app.example.com/cb/../x')).toThrow(OAuthError);
  });

  it('ignores only the port for loopback, per RFC 8252', () => {
    const client = { redirectUris: ['http://127.0.0.1:1234/cb'] };
    expect(resolveRedirectUri(client, 'http://127.0.0.1:55555/cb')).toBe(
      'http://127.0.0.1:55555/cb',
    );
    // A different path is still a different URI.
    expect(() => resolveRedirectUri(client, 'http://127.0.0.1:55555/other')).toThrow(OAuthError);
    // And the port exemption does not extend to remote hosts.
    const remote = { redirectUris: ['https://app.example.com:443/cb'] };
    expect(() => resolveRedirectUri(remote, 'https://app.example.com:8443/cb')).toThrow(OAuthError);
  });

  it('requires redirect_uri when the client registered more than one', () => {
    expect(resolveRedirectUri({ redirectUris: ['https://a.example.com/cb'] }, undefined)).toBe(
      'https://a.example.com/cb',
    );
    expect(() =>
      resolveRedirectUri(
        { redirectUris: ['https://a.example.com/cb', 'https://b.example.com/cb'] },
        undefined,
      ),
    ).toThrow(OAuthError);
  });
});

describe('PKCE', () => {
  const sha256 = (v: string) => (v === 'good'.repeat(11) ? 'CHALLENGE' : `other:${v}`);

  it('is mandatory and S256-only', () => {
    expect(() => assertPkcePresent(undefined, 'S256')).toThrow(OAuthError);
    expect(() => assertPkcePresent('c', 'plain')).toThrow(OAuthError);
    expect(() => assertPkcePresent('c', undefined)).not.toThrow();
  });

  it('accepts a matching verifier and rejects a mismatch', () => {
    const verifier = 'good'.repeat(11);
    expect(() => verifyPkce('CHALLENGE', 'S256', verifier, sha256)).not.toThrow();
    expect(() => verifyPkce('CHALLENGE', 'S256', 'bad'.repeat(15), sha256)).toThrow(OAuthError);
  });

  it('rejects a verifier outside the RFC 7636 charset or length', () => {
    expect(() => verifyPkce('C', 'S256', 'short', sha256)).toThrow(OAuthError);
    expect(() => verifyPkce('C', 'S256', `${'a'.repeat(42)}!`, sha256)).toThrow(OAuthError);
    expect(() => verifyPkce('C', 'S256', 'a'.repeat(129), sha256)).toThrow(OAuthError);
    expect(() => verifyPkce('C', 'S256', undefined, sha256)).toThrow(OAuthError);
  });
});

describe('device user codes', () => {
  it('forgives case, spacing and punctuation when a human retypes', () => {
    expect(normalizeUserCode('bcdf-ghjk')).toBe('BCDF-GHJK');
    expect(normalizeUserCode('BCDF GHJK')).toBe('BCDF-GHJK');
    expect(normalizeUserCode('BCDFGHJK')).toBe('BCDF-GHJK');
  });

  it('rejects codes of the wrong length', () => {
    expect(() => normalizeUserCode('BCDF')).toThrow(OAuthError);
    expect(() => normalizeUserCode('BCDF-GHJK-M')).toThrow(OAuthError);
  });

  it('drops characters outside the alphabet rather than accepting them', () => {
    // A/E/I/O/U and 0/1/L are excluded, so codes never spell words and never
    // mix up visually similar glyphs.
    expect(() => normalizeUserCode('AEIO-UAEI')).toThrow(OAuthError);
  });
});

describe('scope strings', () => {
  it('splits on any whitespace and drops empties', () => {
    expect(parseScopeString('a  b\tc')).toEqual(['a', 'b', 'c']);
    expect(parseScopeString(undefined)).toEqual([]);
    expect(parseScopeString('')).toEqual([]);
  });
});
