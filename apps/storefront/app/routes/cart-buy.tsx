/**
 * An external cart, for the buyer it was opened for (a punchout session): the same live cart as
 * staff see, without staff controls, and with the button that sends it back to the buyer's system.
 * Only the cookie a redeemed start link set admits them (lib/cart-guest.server.ts), to this cart
 * alone. The page may be framed by the origins the plugin named, and its return form posts only
 * to the cart's return URL (`EMBED_HEADER`, folded into the CSP by entry.server.tsx).
 */

import { CartView } from '@commerceworker/cart/view';
import { guestCartOpen } from '@commerceworker/core';
import { EMBED_HEADER } from '@commerceworker/security/csp';
import { data, type ShouldRevalidateFunctionArgs, useLoaderData } from 'react-router';
import { CartRefusal } from '~/components/cart-refusal';
import { cartGuest, cartRefusal } from '~/lib/cart-guest.server';
import { engine } from '~/lib/env.server';
import { signedActor } from '~/lib/principal.server';
import { pageTitle } from '~/lib/store-name';
import type { Route } from './+types/cart-buy';

export const meta: Route.MetaFunction = ({ loaderData: d, matches }) => [
  { title: pageTitle(matches, d?.snapshot.cart?.title ?? 'Cart') },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const guest = await cartGuest(request, params.cartId);
  if (!guest) throw cartRefusal('Open this cart from your purchasing system.', 401);
  // The engine admits the buyer only to the cart they were let into, and answers null otherwise.
  const actor = await signedActor(
    { kind: 'guest', id: guest.id, name: guest.name },
    `cart:${params.cartId}`,
  );
  const snapshot = await engine().cartSnapshot(params.cartId, actor);
  const cart = snapshot?.cart;
  const external = cart?.external;
  if (!snapshot || !cart || !external) throw cartRefusal('This cart doesn’t exist.', 404);
  // The cart's socket refuses the buyer once it closes (the engine's cartGate); say so here
  // rather than render a cart that can't connect. A returned cart stays until its time, to post
  // it again.
  if (!guestCartOpen({ status: cart.status, expiresAt: external.expiresAt }, Date.now()))
    throw cartRefusal(
      'This cart has closed. Go back to your purchasing system and open the catalog again.',
      410,
    );
  const customerName = cart.customerId
    ? await engine().cartCustomerName(params.cartId, actor)
    : null;
  return data(
    {
      snapshot,
      guest,
      customerName,
    },
    {
      headers: {
        'cache-control': 'no-store',
        [EMBED_HEADER]: JSON.stringify({
          frameAncestors: external.frameOrigins,
          formAction: [external.returnUrl],
        }),
      },
    },
  );
}

export function headers({ errorHeaders, loaderHeaders }: Route.HeadersArgs) {
  return errorHeaders ?? loaderHeaders;
}

export const ErrorBoundary = CartRefusal;

export function shouldRevalidate({ currentParams, nextParams }: ShouldRevalidateFunctionArgs) {
  return currentParams.cartId !== nextParams.cartId;
}

export default function CartBuyPage() {
  const { snapshot, guest, customerName } = useLoaderData<typeof loader>();
  return (
    <main id="main" className="min-h-dvh bg-background">
      <CartView
        key={snapshot.cart!.id}
        snapshot={snapshot}
        customerName={customerName}
        mode="guest"
        meId={guest.id}
      />
    </main>
  );
}
