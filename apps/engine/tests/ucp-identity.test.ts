/**
 * UCP identity linking through the engine: the authorization server's calls on `StorefrontApi`
 * (consent, the token endpoint, revocation, the shopper's own list), and a linked platform reading
 * a shopper's orders at `/ucp` with the access token. The engine holds every code and token: a
 * forged platform, another platform's token, an expired token, a reused refresh token, a PKCE or
 * redirect_uri mismatch, a code used twice and a scope past what was granted are each refused here.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  authorizationServerMetadata,
  hashLinkSecret,
  hashShopperSecret,
  IDENTITY_LINKING_CAPABILITY,
  LINK_ACCESS_TTL_S,
  LINK_ORDER_READ,
  LINK_USER_TOKEN_HEADER,
  ORDER_CAPABILITY,
  type OrderState,
  type PlatformCaller,
  PRINCIPAL_HEADER,
  pkceChallenge,
  SHOPPER_CALL,
  SHOPPER_GUEST_ID,
  signPlatform,
  UCP_SETTINGS_KEY,
  UCP_VERSION,
} from '@commerceworker/core';
import {
  orders,
  shopperSessions,
  ucpLinkCodes,
  ucpLinkGrants,
  ucpLinkTokens,
  ucpPlatforms,
  workspaceSettings,
} from '@commerceworker/db';
import { eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { sweep } from '../src/retention';
import { StorefrontApi } from '../src/storefront-api';
import { eraseDataSubject, exportDataSubject } from '../src/subjects';
import { ucpProfile } from '../src/ucp/config';
import { signedGuest } from './principal';
import {
  db,
  enableUcp,
  key,
  monitorCheckout,
  ORIGIN,
  pay,
  platform,
  platformKey,
  platformProfile,
  until,
} from './ucp-helpers';

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
// The authorization server answers only where a shopper can sign in: this engine has Email Sending.
const mailer = {
  ...env,
  EMAIL: { send: async () => ({ messageId: 'm' }) },
  EMAIL_FROM: 'shop@mail.test',
} as unknown as Env;
const api = new StorefrontApi(ctx, mailer);
const noMail = new StorefrontApi(ctx, env);
const actor = () =>
  signedGuest({ kind: 'guest', id: SHOPPER_GUEST_ID, name: 'Shopper' }, SHOPPER_CALL);
const VERIFIER = 'v'.repeat(64);
const STOREFRONT = env.STOREFRONT_ORIGIN.replace(/\/+$/, '');

// Order webhooks to a platform are caught; everything else goes out as usual.
const realFetch = globalThis.fetch;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

type P = { caller: PlatformCaller; key: string; client: { id: string; keyHash: string } };

/** A registered platform with a real key (by its hash) whose cached profile lists identity linking. */
async function linkable(id: string, linking = true): Promise<P> {
  const profile = platformProfile();
  const entry = { version: UCP_VERSION, spec: 'https://ucp.dev/x', schema: 'https://ucp.dev/y' };
  if (linking)
    (profile.ucp.capabilities as Record<string, unknown>)[IDENTITY_LINKING_CAPABILITY] = [entry];
  const caller = await platform(id, profile);
  const secret = `cmw_ucp_${id.padEnd(43, 'k')}`;
  const keyHash = await hashLinkSecret(secret);
  await db()
    .update(ucpPlatforms)
    .set({ keyHash, redirectUris: JSON.stringify([`https://${id}.example/callback`]) })
    .where(eq(ucpPlatforms.id, id));
  return { caller, key: secret, client: { id, keyHash } };
}

/** A shopper signed in: the session secret the cookie would hold. */
async function shopper(email: string) {
  const secret = crypto.randomUUID().replaceAll('-', '').repeat(2);
  await db()
    .insert(shopperSessions)
    .values({
      tokenHash: await hashShopperSecret(secret),
      email,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
  return secret;
}

const request = async (p: P, over: Record<string, string> = {}) => ({
  response_type: 'code',
  client_id: p.client.id,
  redirect_uri: `https://${p.client.id}.example/callback`,
  scope: LINK_ORDER_READ,
  state: 'st',
  code_challenge: await pkceChallenge(VERIFIER),
  code_challenge_method: 'S256',
  ...over,
});

/** Consent as `secret`, and the code the platform's redirect carries. */
async function consent(p: P, secret: string, over: Record<string, string> = {}) {
  const done = await api.ucpLinkDecide(await request(p, over), true, secret, await actor());
  if (done.status !== 'redirect') throw new Error(`no redirect: ${JSON.stringify(done)}`);
  return new URL(done.redirect).searchParams.get('code')!;
}

const redeem = async (p: P, code: string, over: Record<string, string> = {}) =>
  api.ucpLinkToken(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `https://${p.client.id}.example/callback`,
      code_verifier: VERIFIER,
      ...over,
    },
    p.client,
  );

type Tokens = { access_token: string; refresh_token: string; expires_in: number; scope: string };
/** A shopper linked to a platform: its tokens. */
async function link(p: P, email: string) {
  const secret = await shopper(email);
  const res = await redeem(p, await consent(p, secret));
  expect(res.status).toBe(200);
  return { secret, tokens: res.body as unknown as Tokens };
}

/** A UCP call as the storefront would forward it for `p`, with a linked shopper's token if given. */
async function ucpGet(p: P, path: string, token?: string) {
  const res = await worker.fetch(
    new Request(`https://engine${path}`, {
      headers: {
        [PRINCIPAL_HEADER]: await signPlatform(platformKey, p.caller, path),
        ...(token ? { [LINK_USER_TOKEN_HEADER]: token } : {}),
      },
    }),
    env,
  );
  // biome-ignore lint/suspicious/noExplicitAny: a response body read as untyped JSON
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, any>,
  };
}

let alpha: P;
let beta: P;
beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
  alpha = await linkable('alpha');
  beta = await linkable('beta');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url.startsWith('https://platform.example/')) return new Response(null, { status: 204 });
    return realFetch(input as RequestInfo, init);
  });
});
afterAll(() => vi.restoreAllMocks());
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('discovery', () => {
  it('serves RFC 8414 metadata for the configured storefront origin, and is off while checkout is', async () => {
    expect(await api.ucpLinkMetadata()).toEqual(authorizationServerMetadata(STOREFRONT));
    const saved = await db()
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.key, UCP_SETTINGS_KEY))
      .get();
    await db().delete(workspaceSettings).where(eq(workspaceSettings.key, UCP_SETTINGS_KEY));
    try {
      expect(await api.ucpLinkMetadata()).toBeNull();
      expect(await api.ucpLinkToken({ grant_type: 'refresh_token' }, alpha.client)).toMatchObject({
        status: 404,
      });
      expect(await api.ucpLinkAuthorize(await request(alpha), null, await actor())).toMatchObject({
        status: 'refused',
        redirect: null,
      });
    } finally {
      await db().insert(workspaceSettings).values(saved!);
    }
  });

  it('is off where a shopper can’t sign in, as the profile is: no Email Sending, no authorization server', async () => {
    const secret = await shopper('nomail@example.com');
    expect(await noMail.ucpLinkMetadata()).toBeNull();
    expect(
      await noMail.ucpLinkAuthorize(await request(alpha), secret, await actor()),
    ).toMatchObject({
      status: 'refused',
      redirect: null,
    });
    expect(
      await noMail.ucpLinkDecide(await request(alpha), true, secret, await actor()),
    ).toMatchObject({ status: 'refused' });
    expect(await noMail.ucpLinkToken({ grant_type: 'refresh_token' }, alpha.client)).toMatchObject({
      status: 404,
    });
    expect(await noMail.ucpLinkRevoke({ token: 'x' }, alpha.client)).toMatchObject({ status: 404 });
  });

  it('lists identity linking in the profile only where a shopper can sign in', async () => {
    const without = (await ucpProfile(env, ORIGIN))!;
    expect(without.ucp.capabilities).not.toHaveProperty([IDENTITY_LINKING_CAPABILITY]);
    const mailer = {
      ...env,
      EMAIL: { send: async () => ({ messageId: 'm' }) },
      EMAIL_FROM: 'shop@mail.test',
    } as unknown as Env;
    const withMail = (await ucpProfile(mailer, ORIGIN))!;
    expect(withMail.ucp.capabilities[IDENTITY_LINKING_CAPABILITY]).toEqual([
      expect.objectContaining({
        config: { scopes: { [LINK_ORDER_READ]: { description: { plain: expect.any(String) } } } },
      }),
    ]);
  });
});

describe('consent', () => {
  it('shows a signed-in shopper who is asking, and sends one who isn’t to sign in', async () => {
    const secret = await shopper('consent@example.com');
    expect(await api.ucpLinkAuthorize(await request(alpha), secret, await actor())).toMatchObject({
      status: 'consent',
      platform: 'alpha',
      email: 'consent@example.com',
    });
    expect(await api.ucpLinkAuthorize(await request(alpha), null, await actor())).toEqual({
      status: 'sign_in',
      platform: 'alpha',
    });
  });

  it('takes the storefront’s word only under an actor it signed for `shopper`', async () => {
    const secret = await shopper('who@example.com');
    const other = await signedGuest({ kind: 'guest', id: SHOPPER_GUEST_ID, name: 'S' }, 'cart:c1');
    for (const signed of [other, 'forged', '']) {
      expect(
        await api.ucpLinkAuthorize(await request(alpha), secret, signed as never),
      ).toMatchObject({
        status: 'sign_in',
      });
      expect(
        await api.ucpLinkDecide(await request(alpha), true, secret, signed as never),
      ).toMatchObject({
        status: 'sign_in',
      });
    }
    // A stored hash is no secret, and neither is a cookie the engine never minted.
    const hash = await hashShopperSecret(secret);
    for (const bad of [hash, 'f'.repeat(64), 'short', null])
      expect(await api.ucpLinkAuthorize(await request(alpha), bad, await actor())).toMatchObject({
        status: 'sign_in',
      });
  });

  it('refuses a forged platform id, a return address it never registered, and a scope it doesn’t offer', async () => {
    const secret = await shopper('refuse@example.com');
    const act = await actor();
    expect(
      await api.ucpLinkAuthorize(await request(alpha, { client_id: 'nobody' }), secret, act),
    ).toMatchObject({
      status: 'refused',
      redirect: null,
    });
    // The same origin and another path is not the registered address: shown, never redirected to.
    expect(
      await api.ucpLinkAuthorize(
        await request(alpha, { redirect_uri: 'https://alpha.example/elsewhere' }),
        secret,
        act,
      ),
    ).toMatchObject({ status: 'refused', redirect: null });
    expect(
      await api.ucpLinkDecide(
        await request(alpha, { redirect_uri: 'https://alpha.example/elsewhere', scope: 'x:y' }),
        true,
        secret,
        act,
      ),
    ).toMatchObject({ status: 'refused', redirect: null });
    // Alpha's own id with beta's return address: never redirected to.
    expect(
      await api.ucpLinkAuthorize(
        await request(alpha, { redirect_uri: 'https://beta.example/callback' }),
        secret,
        act,
      ),
    ).toMatchObject({ status: 'refused', redirect: null });
    expect(
      await api.ucpLinkDecide(
        await request(alpha, { scope: 'dev.ucp.shopping.order:manage' }),
        true,
        secret,
        act,
      ),
    ).toMatchObject({ status: 'refused', error: 'invalid_scope' });
    // A revoked platform can't be linked to.
    const gone = await linkable('revoked-one');
    await db()
      .update(ucpPlatforms)
      .set({ revokedAt: Date.now() })
      .where(eq(ucpPlatforms.id, 'revoked-one'));
    expect(await api.ucpLinkAuthorize(await request(gone), secret, act)).toMatchObject({
      status: 'refused',
      redirect: null,
    });
  });

  it('refuses a platform that has no return address registered', async () => {
    const bare = await linkable('bare');
    await db().update(ucpPlatforms).set({ redirectUris: null }).where(eq(ucpPlatforms.id, 'bare'));
    const secret = await shopper('bare@example.com');
    expect(await api.ucpLinkAuthorize(await request(bare), secret, await actor())).toMatchObject({
      status: 'refused',
      redirect: null,
    });
  });

  it('denies by sending access_denied back, and mints no code', async () => {
    const secret = await shopper('deny@example.com');
    const before = (
      await db().select().from(ucpLinkCodes).where(like(ucpLinkCodes.email, 'deny@%'))
    ).length;
    const done = await api.ucpLinkDecide(await request(alpha), false, secret, await actor());
    expect(done.status).toBe('redirect');
    expect(new URL((done as { redirect: string }).redirect).searchParams.get('error')).toBe(
      'access_denied',
    );
    expect(
      await db().select().from(ucpLinkCodes).where(like(ucpLinkCodes.email, 'deny@%')),
    ).toHaveLength(before);
  });
});

describe('the token endpoint', () => {
  it('redeems a code for tokens the engine stores only as hashes', async () => {
    const { tokens } = await link(alpha, 'hash@example.com');
    expect(tokens).toMatchObject({ expires_in: LINK_ACCESS_TTL_S, scope: LINK_ORDER_READ });
    const rows = await db().select().from(ucpLinkTokens);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
    expect(stored).toContain(await hashLinkSecret(tokens.access_token));
    const codes = JSON.stringify(await db().select().from(ucpLinkCodes));
    expect(codes).not.toMatch(/cmw_ucpc_/);
  });

  it('refuses a forged platform, a key under another platform’s id and a malformed key hash', async () => {
    const secret = await shopper('forge@example.com');
    const code = await consent(alpha, secret);
    const bad = [
      { id: 'alpha', keyHash: 'f'.repeat(64) },
      { id: 'beta', keyHash: alpha.client.keyHash },
      { id: 'alpha', keyHash: 'not-a-hash' },
      { id: 'alpha', keyHash: null },
      null,
    ];
    for (const client of bad) {
      const res = await api.ucpLinkToken(
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'https://alpha.example/callback',
          code_verifier: VERIFIER,
        },
        client as never,
      );
      expect(res).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    }
    // None of those spent the code.
    expect((await redeem(alpha, code)).status).toBe(200);
  });

  it('refuses a PKCE verifier that does not match, and a redirect_uri that differs', async () => {
    const secret = await shopper('pkce@example.com');
    expect(
      (await redeem(alpha, await consent(alpha, secret), { code_verifier: 'w'.repeat(64) })).body,
    ).toMatchObject({
      error: 'invalid_grant',
    });
    expect(
      (
        await redeem(alpha, await consent(alpha, secret), {
          redirect_uri: 'https://alpha.example/other',
        })
      ).body,
    ).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a code used twice, and ends the link the first use started', async () => {
    const { tokens, secret } = await link(alpha, 'twice@example.com');
    void tokens;
    const code = await consent(alpha, secret);
    const first = (await redeem(alpha, code)).body as unknown as Tokens;
    expect((await redeem(alpha, code)).body).toMatchObject({ error: 'invalid_grant' });
    const probe = await ucpGet(alpha, '/ucp/v1/orders/ord_x', first.access_token);
    expect(probe.status).toBe(401);
  });

  it('refuses another platform’s code, and an expired one', async () => {
    const secret = await shopper('other@example.com');
    const code = await consent(alpha, secret);
    expect(
      (await redeem(beta, code, { redirect_uri: 'https://beta.example/callback' })).body,
    ).toMatchObject({ error: 'invalid_grant' });
    const late = await consent(alpha, secret);
    await db()
      .update(ucpLinkCodes)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(ucpLinkCodes.codeHash, await hashLinkSecret(late)));
    expect((await redeem(alpha, late)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('rotates a refresh token, and a spent one used again ends the whole link', async () => {
    const { tokens } = await link(alpha, 'rotate@example.com');
    const refresh = (t: string) =>
      api.ucpLinkToken({ grant_type: 'refresh_token', refresh_token: t }, alpha.client);
    const next = (await refresh(tokens.refresh_token)).body as unknown as Tokens;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await refresh(tokens.refresh_token)).body).toMatchObject({ error: 'invalid_grant' });
    // The family is dead: the newest refresh token and access token go with it.
    expect((await refresh(next.refresh_token)).body).toMatchObject({ error: 'invalid_grant' });
    expect((await ucpGet(alpha, '/ucp/v1/orders/ord_x', next.access_token)).status).toBe(401);
  });

  it('refuses a refresh token another platform presents, and ends the link', async () => {
    const { tokens } = await link(alpha, 'steal@example.com');
    const res = await api.ucpLinkToken(
      { grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
      beta.client,
    );
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
    expect((await ucpGet(alpha, '/ucp/v1/orders/ord_x', tokens.access_token)).status).toBe(401);
  });

  it('never widens a scope on refresh', async () => {
    const { tokens } = await link(alpha, 'scope@example.com');
    const res = await api.ucpLinkToken(
      {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        scope: `${LINK_ORDER_READ} dev.ucp.shopping.order:manage`,
      },
      alpha.client,
    );
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_scope' } });
  });

  it('revokes at the platform’s request, for its own tokens only', async () => {
    const { tokens } = await link(alpha, 'revoke@example.com');
    expect(await api.ucpLinkRevoke({ token: tokens.access_token }, beta.client)).toMatchObject({
      status: 200,
    });
    // Another platform's revocation changed nothing: the token is still good for its own.
    expect((await ucpGet(alpha, '/ucp/v1/orders/ord_x', tokens.access_token)).status).not.toBe(401);
    expect(await api.ucpLinkRevoke({ token: tokens.refresh_token }, alpha.client)).toMatchObject({
      status: 200,
    });
    expect((await ucpGet(alpha, '/ucp/v1/orders/ord_x', tokens.access_token)).status).toBe(401);
    expect(
      await api.ucpLinkRevoke(
        { token: tokens.refresh_token },
        { id: 'alpha', keyHash: 'f'.repeat(64) },
      ),
    ).toMatchObject({ status: 401 });
  });
});

describe('what the shopper sees on /account', () => {
  it('lists their links and unlinks one, which ends its tokens; not another shopper’s', async () => {
    const a = await link(alpha, 'mine@example.com');
    await link(alpha, 'theirs@example.com');
    const found = await api.shopperLinks(a.secret, await actor());
    expect(found?.email).toBe('mine@example.com');
    const list = found!.links;
    expect(list).toEqual([
      expect.objectContaining({ platform: 'alpha', scopes: [LINK_ORDER_READ] }),
    ]);
    const other = await shopper('intruder@example.com');
    expect(await api.shopperUnlink(other, list[0]!.id, await actor())).toBe(false);
    expect((await api.shopperLinks(other, await actor()))?.links).toEqual([]);
    expect((await ucpGet(alpha, '/ucp/v1/orders/ord_x', a.tokens.access_token)).status).not.toBe(
      401,
    );
    expect(await api.shopperUnlink(a.secret, list[0]!.id, await actor())).toBe(true);
    expect((await ucpGet(alpha, '/ucp/v1/orders/ord_x', a.tokens.access_token)).status).toBe(401);
    expect((await api.shopperLinks(a.secret, await actor()))?.links).toEqual([]);
    // Nothing without the storefront's signature or a session.
    expect(await api.shopperLinks(a.secret, 'forged' as never)).toBeNull();
    expect(await api.shopperLinks(await hashShopperSecret(a.secret), await actor())).toBeNull();
  });

  it('keeps one link per platform', async () => {
    const first = await link(alpha, 'one@example.com');
    const second = await redeem(alpha, await consent(alpha, first.secret));
    expect(second.status).toBe(200);
    expect((await api.shopperLinks(first.secret, await actor()))?.links).toHaveLength(1);
    expect((await ucpGet(alpha, '/ucp/v1/orders/ord_x', first.tokens.access_token)).status).toBe(
      401,
    );
  });
});

describe('a linked platform reading orders', () => {
  const place = async (p: P, buyerEmail: string) => {
    const buyer = { ...monitorCheckout.buyer, email: buyerEmail };
    const created = await worker.fetch(
      new Request('https://engine/ucp/v1/checkout-sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: await signPlatform(
            platformKey,
            p.caller,
            '/ucp/v1/checkout-sessions',
          ),
        },
        body: JSON.stringify({ ...monitorCheckout, buyer }),
      }),
      env,
    );
    const c = (await created.json()) as { id: string };
    const path = `/ucp/v1/checkout-sessions/${c.id}/complete`;
    const done = await worker.fetch(
      new Request(`https://engine${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key(),
          [PRINCIPAL_HEADER]: await signPlatform(platformKey, p.caller, path),
        },
        body: JSON.stringify(pay()),
      }),
      env,
    );
    const orderId = ((await done.json()) as { order: { id: string } }).order.id;
    await until(
      async () => ((await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState).order,
      'the order',
    );
    return orderId;
  };

  it('reads orders placed under the shopper’s address, from any platform’s checkout, and no one else’s', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const { tokens } = await link(alpha, 'reader@example.com');
    const mine = await place(alpha, 'reader@example.com');
    const byBeta = await place(beta, 'READER@example.com');
    const others = await place(alpha, 'someone-else@example.com');
    const path = (id: string) => `/ucp/v1/orders/${id}`;

    const own = await ucpGet(alpha, path(mine), tokens.access_token);
    expect(own).toMatchObject({ status: 200, body: { id: mine } });
    // A checkout another platform ran, under the shopper's address, is the shopper's too.
    expect((await ucpGet(alpha, path(byBeta), tokens.access_token)).body).toMatchObject({
      id: byBeta,
    });
    // Without the token, as before: only what the platform placed itself.
    expect(
      (await ucpGet(alpha, path(byBeta))).body.errors?.[0]?.code ??
        (await ucpGet(alpha, path(byBeta))).body.messages?.[0]?.code,
    ).toBe('not_found');
    expect((await ucpGet(alpha, path(mine))).body).toMatchObject({ id: mine });
    // Another shopper's order, which alpha placed itself, is not readable as this shopper: the token narrows.
    const denied = await ucpGet(alpha, path(others), tokens.access_token);
    expect(JSON.stringify(denied.body)).toContain('not_found');
    expect(JSON.stringify(denied.body)).not.toContain('someone-else');
    // As the account's order page asks: an erased order is no one's, and answers as an unknown id does.
    await db().update(orders).set({ erasedAt: Date.now() }).where(eq(orders.id, mine));
    const erased = await ucpGet(alpha, path(mine), tokens.access_token);
    expect(JSON.stringify(erased.body)).toContain('not_found');
    expect(JSON.stringify(erased.body)).toEqual(
      JSON.stringify((await ucpGet(alpha, path('ord_unknown'), tokens.access_token)).body),
    );
  });

  it('refuses another platform’s token, a forged, expired, refresh or revoked one, with a challenge', async () => {
    const { tokens } = await link(alpha, 'refuse-orders@example.com');
    const path = '/ucp/v1/orders/ord_any';
    const wrong = await ucpGet(beta, path, tokens.access_token);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(wrong.headers.get('cache-control')).toBe('no-store');
    for (const bad of [
      `cmw_ucpa_${'z'.repeat(43)}`,
      tokens.refresh_token,
      'garbage',
      `cmw_ucpc_${'z'.repeat(43)}`,
    ])
      expect((await ucpGet(alpha, path, bad)).status).toBe(401);
    const hash = await hashLinkSecret(tokens.access_token);
    await db()
      .update(ucpLinkTokens)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(ucpLinkTokens.tokenHash, hash));
    expect((await ucpGet(alpha, path, tokens.access_token)).status).toBe(401);
  });

  it('is refused a platform that doesn’t list identity linking, and one that has been revoked', async () => {
    const quiet = await linkable('quiet', false);
    const secret = await shopper('quiet@example.com');
    const res = await redeem(quiet, await consent(quiet, secret));
    const t = res.body as unknown as Tokens;
    expect((await ucpGet(quiet, '/ucp/v1/orders/ord_any', t.access_token)).status).toBe(401);
    // Linked while it listed the capability, then revoked: its key and so its tokens stop working.
    const gone = await linkable('soon-gone');
    const g = (await link(gone, 'gone@example.com')).tokens;
    await db()
      .update(ucpPlatforms)
      .set({ revokedAt: Date.now() })
      .where(eq(ucpPlatforms.id, 'soon-gone'));
    expect(
      (
        await api.ucpLinkToken(
          { grant_type: 'refresh_token', refresh_token: g.refresh_token },
          gone.client,
        )
      ).status,
    ).toBe(401);
  });

  it('reads over MCP as it does over REST', async () => {
    const { tokens } = await link(alpha, 'mcp@example.com');
    const call = async (token?: string) =>
      worker.fetch(
        new Request('https://engine/ucp/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [PRINCIPAL_HEADER]: await signPlatform(platformKey, alpha.caller, '/ucp/mcp'),
            ...(token ? { [LINK_USER_TOKEN_HEADER]: token } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'get_order',
              arguments: {
                meta: { 'ucp-agent': { profile: alpha.caller.profileUrl } },
                id: 'ord_any',
              },
            },
          }),
        }),
        env,
      );
    expect((await call(`cmw_ucpa_${'z'.repeat(43)}`)).status).toBe(401);
    expect((await call(tokens.access_token)).status).toBe(200);
  });
});

describe('data subject requests and retention', () => {
  it('exports the links without a token, and erases them with their tokens', async () => {
    const { tokens } = await link(alpha, 'subject@example.com');
    const out = await exportDataSubject(env, 'subject@example.com');
    expect(out.ucpLinks).toEqual([
      expect.objectContaining({ platformId: 'alpha', scope: LINK_ORDER_READ }),
    ]);
    expect(JSON.stringify(out)).not.toContain(tokens.access_token);
    expect(JSON.stringify(out)).not.toContain(await hashLinkSecret(tokens.access_token));
    expect(await eraseDataSubject(env, 'subject@example.com')).toMatchObject({
      ok: true,
      ucpLinks: 1,
    });
    expect((await ucpGet(alpha, '/ucp/v1/orders/ord_any', tokens.access_token)).status).toBe(401);
    expect(
      await db().select().from(ucpLinkGrants).where(eq(ucpLinkGrants.email, 'subject@example.com')),
    ).toEqual([]);
  });

  it('prunes links a month after they ended, with their tokens', async () => {
    const { tokens } = await link(alpha, 'prune@example.com');
    await api.ucpLinkRevoke({ token: tokens.refresh_token }, alpha.client);
    const hash = await hashLinkSecret(tokens.access_token);
    expect(
      await db().select().from(ucpLinkTokens).where(eq(ucpLinkTokens.tokenHash, hash)),
    ).toHaveLength(1);
    const swept = await sweep(env, Date.now() + 31 * 86_400_000);
    expect(swept.ucpLinks?.grants).toBeGreaterThanOrEqual(1);
    expect(
      await db().select().from(ucpLinkTokens).where(eq(ucpLinkTokens.tokenHash, hash)),
    ).toEqual([]);
  });
});

void ORDER_CAPABILITY;
