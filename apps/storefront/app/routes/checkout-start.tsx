/**
 * A hosted checkout's one-time start link, as an operator handed it to the buyer. A GET only shows
 * a "Continue to checkout" page: mail scanners, link previews and prefetchers fetch links, and
 * nothing a GET does may spend a one-time link. The buyer's tap posts the form back to this path,
 * and only that POST redeems it: the engine mints the buyer's secret, which this sets as a cookie
 * for that checkout alone before a 303 to the page. The Worker refuses a cross-site POST before it
 * gets here. A link that can't be redeemed (used, expired, or hosted checkout off) shows
 * `CheckoutRefusal`.
 */

import { HOSTED_ID, hostedHash } from '@commerceworker/core';
import { data, redirect } from 'react-router';
import { CheckoutRefusal } from '~/components/checkout-refusal';
import { engine } from '~/lib/env.server';
import {
  checkoutCookie,
  checkoutRefusal,
  PRIVATE_HEADERS,
  privateHeaders,
  storefrontSettings,
} from '~/lib/hosted-checkout.server';
import { overBudget } from '~/lib/rate-limit';
import type { Route } from './+types/checkout-start';

export async function loader({ params }: Route.LoaderArgs) {
  if (!HOSTED_ID.test(params.id)) throw checkoutRefusal('This link is not valid.', 404);
  // Reads nothing and changes nothing: the token is not even looked at.
  return data({ id: params.id }, { headers: PRIVATE_HEADERS });
}

export async function action({ params, request }: Route.ActionArgs) {
  if (!HOSTED_ID.test(params.id)) throw checkoutRefusal('This link is not valid.', 404);
  if (!(await storefrontSettings()).checkout.enabled)
    throw checkoutRefusal('Checkout is not available here.', 404);
  // Each link has its own budget, so guessing at one can't spend another's.
  const limited = await overBudget(
    'API_LIMIT',
    `checkout-start:${params.id}:${await hostedHash(params.token)}`,
  );
  if (limited) throw limited;
  const redeemed = await engine().redeemCheckoutStart(params.id, params.token);
  if (!redeemed)
    throw checkoutRefusal(
      'This link has been used or has expired. Ask the business for a new one.',
      410,
    );
  return redirect(`/checkout/${params.id}`, {
    status: 303,
    headers: {
      'set-cookie': checkoutCookie(request, params.id, redeemed.secret, redeemed.expiresAt),
      ...PRIVATE_HEADERS,
    },
  });
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return privateHeaders({ errorHeaders });
}

export const ErrorBoundary = CheckoutRefusal;

export const meta = () => [
  { title: 'Continue to checkout · CommerceWorker' },
  { name: 'robots', content: 'noindex' },
];

export default function CheckoutStartPage() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-safe-6 pt-safe-6 pb-safe-6"
    >
      <h1 className="text-xl tracking-title">Your checkout is ready</h1>
      <p className="mt-2 text-muted-foreground">
        Continue to review it and finish. This link works once, on this device.
      </p>
      {/* A plain form: no script needed, and nothing but this POST opens the link. */}
      <form method="post" className="mt-6">
        <button
          type="submit"
          className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-primary px-6 text-base font-medium text-primary-foreground"
        >
          Continue to checkout
        </button>
      </form>
    </main>
  );
}
