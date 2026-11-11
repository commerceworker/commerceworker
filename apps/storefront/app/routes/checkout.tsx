/**
 * A hosted checkout, for the buyer whose redeemed start link set its cookie
 * (lib/hosted-checkout.server.ts). The engine decides who may see a session (`checkout`: the cookie's
 * hash and an actor signed for this checkout) and answers null for anyone else's; this only says
 * who asks. The page itself is a placeholder until the checkout page is built.
 */

import { HOSTED_ID } from '@commerceworker/core';
import { data, useLoaderData } from 'react-router';
import { CheckoutRefusal } from '~/components/checkout-refusal';
import { engine } from '~/lib/env.server';
import { checkoutBuyer, checkoutRefusal, storefrontSettings } from '~/lib/hosted-checkout.server';
import { overBudget } from '~/lib/rate-limit';
import type { Route } from './+types/checkout';

export const meta = () => [{ title: 'Checkout · CommerceWorker' }];

export async function loader({ request, params }: Route.LoaderArgs) {
  if (!HOSTED_ID.test(params.id)) throw checkoutRefusal('This checkout doesn’t exist.', 404);
  if (!(await storefrontSettings()).checkout.enabled)
    throw checkoutRefusal('Checkout is not available here.', 404);
  const buyer = await checkoutBuyer(request, params.id);
  if (!buyer) throw checkoutRefusal('Open this checkout from the link you were sent.', 401);
  // Each cookie has its own budget: someone sending a wrong one spends theirs, not the buyer's.
  const limited = await overBudget('API_LIMIT', buyer.budgetKey);
  if (limited) throw limited;
  const checkout = await engine().checkout(params.id, buyer.secret, buyer.actor);
  if (!checkout) throw checkoutRefusal('This checkout doesn’t exist.', 404);
  return data(
    { checkout },
    { headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } },
  );
}

export function headers({ errorHeaders, loaderHeaders }: Route.HeadersArgs) {
  return errorHeaders ?? loaderHeaders;
}

export const ErrorBoundary = CheckoutRefusal;

export default function CheckoutPage() {
  const { checkout } = useLoaderData<typeof loader>();
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-xl tracking-title">Checkout</h1>
      <p className="mt-2 text-muted-foreground">
        Your checkout is saved. The page to pay for it is coming.
      </p>
      <ul className="mt-6 divide-y">
        {checkout.lines.map((l) => (
          <li key={l.id} className="flex justify-between py-2">
            <span>{l.title ?? l.sku}</span>
            <span className="tabular-nums">× {l.qty}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
