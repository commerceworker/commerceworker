import {
  hashLinkSecret,
  LINK_ACCESS_TTL_S,
  LINK_CODE_TTL_MS,
  LINK_GRANT_TTL_MS,
  LINK_ORDER_READ,
  pkceChallenge,
} from '@commerceworker/core';
import { InMemoryUcpLinks, InMemoryUcpStore } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  decideLink,
  describeLink,
  type LinkPorts,
  linkedShopper,
  linkToken,
  pruneUcpLinks,
  revokeLinkToken,
  shopperLinks,
  unlinkShopper,
} from '../src/commerce';

const now = 1_800_000_000_000;
const ISSUER = 'https://shop.example';
const VERIFIER = 'v'.repeat(64);
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const ada = 'ada@example.com';

function setup() {
  const links = new InMemoryUcpLinks();
  const platforms = new InMemoryUcpStore({
    platforms: [
      {
        id: 'ucp_a',
        name: 'Agent A',
        keyHash: KEY_A,
        profileUrl: 'https://a.example/.well-known/ucp',
        redirectUris: ['https://a.example/callback', 'https://a.example/callback?tenant=7'],
      },
      {
        id: 'ucp_b',
        name: 'Agent B',
        keyHash: KEY_B,
        profileUrl: 'https://b.example/.well-known/ucp',
        redirectUris: ['https://b.example/callback'],
      },
      {
        id: 'ucp_gone',
        name: 'Gone',
        keyHash: 'c'.repeat(64),
        profileUrl: 'https://gone.example/p',
        revokedAt: 1,
      },
    ],
  });
  const ports: LinkPorts = { links, platforms, issuer: ISSUER };
  return { ports, links, platforms };
}

const A = { id: 'ucp_a', keyHash: KEY_A };
const B = { id: 'ucp_b', keyHash: KEY_B };

/** A well-formed authorization request from platform A; `over` replaces or (with undefined) drops parameters. */
async function request(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: 'ucp_a',
    redirect_uri: 'https://a.example/callback',
    scope: LINK_ORDER_READ,
    state: 'xyz',
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    ...over,
  };
  return Object.fromEntries(
    Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

/** Approves a request as Ada and returns the code the platform's redirect carries. */
async function approved(ports: LinkPorts, params?: Record<string, string>, at = now) {
  const out = await decideLink(ports, params ?? (await request()), true, ada, at);
  if (out.status !== 'redirect') throw new Error(`not approved: ${JSON.stringify(out)}`);
  const url = new URL(out.redirect);
  return { url, code: url.searchParams.get('code')! };
}

const redeem = (
  ports: LinkPorts,
  code: string,
  over: Record<string, string> = {},
  client = A,
  at = now,
) =>
  linkToken(
    ports,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://a.example/callback',
      code_verifier: VERIFIER,
      ...over,
    },
    client,
    at,
  );

/** A completed link: the tokens platform A holds. */
async function linked() {
  const s = setup();
  const { code } = await approved(s.ports);
  const res = await redeem(s.ports, code);
  expect(res.status).toBe(200);
  const body = res.body as { access_token: string; refresh_token: string };
  return { ...s, access: body.access_token, refresh: body.refresh_token };
}

describe('the authorization request', () => {
  it('shows a signed-in shopper the platform, their address and each scope in words', async () => {
    const { ports } = setup();
    expect(await describeLink(ports, await request(), ada)).toEqual({
      status: 'consent',
      platform: 'Agent A',
      email: ada,
      scopes: [
        { scope: LINK_ORDER_READ, description: 'See the orders you placed with this store.' },
      ],
      redirectUri: 'https://a.example/callback',
    });
  });

  it('sends a shopper who isn’t signed in to sign in, and a request that is bad nowhere', async () => {
    const { ports } = setup();
    expect(await describeLink(ports, await request(), null)).toEqual({
      status: 'sign_in',
      platform: 'Agent A',
    });
    // A bad request is refused before anyone is asked to sign in for it.
    expect(await describeLink(ports, await request({ scope: 'x:y' }), null)).toMatchObject({
      status: 'refused',
      error: 'invalid_scope',
    });
  });

  it('shows, never redirects, an unknown or revoked platform and a return address it didn’t register', async () => {
    const { ports } = setup();
    const refused = { status: 'refused', error: 'invalid_request', redirect: null };
    expect(await describeLink(ports, await request({ client_id: 'ucp_none' }), ada)).toMatchObject(
      refused,
    );
    expect(await describeLink(ports, await request({ client_id: 'ucp_gone' }), ada)).toMatchObject(
      refused,
    );
    expect(await describeLink(ports, await request({ client_id: undefined }), ada)).toMatchObject(
      refused,
    );
    for (const redirect_uri of [
      undefined,
      'http://a.example/callback',
      'https://evil.example/callback',
      'https://a.example.evil.example/callback',
      'https://a.example:8443/callback',
      'https://a.example/callback#frag',
      // The same origin is not enough: only the exact registered strings.
      'https://a.example/other',
      'https://a.example/callback/',
      'https://a.example/callback?tenant=8',
      'https://a.example/callbackx',
      'https://A.example/callback ',
      'https://user:pw@a.example/callback',
      'myapp://callback',
      'not a url',
    ])
      expect(await describeLink(ports, await request({ redirect_uri }), ada)).toMatchObject(
        refused,
      );
  });

  it('refuses a platform with no return address registered, and a registered address of another platform', async () => {
    const { ports, platforms } = setup();
    await platforms.addPlatform({
      id: 'ucp_bare',
      name: 'Bare',
      profileUrl: 'https://bare.example/p',
      keyPrefix: 'cmw_ucp_b',
      keyHash: 'd'.repeat(64),
      redirectUris: [],
      createdAt: 0,
      createdBy: null,
    });
    const bare = await describeLink(
      ports,
      await request({ client_id: 'ucp_bare', redirect_uri: 'https://bare.example/callback' }),
      ada,
    );
    expect(bare).toMatchObject({ status: 'refused', redirect: null });
    // B's registered address is no address of A's.
    expect(
      await describeLink(ports, await request({ redirect_uri: 'https://b.example/callback' }), ada),
    ).toMatchObject({ status: 'refused', redirect: null });
  });

  it('never sends an error anywhere but a registered address', async () => {
    const { ports } = setup();
    const bad = [
      { redirect_uri: 'https://a.example/other', response_type: 'token' },
      { redirect_uri: 'https://a.example/other', scope: 'x:y' },
      { redirect_uri: 'https://evil.example/cb', code_challenge: undefined },
    ];
    for (const over of bad) {
      const view = await describeLink(ports, await request(over), ada);
      expect(view).toMatchObject({ status: 'refused', redirect: null });
    }
  });

  it('sends every other fault back to the platform’s own address, with its state and the issuer', async () => {
    const { ports } = setup();
    const cases: [Record<string, string | undefined>, string][] = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ scope: undefined }, 'invalid_scope'],
      [{ scope: 'dev.ucp.shopping.order:manage' }, 'invalid_scope'],
      [{ scope: `${LINK_ORDER_READ} dev.ucp.shopping.order:manage` }, 'invalid_scope'],
      [{ resource: 'https://other.example/ucp' }, 'invalid_target'],
      [{ state: 's'.repeat(513) }, 'invalid_request'],
    ];
    for (const [over, error] of cases) {
      const view = await describeLink(ports, await request(over), ada);
      expect(view, JSON.stringify(over)).toMatchObject({ status: 'refused', error });
      const to = new URL((view as { redirect: string }).redirect);
      expect(to.origin + to.pathname).toBe('https://a.example/callback');
      expect(to.searchParams.get('error')).toBe(error);
      expect(to.searchParams.get('iss')).toBe(ISSUER);
    }
    const view = await describeLink(ports, await request({ response_type: 'token' }), ada);
    expect(new URL((view as { redirect: string }).redirect).searchParams.get('state')).toBe('xyz');
  });

  it('takes this business’s own UCP endpoint as the resource', async () => {
    const { ports } = setup();
    const view = await describeLink(ports, await request({ resource: `${ISSUER}/ucp` }), ada);
    expect(view.status).toBe('consent');
  });
});

describe('the shopper’s answer', () => {
  it('denies by sending access_denied back, and stores nothing', async () => {
    const { ports } = setup();
    const out = await decideLink(ports, await request(), false, ada, now);
    expect(out.status).toBe('redirect');
    const url = new URL((out as { redirect: string }).redirect);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('xyz');
    expect(url.searchParams.has('code')).toBe(false);
  });

  it('approves with a one-time code and the state, keeping the query the platform’s address had', async () => {
    const { ports } = setup();
    const { url, code } = await approved(
      ports,
      await request({ redirect_uri: 'https://a.example/callback?tenant=7' }),
    );
    expect(url.searchParams.get('tenant')).toBe('7');
    expect(url.searchParams.get('state')).toBe('xyz');
    expect(url.searchParams.get('iss')).toBe(ISSUER);
    expect(code).toMatch(/^cmw_ucpc_[A-Za-z0-9_-]{43}$/);
  });

  it('checks the request again, and approves only for a signed-in shopper', async () => {
    const { ports } = setup();
    expect(await decideLink(ports, await request(), true, null, now)).toEqual({
      status: 'sign_in',
      platform: 'Agent A',
    });
    // A forged form: a return address on another origin is refused, not redirected to.
    expect(
      await decideLink(
        ports,
        await request({ redirect_uri: 'https://evil.example/cb' }),
        true,
        ada,
        now,
      ),
    ).toMatchObject({ status: 'refused', redirect: null });
    expect(
      await decideLink(
        ports,
        await request({ scope: 'dev.ucp.shopping.order:manage' }),
        true,
        ada,
        now,
      ),
    ).toMatchObject({ status: 'refused', error: 'invalid_scope' });
  });

  it('keeps no code in the clear', async () => {
    const { ports, links } = setup();
    const { code } = await approved(ports);
    expect(await links.spendCode(code, now)).toBeNull();
    expect(await links.spendCode(await hashLinkSecret(code), now)).toMatchObject({ kind: 'spent' });
  });
});

describe('redeeming a code', () => {
  it('gives a platform that authenticates opaque tokens, stored as hashes, for the scope asked', async () => {
    const { ports, links, access, refresh } = await linked();
    expect(access).toMatch(/^cmw_ucpa_[A-Za-z0-9_-]{43}$/);
    expect(refresh).toMatch(/^cmw_ucpr_[A-Za-z0-9_-]{43}$/);
    expect(await links.access(access, now)).toBeNull();
    expect(await links.refresh(refresh)).toBeNull();
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 1)).toMatchObject({
      email: ada,
    });
    const res = await (async () => {
      const s = setup();
      const { code } = await approved(s.ports);
      return redeem(s.ports, code);
    })();
    expect(res.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: LINK_ACCESS_TTL_S,
      scope: LINK_ORDER_READ,
    });
  });

  it('refuses a code used twice, and ends the link the first use started', async () => {
    const { ports } = setup();
    const { code } = await approved(ports);
    const first = await redeem(ports, code);
    const { access_token: access } = first.body as { access_token: string };
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 1)).not.toBeNull();
    const second = await redeem(ports, code, {}, A, now + 2);
    expect(second).toEqual({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'The code was already used.' },
    });
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 3)).toBeNull();
  });

  it('makes no link when a replay lands between spending the code and creating the link', async () => {
    const { ports, links } = setup();
    const { code } = await approved(ports);
    // The first redemption has spent the code but not yet written its link; the replay arrives.
    const hash = await hashLinkSecret(code);
    const first = await links.spendCode(hash, now);
    expect(first?.kind).toBe('spent');
    expect((await redeem(ports, code, {}, A, now + 1)).body).toMatchObject({
      error: 'invalid_grant',
    });
    // The first redemption goes on to write: nothing is made, and nothing was handed out.
    const c = (first as { code: { grantId: string } }).code;
    expect(
      await links.createGrant(
        {
          id: c.grantId,
          platformId: 'ucp_a',
          email: ada,
          scope: LINK_ORDER_READ,
          createdAt: now,
          expiresAt: now + 1e6,
          revokedAt: null,
        },
        [],
        now + 2,
        hash,
      ),
    ).toBe(false);
    expect(await links.grant(c.grantId)).toBeNull();
    expect(await shopperLinks(ports, ada, now + 3)).toEqual([]);
  });

  it('refuses a PKCE verifier that isn’t the one the request was made with, and spends the code', async () => {
    for (const code_verifier of ['w'.repeat(64), 'short', '']) {
      const { ports } = setup();
      const { code } = await approved(ports);
      expect((await redeem(ports, code, { code_verifier })).body).toMatchObject({
        error: 'invalid_grant',
      });
      // The right verifier now finds the code spent.
      expect((await redeem(ports, code)).status).toBe(400);
    }
  });

  it('refuses a missing PKCE verifier', async () => {
    const { ports } = setup();
    const { code } = await approved(ports);
    const res = await linkToken(
      ports,
      { grant_type: 'authorization_code', code, redirect_uri: 'https://a.example/callback' },
      A,
      now,
    );
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a redirect_uri other than the request’s', async () => {
    const { ports } = setup();
    const { code } = await approved(ports);
    expect(
      (await redeem(ports, code, { redirect_uri: 'https://a.example/other' })).body,
    ).toMatchObject({ error: 'invalid_grant' });
    const { code: again } = await approved(ports);
    expect((await redeem(ports, again, { redirect_uri: '' })).body).toMatchObject({
      error: 'invalid_grant',
    });
  });

  it('refuses a code after its minute, and one that was never issued', async () => {
    const { ports } = setup();
    const { code } = await approved(ports);
    expect((await redeem(ports, code, {}, A, now + LINK_CODE_TTL_MS)).body).toMatchObject({
      error: 'invalid_grant',
    });
    expect((await redeem(ports, `cmw_ucpc_${'x'.repeat(43)}`)).body).toMatchObject({
      error: 'invalid_grant',
    });
    expect((await redeem(ports, 'garbage')).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses another platform’s code, even with that platform’s own valid key', async () => {
    const { ports } = setup();
    const { code } = await approved(ports);
    const res = await redeem(ports, code, { redirect_uri: 'https://a.example/callback' }, B);
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
    // And the code is spent: the platform it was for can't use it now either.
    expect((await redeem(ports, code)).status).toBe(400);
  });

  it('authenticates the platform first: a forged or revoked platform gets nothing and spends nothing', async () => {
    const { ports } = setup();
    const { code } = await approved(ports);
    const unauthorized = { status: 401, body: { error: 'invalid_client' } };
    expect(await redeem(ports, code, {}, { id: 'ucp_a', keyHash: 'f'.repeat(64) })).toMatchObject(
      unauthorized,
    );
    expect(await redeem(ports, code, {}, { id: 'ucp_a', keyHash: null as never })).toMatchObject(
      unauthorized,
    );
    // A real key, named as another platform.
    expect(await redeem(ports, code, {}, { id: 'ucp_b', keyHash: KEY_A })).toMatchObject(
      unauthorized,
    );
    // A revoked platform's key.
    expect(
      await redeem(ports, code, {}, { id: 'ucp_gone', keyHash: 'c'.repeat(64) }),
    ).toMatchObject(unauthorized);
    // None of that spent the code.
    expect((await redeem(ports, code)).status).toBe(200);
  });

  it('takes a client that names no id, by its key alone', async () => {
    const { ports } = setup();
    const { code } = await approved(ports);
    expect((await redeem(ports, code, {}, { id: null, keyHash: KEY_A })).status).toBe(200);
  });

  it('refuses a grant type it doesn’t offer', async () => {
    const { ports } = setup();
    for (const grant_type of ['client_credentials', 'password', '']) {
      expect((await linkToken(ports, { grant_type }, A, now)).body).toMatchObject({
        error: 'unsupported_grant_type',
      });
    }
  });

  it('ends the link at its absolute end, however often it is refreshed', async () => {
    const t = await linked();
    const end = now + LINK_GRANT_TTL_MS;
    let refresh = t.refresh;
    let at = now;
    // Each refresh issues a refresh token good for 30 days: keep refreshing to the link's last days.
    while (at + 29 * 86_400_000 < end - 1000) {
      at += 29 * 86_400_000;
      const res = await linkToken(
        t.ports,
        { grant_type: 'refresh_token', refresh_token: refresh },
        A,
        at,
      );
      expect(res.status).toBe(200);
      refresh = (res.body as { refresh_token: string }).refresh_token;
    }
    // Refreshed with a second to live, the new tokens end with the link.
    const last = await linkToken(
      t.ports,
      { grant_type: 'refresh_token', refresh_token: refresh },
      A,
      end - 1000,
    );
    expect(last.status).toBe(200);
    expect((last.body as { expires_in: number }).expires_in).toBe(1);
    const { refresh_token } = last.body as { refresh_token: string };
    expect(
      (await linkToken(t.ports, { grant_type: 'refresh_token', refresh_token }, A, end)).body,
    ).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('an access token', () => {
  it('speaks for the shopper at the platform it was issued to, for its scope, until it expires', async () => {
    const { ports, access } = await linked();
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 1)).toMatchObject({
      email: ada,
    });
    expect(
      await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + LINK_ACCESS_TTL_S * 1000),
    ).toBeNull();
  });

  it('is refused when another platform presents it', async () => {
    const { ports, access } = await linked();
    expect(await linkedShopper(ports, access, 'ucp_b', LINK_ORDER_READ, now + 1)).toBeNull();
  });

  it('is refused when it is forged, malformed, a refresh token or has the wrong scope', async () => {
    const { ports, refresh, links } = await linked();
    for (const token of [
      `cmw_ucpa_${'z'.repeat(43)}`,
      'cmw_ucpa_short',
      '',
      null,
      undefined,
      7,
      refresh,
    ])
      expect(await linkedShopper(ports, token, 'ucp_a', LINK_ORDER_READ, now + 1)).toBeNull();
    // A link that holds another scope only.
    const other = 'cmw_ucpa_' + 'q'.repeat(43);
    await links.createGrant(
      {
        id: 'lg_other',
        platformId: 'ucp_a',
        email: 'grace@example.com',
        scope: 'dev.ucp.shopping.order:manage',
        createdAt: now,
        expiresAt: now + 1e6,
        revokedAt: null,
      },
      [
        {
          tokenHash: await hashLinkSecret(other),
          grantId: 'lg_other',
          kind: 'access',
          scope: 'dev.ucp.shopping.order:manage',
          createdAt: now,
          expiresAt: now + 1e5,
        },
      ],
      now,
    );
    expect(await linkedShopper(ports, other, 'ucp_a', LINK_ORDER_READ, now + 1)).toBeNull();
  });
});

describe('refreshing', () => {
  const refreshWith = (
    ports: LinkPorts,
    refresh_token: string,
    over: Record<string, string> = {},
    client = A,
    at = now + 10,
  ) => linkToken(ports, { grant_type: 'refresh_token', refresh_token, ...over }, client, at);

  it('issues the next pair and spends the refresh token', async () => {
    const { ports, access, refresh } = await linked();
    const res = await refreshWith(ports, refresh);
    expect(res.status).toBe(200);
    const next = res.body as { access_token: string; refresh_token: string };
    expect(next.access_token).not.toBe(access);
    expect(next.refresh_token).not.toBe(refresh);
    expect(
      await linkedShopper(ports, next.access_token, 'ucp_a', LINK_ORDER_READ, now + 11),
    ).toMatchObject({ email: ada });
    // The old access token lives out its own short life; the old refresh token is spent.
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 11)).not.toBeNull();
  });

  it('treats a spent refresh token presented again as theft: the whole link ends', async () => {
    const { ports, refresh } = await linked();
    const rotated = (await refreshWith(ports, refresh)).body as {
      access_token: string;
      refresh_token: string;
    };
    expect((await refreshWith(ports, refresh, {}, A, now + 20)).body).toMatchObject({
      error: 'invalid_grant',
      error_description: 'The refresh token was already used.',
    });
    // The newest tokens go with it, whoever holds them.
    expect(
      await linkedShopper(ports, rotated.access_token, 'ucp_a', LINK_ORDER_READ, now + 21),
    ).toBeNull();
    expect((await refreshWith(ports, rotated.refresh_token, {}, A, now + 22)).body).toMatchObject({
      error: 'invalid_grant',
    });
  });

  it('ends the link when another platform presents its refresh token, and gives that platform nothing', async () => {
    const { ports, access, refresh } = await linked();
    const res = await refreshWith(ports, refresh, {}, B);
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 11)).toBeNull();
  });

  it('refuses a scope beyond what was granted, and rotates nothing', async () => {
    const { ports, refresh } = await linked();
    for (const scope of [
      'dev.ucp.shopping.order:manage',
      `${LINK_ORDER_READ} dev.ucp.shopping.order:manage`,
      '',
    ])
      expect((await refreshWith(ports, refresh, { scope })).body).toMatchObject({
        error: 'invalid_scope',
      });
    // The refresh token is still good.
    expect((await refreshWith(ports, refresh, { scope: LINK_ORDER_READ })).status).toBe(200);
  });

  it('refuses an access token, a forged token, an expired one and one of a revoked link', async () => {
    const { ports, access, refresh } = await linked();
    for (const t of [access, `cmw_ucpr_${'z'.repeat(43)}`, 'x', ''])
      expect((await refreshWith(ports, t)).body).toMatchObject({ error: 'invalid_grant' });
    expect((await refreshWith(ports, refresh, {}, A, now + 31 * 86_400_000)).body).toMatchObject({
      error: 'invalid_grant',
    });
    await revokeLinkToken(ports, { token: refresh }, A, now + 5);
    expect((await refreshWith(ports, refresh)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('needs the platform’s own key', async () => {
    const { ports, refresh } = await linked();
    expect(
      (await refreshWith(ports, refresh, {}, { id: 'ucp_a', keyHash: 'f'.repeat(64) })).status,
    ).toBe(401);
  });
});

describe('revocation', () => {
  it('ends the link and every token of it, whether it is given the access or the refresh token', async () => {
    for (const which of ['access', 'refresh'] as const) {
      const t = await linked();
      const token = which === 'access' ? t.access : t.refresh;
      expect(await revokeLinkToken(t.ports, { token }, A, now + 1)).toEqual({
        status: 200,
        body: {},
      });
      expect(await linkedShopper(t.ports, t.access, 'ucp_a', LINK_ORDER_READ, now + 2)).toBeNull();
      expect(
        (
          await linkToken(
            t.ports,
            { grant_type: 'refresh_token', refresh_token: t.refresh },
            A,
            now + 2,
          )
        ).body,
      ).toMatchObject({ error: 'invalid_grant' });
    }
  });

  it('answers 200 for a token it doesn’t know, and leaves another platform’s token alone', async () => {
    const { ports, access } = await linked();
    expect(
      (await revokeLinkToken(ports, { token: `cmw_ucpa_${'z'.repeat(43)}` }, A, now)).status,
    ).toBe(200);
    expect((await revokeLinkToken(ports, {}, A, now)).status).toBe(200);
    expect((await revokeLinkToken(ports, { token: access }, B, now)).status).toBe(200);
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 1)).not.toBeNull();
  });

  it('needs the platform to authenticate', async () => {
    const { ports, access } = await linked();
    expect(
      (
        await revokeLinkToken(
          ports,
          { token: access },
          { id: 'ucp_a', keyHash: 'f'.repeat(64) },
          now,
        )
      ).status,
    ).toBe(401);
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 1)).not.toBeNull();
  });
});

describe('what the shopper sees', () => {
  it('lists their links, and unlinks one, which ends its tokens; another shopper’s can’t be', async () => {
    const { ports, access, links } = await linked();
    const mine = await shopperLinks(ports, ada, now + 1);
    expect(mine).toEqual([
      expect.objectContaining({ platform: 'ucp_a', scopes: [LINK_ORDER_READ], since: now }),
    ]);
    expect(await shopperLinks(ports, 'grace@example.com', now + 1)).toEqual([]);
    expect(await unlinkShopper(ports, 'grace@example.com', mine[0]!.id, now + 2)).toBe(false);
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 3)).not.toBeNull();
    expect(await unlinkShopper(ports, ada, mine[0]!.id, now + 4)).toBe(true);
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 5)).toBeNull();
    expect(await shopperLinks(ports, ada, now + 6)).toEqual([]);
    void links;
  });

  it('keeps one link per platform: linking again ends the first', async () => {
    const { ports, access } = await linked();
    const { code } = await approved(ports, undefined, now + 100);
    expect((await redeem(ports, code, {}, A, now + 101)).status).toBe(200);
    expect(await linkedShopper(ports, access, 'ucp_a', LINK_ORDER_READ, now + 102)).toBeNull();
    expect(await shopperLinks(ports, ada, now + 102)).toHaveLength(1);
  });
});

describe('the sweep', () => {
  it('deletes codes a day after they expired and links a month after they ended', async () => {
    const { ports, access } = await linked();
    const { code } = await approved(ports);
    const early = await pruneUcpLinks(ports, now + 86_400_000);
    // The first access token (15 minutes) is long expired by then; nothing else is old enough.
    expect(early).toEqual({ codes: 0, grants: 0, tokens: 1 });
    const day = await pruneUcpLinks(ports, now + LINK_CODE_TTL_MS + 86_400_001);
    expect(day.codes).toBe(2);
    expect(code).toBeTruthy();
    // The link is live for months more, so it stays.
    expect(await shopperLinks(ports, ada, now + 86_400_000)).toHaveLength(1);
    expect(access).toBeTruthy();
    const late = await pruneUcpLinks(ports, now + LINK_GRANT_TTL_MS + 31 * 86_400_000);
    expect(late.grants).toBe(1);
  });
});
