import { describe, expect, it, vi } from 'vitest';

/**
 * What the OAuth provider writes to `OAUTH_KV`, which the nightly export copies as it is
 * (workers/kv-backup.ts): the backup's claim that it holds no secret that works as a credential
 * rests on this. A confidential client is registered and a person approves it; the code is traded
 * for tokens and the refresh token is used once. None of the secrets that were handed out may be in
 * any stored key or value.
 */
const kv = new Map<string, string>();
const env = {
  PRINCIPAL_KEY: 'web-test-key',
  OAUTH_KV: {
    get: async (k: string, type?: string | { type?: string }) => {
      const v = kv.get(k) ?? null;
      const json = type === 'json' || (typeof type === 'object' && type.type === 'json');
      return v && json ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => {
      kv.set(k, v);
    },
    delete: async (k: string) => {
      kv.delete(k);
    },
    list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
      keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  },
};

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ fetch: async () => Response.json({}), dropA2aPushes: async () => ({}) }),
}));
vi.mock('~/lib/audit.server', () => ({ audit: async () => {}, clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/auth.server', () => ({
  apiPrincipal: vi.fn(),
  grantPrincipal: vi.fn(),
  Throttled: class extends Error {},
  TokenExpired: class extends Error {},
  setupDue: () => null,
}));

const { oauthApi, oauthFetch } = await import('~/lib/oauth.server');
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;

describe('what the OAuth provider stores', () => {
  it('holds no client secret, authorization code, access token or refresh token', async () => {
    const oauth = oauthApi(new Request('https://app.test/oauth/authorize'));
    const client = await oauth.createClient({
      redirectUris: ['https://client.test/cb'],
      tokenEndpointAuthMethod: 'client_secret_post',
    });
    expect(client.clientSecret).toBeTruthy();
    const verifier = 'v'.repeat(64);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const { redirectTo } = await oauth.completeAuthorization({
      request: {
        responseType: 'code',
        clientId: client.clientId,
        redirectUri: 'https://client.test/cb',
        scope: ['viewer'],
        state: 's',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        resource: 'https://app.test/api/v1',
      },
      userId: 'usr_1',
      metadata: {},
      scope: ['viewer'],
      props: { kind: 'user', id: 'usr_1', role: 'viewer', secretProp: 'a-person-private-prop' },
    });
    const code = new URL(redirectTo).searchParams.get('code')!;
    const token = (form: Record<string, string>) =>
      oauthFetch(
        new Request('https://app.test/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: client.clientId,
            client_secret: client.clientSecret!,
            ...form,
          }),
        }),
        env as never,
        ctx,
      );
    const issued = (await (
      await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://client.test/cb',
        code_verifier: verifier,
      })
    ).json()) as { access_token: string; refresh_token: string };
    const refreshed = (await (
      await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token })
    ).json()) as { access_token: string; refresh_token: string };
    expect(refreshed.refresh_token).toBeTruthy();

    // The secrets by their pieces too: a token is `<user>:<grant>:<random>`, and the random part is what works.
    const secrets = [
      client.clientSecret!,
      code,
      code.split(':').at(-1)!,
      issued.access_token,
      issued.access_token.split(':').at(-1)!,
      issued.refresh_token,
      issued.refresh_token.split(':').at(-1)!,
      refreshed.access_token.split(':').at(-1)!,
      refreshed.refresh_token.split(':').at(-1)!,
      verifier,
    ];
    const stored = [...kv].map(([k, v]) => `${k}\n${v}`).join('\n');
    expect(kv.size).toBeGreaterThan(3);
    for (const s of secrets) expect(stored, `stored a secret: ${s.slice(0, 8)}…`).not.toContain(s);
    // The props are encrypted, not stored as written.
    expect(stored).not.toContain('a-person-private-prop');
    expect([...kv.keys()].some((k) => k.startsWith('grant:'))).toBe(true);
  });
});
