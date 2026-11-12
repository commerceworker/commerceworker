/**
 * The places a signed-in shopper has shipped to (`/account/addresses`): the ship-tos of their own
 * orders and, for a consumer customer with their address, the address book's entries
 * (`StorefrontRpc.shopperAddresses`, by the session's address alone). Only a book entry can be
 * forgotten (`forgetAddress`, a plain form post, idempotent); an order's place is that order's
 * record, so it is shown without the button. The ids the page posts are the engine's, and the engine
 * only ever finds one among what the session's address owns.
 */

import type { ShopperAddress } from '@commerceworker/core';
import { Empty } from '@commerceworker/ui/page';
import { MapPin } from 'lucide-react';
import { data, Form, redirect, useLoaderData } from 'react-router';
import { AccountPageRefusal } from '~/components/account-refusal';
import { SignedInShell } from '~/components/account-shell';
import { engine } from '~/lib/env.server';
import { overBudget } from '~/lib/rate-limit';
import {
  accountCall,
  accountHeaders,
  clientKey,
  PRIVATE_HEADERS,
  toSignIn,
} from '~/lib/shopper.server';
import { pageTitle } from '~/lib/store-name';
import type { Route } from './+types/account-addresses';

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: pageTitle(matches, 'Your addresses') },
  { name: 'robots', content: 'noindex' },
];

/** Each list reads the ship-to of a few orders, so it has a budget of its own per client. */
const budget = (request: Request) => overBudget('API_LIMIT', `addresses:${clientKey(request)}`);

export async function loader({ request }: Route.LoaderArgs) {
  const { secret, actor } = await accountCall(request);
  const limited = await budget(request);
  if (limited) throw limited;
  const found = await engine().shopperAddresses(secret, actor);
  if (!found) throw toSignIn();
  return data(found, { headers: PRIVATE_HEADERS });
}

export async function action({ request }: Route.ActionArgs) {
  const { secret, actor } = await accountCall(request);
  const limited = await budget(request);
  if (limited) throw limited;
  const id = (await request.formData()).get('forget');
  // The engine decides what can go; a repeat, or an id that isn't the shopper's, forgets nothing.
  if (typeof id === 'string' && id.length <= 100) await engine().forgetAddress(secret, actor, id);
  return redirect('/account/addresses', { status: 303, headers: PRIVATE_HEADERS });
}

export function headers({ errorHeaders }: Route.HeadersArgs) {
  return accountHeaders({ errorHeaders });
}

export const ErrorBoundary = AccountPageRefusal;

/** An address as the lines a person writes it on. */
export function addressLines(a: ShopperAddress): string[] {
  const place = [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [a.name, a.line1, a.line2, place, a.country].filter((l): l is string => !!l);
}

export default function AccountAddressesPage() {
  const { email, addresses } = useLoaderData<typeof loader>();
  return (
    <SignedInShell email={email}>
      <h1 className="text-xl tracking-title">Your addresses</h1>
      <p className="mt-2 text-muted-foreground">
        Where your orders have shipped. Checkout offers them when you are signed in.
      </p>
      {addresses.length === 0 ? (
        <Empty
          icon={<MapPin aria-hidden="true" />}
          title={<h2 className="text-lg tracking-title">No addresses yet</h2>}
          className="mt-6"
        >
          Addresses show here once an order has shipped to one.
        </Empty>
      ) : (
        <ul className="mt-4 divide-y border-y">
          {addresses.map((a) => {
            const lines = addressLines(a);
            return (
              <li key={a.id} className="flex items-start justify-between gap-4 py-4">
                <p className="min-w-0">
                  {lines.map((line, i) => (
                    <span key={`${i}-${line}`} className="block break-words">
                      {line}
                    </span>
                  ))}
                  {a.source === 'order' ? (
                    <span className="mt-1 block text-muted-foreground text-sm">
                      From your orders
                    </span>
                  ) : null}
                </p>
                {a.source === 'book' ? (
                  <Form method="post" className="shrink-0">
                    <button
                      type="submit"
                      name="forget"
                      value={a.id}
                      aria-label={`Forget ${a.line1}`}
                      className="inline-flex min-h-11 items-center rounded-full border px-5 text-base"
                    >
                      Forget
                    </button>
                  </Form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 text-muted-foreground text-sm">
        Forgetting an address removes it from the ones saved for checkout. Past orders keep the
        address they shipped to.
      </p>
    </SignedInShell>
  );
}
