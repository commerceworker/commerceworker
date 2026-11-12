import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import {
  authorizationServerMetadata,
  businessProfile,
  hashLinkSecret,
  IDENTITY_LINKING_CAPABILITY,
  identityLinkingConfig,
  LINK_ORDER_READ,
  LINK_PATHS,
  LINK_SCOPES,
  LINK_SECRET,
  linkRedirectProblem,
  linkRedirectShapeProblem,
  linkScopes,
  negotiate,
  newLinkSecret,
  ORDER_CAPABILITY,
  parsePlatformProfile,
  pkceChallenge,
  pkceMatches,
  UCP_CAPABILITIES,
  UCP_VERSION,
} from '../src';

// The published schemas (tests/fixtures/ucp), for checking what we serve.
const ROOT = join(__dirname, 'fixtures/ucp/schemas');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.json') ? [p] : [];
  });
const schemas = files(ROOT).map((p) => JSON.parse(readFileSync(p, 'utf8')) as { $id: string });
function conformsTo(ref: string, value: unknown) {
  const v = new Validator({ $ref: `https://ucp.dev/schemas/${ref}` }, '2020-12', false);
  for (const s of schemas) v.addSchema(s as never, s.$id);
  const r = v.validate(value);
  return r.valid ? [] : r.errors.map((e) => `${e.instanceLocation}: ${e.error}`);
}
const LINKING =
  'common/identity_linking.json#/$defs/dev.ucp.common.identity_linking/business_schema';
const ORIGIN = 'https://shop.example';

describe('the profile’s identity_linking capability', () => {
  const profile = businessProfile(ORIGIN, [], [], true);
  const entry = profile.ucp.capabilities[IDENTITY_LINKING_CAPABILITY]![0]!;

  it('conforms to the vendored identity_linking business schema, and so does the whole profile', () => {
    expect(conformsTo(LINKING, entry)).toEqual([]);
    expect(conformsTo('profile.json#/$defs/business_schema', profile)).toEqual([]);
  });

  it('declares exactly the scopes this business offers, each as the schema words a scope token', () => {
    expect(Object.keys(entry.config!.scopes)).toEqual(Object.keys(LINK_SCOPES));
    expect(Object.keys(entry.config!.scopes)).toEqual(['dev.ucp.shopping.order:read']);
    for (const policy of Object.values(entry.config!.scopes))
      expect(policy).toEqual({ description: { plain: expect.any(String) } });
  });

  it('is absent where a shopper can’t sign in, and the rest of the profile is the same', () => {
    const off = businessProfile(ORIGIN, [], []);
    expect(off.ucp.capabilities).not.toHaveProperty([IDENTITY_LINKING_CAPABILITY]);
    expect(conformsTo('profile.json#/$defs/business_schema', off)).toEqual([]);
    const { [IDENTITY_LINKING_CAPABILITY]: _, ...rest } = profile.ucp.capabilities;
    expect(rest).toEqual(off.ucp.capabilities);
  });

  it('is not valid without its scopes', () => {
    const { config: _config, ...bare } = entry;
    expect(conformsTo(LINKING, bare)).not.toEqual([]);
    expect(conformsTo(LINKING, { ...entry, config: {} })).not.toEqual([]);
  });

  it('names the version and the schema it is declared by, and is no extension', () => {
    expect(entry).toMatchObject({
      version: UCP_VERSION,
      schema: `https://ucp.dev/${UCP_VERSION}/schemas/common/identity_linking.json`,
    });
    expect(UCP_CAPABILITIES[IDENTITY_LINKING_CAPABILITY]).not.toHaveProperty('extends');
  });

  it('is activated by a platform that lists it, on its own', () => {
    const doc = (caps: Record<string, unknown>) => ({
      ucp: { version: UCP_VERSION, capabilities: caps },
    });
    const e = { version: UCP_VERSION, spec: 'https://ucp.dev/x', schema: 'https://ucp.dev/y' };
    const p = parsePlatformProfile(
      doc({ [IDENTITY_LINKING_CAPABILITY]: [e], [ORDER_CAPABILITY]: [e] }),
    );
    if ('problem' in p) throw new Error(p.problem);
    const n = negotiate(p);
    expect(n.ok && [...n.capabilities.keys()].sort()).toEqual(
      [IDENTITY_LINKING_CAPABILITY, ORDER_CAPABILITY].sort(),
    );
    const orders = parsePlatformProfile(doc({ [ORDER_CAPABILITY]: [e] }));
    if ('problem' in orders) throw new Error(orders.problem);
    const m = negotiate(orders);
    expect(m.ok && m.capabilities.has(IDENTITY_LINKING_CAPABILITY)).toBe(false);
  });

  it('builds the same config the profile carries', () => {
    expect(identityLinkingConfig()).toEqual(entry.config!);
  });
});

describe('the authorization server’s metadata', () => {
  const meta = authorizationServerMetadata(`${ORIGIN}/`);

  it('names the issuer without a trailing slash and the three endpoints under it', () => {
    expect(meta).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}${LINK_PATHS.authorize}`,
      token_endpoint: `${ORIGIN}${LINK_PATHS.token}`,
      revocation_endpoint: `${ORIGIN}${LINK_PATHS.revoke}`,
    });
  });

  it('offers the code grant with PKCE S256 only, and refresh, with the scopes the profile lists', () => {
    expect(meta.response_types_supported).toEqual(['code']);
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.scopes_supported).toEqual(Object.keys(LINK_SCOPES));
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    // No implicit grant, no client credentials, no password, no plain PKCE, no registration.
    expect(JSON.stringify(meta)).not.toMatch(
      /implicit|password|client_credentials|"plain"|registration/,
    );
  });

  it('keeps clear of the staff server’s paths', () => {
    for (const p of Object.values(LINK_PATHS)) expect(p).not.toMatch(/^\/oauth\//);
  });
});

describe('scopes', () => {
  it('takes only scopes this business offers, as a set', () => {
    expect(linkScopes(LINK_ORDER_READ)).toEqual([LINK_ORDER_READ]);
    expect(linkScopes(`${LINK_ORDER_READ} ${LINK_ORDER_READ}`)).toEqual([LINK_ORDER_READ]);
    for (const bad of [
      '',
      '  ',
      undefined,
      7,
      'dev.ucp.shopping.order:manage',
      'dev.ucp.shopping.checkout:create',
      `${LINK_ORDER_READ} dev.ucp.shopping.order:manage`,
      'dev.ucp.shopping.order:read\n',
      'x'.repeat(600),
    ])
      expect(linkScopes(bad)).toBeNull();
  });
});

describe('PKCE', () => {
  it('makes RFC 7636 appendix B’s challenge from its verifier', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await pkceChallenge(verifier)).toBe(challenge);
    expect(await pkceMatches(verifier, challenge)).toBe(true);
  });

  it('matches only the verifier the challenge was made from, and refuses a malformed one', async () => {
    const verifier = 'v'.repeat(43);
    const challenge = await pkceChallenge(verifier);
    expect(await pkceMatches('w'.repeat(43), challenge)).toBe(false);
    expect(await pkceMatches(challenge, challenge)).toBe(false);
    // Too short, too long, or a character a verifier can't hold: refused before it is hashed.
    for (const bad of ['v'.repeat(42), 'v'.repeat(129), `${'v'.repeat(42)}!`, ''])
      expect(await pkceMatches(bad, challenge)).toBe(false);
  });
});

describe('secrets', () => {
  it('are 256 random bits, tagged by kind, and no kind passes for another or for a platform key', () => {
    const [code, access, refresh] = [
      newLinkSecret('code'),
      newLinkSecret('access'),
      newLinkSecret('refresh'),
    ];
    expect(LINK_SECRET.code.test(code)).toBe(true);
    expect(LINK_SECRET.access.test(access)).toBe(true);
    expect(LINK_SECRET.refresh.test(refresh)).toBe(true);
    expect(LINK_SECRET.access.test(refresh)).toBe(false);
    expect(LINK_SECRET.refresh.test(code)).toBe(false);
    for (const s of [code, access, refresh]) expect(s.startsWith('cmw_ucp_')).toBe(false);
    expect(newLinkSecret('access')).not.toBe(access);
  });

  it('are stored as their SHA-256', async () => {
    const hash = await hashLinkSecret('abc');
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('where a platform may be sent', () => {
  const registered = ['https://agent.example/callback', 'https://agent.example/oauth/cb?tenant=1'];

  it('accepts only a string registered for the platform, exactly', () => {
    for (const ok of registered) expect(linkRedirectProblem(ok, registered)).toBeNull();
  });

  it('refuses the same origin with another path, query, slash, case or port', () => {
    for (const near of [
      'https://agent.example/other',
      'https://agent.example/callback/',
      'https://agent.example/callback?x=1',
      'https://agent.example/callbackx',
      'https://agent.example/oauth/cb?tenant=2',
      'https://agent.example/Callback',
      'https://AGENT.example/callback ',
      'https://agent.example:8443/callback',
      'https://agent.example/callback/../callback',
    ])
      expect(linkRedirectProblem(near, registered), near).not.toBeNull();
  });

  it('refuses every address when none is registered, and any that is not https or has a fragment or credentials', () => {
    expect(linkRedirectProblem('https://agent.example/callback', [])).toMatch(/no return address/);
    for (const bad of [
      'http://agent.example/cb',
      'https://agent.example/cb#x',
      'https://agent.example/cb#',
      'https://u:p@agent.example/cb',
      'agent://callback',
      'javascript:alert(1)',
      '//agent.example/cb',
      '/cb',
      '',
      `https://agent.example/${'a'.repeat(2000)}`,
    ]) {
      // Not even a registered copy of one is allowed.
      expect(linkRedirectProblem(bad, [bad]), bad).not.toBeNull();
      expect(linkRedirectShapeProblem(bad), bad).not.toBeNull();
    }
    expect(linkRedirectShapeProblem('https://agent.example/cb?a=1')).toBeNull();
  });
});
