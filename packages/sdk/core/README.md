# @commerceworker/sdk-core

> A private workspace package. It ships on npm inside [`@commerceworker/sdk`](../sdk/README.md) as `@commerceworker/sdk`; the examples below use that name.

The framework-agnostic client for CommerceWorker's read-only Delivery API (and Preview, for
drafts). No dependencies; it runs on `fetch` in Node, browsers, Workers and other edge runtimes.

```sh
npm install @commerceworker/sdk
```

```ts
import { createDeliveryClient, imageProps } from '@commerceworker/sdk';

const client = createDeliveryClient({
  baseUrl: 'https://cdn.your-workspace.commerceworker.com',
  space: 'your-space',
  environment: 'main',
  token: process.env.COMMERCEWORKER_CDA_TOKEN!,
});

const article = await client.getEntry(id, { locale: 'en-US', include: 1 });
```

## Assets

```ts
const hero = await client.getAsset(heroId, { locale: 'en-US' });

// Every <img> attribute: src, srcSet, sizes, width, height, alt, loading, decoding,
// fetchPriority, and style.objectPosition (focal point) / style.backgroundColor (placeholder).
const props = imageProps(hero, { sizes: '(min-width: 960px) 960px, 100vw', priority: true });

for await (const asset of client.iterateAssets({ kind: 'image' })) {
  // every published image, fetched a page at a time
}
for await (const asset of client.iterateCollection(collectionId)) {
  // a collection's published members, in its order
}
```

Use the URLs an asset carries as they are: they're signed, so a URL built or edited by hand is a
`404`. `imageProps`, `assetUrl` and `srcset` only ever pick among them. A failed request throws
`DeliveryError` with `status`, the API's error `code` and the parsed `body`.

**Local development.** A local stack has no media origin, so an asset's `url` is the api's signed,
short-lived URL, `srcset` is empty and `renditions` is `{}`. `imageProps` then returns `src`
alone; the same code renders, without responsive widths.

## Docs

- [SDKs guide](https://docs.commerceworker.com/content/guides/sdks/)
- [Delivering assets](https://docs.commerceworker.com/content/guides/delivering-assets/), including
  [building an image component](https://docs.commerceworker.com/content/guides/delivering-assets/#build-an-image-component)
- [Reading content](https://docs.commerceworker.com/content/guides/reading-content/)
