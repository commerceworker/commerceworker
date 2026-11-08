/**
 * Setting a new password with an emailed code (`lib/password-reset.server.ts`). Public. Reached two
 * ways, both carried in the `cw_reset` cookie (`lib/password-reset.ts`): from `/login/forgot`,
 * holding the address, to type the code; or from the emailed link `/login/reset/<id>.<code>`,
 * whose first request moves the code into the cookie and redirects here, so it is in no later URL.
 * The forms post as whole documents (`reloadDocument`): a `/login/reset.data` fetch is outside
 * the cookie's path. The page is never cached and sends no referrer to another origin.
 *
 * A reset starts no session: the person signs in with the new password, and their two-factor code
 * if they use one.
 */

import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { useEffect, useRef } from 'react';
import { data, Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Mark } from '~/components/mark';
import { Throttled } from '~/lib/auth.server';
import {
  FORGOT_PATH,
  forgetReset,
  keepReset,
  parseResetLink,
  RESET_LINK_INVALID,
  RESET_MINUTES,
  RESET_PATH,
  resetFrom,
} from '~/lib/password-reset';
import { openResetLink, ResetError, resetPassword } from '~/lib/password-reset.server';
import { retryText } from '~/lib/throttle';
import type { Route } from './+types/login-reset';

export const meta = () => [{ title: 'Choose a new password · CommerceWorker' }];

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

export async function loader({ request, params }: Route.LoaderArgs) {
  // The emailed link: check it (a try), keep its code and the masked address it is for in the
  // cookie, and drop it from the address bar.
  if (params.token !== undefined) {
    if (!parseResetLink(params.token)) return { mode: 'invalid' as const };
    let masked: string | null;
    try {
      masked = await openResetLink(request, params.token);
    } catch (err) {
      if (!(err instanceof Throttled)) throw err;
      return {
        mode: 'invalid' as const,
        error: `Too many codes tried from here. ${retryText(err.retryAfterMs)}`,
      };
    }
    if (!masked) return { mode: 'invalid' as const };
    throw redirect(RESET_PATH, {
      headers: { 'set-cookie': keepReset({ link: params.token, masked }) },
    });
  }
  const carry = resetFrom(request);
  if (!carry) throw redirect(FORGOT_PATH);
  return 'link' in carry
    ? { mode: 'link' as const, masked: carry.masked }
    : { mode: 'code' as const, email: carry.email };
}

export async function action({ request }: Route.ActionArgs) {
  const carry = resetFrom(request);
  if (!carry) throw redirect(FORGOT_PATH);
  const form = await request.formData();
  try {
    await resetPassword(
      request,
      carry,
      String(form.get('code') ?? ''),
      String(form.get('password') ?? ''),
    );
  } catch (err) {
    if (err instanceof ResetError) return data({ error: err.message }, { status: 400 });
    if (!(err instanceof Throttled)) throw err;
    return data(
      { error: `Too many codes tried from here. ${retryText(err.retryAfterMs)}` },
      { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
    );
  }
  return redirect('/login?reset=1', { headers: { 'set-cookie': forgetReset() } });
}

export default function LoginReset() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const error = result?.error;
  const first = useRef<HTMLInputElement>(null);
  // After a refusal, the field to fix is ready to retype.
  useEffect(() => {
    if (error) first.current?.select();
  }, [error]);
  const errorLine = error ? (
    <p id="reset-error" className="mt-2 text-destructive text-sm" role="alert">
      {error}
    </p>
  ) : null;
  const described = (hint?: string) =>
    [error ? 'reset-error' : null, hint].filter(Boolean).join(' ') || undefined;
  return (
    <main className="grid min-h-dvh content-start justify-items-center bg-background px-4 pt-[16vh]">
      <div className="h-fit w-full max-w-sm card p-6">
        <Mark className="size-7 text-brand" />
        {loaded.mode === 'invalid' ? (
          <>
            <h1 className="mt-4 font-semibold tracking-title text-2xl">Reset your password</h1>
            <p role="alert" className="mt-1 text-muted-foreground text-sm">
              {('error' in loaded && loaded.error) || RESET_LINK_INVALID}
            </p>
          </>
        ) : (
          <Form method="post" reloadDocument>
            <h1 className="mt-4 font-semibold tracking-title text-2xl">
              {loaded.mode === 'code' ? 'Check your email' : 'Choose a new password'}
            </h1>
            {loaded.mode === 'code' ? (
              <>
                <p className="mt-1 max-w-measure text-muted-foreground text-sm">
                  If <span className="text-foreground">{loaded.email}</span> belongs to an account
                  that signs in with a password, we’ve emailed it a code. It works once, for{' '}
                  {RESET_MINUTES} minutes.
                </p>
                <input type="hidden" name="email" value={loaded.email} autoComplete="username" />
                <label className="mt-5 block text-sm" htmlFor="code">
                  Code
                </label>
                <Input
                  ref={first}
                  id="code"
                  name="code"
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={12}
                  placeholder="ABCD-EFGH"
                  className="mt-1 font-mono"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={described()}
                />
              </>
            ) : (
              <p className="mt-1 text-muted-foreground text-sm">
                Choose the password <span className="text-foreground">{loaded.masked}</span> will
                sign in with from now on. Not your address? Don’t continue: ask for a code yourself.
              </p>
            )}
            <label className="mt-3 block text-sm" htmlFor="password">
              New password
            </label>
            <Input
              ref={loaded.mode === 'link' ? first : undefined}
              id="password"
              name="password"
              type="password"
              required
              minLength={10}
              autoFocus={loaded.mode === 'link'}
              autoComplete="new-password"
              className="mt-1"
              aria-invalid={error ? true : undefined}
              aria-describedby={described('password-hint')}
            />
            <p id="password-hint" className="mt-1.5 text-muted-foreground text-xs">
              At least 10 characters. Every session signs out; if you use two-factor sign-in, you’ll
              still need your code.
            </p>
            {errorLine}
            <Button type="submit" className="mt-4 w-full" disabled={busy}>
              {busy ? 'Saving…' : 'Set new password'}
            </Button>
          </Form>
        )}
        <div className="mt-3 flex flex-wrap gap-x-4 text-xs">
          <a
            href={FORGOT_PATH}
            className="-my-1 inline-flex min-h-8 items-center text-link hover:underline"
          >
            Send a new code
          </a>
          <a
            href="/login"
            className="-my-1 inline-flex min-h-8 items-center text-link hover:underline"
          >
            Back to sign-in
          </a>
        </div>
      </div>
    </main>
  );
}
