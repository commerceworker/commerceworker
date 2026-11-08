# @commerceworker/sdk-management

> A private workspace package. It ships on npm inside [`@commerceworker/sdk`](../sdk/README.md) as `@commerceworker/sdk/management`; the examples below use that name.

The client for CommerceWorker's Management API: content types, entries and their versions, the
asset library, bulk jobs, releases, scheduled actions, webhooks, environments and keys. No
dependencies; it runs on `fetch`. Keep it on a server: a Management token never belongs in a
browser or app bundle.

```sh
npm install @commerceworker/sdk
```

```ts
import { createManagementClient } from '@commerceworker/sdk/management';

const cma = createManagementClient({
  baseUrl: 'https://api.your-workspace.commerceworker.com',
  space: 'your-space',
  environment: 'main',
  token: process.env.COMMERCEWORKER_CMA_TOKEN!,
});

const { entry } = await cma.entries.create({
  contentTypeApiId: 'article',
  fields: { title: { 'en-US': 'Hello, world' } },
});
await cma.entries.publish(entry.id, { expectedVersion: entry.currentVersion });
```

The client is exactly as powerful as its token; the server checks every call. A read after the
client's own write sees it (it echoes the api's `x-cw-bookmark`).

## Assets

```ts
// Any size: one signed upload up to 100 MiB, a multipart upload above it, each part retried.
const asset = await cma.assets.upload(
  { fileName: 'hero.jpg', contentType: 'image/jpeg', body: file },
  { onProgress: ({ loaded, total }) => console.log(`${loaded}/${total}`) },
);
await cma.assets.setMetadata(asset.id, { altText: { 'en-US': 'A hand holding a cup' } });
await cma.assets.publish(asset.id);

// A new file, whatever its size: the asset at its next version.
await cma.assets.replaceFile(asset.id, {
  fileName: 'hero-v2.jpg',
  contentType: 'image/jpeg',
  body,
});

for await (const a of cma.assets.iterate({ kind: 'image' })) {
  // the whole library, fetched a page at a time as the loop reads
}
for await (const a of cma.assets.collections.iterateAssets(collectionId)) {
  // a collection's members, in its order
}
```

`assets` also has `versions` and `restoreVersion`, `setRights`, `usage`, `transformUrl`,
`generateAltText` and `autoTag`, `videos`, `bulk` (followed with `bulkJobs`), and the `folders`,
`collections`, `shareLinks`, `zips` and `renditions` namespaces. `Asset` is fully typed: `file`
(`AssetFile`, with `video` on a hosted video), `metadata`, `rights`, `ingestStatus` and the rest.

A signed upload URL stores its file once; a second `PUT` through it is a `412`. On a retry,
`upload` and `replaceFile` count that 412 as stored (an earlier attempt's bytes landed and only its
answer was lost); on a first attempt they throw it.

## Errors

A failed call throws `ManagementError` with `status`, the API's error `code`, the parsed `error`
object and the raw `body`. Guards narrow it to the details a code carries:

```ts
import { isAssetInUse, isAssetRightsError } from '@commerceworker/sdk/management';

try {
  await cma.assets.archive(id); // deleting needs an archived asset
  await cma.assets.delete(id);
} catch (err) {
  if (isAssetInUse(err)) {
    console.log(`Linked from ${err.error.total} entries`, err.error.usage);
  } else throw err;
}
```

`isAssetInUse` (`usage`, `total`), `isAssetRightsError` (`embargoUntil` or `expiresAt`),
`isValidationError` (`issues`), `isConflict`, `isNotFound` and `isRateLimited`.

## Docs

- [SDKs guide](https://docs.commerceworker.com/content/guides/sdks/#writing-content)
- [Media and assets](https://docs.commerceworker.com/content/guides/media/)
- [REST API errors](https://docs.commerceworker.com/content/reference/rest-api/#errors)
