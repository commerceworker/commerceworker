# @commerceworker/sdk

The CommerceWorker SDK, in one package: read and render content in any framework or runtime,
verify webhooks, manage a space, generate types, and the `commerceworker` command. Import only the
subpath you use; nothing else ends up in your bundle.

```sh
npm install @commerceworker/sdk
```

```ts
import { createDeliveryClient, imageProps } from '@commerceworker/sdk';
import { toHtml } from '@commerceworker/sdk/rich-text';

const client = createDeliveryClient({
  baseUrl: 'https://cdn.your-workspace.commerceworker.com',
  space: 'your-space',
  environment: 'main',
  token: process.env.COMMERCEWORKER_CDA_TOKEN!,
});

const article = await client.getEntry(id, { locale: 'en-US', include: 1 });
const html = toHtml(article.fields.body, { entryHref: (t) => `/${t.fields?.slug}` });
```

| Import                            | What it is                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@commerceworker/sdk`              | The Delivery and Preview client, `imageProps` for delivered assets. Runs on `fetch` anywhere       |
| `@commerceworker/sdk/rich-text`    | `toHtml`, `toMarkdown`, `toPlainText`, `excerpt` for `RichTextDocument` trees: escaped, safe links |
| `@commerceworker/sdk/webhooks`     | `verifyWebhookSignature` for signed webhook deliveries                                             |
| `@commerceworker/sdk/redirects`    | Resolve the space's redirects                                                                      |
| `@commerceworker/sdk/inline-edit`  | Inline editing on previews                                                                         |
| `@commerceworker/sdk/edge`         | A tiny Delivery client for edge functions and devices: one locale, flat fields                     |
| `@commerceworker/sdk/management`   | The Management API client. Server only: a Management token never belongs in a bundle               |
| `@commerceworker/sdk/commerce`     | The commerce API client: orders, carts, catalog, pricing and B2B, typed from the OpenAPI document. Server only |
| `@commerceworker/sdk/commerce/webhooks` | `verifyCommerceWebhook` for signed commerce webhook deliveries                                  |
| `@commerceworker/sdk/react`        | React hooks (`useEntry`, `useEntries`, `useAsset`, …) and `<Image>`. Needs `react`                 |
| `@commerceworker/sdk/vue`          | Vue 3 composables and `<CwImage>`. Needs `vue`                                                     |
| `@commerceworker/sdk/react-native` | An offline entry cache with delta sync and image helpers for React Native                          |
| `@commerceworker/sdk/codegen`      | Generate TypeScript types from a content model, programmatically                                   |

React and Vue are optional peer dependencies: install the one you use.

## The `commerceworker` command

Sign in to a workspace, keep the content model in a file, read and write entries, upload assets,
import files and generate types. Every command takes `--json` for scripts and agents. Node 24 or
later.

```sh
npx commerceworker login --url https://api.your-workspace.commerceworker.com
npx commerceworker model export --out content-model.ts
npx commerceworker types --out src/generated/content-types.ts
```

## Docs

- [SDKs guide](https://docs.commerceworker.com/content/guides/sdks/)
- [Your own frontend](https://docs.commerceworker.com/content/guides/your-own-frontend/)
- [CLI](https://docs.commerceworker.com/content/guides/cli/)
