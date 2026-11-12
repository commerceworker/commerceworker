/**
 * A signed-in shopper's page (`/account`): their orders, newest first, a page at a time, each
 * opening its own page; and sign out. A shopper is the verified email address, so the orders are
 * those placed under it (the engine finds them, `StorefrontRpc.shopperOrders`, by the session's
 * address and nothing this page sends); the cursor in `?after=` only says where the page after
 * starts. Anyone not signed in goes to the sign-in page. Signing out ends the session at the
 * engine, not only the cookie, then clears it. Never cached: it is one person's.
 */

import { formatAmount } from '@commerceworker/core';
import { Empty } from '@commerceworker/ui/page';
import { Receipt } from 'lucide-react';
import { data, Link, redirect, useLoaderData } from 'react-router';
import { AccountPageRefusal } from '~/components/account-refusal';
import { SignedInShell } from '~/components/account-shell';
import { placedOn, STATUS } from '~/components/order-view';
import { engine } from '~/lib/env.server';
import {
  accountCall,
  accountHeaders,
  clearedShopperCookie,
  listCursor,
  PRIVATE_HEADERS,
  shopperActor,
  shopperSecret,
  toSignIn,
} from '~/lib/shopper.server';
import { pageTitle } from '~/lib/store-name';
import type { Route } from './+types/account';

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: pageTitle(matches, 'Your orders') },
  { name: 'robots', content: 'noindex' },
];

export async function loader({ request }: Route.LoaderArgs) {
  const { secret, actor } = await accountCall(request);
  const cursor = listCursor(request);
  const page = await engine().shopperOrders(secret, actor, cursor);
  if (!page) throw toSignIn();
  return data({ ...page, paged: !!cursor }, { headers: PRIVATE_HEADERS });
}

export async function action({ request }: Route.ActionArgs) {
  const secret = shopperSecret(request);
  if (secret) await engine().shopperSignOut(secret, await shopperActor());
  return redirect('/account/sign-in', {
    status: 303,
    headers: { 'set-cookie': clearedShopperCookie(request), ...PRIVATE_HEADERS },
  });
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return accountHeaders({ errorHeaders });
}

export const ErrorBoundary = AccountPageRefusal;

export default function AccountPage() {
  const { email, orders, next, paged } = useLoaderData<typeof loader>();
  return (
    <SignedInShell email={email}>
      <h1 className="text-xl tracking-title">Your orders</h1>
      {orders.length === 0 ? (
        <Empty
          icon={<Receipt aria-hidden="true" />}
          title={<h2 className="text-lg tracking-title">No orders yet</h2>}
          className="mt-6"
        >
          Orders placed with {email} show here, and in the confirmation email each one sent.
        </Empty>
      ) : (
        <ul className="mt-4 divide-y border-y">
          {orders.map((o) => (
            <li key={o.id}>
              <Link
                to={`/account/orders/${o.id}`}
                className="flex min-h-11 items-center justify-between gap-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block font-medium">Order {o.ref}</span>
                  <span className="block text-muted-foreground text-sm">
                    {placedOn(o.placedAt)} · {STATUS[o.status]}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatAmount(o.total, o.currency)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {next || paged ? (
        <p className="mt-2 flex flex-wrap gap-x-6">
          {paged ? (
            <Link to="/account" className="inline-flex min-h-11 items-center underline">
              Newest orders
            </Link>
          ) : null}
          {next ? (
            <Link
              to={`/account?after=${encodeURIComponent(next)}`}
              className="inline-flex min-h-11 items-center underline"
            >
              Older orders
            </Link>
          ) : null}
        </p>
      ) : null}
    </SignedInShell>
  );
}
