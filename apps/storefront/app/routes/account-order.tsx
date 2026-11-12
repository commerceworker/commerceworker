/**
 * One of a signed-in shopper's orders (`/account/orders/<id>`): the buyer-safe view the receipt
 * shows (`OrderView`), asked of the engine by the session's secret (`StorefrontRpc.shopperOrder`),
 * which checks again that the order was placed under the session's address. An order of another
 * address, an erased one and an id nothing started all answer the same 404, so the page tells a
 * stranger nothing about which orders exist. No credential rides in the URL (the order's id is
 * not one), so the page needs no `no-referrer`: `same-origin`, like the rest of the account.
 */

import { data } from 'react-router';
import { AccountPageRefusal } from '~/components/account-refusal';
import { AccountShell } from '~/components/account-shell';
import { OrderView } from '~/components/order-view';
import { engine } from '~/lib/env.server';
import { accountCall, accountHeaders, PRIVATE_HEADERS } from '~/lib/shopper.server';
import type { Route } from './+types/account-order';

const ORDER_ID = /^[A-Za-z0-9_-]{1,100}$/;

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d ? `Order ${d.ref}` : 'Order'} · CommerceWorker` },
  { name: 'robots', content: 'noindex' },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { secret, actor } = await accountCall(request);
  const view = ORDER_ID.test(params.id)
    ? await engine().shopperOrder(secret, actor, params.id)
    : null;
  if (!view)
    throw data('We can’t find that order under your account.', {
      status: 404,
      headers: PRIVATE_HEADERS,
    });
  return data(view, { headers: PRIVATE_HEADERS });
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return accountHeaders({ errorHeaders });
}

export const ErrorBoundary = AccountPageRefusal;

export default function AccountOrderPage({ loaderData: order }: Route.ComponentProps) {
  return (
    <AccountShell wide>
      <a href="/account" className="-ml-1 mb-4 inline-flex min-h-11 items-center underline">
        All orders
      </a>
      <OrderView order={order} />
    </AccountShell>
  );
}
