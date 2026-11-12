/**
 * Where a hosted checkout goes once its order is placed: the order's reference and nothing more.
 * (The full confirmation, with the order's lines, address and status, comes with the confirmation
 * page.) Guarded as the checkout page is, so only the buyer holding the cookie sees it; a checkout
 * that isn't complete goes back to its page.
 */

import { HOSTED_ID } from '@commerceworker/core';
import { Empty } from '@commerceworker/ui/page';
import { CircleCheck } from 'lucide-react';
import { data, redirect, useLoaderData } from 'react-router';
import { CheckoutRefusal } from '~/components/checkout-refusal';
import { engine } from '~/lib/env.server';
import {
  checkoutBuyer,
  checkoutRefusal,
  PRIVATE_HEADERS,
  privateHeaders,
  storefrontSettings,
} from '~/lib/hosted-checkout.server';
import { orderRef } from '~/lib/order-ref';
import { overBudget } from '~/lib/rate-limit';
import type { Route } from './+types/checkout-placed';

export const meta = () => [
  { title: 'Order placed · CommerceWorker' },
  { name: 'robots', content: 'noindex' },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  if (!HOSTED_ID.test(params.id)) throw checkoutRefusal('This checkout doesn’t exist.', 404);
  const settings = await storefrontSettings();
  if (!settings.checkout.enabled) throw checkoutRefusal('Checkout is not available here.', 404);
  const buyer = await checkoutBuyer(request, params.id);
  if (!buyer) throw checkoutRefusal('Open this checkout from the link you were sent.', 401);
  const limited = await overBudget('API_LIMIT', buyer.budgetKey);
  if (limited) throw limited;
  const checkout = await engine().checkout(params.id, buyer.secret, buyer.actor);
  if (!checkout) throw checkoutRefusal('This checkout doesn’t exist.', 404);
  if (checkout.status !== 'completed' || !checkout.orderId)
    return redirect(`/checkout/${params.id}`, { status: 303, headers: PRIVATE_HEADERS });
  return data(
    {
      orderId: checkout.orderId,
      testPayments: settings.checkout.testPayments,
    },
    { headers: PRIVATE_HEADERS },
  );
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return privateHeaders({ errorHeaders });
}

export const ErrorBoundary = CheckoutRefusal;

export default function OrderPlacedPage() {
  const { orderId, testPayments } = useLoaderData<typeof loader>();
  return (
    <main id="main" className="mx-auto max-w-2xl px-safe-4 pt-safe-6 pb-safe-8 sm:px-safe-6">
      {/* TODO(S7): the merchant's store name, which the wordmark stands in for until then. */}
      <p className="mb-6 font-semibold text-brand tracking-title">CommerceWorker</p>
      <Empty
        icon={<CircleCheck aria-hidden="true" />}
        title={<h1 className="text-xl tracking-title">Order placed</h1>}
      >
        Your order reference is <span className="font-mono">{orderRef(orderId)}</span>.
        {testPayments ? ' This was a test order: no card was charged.' : ''}
      </Empty>
    </main>
  );
}
