# @commerceworker/sdk-commerce

> A private workspace package. It ships on npm inside [`@commerceworker/sdk`](../sdk/README.md) as `@commerceworker/sdk/commerce` and `@commerceworker/sdk/commerce/webhooks`; the examples below use those names.

A typed client for CommerceWorker's REST API (`/api/v1`): orders, carts, catalog, pricing, B2B and
webhook subscriptions. No dependencies; it runs on `fetch`. Keep it on a server: an API token never
belongs in a browser or app bundle.

```ts
import { createCommerceClient } from '@commerceworker/sdk/commerce';

const commerce = createCommerceClient({
  baseUrl: 'https://app.your-workspace.commerceworker.com',
  token: process.env.COMMERCEWORKER_API_TOKEN!,
});

const { orderId } = await commerce.startOrder(
  { flowId: 'checkout', input: { model: 'b2c' } },
  { idempotencyKey: 'order-42' },
);
for await (const order of commerce.paginate('list_orders', { status: 'running' })) {
  console.log(order);
}
```

```ts
import { verifyCommerceWebhook } from '@commerceworker/sdk/commerce/webhooks';

const result = await verifyCommerceWebhook(rawBody, request.headers.get('x-commerceworker-signature'), secret);
if (!result.ok) return new Response(result.reason, { status: 400 });
```

The operations and their types are generated from the API's OpenAPI document (`src/generated`);
maintainers regenerate them with `pnpm sdk:generate`. See `docs/content/sdks.md`.
