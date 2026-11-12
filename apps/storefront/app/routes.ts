import { type RouteConfig, route } from '@react-router/dev/routes';

export default [
  // An external cart's buyer (a punchout session): a one-time start link, then the cart itself,
  // outside any app shell and sign-in (lib/cart-guest.server.ts).
  route('cart/start/:cartId/:token', 'routes/cart-start.tsx'),
  route('cart/:cartId', 'routes/cart-buy.tsx'),
  // A hosted checkout's buyer: a one-time start link an operator made (`create_checkout`), then the
  // checkout itself, outside any app shell and sign-in (lib/hosted-checkout.server.ts).
  route('checkout/start/:id/:token', 'routes/checkout-start.tsx'),
  route('checkout/:id', 'routes/checkout.tsx'),
  route('checkout/:id/placed', 'routes/checkout-placed.tsx'),
  // A cart's files and its product search, for the cart's buyer; staff reach theirs on the admin
  // (lib/cart-files.server.ts, packages/cart/src/files.ts).
  route('carts/:cartId/attachments', 'routes/cart-attachments.ts'),
  route('carts/:cartId/attachments/:attachmentId', 'routes/cart-attachment.ts'),
  route('carts/:cartId/products', 'routes/cart-products.ts'),
] satisfies RouteConfig;
