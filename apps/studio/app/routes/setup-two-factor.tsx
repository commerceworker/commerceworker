/**
 * The two-factor step: someone whose role must use two-factor sign-in turns it on, and nothing
 * else, before anything opens (a new deployment's first admin meets it straight after setup, then
 * goes on to the first space). The same setup as Account's (`two-factor.server.ts`): the app scans
 * the QR code (or takes the key), they enter a code and their password, and save the recovery
 * codes; Continue goes to `/`.
 *
 * While it is due the sign-in gate holds them here (`setupPath`); signing out is the other way
 * off. Anyone it isn't due for goes straight on to `/`.
 */

import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { useEffect, useRef } from 'react';
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
} from 'react-router';
import { Mark } from '~/components/mark';
import { groupedKey, QrCode, RecoveryCodes } from '~/components/two-factor';
import { requireUser, Throttled } from '~/lib/auth.server';
import { TeamError } from '~/lib/team.server';
import { enableTwoFactor, startSetup } from '~/lib/two-factor.server';
import type { Route } from './+types/setup-two-factor';

export const meta = () => [{ title: 'Two-factor sign-in · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  if (me.kind !== 'user' || !me.twoFactorDue) throw redirect('/');
  return { setup: startSetup(me), admin: me.role === 'admin' };
}

/**
 * The page carries the secret that becomes the person's second factor (and then their recovery
 * codes): never kept in the browser's cache, where whoever uses the browser next could read it.
 */
export const headers: Route.HeadersFunction = ({ actionHeaders, loaderHeaders }) => {
  const h = new Headers(actionHeaders);
  h.set('cache-control', 'no-store');
  for (const [k, v] of loaderHeaders) if (!h.has(k)) h.set(k, v);
  return h;
};

/** The key on screen is the one the app scanned: never made again under the person's feet. */
export const shouldRevalidate = () => false;

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request);
  const f = await request.formData();
  const str = (k: string) => String(f.get(k) ?? '');
  try {
    const codes = await enableTwoFactor(request, me, {
      secret: str('secret'),
      code: str('code'),
      password: str('password'),
    });
    return { recoveryCodes: codes };
  } catch (err) {
    if (err instanceof TeamError) return data({ error: err.message }, { status: 400 });
    if (err instanceof Throttled) return data({ error: err.message }, { status: 429 });
    throw err;
  }
}

export default function SetupTwoFactor() {
  const { setup, admin } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const navigate = useNavigate();
  const error = result && 'error' in result ? result.error : null;
  const codes = result && 'recoveryCodes' in result ? result.recoveryCodes : null;
  const heading = useRef<HTMLHeadingElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  // The codes are a new step: it takes focus, so nobody is left on the form that has gone.
  useEffect(() => {
    if (codes) heading.current?.focus();
  }, [codes]);
  // A refused code is ready to retype.
  useEffect(() => {
    if (error && /code/i.test(error)) codeField.current?.select();
  }, [error]);

  return (
    <main className="grid min-h-dvh content-start justify-items-center bg-background px-4 pt-[8vh] pb-10 max-sm:pt-6">
      <div className="w-full max-w-md card p-6">
        <Mark className="size-7 text-brand" />
        {codes ? (
          <div className="space-y-3">
            <h1
              ref={heading}
              tabIndex={-1}
              className="mt-4 font-semibold text-2xl tracking-title outline-none"
            >
              Save your recovery codes
            </h1>
            <p className="text-muted-foreground text-sm">
              Two-factor sign-in is on. Each code signs you in once if you can’t use your
              authenticator app. Keep them apart from your phone; they are shown only now.
            </p>
            <RecoveryCodes codes={codes} done="Continue" onDone={() => navigate('/')} />
          </div>
        ) : (
          <Form method="post" className="space-y-3">
            <h1 className="mt-4 font-semibold text-2xl tracking-title">
              Turn on two-factor sign-in
            </h1>
            <p className="text-muted-foreground text-sm">
              {admin
                ? 'An admin can change who has access, so signing in also needs a code from an authenticator app'
                : 'Your role needs it in this deployment: signing in also needs a code from an authenticator app'}{' '}
              (1Password, Google Authenticator, Authy and others). Scan this:
            </p>
            <input type="hidden" name="secret" value={setup.secret} />
            <div className="flex flex-wrap items-center gap-4 pt-1">
              <QrCode value={setup.uri} />
              <div className="min-w-0 text-xs">
                <p className="text-muted-foreground">Can’t scan? Enter this key in the app:</p>
                <code className="mt-1 block select-all break-all font-mono text-sm">
                  {groupedKey(setup.secret)}
                </code>
              </div>
            </div>
            <label className="block pt-1 text-sm" htmlFor="code">
              Code from the app
            </label>
            <Input
              ref={codeField}
              id="code"
              name="code"
              required
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              className="font-mono"
              aria-invalid={error && /code/i.test(error) ? true : undefined}
              aria-describedby={error ? 'two-factor-error' : undefined}
            />
            <label className="block text-sm" htmlFor="password">
              Your password
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              aria-invalid={error && /password/i.test(error) ? true : undefined}
              aria-describedby={error ? 'two-factor-error' : undefined}
            />
            {error ? (
              <p id="two-factor-error" role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="mt-1 w-full" disabled={busy}>
              {busy ? 'Turning on…' : 'Turn on'}
            </Button>
          </Form>
        )}
        {codes ? null : (
          <p className="mt-4 text-muted-foreground text-sm">
            Not now?{' '}
            <Link to="/logout" className="text-link underline-offset-4 hover:underline">
              Sign out
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
