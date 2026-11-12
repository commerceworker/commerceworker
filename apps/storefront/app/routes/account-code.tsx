/**
 * Entering the emailed code (`/account/code?email=…`). The address comes from the sign-in page's
 * redirect (the Worker's logs drop query strings, and the page sends no referrer), is shown back
 * and posted as a hidden field. Whatever is wrong with a try, a wrong, used, expired or never-sent
 * code, reads the same, and each address and client has a budget on top of the engine's five tries
 * per code. Success sets the session cookie, which only this response can: the engine minted it.
 */

import { SHOPPER_CODE, shopperEmail } from '@commerceworker/core';
import { data, Form, redirect, useActionData, useLoaderData } from 'react-router';
import { AccountRefusal } from '~/components/account-refusal';
import { AccountShell, accountButton } from '~/components/account-shell';
import { TextField } from '~/components/checkout-fields';
import { engine } from '~/lib/env.server';
import {
  accountHeaders,
  canSetShopperCookie,
  currentShopper,
  insecureRefusal,
  PRIVATE_HEADERS,
  safeNext,
  shopperActor,
  shopperCookie,
  signInBudget,
} from '~/lib/shopper.server';
import { pageTitle } from '~/lib/store-name';
import type { Route } from './+types/account-code';

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: pageTitle(matches, 'Enter your code') },
  { name: 'robots', content: 'noindex' },
];

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const next = safeNext(params.get('next'));
  if (await currentShopper(request))
    return redirect(next ?? '/account', { status: 303, headers: PRIVATE_HEADERS });
  const email = shopperEmail(params.get('email'));
  if (!email) return redirect('/account/sign-in', { status: 303, headers: PRIVATE_HEADERS });
  return data({ email, next }, { headers: PRIVATE_HEADERS });
}

const refuse = (error: string, email: string, status = 400) =>
  data({ error, email }, { status, headers: PRIVATE_HEADERS });

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = shopperEmail(form.get('email'));
  if (!email) return redirect('/account/sign-in', { status: 303, headers: PRIVATE_HEADERS });
  const code = String(form.get('code') ?? '')
    .replace(/\s+/g, '')
    .trim();
  if (!SHOPPER_CODE.test(code)) return refuse('Enter the 6 digits from the email.', email);

  // Over plain http on a real host no session can be set: refuse before the code is spent.
  if (!canSetShopperCookie(request)) return insecureRefusal();
  const limited = await signInBudget(request, 'code', email);
  if (limited) return limited;
  const signedIn = await engine().redeemShopperCode(email, code, await shopperActor());
  if (!signedIn)
    return refuse('That code didn’t work. Check it and try again, or ask for a new one.', email);
  return redirect(safeNext(form.get('next')) ?? '/account', {
    status: 303,
    headers: {
      'set-cookie': shopperCookie(request, signedIn.secret, signedIn.expiresAt),
      ...PRIVATE_HEADERS,
    },
  });
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return accountHeaders({ errorHeaders });
}

export const ErrorBoundary = AccountRefusal;

export default function CodePage() {
  const { email, next } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const error = result && 'error' in result ? result.error : undefined;
  return (
    <AccountShell>
      <h1 className="text-xl tracking-title">Check your email</h1>
      <p className="mt-2 text-muted-foreground">
        We sent a 6-digit code to{' '}
        <span className="break-all font-medium text-foreground">{email}</span>. It works once, for
        10 minutes. You can also open the link in the same email.
      </p>
      <Form method="post" className="mt-6 flex flex-col gap-4">
        <input type="hidden" name="email" value={email} />
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <TextField
          name="code"
          label="Code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          maxLength={6}
          error={error}
        />
        <button type="submit" className={accountButton}>
          Sign in
        </button>
      </Form>
      <p className="mt-6 text-sm">
        <a className="inline-flex min-h-11 items-center underline" href="/account/sign-in">
          Use a different email, or get a new code
        </a>
      </p>
    </AccountShell>
  );
}
