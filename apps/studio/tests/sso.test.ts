import { InMemoryAdminAuth } from '@commerceworker/test-kit';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SSO,
  decideSso,
  describeSso,
  parseDomains,
  readSsoSettings,
  type SsoSettings,
} from '~/lib/sso';

const env: Record<string, string> = {
  OIDC_ISSUER: 'https://idp.test',
  OIDC_CLIENT_ID: 'client-1',
  OIDC_CLIENT_SECRET: 's3cret',
  PRINCIPAL_KEY: 'test-principal-key-0123456789abcdef',
};

let store = new InMemoryAdminAuth();
const audit = vi.fn();
let settings = DEFAULT_SSO;
vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/wire.server', () => ({ adminAuth: () => store }));
vi.mock('~/lib/audit.server', () => ({ audit }));
vi.mock('~/lib/settings.server', () => ({ ssoSettings: async () => settings }));
vi.mock('~/lib/auth.server', () => ({
  cookie: (request: Request, name: string) =>
    request.headers
      .get('cookie')
      ?.split(/;\s*/)
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1),
  forgetUserCount: vi.fn(),
  startSession: vi.fn(async () => '__Host-cw_session=new'),
}));

const {
  finishSsoLink,
  pendingSsoLink,
  SsoError,
  signInWithSso,
  ssoConfig,
  startSso,
  verifyCallback,
} = await import('~/lib/sso.server');

describe('SSO settings', () => {
  it('reads domains from an admin’s text, dropping junk and repeats', () => {
    expect(parseDomains('Example.com, @acme.co.uk\nexample.com  not a domain, a@b')).toEqual([
      'example.com',
      'acme.co.uk',
    ]);
  });

  it('never lets someone new join as an admin', () => {
    expect(
      readSsoSettings(JSON.stringify({ jitRole: 'admin', domains: ['x.com'] })).jitRole,
    ).toBeNull();
    expect(readSsoSettings(JSON.stringify({ jitRole: 'member', domains: ['x.com'] })).jitRole).toBe(
      'member',
    );
    expect(
      readSsoSettings(JSON.stringify({ jitRole: 'operator', domains: ['x.com'] })).jitRole,
    ).toBeNull();
  });

  it('reads stored settings, with anything unreadable at its default', () => {
    expect(readSsoSettings(null)).toEqual(DEFAULT_SSO);
    expect(readSsoSettings('{oops')).toEqual(DEFAULT_SSO);
    expect(
      readSsoSettings(JSON.stringify({ jitRole: 'owner', domains: ['x.com', 'bad'], ssoOnly: 1 })),
    ).toEqual({ jitRole: null, domains: ['x.com'], ssoOnly: false });
    expect(describeSso({ jitRole: 'member', domains: ['x.com'], ssoOnly: true })).toBe(
      'new people join as member from x.com; SSO only',
    );
  });
});

describe('decideSso', () => {
  const id = { sub: 'sub-1', email: 'ann@acme.com', name: 'Ann' };
  const open: SsoSettings = { jitRole: 'member', domains: ['acme.com'], ssoOnly: false };
  const person = (over = {}) => ({ id: 'usr_1', externalSub: null, disabledAt: null, ...over });

  it('signs in the person linked to the subject, unless they are disabled', () => {
    expect(decideSso(id, person({ externalSub: 'sub-1' }), undefined, DEFAULT_SSO)).toEqual({
      kind: 'existing',
      userId: 'usr_1',
    });
    expect(decideSso(id, person({ disabledAt: 1 }), undefined, open).kind).toBe('refuse');
  });

  it('links a teammate by email once, never over another identity', () => {
    expect(decideSso(id, undefined, person(), DEFAULT_SSO)).toEqual({
      kind: 'link',
      userId: 'usr_1',
    });
    expect(decideSso(id, undefined, person({ externalSub: 'sub-2' }), open)).toEqual({
      kind: 'refuse',
      reason: 'email linked to another identity',
    });
    expect(decideSso({ ...id, email: null }, undefined, undefined, open)).toEqual({
      kind: 'refuse',
      reason: 'no verified email',
    });
  });

  it('adds someone new only when admins allow it and the domain is listed', () => {
    expect(decideSso(id, undefined, undefined, open)).toEqual({
      kind: 'create',
      role: 'member',
      email: 'ann@acme.com',
    });
    expect(decideSso(id, undefined, undefined, DEFAULT_SSO)).toEqual({
      kind: 'refuse',
      reason: 'not on the team',
    });
    expect(
      decideSso({ ...id, email: 'eve@acme.com.evil.test' }, undefined, undefined, open),
    ).toEqual({ kind: 'refuse', reason: 'domain not allowed' });
  });
});

describe('linking an identity to someone with a password', () => {
  const identity = { sub: 'idp|ann', email: 'ann@acme.com', name: 'Ann' };
  const ann = {
    id: 'usr_1',
    email: 'ann@acme.com',
    name: 'Ann',
    role: 'admin',
    externalSub: null,
    disabledAt: null,
  };
  const request = (cookie?: string) =>
    new Request('https://app.test/login/sso/link', cookie ? { headers: { cookie } } : {});

  beforeEach(() => {
    store = new InMemoryAdminAuth({ users: [ann] });
    settings = DEFAULT_SSO;
    audit.mockReset();
  });

  it('links someone without a password at once', async () => {
    expect(await signInWithSso(request(), identity)).toEqual({ session: '__Host-cw_session=new' });
    expect((await store.user(ann.id))?.externalSub).toBe(identity.sub);
  });

  it('fails closed when the passwordless link loses a race', async () => {
    vi.spyOn(store, 'linkSub').mockResolvedValueOnce(false);
    await expect(signInWithSso(request(), identity)).rejects.toThrow(/no longer available/);
    expect(audit).not.toHaveBeenCalled();
  });

  it('waits for the password and links only the matching person once', async () => {
    const user = { ...store.users.get(ann.id)!, passwordHash: 'pbkdf2$…' };
    store.users.set(ann.id, user);
    const outcome = await signInWithSso(request(), identity);
    expect((await store.user(ann.id))?.externalSub).toBeNull();
    if (!('confirmLink' in outcome)) throw new Error('expected a pending link');
    expect(outcome.confirmLink).toMatch(
      /^__Host-cw_sso_link=sl1\..*; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
    );
    const cookie = outcome.confirmLink.split(';')[0]!;
    const pending = await pendingSsoLink(request(cookie));
    expect(pending).toMatchObject({
      sub: identity.sub,
      user: { id: user.id, passwordHash: user.passwordHash },
    });
    expect(pending?.user).not.toHaveProperty('totpSecret');
    for (const change of [{ externalSub: 'other' }, { passwordHash: null }, { disabledAt: 5 }]) {
      store.users.set(ann.id, { ...user, ...change });
      expect(await pendingSsoLink(request(cookie))).toBeNull();
    }
    store.users.set(ann.id, user);
    expect(await pendingSsoLink(request('__Host-cw_sso_link=sl1.forged.sig'))).toBeNull();
    const bob = { kind: 'user' as const, id: 'usr_2', name: 'Bob', role: 'admin' as const };
    expect(await finishSsoLink(request(cookie), bob)).toBe(false);
    const caller = { ...bob, id: ann.id, name: ann.name };
    await store.addSsoUser({
      id: 'usr_3',
      email: 'other@example.com',
      name: 'Other',
      role: 'member',
      externalSub: identity.sub,
      createdAt: 1,
    });
    expect(await finishSsoLink(request(cookie), caller)).toBe(false);
    store.users.delete('usr_3');
    vi.spyOn(store, 'linkSub').mockResolvedValueOnce(false);
    expect(await finishSsoLink(request(cookie), caller)).toBe(false);
    expect(await finishSsoLink(request(cookie), caller)).toBe(true);
    expect(await finishSsoLink(request(cookie), caller)).toBe(false);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('creates only member accounts when JIT sign-in permits the verified domain', async () => {
    settings = { jitRole: 'member', domains: ['acme.com'], ssoOnly: false };
    const result = await signInWithSso(request(), {
      sub: 'new-sub',
      email: 'new@acme.com',
      name: 'New',
    });
    expect(result).toEqual({ session: '__Host-cw_session=new' });
    expect(await store.userBySub('new-sub')).toMatchObject({
      email: 'new@acme.com',
      role: 'member',
      passwordHash: null,
    });
  });
});

describe('the OpenID Connect flow', () => {
  let key: CryptoKey;
  let jwk: Record<string, unknown>;
  const calls: Request[] = [];
  let claims: Record<string, unknown> = {};
  let signWith: { audience?: string; issuer?: string } = {};

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey as CryptoKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
    claims = {};
    signWith = {};
  });

  /** The provider: discovery, keys, and a token endpoint that signs `claims` with the flow's nonce. */
  function provider(nonce: () => string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request.clone() as Request);
        const url = new URL(request.url);
        if (url.pathname === '/.well-known/openid-configuration')
          return Response.json({
            issuer: 'https://idp.test',
            authorization_endpoint: 'https://idp.test/authorize',
            token_endpoint: 'https://idp.test/token',
            jwks_uri: 'https://idp.test/keys',
          });
        if (url.pathname === '/keys') return Response.json({ keys: [jwk] });
        if (url.pathname === '/token') {
          const idToken = await new SignJWT({
            nonce: nonce(),
            email: 'ann@acme.com',
            email_verified: true,
            name: 'Ann',
            ...claims,
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setSubject('sub-1')
            .setIssuer(signWith.issuer ?? 'https://idp.test')
            .setAudience(signWith.audience ?? 'client-1')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(key);
          return Response.json({ id_token: idToken, token_type: 'Bearer' });
        }
        return new Response('not found', { status: 404 });
      }),
    );
  }

  /** Starts a flow, then comes back the way the provider would redirect the browser. */
  async function roundTrip(
    tamper: (q: URLSearchParams) => void = () => {},
    reauth = false,
    forge: (flow: Record<string, unknown>) => void = () => {},
  ) {
    const c = ssoConfig()!;
    let flowNonce = '';
    provider(() => flowNonce);
    const start = await startSso(new Request('https://app.test/login/sso'), c, '/orders', reauth);
    const auth = new URL(start.location);
    flowNonce = auth.searchParams.get('nonce')!;
    const q = new URLSearchParams({ code: 'code-1', state: auth.searchParams.get('state')! });
    tamper(q);
    // A forger can read the sealed flow and edit it, but not sign the result.
    const [name, value] = start.cookie.split(';')[0]!.split(/=(.*)/s);
    const [version, payload, sig] = value!.split('.');
    const sealed = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/')));
    const before = JSON.stringify(sealed);
    forge(sealed.flow);
    const edited =
      JSON.stringify(sealed) === before
        ? value
        : `${version}.${btoa(JSON.stringify(sealed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${sig}`;
    const back = new Request(`https://app.test/login/sso/callback?${q}`, {
      headers: { cookie: `${name}=${edited}` },
    });
    return { auth, result: verifyCallback(back, c) };
  }

  it('sends a PKCE, state and nonce request and signs in who the token vouches for', async () => {
    const { auth, result } = await roundTrip();
    expect(auth.origin + auth.pathname).toBe('https://idp.test/authorize');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('redirect_uri')).toBe('https://app.test/login/sso/callback');
    expect(await result).toEqual({
      identity: { sub: 'sub-1', email: 'ann@acme.com', name: 'Ann' },
      next: '/orders',
      reauthAt: null,
    });
    // An ordinary sign-in doesn't make the provider ask again.
    expect(auth.searchParams.has('prompt')).toBe(false);
    expect(auth.searchParams.has('max_age')).toBe(false);
    const token = calls.find((r) => r.url.endsWith('/token'))!;
    expect(token.headers.get('authorization')).toBe(`Basic ${btoa('client-1:s3cret')}`);
    const body = new URLSearchParams(await token.text());
    expect(body.get('code_verifier')).toBeTruthy();
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('refuses another state, a token for another client or issuer, and a stale nonce', async () => {
    await expect((await roundTrip((q) => q.set('state', 'forged'))).result).rejects.toThrow(
      /state mismatch/,
    );
    signWith = { audience: 'someone-else' };
    await expect((await roundTrip()).result).rejects.toBeInstanceOf(SsoError);
    signWith = { issuer: 'https://evil.test' };
    await expect((await roundTrip()).result).rejects.toBeInstanceOf(SsoError);
    signWith = {};
    claims = { nonce: 'replayed' };
    await expect((await roundTrip()).result).rejects.toThrow(/nonce mismatch/);
  });

  it('asks the provider to sign them in again for a step-up, and takes only a fresh sign-in', async () => {
    const now = Math.floor(Date.now() / 1000);
    claims = { auth_time: now };
    const { auth, result } = await roundTrip(undefined, true);
    expect(auth.searchParams.get('prompt')).toBe('login');
    expect(auth.searchParams.get('max_age')).toBe('0');
    expect((await result).reauthAt).toBeGreaterThan(0);
    // The provider answered from a sign-in before the step-up began, or didn't say when.
    claims = { auth_time: now - 30 * 60 };
    await expect((await roundTrip(undefined, true)).result).rejects.toThrow(/sign them in again/);
    claims = {};
    await expect((await roundTrip(undefined, true)).result).rejects.toThrow(/sign them in again/);
  });

  it('refuses a flow cookie the browser edited, or brought back after it expired', async () => {
    claims = { auth_time: Math.floor(Date.now() / 1000) - 30 * 60 };
    const earlier = (f: Record<string, unknown>) => {
      f.reauth = { at: 0 };
    };
    // A step-up whose start was moved back, and an ordinary sign-in made into one.
    await expect((await roundTrip(undefined, true, earlier)).result).rejects.toThrow(
      /no sign-in in progress/,
    );
    await expect((await roundTrip(undefined, false, earlier)).result).rejects.toThrow(
      /no sign-in in progress/,
    );
    claims = {};
    const { result } = await roundTrip(undefined, false, () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    });
    await expect(result).rejects.toThrow(/no sign-in in progress/);
    vi.restoreAllMocks();
  });

  it('keeps an unverified email from matching anyone', async () => {
    claims = { email_verified: false };
    expect((await (await roundTrip()).result).identity.email).toBeNull();
    // A token that leaves the claim out vouches for nothing, unless the deployment trusts its
    // provider's addresses (Entra ID: OIDC_TRUST_EMAIL).
    claims = { email_verified: undefined };
    expect((await (await roundTrip()).result).identity.email).toBeNull();
    env.OIDC_TRUST_EMAIL = 'true';
    try {
      expect((await (await roundTrip()).result).identity.email).toBe('ann@acme.com');
      // Entra's own word that the address's domain isn't verified still counts.
      claims = { email_verified: undefined, xms_edov: false };
      expect((await (await roundTrip()).result).identity.email).toBeNull();
    } finally {
      delete env.OIDC_TRUST_EMAIL;
    }
  });

  it('refuses a callback with no flow in this browser, or a provider error', async () => {
    const c = ssoConfig()!;
    await expect(
      verifyCallback(new Request('https://app.test/login/sso/callback?code=x&state=y'), c),
    ).rejects.toThrow(/no sign-in in progress/);
    await expect((await roundTrip((q) => q.set('error', 'access_denied'))).result).rejects.toThrow(
      /access_denied/,
    );
  });
});
