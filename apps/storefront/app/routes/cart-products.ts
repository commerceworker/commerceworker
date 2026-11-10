/**
 * Products to add to a cart, for its search field (packages/cart/src/cart-view.tsx): the buyer the
 * cart admitted, by the cookie their start link set for this cart alone. The engine searches what
 * the cart's quote prices and decides who may (`searchCartProducts`); this only says who asks.
 */

import { productSearchBudgetKey, searchProducts } from '@commerceworker/cart/files';
import { data } from 'react-router';
import { cartBuyer, cartFiles } from '~/lib/cart-files.server';
import { overBudget } from '~/lib/rate-limit';
import type { Route } from './+types/cart-products';

export async function loader({ request, params }: Route.LoaderArgs) {
  const actor = await cartBuyer(request, params.cartId);
  if (!actor) throw data({ error: 'Unauthorized' }, { status: 401 });
  const limited = await overBudget('API_LIMIT', productSearchBudgetKey(params.cartId, actor));
  if (limited) throw limited;
  const r = await searchProducts(
    cartFiles(),
    params.cartId,
    actor,
    new URL(request.url).searchParams.get('q'),
  );
  if (!r.ok) throw data({ error: r.error }, { status: r.status });
  return data(r.page, { headers: { 'cache-control': 'private, no-store' } });
}
