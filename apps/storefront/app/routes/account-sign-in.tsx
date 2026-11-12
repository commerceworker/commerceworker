/**
 * Asking for a sign-in code (`/account/sign-in`): an email address, and Turnstile where the
 * deployment uses it, since this form makes the deployment send mail. A plain form that posts
 * back, so it needs no script (the challenge aside). The answer never depends on whether the
 * address has orders: any address that is one is sent a code and goes on to enter it. Each address
 * and each client has a budget, and the engine sends at most one code a minute to an address.
 */

import { shopperEmail } from '@commerceworker/core';
import { Turnstile } from '@commerceworker/ui/turnstile';
import { data, Form, redirect, useActionData, useLoaderData } from 'react-router';
import { AccountRefusal } from '~/components/account-refusal';
import { AccountShell, accountButton } from '~/components/account-shell';
import { TextField } from '~/components/checkout-fields';
import { engine } from '~/lib/env.server';
import {
  accountHeaders,
  currentShopper,
  PRIVATE_HEADERS,
  safeNext,
  shopperActor,
  signInBudget,
} from '~/lib/shopper.server';
import { pageTitle } from '~/lib/store-name';
import { checkSignInTurnstile, turnstileSiteKey } from '~/lib/turnstile.server';
import type { Route } from './+types/account-sign-in';

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: pageTitle(matches, 'Sign in') },
  { name: 'robots', content: 'noindex' },
];

export async function loader({ request }: Route.LoaderArgs) {
  // `next`: the linking request a platform sent them here from, which sign-in returns them to.
  const next = safeNext(new URL(request.url).searchParams.get('next'));
  if (await currentShopper(request))
    return redirect(next ?? '/account', { status: 303, headers: PRIVATE_HEADERS });
  return data({ siteKey: turnstileSiteKey(), next }, { headers: PRIVATE_HEADERS });
}

const refuse = (error: string, status: number, email?: string) =>
  data({ error, ...(email ? { email } : {}) }, { status, headers: PRIVATE_HEADERS });

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const given = form.get('email');
  const email = shopperEmail(given);
  if (!email)
    return refuse('Enter a valid email address.', 400, typeof given === 'string' ? given : '');

  // The check first: a refused attempt costs the engine nothing and spends no address's budget.
  const check = await checkSignInTurnstile(request, form);
  if (check) return refuse(check.error, check.status, email);
  const limited = await signInBudget(request, 'start', email);
  if (limited) return limited;

  const { status } = await engine().startShopperSignIn(email, await shopperActor());
  const next = safeNext(form.get('next'));
  const onward = next ? `&next=${encodeURIComponent(next)}` : '';
  if (status === 'sent')
    return redirect(`/account/code?email=${encodeURIComponent(email)}${onward}`, {
      status: 303,
      headers: PRIVATE_HEADERS,
    });
  if (status === 'wait')
    return data(
      { email, waiting: true as const },
      { status: 429, headers: { ...PRIVATE_HEADERS, 'retry-after': '60' } },
    );
  if (status === 'unavailable') return refuse('Signing in isn’t available here.', 503, email);
  if (status === 'failed')
    return refuse('We couldn’t send the email. Try again in a minute.', 502, email);
  return refuse('Enter a valid email address.', 400, email);
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return accountHeaders({ errorHeaders }, { turnstile: true });
}

export const ErrorBoundary = AccountRefusal;

export default function SignInPage() {
  const { siteKey, next } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const waiting = result && 'waiting' in result ? result : null;
  const error = result && 'error' in result ? result : null;
  return (
    <AccountShell>
      <h1 className="text-xl tracking-title">Sign in</h1>
      <p className="mt-2 text-muted-foreground">
        Enter your email and we’ll send you a code. No password needed.
      </p>
      <Form method="post" className="mt-6 flex flex-col gap-4">
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <TextField
          name="email"
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          maxLength={254}
          defaultValue={result && 'email' in result ? (result.email ?? '') : ''}
          error={error?.error}
        />
        {siteKey ? (
          <Turnstile siteKey={siteKey} action="shop_sign_in" reset={result} onSolved={() => {}} />
        ) : null}
        <button type="submit" className={accountButton}>
          Send code
        </button>
      </Form>
      {waiting ? (
        <p role="status" className="mt-4 text-sm">
          A code was just sent to {waiting.email}. Check your email, or ask again in a minute.{' '}
          <a
            className="underline"
            href={`/account/code?email=${encodeURIComponent(waiting.email)}${next ? `&next=${encodeURIComponent(next)}` : ''}`}
          >
            Enter the code
          </a>
        </p>
      ) : null}
      <p className="mt-6 text-muted-foreground text-sm">
        Checking out as a guest works without an account.
      </p>
    </AccountShell>
  );
}
