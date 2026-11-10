/** One of a cart's files, downloaded, for the cart's own buyer (`downloadAttachment` sets the headers). */

import { downloadAttachment } from '@commerceworker/cart/files';
import { cartBuyer, cartFiles } from '~/lib/cart-files.server';
import type { Route } from './+types/cart-attachment';

export async function loader({ request, params }: Route.LoaderArgs) {
  const actor = await cartBuyer(request, params.cartId);
  if (!actor) return new Response('Unauthorized', { status: 401 });
  return (
    (await downloadAttachment(cartFiles(), params.cartId, params.attachmentId, actor)) ??
    new Response('Not found', { status: 404 })
  );
}
