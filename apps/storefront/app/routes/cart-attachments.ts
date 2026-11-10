/** Adding a file to a cart: a multipart POST from the cart page (packages/cart/src/cart-view.tsx). */

import { uploadAttachment } from '@commerceworker/cart/files';
import { data } from 'react-router';
import { cartBuyer, cartFiles } from '~/lib/cart-files.server';
import type { Route } from './+types/cart-attachments';

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await cartBuyer(request, params.cartId);
  if (!actor) throw data({ error: 'Unauthorized' }, { status: 401 });
  const r = await uploadAttachment(cartFiles(), params.cartId, actor, await request.formData());
  if (!r.ok) throw data({ error: r.error }, { status: r.status });
  return { ok: true };
}
