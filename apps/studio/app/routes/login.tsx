import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useRef, useState } from 'react';
import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from 'react-router';
import { Mark } from '~/components/mark';
import { authEnabled, principal, type SignInResult, signIn, Throttled } from '~/lib/auth.server';
import { INVITE_INVALID } from '~/lib/invites';
import { nextPath, redirectToNext, withNext } from '~/lib/next-path';
import { FORGOT_PATH } from '~/lib/password-reset';
import { resetAvailable } from '~/lib/password-reset.server';
import { ssoOnlyInEffect } from '~/lib/settings.server';
import { ssoConfig } from '~/lib/sso.server';
import type { Route } from './+types/login';

export const meta = () => [{ title: 'Sign in · CommerceWorker' }];

/** Lets a throttled sign-in's Retry-After reach the response. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

export async function loader({ request }: Route.LoaderArgs) {
  if (!(await authEnabled()) || (await principal(request))) throw redirectToNext(nextPath(request));
  return {
    sso: !!ssoConfig(),
    ssoOnly: await ssoOnlyInEffect(),
    // Without email (and outside local development), only an admin can reset a password.
    canReset: resetAvailable(request),
  };
}

/** What the sign-in page says after single sign-on sent someone back without a session. */
const SSO_ERRORS: Record<string, string> = {
  failed: 'Single sign-on didn’t finish. Try again; if it keeps failing, tell an admin.',
  refused:
    'Your identity provider signed you in, but you aren’t on this deployment’s team. Ask an admin to add you.',
  disabled: 'Your account here is disabled. Ask an admin to enable it.',
  invite: INVITE_INVALID,
};

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  if (await ssoOnlyInEffect())
    return { error: 'This deployment signs in with single sign-on only. Use the button above.' };
  const email = String(form.get('email') ?? '');
  let result: SignInResult | null;
  const forgot = resetAvailable(request)
    ? 'If you’ve forgotten your password, reset it below.'
    : 'If you’ve forgotten your password, ask an admin to reset it.';
  try {
    result = await signIn(request, email, String(form.get('password') ?? ''));
  } catch (err) {
    if (!(err instanceof Throttled)) throw err;
    return data(
      {
        error: `${err.message} ${forgot}`,
      },
      { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
    );
  }
  if (!result) return { error: 'That email and password don’t match an active account.' };
  const next = nextPath(request);
  const headers = { 'set-cookie': result.cookie };
  return result.twoFactor
    ? redirect(withNext('/login/two-factor', next), { headers })
    : redirectToNext(next, { headers });
}

export default function Login() {
  const { sso, ssoOnly, canReset } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [params] = useSearchParams();
  const busy = useNavigation().state === 'submitting';
  const password = useRef<HTMLInputElement>(null);
  const passkey = usePasskeySignIn();
  const error = passkey.error ?? result?.error ?? SSO_ERRORS[params.get('sso') ?? ''] ?? undefined;
  const ssoHref = `/login/sso${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`;
  // After a refusal, the password is ready to retype.
  useEffect(() => {
    if (error) password.current?.select();
  }, [error]);
  const connecting = params.get('next')?.startsWith('/oauth/authorize');
  return (
    <main className="grid min-h-dvh content-start justify-items-center gap-4 bg-background px-4 pt-[16vh]">
      <Form method="post" className="h-fit w-full max-w-sm card p-6">
        {params.get('signed-out') && !error ? (
          <p role="status" className="mb-4 text-muted-foreground text-sm">
            You’ve signed out.
          </p>
        ) : params.get('reset') && !error ? (
          <p role="status" className="mb-4 text-muted-foreground text-sm">
            Your password is changed and every session signed out. Sign in with the new one.
          </p>
        ) : null}
        <Mark className="size-7 text-brand" />
        <h1 className="mt-4 font-semibold tracking-title text-2xl">CommerceWorker</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {connecting
            ? 'Sign in to connect an app to CommerceWorker.'
            : ssoOnly
              ? 'Sign in with your organization’s account.'
              : 'Sign in with your work email.'}
        </p>
        {sso ? (
          <Button asChild variant={ssoOnly ? 'default' : 'outline'} className="mt-5 w-full">
            <a href={ssoHref}>Sign in with single sign-on</a>
          </Button>
        ) : null}
        {ssoOnly ? (
          error ? (
            <p id="sign-in-error" className="mt-2 text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null
        ) : (
          <>
            {sso ? (
              <p className="mt-4 text-center text-muted-foreground text-xs">or with a password</p>
            ) : null}
            <label className={`${sso ? 'mt-2' : 'mt-5'} block text-sm`} htmlFor="email">
              Email
            </label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoFocus={!sso}
              autoComplete="username"
              className="mt-1"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'sign-in-error' : undefined}
            />
            <label className="mt-3 block text-sm" htmlFor="password">
              Password
            </label>
            <Input
              ref={password}
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'sign-in-error' : undefined}
            />
            {error ? (
              <p id="sign-in-error" className="mt-2 text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="mt-4 w-full" disabled={busy || passkey.busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
            {passkey.supported ? (
              <Button
                type="button"
                variant="outline"
                className="mt-2 w-full"
                disabled={busy || passkey.busy}
                onClick={() => void passkey.start(params.toString())}
              >
                {passkey.busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
              </Button>
            ) : null}
            {canReset ? (
              <a
                href={FORGOT_PATH}
                className="-my-1 mt-3 inline-flex min-h-8 items-center text-link text-xs hover:underline"
              >
                Forgot your password?
              </a>
            ) : (
              <p className="mt-3 text-muted-foreground text-xs">
                Forgot your password? Ask an admin to reset it on the Team page.
              </p>
            )}
          </>
        )}
      </Form>
    </main>
  );
}

/** Signing in with a passkey: ask the server for a challenge, let the browser answer, check it. */
function usePasskeySignIn() {
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = async (search: string, body: Record<string, unknown>) => {
    const res = await fetch(`/login/passkey${search ? `?${search}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error ?? 'That did not go through. Try again.'));
    return json;
  };
  const start = async (search: string) => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await call(search, { step: 'options' });
      let response: Awaited<ReturnType<typeof startAuthentication>>;
      try {
        response = await startAuthentication({
          optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'],
        });
      } catch {
        // The person closed the prompt, or has no passkey here: nothing to report as a failure.
        return;
      }
      const { location } = await call(search, { step: 'verify', response });
      window.location.assign(String(location ?? '/'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { supported, busy, error, start };
}
