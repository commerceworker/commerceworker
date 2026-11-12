/**
 * An order's receipt for its buyer: the page a confirmation email links to
 * (`/orders/<id>?t=<credential>`, also what UCP's default `orderPermalink` points at). The
 * credential is a bearer secret, so the page is never cached, sends no referrer and is kept out of
 * search; what it shows is the engine's buyer-safe view (`StorefrontRpc.orderReceipt`: lines,
 * totals, status, ship-to, tracking), never a timeline or a note. An unknown order, a wrong
 * credential and an expired one all read the same.
 */

import { Empty } from '@commerceworker/ui/page';
import { Receipt } from 'lucide-react';
import { data, isRouteErrorResponse, useLoaderData, useRouteError } from 'react-router';
import { OrderView } from '~/components/order-view';
import { engine } from '~/lib/env.server';
import { overBudget } from '~/lib/rate-limit';
import type { Route } from './+types/order-receipt';

const ORDER_ID = /^[A-Za-z0-9_-]{1,100}$/;

const PRIVATE = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d ? `Order ${d.ref}` : 'Order'} · CommerceWorker` },
  { name: 'robots', content: 'noindex' },
  { name: 'referrer', content: 'no-referrer' },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const limited = await overBudget(
    'API_LIMIT',
    `receipt:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`,
  );
  if (limited) throw limited;
  const credential = new URL(request.url).searchParams.get('t');
  const view =
    credential && ORDER_ID.test(params.orderId)
      ? await engine().orderReceipt(params.orderId, credential)
      : null;
  if (!view)
    throw data('This link isn’t valid, or it has expired.', { status: 404, headers: PRIVATE });
  return data(view, { headers: PRIVATE });
}

export function headers({ errorHeaders, loaderHeaders }: Route.HeadersArgs) {
  return errorHeaders ?? loaderHeaders;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const said = isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : null;
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-24">
      <Empty
        icon={<Receipt aria-hidden="true" />}
        title={
          <h1 className="text-xl tracking-title">
            {said ? 'We can’t show this order' : 'Something went wrong'}
          </h1>
        }
      >
        {said ?? 'Try the link in your confirmation email again.'}
      </Empty>
    </main>
  );
}

export default function OrderReceiptPage() {
  const o = useLoaderData<typeof loader>();
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 pt-safe-12 pb-safe-12">
      <OrderView order={o} />
    </main>
  );
}
