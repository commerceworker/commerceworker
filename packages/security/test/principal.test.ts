import { describe, expect, it } from 'vitest';
import {
  PRINCIPAL_TTL_S,
  signPrincipal,
  verifyPrincipal,
  type WebPrincipal,
} from '../src/principal';
import { atLeast, isRole } from '../src/roles';

const KEY = 'test-principal-key';
const OLD = 'previous-principal-key';
const ada: WebPrincipal = { sub: 'usr_ada', email: 'ada@example.com', name: 'Ada', role: 'admin' };
const NOW = 1_800_000_000_000;

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));

describe('signed principal', () => {
  it('round-trips for the path it was signed for', async () => {
    const h = await signPrincipal(KEY, ada, '/spaces/s1/entries', NOW);
    expect(await verifyPrincipal(KEY, h, '/spaces/s1/entries', NOW)).toEqual(ada);
  });

  it('is payload.signature, with iat/exp in seconds and exp = iat + 60', async () => {
    const h = await signPrincipal(KEY, ada, '/mcp', NOW);
    const [payload, sig, extra] = h.split('.');
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(extra).toBeUndefined();
    const claims = decode(payload!);
    expect(claims).toEqual({ ...ada, iat: NOW / 1000, exp: NOW / 1000 + 60, path: '/mcp' });
    expect(PRINCIPAL_TTL_S).toBe(60);
  });

  it('carries the session it was signed from, when there is one', async () => {
    const withSession = { ...ada, sid: 'a1b2c3' };
    const h = await signPrincipal(KEY, withSession, '/agents/assistant-agent/usr_ada', NOW);
    expect(await verifyPrincipal(KEY, h, '/agents/assistant-agent/usr_ada', NOW)).toEqual(
      withSession,
    );
    // Without one, the claims say nothing about a session.
    const bare = await signPrincipal(KEY, ada, '/mcp', NOW);
    expect(decode(bare.split('.')[0]!)).not.toHaveProperty('sid');
  });

  it('refuses another path', async () => {
    const h = await signPrincipal(KEY, ada, '/spaces/s1', NOW);
    expect(await verifyPrincipal(KEY, h, '/spaces/s2', NOW)).toBeNull();
    expect(await verifyPrincipal(KEY, h, '/spaces/s1/', NOW)).toBeNull();
  });

  it('expires after 60 seconds', async () => {
    const h = await signPrincipal(KEY, ada, '/mcp', NOW);
    expect(await verifyPrincipal(KEY, h, '/mcp', NOW + 59_000)).toEqual(ada);
    expect(await verifyPrincipal(KEY, h, '/mcp', NOW + 60_000)).toBeNull();
  });

  it('refuses one issued in the future beyond the skew', async () => {
    const h = await signPrincipal(KEY, ada, '/mcp', NOW + 30_000);
    expect(await verifyPrincipal(KEY, h, '/mcp', NOW)).toBeNull();
    const near = await signPrincipal(KEY, ada, '/mcp', NOW + 3_000);
    expect(await verifyPrincipal(KEY, near, '/mcp', NOW)).toEqual(ada);
  });

  it('refuses another key, and accepts the previous key during a rotation', async () => {
    const h = await signPrincipal(OLD, ada, '/mcp', NOW);
    expect(await verifyPrincipal(KEY, h, '/mcp', NOW)).toBeNull();
    expect(await verifyPrincipal([KEY, OLD], h, '/mcp', NOW)).toEqual(ada);
    expect(await verifyPrincipal([KEY, undefined], h, '/mcp', NOW)).toBeNull();
  });

  it('refuses a payload changed after signing', async () => {
    const h = await signPrincipal(KEY, { ...ada, role: 'member' }, '/mcp', NOW);
    const [payload, sig] = h.split('.');
    const forged = b64url(JSON.stringify({ ...decode(payload!), role: 'admin' }));
    expect(await verifyPrincipal(KEY, `${forged}.${sig}`, '/mcp', NOW)).toBeNull();
  });

  it('refuses a long-lived envelope even when signed with the key', async () => {
    // A signer that set exp far ahead (a bug, or a leaked key): the verifier holds the TTL itself.
    const payload = b64url(
      JSON.stringify({ ...ada, iat: NOW / 1000, exp: NOW / 1000 + 3600, path: '/mcp' }),
    );
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
    );
    const h = `${payload}.${b64url(String.fromCharCode(...sig))}`;
    expect(await verifyPrincipal(KEY, h, '/mcp', NOW)).toBeNull();
  });

  it('refuses garbage, empty and missing headers without throwing', async () => {
    for (const h of [null, undefined, '', '.', 'abc', 'a.b.c', '!!.??', 'e30.e30'])
      expect(await verifyPrincipal(KEY, h, '/mcp', NOW)).toBeNull();
  });

  it('refuses an unknown role or a missing subject', async () => {
    const bad = await signPrincipal(KEY, { ...ada, role: 'owner' as never }, '/mcp', NOW);
    expect(await verifyPrincipal(KEY, bad, '/mcp', NOW)).toBeNull();
    const nobody = await signPrincipal(KEY, { ...ada, sub: '' }, '/mcp', NOW);
    expect(await verifyPrincipal(KEY, nobody, '/mcp', NOW)).toBeNull();
  });

  it('will not sign without a key', async () => {
    await expect(signPrincipal('', ada, '/mcp', NOW)).rejects.toThrow(/PRINCIPAL_KEY/);
  });
});

describe('roles', () => {
  it('orders member below admin', () => {
    expect(atLeast('admin', 'member')).toBe(true);
    expect(atLeast('member', 'admin')).toBe(false);
    expect(atLeast(null, 'member')).toBe(false);
    expect(isRole('member')).toBe(true);
    expect(isRole('viewer')).toBe(false);
  });
});
