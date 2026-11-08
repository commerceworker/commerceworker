/**
 * Asking for a password reset code (`lib/password-reset.server.ts`): an address in, the same
 * answer out whether or not it has an account, then on to `/login/reset` to type the code. Public.
 * The form posts as a whole document (`reloadDocument`) so the reset cookie, scoped to
 * `/login/reset`, rides the redirect.
 */

import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { useEffect, useRef } from 'react';
import { data, Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Mark } from '~/components/mark';
import { authEnabled, principal, Throttled } from '~/lib/auth.server';
import { nextPath, redirectToNext } from '~/lib/next-path';
import { keepReset, RESET_PATH } from '~/lib/password-reset';
import { ResetError, requestReset, resetAvailable } from '~/lib/password-reset.server';
import { ssoOnlyInEffect } from '~/lib/settings.server';
import { retryText } from '~/lib/throttle';
import type { Route } from './+types/login-forgot';

export const meta = () => [{ title: 'Reset your password · CommerceWorker' }];

/** Lets a throttled request's Retry-After reach the response. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

/** Why this workspace can't reset a password by email, or null when it can. */
async function unavailable(request: Request): Promise<string | null> {
  if (await ssoOnlyInEffect())
    return 'This workspace signs in with single sign-on only. Reset your password with your organization’s identity provider.';
  if (!resetAvailable(request))
    return 'This workspace doesn’t send email. Ask an admin to reset your password on the Team page.';
  return null;
}

export async function loader({ request }: Route.LoaderArgs) {
  if (!(await authEnabled()) || (await principal(request))) throw redirectToNext(nextPath(request));
  return { unavailable: await unavailable(request) };
}

export async function action({ request }: Route.ActionArgs) {
  const why = await unavailable(request);
  if (why) return data({ error: why }, { status: 400 });
  const form = await request.formData();
  try {
    const asked = await requestReset(request, String(form.get('email') ?? ''));
    return redirect(RESET_PATH, { headers: { 'set-cookie': keepReset(asked) } });
  } catch (err) {
    if (err instanceof ResetError) return data({ error: err.message }, { status: 400 });
    if (!(err instanceof Throttled)) throw err;
    return data(
      { error: `Too many reset requests from here. ${retryText(err.retryAfterMs)}` },
      { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
    );
  }
}

export default function LoginForgot() {
  const { unavailable } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const email = useRef<HTMLInputElement>(null);
  const error = result?.error;
  useEffect(() => {
    if (error) email.current?.focus();
  }, [error]);
  return (
    <main className="grid min-h-dvh content-start justify-items-center bg-background px-4 pt-[16vh]">
      <div className="h-fit w-full max-w-sm card p-6">
        <Mark className="size-7 text-brand" />
        <h1 className="mt-4 font-semibold tracking-title text-2xl">Reset your password</h1>
        {unavailable ? (
          <p role="alert" className="mt-1 text-muted-foreground text-sm">
            {unavailable}
          </p>
        ) : (
          <Form method="post" reloadDocument>
            <p className="mt-1 text-muted-foreground text-sm">
              Enter your work email. If it belongs to an account that signs in with a password,
              we’ll email it a code.
            </p>
            <label className="mt-5 block text-sm" htmlFor="email">
              Email
            </label>
            <Input
              ref={email}
              id="email"
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="username"
              className="mt-1"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'forgot-error' : undefined}
            />
            {error ? (
              <p id="forgot-error" className="mt-2 text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="mt-4 w-full" disabled={busy}>
              {busy ? 'Sending…' : 'Email me a code'}
            </Button>
          </Form>
        )}
        <a
          href="/login"
          className="-my-1 mt-3 inline-flex min-h-8 items-center text-link text-xs hover:underline"
        >
          Back to sign-in
        </a>
      </div>
    </main>
  );
}
