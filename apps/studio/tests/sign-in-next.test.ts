import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

// Sign-in's redirects to where it was asked to go back to. The invitation page keeps its token in
// a cookie scoped to `/invite`; a client-side navigation would load `/invite.data`, outside that
// path, and the page would read no token. So landing there after signing in (by password, after
// two-factor, after confirming an SSO link, or already signed in) must be a document load: React
// Router's `X-Remix-Reload-Document` redirect. Elsewhere, a plain client redirect.

let signedIn: unknown = null;
let signInResult: { cookie: string; twoFactor: boolean } | null = null;
let secondFactor: string[] | null = null;
class Throttled extends Error {}
vi.mock('~/lib/auth.server', () => ({
  authEnabled: async () => true,
  principal: async () => signedIn,
  signIn: async () => signInResult,
  Throttled,
  clearChallengeCookie: 'cw_2fa=; Max-Age=0',
  pendingChallenge: async () => ({ email: 'ann@example.com' }),
  verifySecondFactor: async () => secondFactor,
  signInToLink: async () => ({ twoFactor: false, cookie: '', signIn: async () => 'cw_session=s' }),
}));
vi.mock('~/lib/settings.server', () => ({ ssoOnlyInEffect: async () => false }));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn() }));
vi.mock('~/lib/sso.server', () => ({
  ssoConfig: () => null,
  clearLinkCookie: 'cw_sso_link=; Max-Age=0',
  LINK_PATH: '/login/sso/link',
  pendingSsoLink: async () => ({
    user: { id: 'usr_ann', email: 'ann@example.com', name: 'Ann', role: 'member' },
  }),
  finishSsoLink: async () => true,
}));

const readInvite = vi.fn(async (_r: Request, token: string) =>
  token === TOKEN
    ? {
        page: {
          email: 'ann@example.com',
          role: 'member',
          inviter: 'Ada',
          spaces: [],
          expiresAt: '2026-11-08T00:00:00.000Z',
        },
      }
    : null,
);
vi.mock('~/lib/invites.server', () => ({
  readInvite,
  checkThrottle: async () => {},
  acceptSignedIn: vi.fn(),
  joinWithPassword: vi.fn(),
  InviteError: class extends Error {},
}));
const TOKEN = `cwi_${'c'.repeat(43)}`;

const login = await import('~/routes/login');
const invite = await import('~/routes/invite');
const twoFactor = await import('~/routes/login-two-factor');
const ssoLink = await import('~/routes/login-sso-link');
const { redirectToNext } = await import('~/lib/next-path');

const RELOAD = 'X-Remix-Reload-Document';
const post = (path: string, fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request(`https://acme.commerceworker.com${path}`, { method: 'POST', body });
};
const get = (path: string) => new Request(`https://acme.commerceworker.com${path}`);
/** What a loader or action answered, returned or thrown. */
const answer = async (run: () => Promise<unknown>) => {
  try {
    return (await run()) as Response;
  } catch (thrown) {
    return thrown as Response;
  }
};
const args = (request: Request) => ({ request, params: {}, context: {} }) as never;

beforeEach(() => {
  signedIn = null;
  signInResult = { cookie: 'cw_session=s', twoFactor: false };
  secondFactor = ['cw_session=s'];
});

describe('back to the invitation page after signing in', () => {
  it('a password sign-in is a document redirect to /invite, and a plain one elsewhere', async () => {
    const res = await answer(() =>
      login.action(args(post('/login?next=%2Finvite', { email: 'a@b.c', password: 'p' }))),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/invite');
    expect(res.headers.get(RELOAD)).toBe('true');
    expect(res.headers.get('set-cookie')).toContain('cw_session=s');

    const other = await answer(() =>
      login.action(args(post('/login?next=%2Fcontent', { email: 'a@b.c', password: 'p' }))),
    );
    expect(other.headers.get('location')).toBe('/content');
    expect(other.headers.get(RELOAD)).toBeNull();
  });

  it('a password needing two-factor goes to the code step (no cookie read there), then a document redirect', async () => {
    signInResult = { cookie: 'cw_2fa=c', twoFactor: true };
    const first = await answer(() =>
      login.action(args(post('/login?next=%2Finvite', { email: 'a@b.c', password: 'p' }))),
    );
    expect(first.headers.get('location')).toBe('/login/two-factor?next=%2Finvite');
    const code = await answer(() =>
      twoFactor.action(args(post('/login/two-factor?next=%2Finvite', { code: '123456' }))),
    );
    expect(code.headers.get('location')).toBe('/invite');
    expect(code.headers.get(RELOAD)).toBe('true');
  });

  it('confirming an SSO link with a password lands there as a document too', async () => {
    const res = await answer(() =>
      ssoLink.action(args(post('/login/sso/link?next=%2Finvite', { password: 'p' }))),
    );
    expect(res.headers.get('location')).toBe('/invite');
    expect(res.headers.get(RELOAD)).toBe('true');
  });

  it('someone already signed in is sent on as a document', async () => {
    signedIn = { kind: 'user', id: 'usr_ann', name: 'Ann', role: 'member' };
    for (const loader of [login.loader, twoFactor.loader]) {
      const res = await answer(() => loader(args(get('/login?next=%2Finvite'))));
      expect(res.headers.get('location')).toBe('/invite');
      expect(res.headers.get(RELOAD)).toBe('true');
    }
  });

  it('matches only the invitation page itself', () => {
    for (const path of ['/invite', '/invite?x=1'])
      expect(redirectToNext(path).headers.get(RELOAD)).toBe('true');
    for (const path of ['/invites', '/invite-team', '/', '/team'])
      expect(redirectToNext(path).headers.get(RELOAD)).toBeNull();
  });
});

describe('the invitation page', () => {
  it('moves the token from the link into its cookie, then reads it from there', async () => {
    const first = await answer(() =>
      invite.loader({ request: get(`/invite/${TOKEN}`), params: { token: TOKEN } } as never),
    );
    expect(first.headers.get('location')).toBe('/invite');
    expect(first.headers.get('set-cookie')).toContain(`cw_invite=${TOKEN}; Path=/invite;`);
    const page = (await invite.loader({
      request: new Request('https://acme.commerceworker.com/invite', {
        headers: { cookie: `cw_invite=${TOKEN}` },
      }),
      params: {},
    } as never)) as { state: string };
    expect(page.state).toBe('open');
    expect(readInvite).toHaveBeenLastCalledWith(expect.any(Request), TOKEN);
    // Without the cookie (as `/invite.data` would be), there is nothing to read.
    const bare = (await invite.loader({ request: get('/invite'), params: {} } as never)) as {
      state: string;
    };
    expect(bare.state).toBe('invalid');
  });

  it('sends no referrer elsewhere, yet keeps its own form posts same-origin', () => {
    const h = invite.headers({
      actionHeaders: new Headers(),
      loaderHeaders: new Headers(),
    } as never) as Headers;
    // `no-referrer` would make the browser post with `Origin: null`, refused as cross-site.
    expect(h.get('referrer-policy')).toBe('same-origin');
    expect(h.get('cache-control')).toBe('no-store');
  });
});
