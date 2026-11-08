/**
 * Accepting an invitation: whoever holds the link sees who invited them and to what, then either
 * creates their account (a password, or single sign-on where the workspace uses it) or, signed in
 * as the invited address, accepts it onto their account. The link works once
 * (`invites.server.ts`); every way it can fail reads the same, and failures are throttled per
 * address like sign-in. Public: it is how someone with no account gets one.
 *
 * The link is `/invite/<token>`. Its first request moves the token into a cookie scoped to this
 * page (and the SSO callback) and redirects to `/invite`, so the token is in no later URL: not the
 * form posts, not sign-in's `?next=/invite`, not single sign-on's round trip (`lib/invites.ts`).
 * The forms post as whole documents (`reloadDocument`): a `/invite.data` fetch is outside the
 * cookie's path. The page is never cached and sends no referrer to another origin.
 */

import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { data, Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Mark } from '~/components/mark';
import { principal, startSession, Throttled } from '~/lib/auth.server';
import {
  forgetInviteToken,
  INVITE_INVALID,
  inviteTokenFrom,
  isInviteToken,
  keepInviteToken,
  withCookies,
} from '~/lib/invites';
import {
  acceptSignedIn,
  checkThrottle,
  InviteError,
  joinWithPassword,
  readInvite,
} from '~/lib/invites.server';
import { ssoOnlyInEffect } from '~/lib/settings.server';
import { ssoConfig } from '~/lib/sso.server';
import type { Route } from './+types/invite';

export const meta = () => [{ title: 'Accept your invitation · CommerceWorker' }];

/**
 * Out of caches, and no referrer to another origin. `same-origin`, not `no-referrer`: under
 * `no-referrer` a browser posts the page's forms with `Origin: null`, which the cross-site check
 * (`origin.ts`) refuses.
 */
export const headers: Route.HeadersFunction = ({ actionHeaders, loaderHeaders }) => {
  const h = new Headers(actionHeaders);
  h.set('cache-control', 'no-store');
  h.set('referrer-policy', 'same-origin');
  for (const [k, v] of loaderHeaders) if (!h.has(k)) h.set(k, v);
  return h;
};

const throttled = (err: Throttled) =>
  data(
    { state: 'throttled' as const, error: err.message },
    { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
  );

export async function loader({ request, params }: Route.LoaderArgs) {
  // The link itself: keep the token in its cookie and drop it from the address.
  if (params.token !== undefined) {
    if (!isInviteToken(params.token)) return { state: 'invalid' as const };
    throw redirect('/invite', { headers: withCookies(keepInviteToken(params.token)) });
  }
  const token = inviteTokenFrom(request);
  if (!token) return { state: 'invalid' as const };
  try {
    await checkThrottle(request);
  } catch (err) {
    if (err instanceof Throttled) return throttled(err);
    throw err;
  }
  const found = await readInvite(request, token);
  if (!found) return { state: 'invalid' as const };
  const me = await principal(request);
  return {
    state: 'open' as const,
    invite: found.page,
    me: me?.kind === 'user' ? { email: me.email ?? '' } : null,
    sso: !!ssoConfig(),
    ssoOnly: await ssoOnlyInEffect(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const token = inviteTokenFrom(request);
  if (!token) return data({ error: INVITE_INVALID }, { status: 400 });
  const f = await request.formData();
  try {
    if (f.get('intent') === 'accept') {
      const me = await principal(request);
      if (!me) throw redirect('/login?next=%2Finvite');
      await acceptSignedIn(request, me, token);
      return redirect('/?joined=1', { headers: withCookies(forgetInviteToken()) });
    }
    const id = await joinWithPassword(request, token, {
      name: String(f.get('name') ?? ''),
      password: String(f.get('password') ?? ''),
    });
    // On to their Account page, where a passkey can be added (and two-factor sign-in set up, if
    // their role needs it: the session sends them there until it is).
    const headers = withCookies(forgetInviteToken());
    headers.append('set-cookie', await startSession(request, id));
    return redirect('/account?welcome=1', { headers });
  } catch (err) {
    if (err instanceof Throttled) return throttled(err);
    if (err instanceof InviteError) return data({ error: err.message }, { status: err.status });
    throw err;
  }
}

export default function InvitePage() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const error = result && 'error' in result ? result.error : undefined;
  return (
    <main className="grid min-h-dvh content-start justify-items-center bg-background px-4 pt-[16vh]">
      <div className="w-full max-w-sm card p-6">
        <Mark className="size-7 text-brand" />
        {loaded.state === 'open' ? (
          <Open {...loaded} error={error} busy={busy} />
        ) : (
          <>
            <h1 className="mt-4 font-semibold tracking-title text-2xl">Invitation</h1>
            <p role="alert" className="mt-1 text-muted-foreground text-sm">
              {loaded.state === 'throttled' ? loaded.error : INVITE_INVALID}
            </p>
            <a href="/login" className="mt-4 inline-block text-link text-sm hover:underline">
              Go to sign-in
            </a>
          </>
        )}
      </div>
    </main>
  );
}

type OpenProps = Extract<Awaited<ReturnType<typeof loader>>, { state: 'open' }> & {
  error?: string;
  busy: boolean;
};

function Open({ invite, me, sso, ssoOnly, error, busy }: OpenProps) {
  // Back here after signing in: the token waits in its cookie, never in `next`.
  const next = encodeURIComponent('/invite');
  // UTC on both sides, so the server's render and the browser's agree.
  const expires = new Date(invite.expiresAt).toLocaleDateString('en', {
    dateStyle: 'long',
    timeZone: 'UTC',
  });
  const errorLine = error ? (
    <p id="invite-error" role="alert" className="mt-2 text-destructive text-sm">
      {error}
    </p>
  ) : null;
  return (
    <>
      <h1 className="mt-4 font-semibold tracking-title text-2xl">Join CommerceWorker</h1>
      <p className="mt-1 max-w-measure text-muted-foreground text-sm">
        {invite.inviter} invited <span className="text-foreground">{invite.email}</span> as{' '}
        {invite.role === 'admin' ? 'an admin' : 'a member'}. The link works once, until {expires}.
      </p>
      {invite.spaces.length ? (
        <ul className="mt-3 space-y-1 text-sm" aria-label="Spaces you’ll join">
          {invite.spaces.map((s) => (
            <li key={s.name} className="flex justify-between gap-3">
              <span>{s.name}</span>
              <span className="text-muted-foreground">{s.role}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {me ? (
        me.email === invite.email ? (
          <Form method="post" reloadDocument className="mt-5">
            <input type="hidden" name="intent" value="accept" />
            {errorLine}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Accepting…' : 'Accept invitation'}
            </Button>
          </Form>
        ) : (
          <p role="alert" className="mt-5 text-sm">
            You’re signed in as {me.email}. Sign out, then open this link again to accept it as{' '}
            {invite.email}.
          </p>
        )
      ) : (
        <>
          {sso ? (
            <Button asChild variant={ssoOnly ? 'default' : 'outline'} className="mt-5 w-full">
              <a href={`/login/sso?next=${next}`}>Continue with single sign-on</a>
            </Button>
          ) : null}
          {ssoOnly ? (
            errorLine
          ) : (
            <Form method="post" reloadDocument className={sso ? 'mt-4' : 'mt-5'}>
              {sso ? (
                <p className="mb-2 text-center text-muted-foreground text-xs">
                  or create a password
                </p>
              ) : null}
              <input type="hidden" name="intent" value="join" />
              <input type="hidden" name="email" value={invite.email} autoComplete="username" />
              <label className="block text-sm" htmlFor="name">
                Name <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input id="name" name="name" autoComplete="name" className="mt-1" />
              <label className="mt-3 block text-sm" htmlFor="password">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                className="mt-1"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'invite-error password-hint' : 'password-hint'}
              />
              <p id="password-hint" className="mt-1.5 text-muted-foreground text-xs">
                At least 10 characters. You can add a passkey once you’re in.
              </p>
              {errorLine}
              <Button type="submit" className="mt-4 w-full" disabled={busy}>
                {busy ? 'Creating your account…' : 'Create account and join'}
              </Button>
            </Form>
          )}
          <p className="mt-4 text-muted-foreground text-xs">
            Already have an account?{' '}
            <a href={`/login?next=${next}`} className="text-link hover:underline">
              Sign in to accept
            </a>
          </p>
        </>
      )}
    </>
  );
}
