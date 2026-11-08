# @commerceworker/sdk-codegen

> A private workspace package. It ships on npm inside [`@commerceworker/sdk`](../sdk/README.md) as `@commerceworker/sdk/codegen`; the examples below use that name.

Generates TypeScript types from your space's content model, so `entry.fields.title` is a `string`
rather than `unknown`. The published package runs it as `commerceworker types`; the workspace's own
`commerceworker-codegen` bin is for local use.

```sh
npm install -D @commerceworker/sdk

npx commerceworker types --out src/generated/content-types.ts
```

```ts
import type { ArticleFields } from './generated/content-types.js';

const article = await client.getEntry<ArticleFields>(id, { locale: 'en-US', include: 1 });
article.fields.title; // string
```

Each content type becomes a delivery shape (`ArticleFields`) and a management shape
(`ArticleDraftFields`, keyed by locale).

## Assets

An asset field in a delivery shape is `AssetLink | DeliveredAsset`: the link, or the asset itself
when `include` embeds it. `DeliveredAsset` is the same shape as `@commerceworker/sdk`'s, so an
embedded asset goes straight into its `imageProps`:

```ts
import { imageProps } from '@commerceworker/sdk';

const hero = article.fields.hero;
const props = hero && 'url' in hero ? imageProps(hero, { sizes: '100vw' }) : undefined;
```

**Local development.** A local stack has no media origin, so an embedded asset has an empty
`srcset` and no renditions, and `imageProps` gives the one signed `src`.

## Docs

- [SDKs guide](https://docs.commerceworker.com/content/guides/sdks/#typed-content)
- [Delivering assets](https://docs.commerceworker.com/content/guides/delivering-assets/)
