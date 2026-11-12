/**
 * The link in a sign-in email (`/account/confirm/<token>`). A GET only shows who the link is for,
 * masked, and a "Sign in" button: mail scanners, link previews and prefetchers fetch links, and
 * nothing a GET does may spend a one-time link (the preview the engine gives reads and writes
 * nothing). The shopper's tap posts the form back to this path, and only that POST redeems it: the
 * engine mints the session secret, which this sets as the cookie before a 303 to `/account`. The
 * Worker refuses a cross-site POST before it gets here.
 *
 * A link someone forwarded, or posted for a victim to open, would sign the victim in as its owner
 * (login CSRF): the page names the address first, and while a shopper is signed in already the POST
 * redeems nothing until they confirm they mean to replace that session (`replace`), then ends it.
 * A link that can't be redeemed (used, expired, or replaced by a newer code) shows `AccountRefusal`.
 */

import { SHOPPER_SECRET } from '@commerceworker/core';
import { data, redirect, useActionData, useLoaderData } from 'react-router';
import { AccountRefusal } from '~/components/account-refusal';
import { AccountShell, accountButton } from '~/components/account-shell';
import { engine } from '~/lib/env.server';
import {
  accountHeaders,
  canSetShopperCookie,
  currentShopper,
  PRIVATE_HEADERS,
  shopperActor,
  shopperCookie,
  signInBudget,
} from '~/lib/shopper.server';
import { pageTitle } from '~/lib/store-name';
import type { Route } from './+types/account-confirm';

const invalid = () => data('This link isn’t valid.', { status: 404, headers: PRIVATE_HEADERS });
const spent = () =>
  data('This link has been used or has expired. Ask for a new code.', {
    status: 410,
    headers: PRIVATE_HEADERS,
  });

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: pageTitle(matches, 'Confirm sign-in') },
  { name: 'robots', content: 'noindex' },
];

export async function loader({ params, request }: Route.LoaderArgs) {
  if (!SHOPPER_SECRET.test(params.token)) throw invalid();
  const limited = await signInBudget(request, 'link');
  if (limited) throw limited;
  // Reads and changes nothing: the token's owner is shown, masked, and the link stays good.
  const preview = await engine().shopperLinkPreview(params.token, await shopperActor());
  if (!preview) throw spent();
  const current = await currentShopper(request);
  return data(
    { masked: preview.masked, signedInAs: current?.shopper.email ?? null },
    { headers: PRIVATE_HEADERS },
  );
}

export async function action({ params, request }: Route.ActionArgs) {
  if (!SHOPPER_SECRET.test(params.token)) throw invalid();
  // Over plain http on a real host no session can be set: refuse before the link is spent.
  if (!canSetShopperCookie(request))
    return data(
      { error: 'Sign in over a secure (https) connection.' },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  // The client's budget (a link's token is 256 bits: there is nothing to guess per link).
  const limited = await signInBudget(request, 'link');
  if (limited) throw limited;

  const current = await currentShopper(request);
  const replace = (await request.formData()).get('replace') === '1';
  if (current && !replace) {
    // Someone is signed in: signing in as another is the shopper's call, not a link's.
    const preview = await engine().shopperLinkPreview(params.token, await shopperActor());
    if (!preview) throw spent();
    return data(
      { masked: preview.masked, signedInAs: current.shopper.email },
      { status: 409, headers: PRIVATE_HEADERS },
    );
  }
  const signedIn = await engine().redeemShopperLink(params.token, await shopperActor());
  if (!signedIn) throw spent();
  // The session being replaced ends at the engine, not only in the browser.
  if (current) await engine().shopperSignOut(current.secret, await shopperActor());
  return redirect('/account', {
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

export default function ConfirmPage() {
  const loaded = useLoaderData<typeof loader>();
  const answer = useActionData<typeof action>();
  const shown = answer && 'masked' in answer ? answer : loaded;
  const error = answer && 'error' in answer ? answer.error : null;
  return (
    <AccountShell>
      <h1 className="text-xl tracking-title">Sign in</h1>
      <p className="mt-2 text-muted-foreground">
        This link signs in{' '}
        <span className="break-all font-medium text-foreground">{shown.masked}</span>. It works
        once. If that isn’t you, close this page.
      </p>
      {shown.signedInAs ? (
        <p role="status" className="mt-4 text-sm">
          You’re signed in as <span className="break-all font-medium">{shown.signedInAs}</span>.
          Continuing signs you out of that account.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {/* A plain form: no script needed, and nothing but this POST opens the link. */}
      <form method="post" className="mt-6">
        {shown.signedInAs ? <input type="hidden" name="replace" value="1" /> : null}
        <button type="submit" className={accountButton}>
          {shown.signedInAs ? 'Sign out and continue' : 'Sign in'}
        </button>
      </form>
    </AccountShell>
  );
}
