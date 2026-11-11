# SDKs

Method-level reference for the client packages. For a task-oriented tour, see the
[SDKs guide](https://docs.commerceworker.com/content/guides/sdks/).

Everything ships as one npm package, `@commerceworker/sdk` (`packages/sdk/sdk`), with a subpath per
module and the `commerceworker` CLI as its binary. In the workspace each module is its own private
package under `packages/sdk/*` (`sdk-core`, `sdk-web`, …); the published package bundles them with
tsup and copies their `.d.ts` files (`packages/sdk/sdk/scripts/types.ts`), so a user only ever sees
`@commerceworker/sdk`. `scripts/sdk-packages.ts` packs it, loads and type-checks every subpath
from the tarball, and publishes it on an `sdk-v<version>` tag.

Five modules target the read-only **Delivery API**, one, `@commerceworker/sdk/management`,
targets the **Management API** for programmatic authoring, and `@commerceworker/sdk/codegen`
generates typed field shapes. Point Delivery clients at the delivery host, `https://cdn.<domain>`
(cached; served by the delivery worker), and the Management client and codegen at the api host,
`https://api.<domain>`. A Delivery client in `preview: true` mode reads `/preview/*`, which only the
api serves, so give it the api host. The Delivery clients share a model (`DeliveredEntry`,
`SearchHit`) but differ in surface and footprint.

## Choosing a client

| Use case                                                            | Import                            |
| ------------------------------------------------------------------- | --------------------------------- |
| Node/SSR/backend, or building your own integration                  | `@commerceworker/sdk`         |
| React apps                                                          | `@commerceworker/sdk/react`          |
| Vue 3 / Nuxt apps                                                   | `@commerceworker/sdk/vue`          |
| Edge functions, constrained devices, single-locale, minimal payload | `@commerceworker/sdk/edge`         |
| React Native apps with offline sync                                 | `@commerceworker/sdk/react-native` |
| Programmatic authoring/publishing (writes)                          | `@commerceworker/sdk/management`   |
| Storefront reads: products, categories, faceted listings, search     | `@commerceworker/sdk/catalog`      |
| Commerce: orders, carts, catalog, pricing, B2B, webhook subscriptions | `@commerceworker/sdk/commerce`   |
| The `commerceworker` command for commerce (orders, flows, approvals, `run <operationId>`) | the `commerceworker` bin; built on `@commerceworker/sdk/commerce` (see `developer-tooling.md`) |
| Verifying a commerce webhook delivery                               | `@commerceworker/sdk/commerce/webhooks` |
| Types for entry fields                                              | `@commerceworker/sdk/codegen`      |
| Rendering rich text to HTML, Markdown or plain text (any framework) | `@commerceworker/sdk/rich-text`    |

The five Delivery modules are **read-only**. For writes and publishing, use
`@commerceworker/sdk/management`, call the Management API directly, or drive the MCP tools
([MCP server](./mcp.md)).

## `@commerceworker/sdk` — framework-agnostic Delivery client

Zero-dependency client for Node, SSR, edge runtimes, and tests.

```ts
import { createDeliveryClient } from '@commerceworker/sdk';

const client = createDeliveryClient({
  baseUrl: 'https://cdn.example.com',
  space: 'space-1',
  environment: 'main',
  token: '<cda-token>',
  fetch, // optional: inject a fetch (SSR/edge/test)
  cacheTtlMs: 0, // optional in-memory cache (0 = off)
  preview: false, // optional: read drafts from the Preview API (see Inline editing)
  locale: 'en-US', // optional: locale stamped onto inline-edit refs
  readYourWrites: true, // optional, preview only: echo x-cw-bookmark (default true)
  bookmark: undefined, // optional, preview only: a bookmark to start from
});
```

API:

```ts
client.getEntry<F>(id, { locale?, include? }): Promise<DeliveredEntry<F>>
client.getSingleton<F>(contentType, { locale?, include? }): Promise<DeliveredEntry<F>> // a singleton type's one entry; 404 DeliveryError otherwise
client.listEntries<F>(query?): Promise<{ items: DeliveredEntry<F>[]; total: number; nextCursor? }>
client.search(query, { topK? }): Promise<SearchHit[]>
client.getAsset(id, { locale? }): Promise<DeliveredAsset>
client.listAssets({ limit?, cursor?, skip?, kind?, tag?, folder?, locale? }): Promise<AssetPage>
client.iterateAssets(query?): AsyncGenerator<DeliveredAsset>   // every page, following nextCursor
client.getCollection(id, { limit?, cursor?, locale? }): Promise<DeliveredCollection>  // Delivery only
client.iterateCollection(id, { limit?, cursor?, locale? }): AsyncGenerator<DeliveredAsset>
client.searchAssets(q, { limit?, kind?, tag?, folder?, locale? }): Promise<AssetSearchPage>  // Delivery only
client.listTags({ locale?, contentType? }): Promise<DeliveredTag[]>      // Delivery only
client.getTag(slug, { locale?, contentType? }): Promise<DeliveredTag>
client.listConcepts({ scheme?, locale?, contentType? }): Promise<DeliveredConcept[]>
client.getConcept(slug, { scheme?, locale?, contentType? }): Promise<DeliveredConcept>
client.redirects(): Promise<DeliveredRedirect[]>         // Delivery only: the enabled set, to apply
client.resolveRedirect(path, { locale? }): Promise<RedirectMatch | null>  // Delivery only; null on 404
client.menus(): Promise<DeliveredMenuSummary[]>          // Delivery only: { handle, name, description? }
client.menu(handle, { locale? }): Promise<DeliveredMenu> // Delivery only: resolved; 404 DeliveryError for an unknown handle
client.routes(): Promise<DeliveredRoute[]>               // Delivery only: { contentType, urlPattern } per published type
client.sitemap({ from?, limit?, base? }): Promise<SitemapPage>  // Delivery only: { items, next }, published pages and their paths
client.query(): EntryQueryBuilder<F>     // fluent builder; .tagged(...slugs) for an archive,
                                         // .references(field, ...ids), .linksTo(...ids), .or(...conditions)
client.editable(entry, field, { locale? }): Record<string, string>   // see Inline editing
client.clearCache(): void
client.bookmark: string | undefined     // read-your-writes position (preview); assignable
```

- `EntryQuery` = `{ contentType?, locale?, include?, limit?, skip?, cursor?, since?, filters?, where?, linksToEntry?, order?, select?, search?, tags? }`.
  `where` (an `EntryWhere` tree of `and`/`or` groups) is sent as the `where` parameter's JSON,
  `linksToEntry` as `links_to_entry`; a filter `field` may be a component path (`seo.title`).
  Delivery pages with `skip`; Preview (`preview: true`) pages with `cursor`, the last page's
  `nextCursor`, and refuses `skip` (`422`).
  `tags` (slugs) sends `metadata.tags.slug[in]`, and a filter on `metadata.*` is sent unprefixed.
- `DeliveredTag` = `{ id, slug, label, labels?, description, count, countsByContentType }`;
  `DeliveredConcept` adds `schemeId` and `broaderId`.
- `filters` use the same operators as the HTTP query language (`eq`, `ne`, `in`, `match`, etc.).
- The fluent builder reads naturally:
  `client.query().contentType('article').locale('en-US').limit(10).fetch()`.
- `include` controls reference embedding depth (linked entries are nested in `fields`, including
  inside components and rich-text `data.target`s).
- `client.search()` hits `/search` with hybrid mode by default (same as the API).
- Failed requests throw `DeliveryError` with the `status`, the API's error `code` when the body
  names one (`{ error: { code, message } }`; the delivery gateway's `{ error: '…' }` refusals have
  none), the parsed `body` (`undefined` if it wasn't JSON) and the server's message in `message`.
- `iterateAssets(query)` and `iterateCollection(id, opts)` are `async` generators: each fetches a
  page (`limit`) when the loop needs the next item and follows `nextCursor` to the last page, so
  `break` stops fetching. A `skip` applies to the first page only, and a cursor the server
  repeats (the starting `cursor` included) throws a plain `Error` rather than looping.
- `getAsset` / `listAssets` read `/assets` (or `/preview/…/assets` with `preview: true`) and return
  the delivered asset shape (see [API reference](./api-reference.md#delivery-api-cda));
  `AssetPage` is `{ items, total, nextCursor? }`, and a `cursor` wins over `skip`.
- Pure helpers, also on the client: `assetUrl(asset, { rendition?, width? })` returns the
  rendition's URL (`undefined` if the space has none by that name), the ladder step at or above
  `width` (the largest past it, the original without a ladder), or the original; `srcset(asset)`
  returns `"url 320w, url 640w, …"` (empty without a ladder). Neither adds a query parameter, so
  signed and immutable URLs stay intact.
- `embedCard(node)` turns a rich-text `embed` node into a link card `{ href, title, provider,
  providerName, kind, authorName?, thumbnail? }` (`thumbnail` is `<img>` attributes: `src`,
  `width?`, `height?`, `alt: ''`, lazy, `referrerPolicy: 'no-referrer'`), or `undefined` for any
  other node or a non-https URL. The title falls back to the URL without its scheme; an unknown
  provider is named by its id. It is the safe default; a front end that wants a player builds it
  from `provider` and `url` (`packages/sdk/core/src/embed.ts`).
- `imageProps(asset, { sizes?, width?, rendition?, locale?, priority? })` (also on the client)
  returns the `<img>` attributes `{ src, srcSet?, sizes?, width?, height?, alt, loading,
  decoding, fetchPriority?, style: { objectPosition?, backgroundColor? } }`, or `undefined` for
  an asset with no image (audio, documents, a video without `video.thumbnailUrl`, which is a
  video's `src`). `srcSet` is the ladder with `sizes` (default `(max-width: Wpx) 100vw, Wpx` with
  `width`, else `100vw`); `src` is the step at or above `width`, else `url`; `width`/`height` are
  the asset's, scaled to `width`; a found `rendition` is the only `src`, with only the target
  `width`. When the image is wider than the ladder's last step (the ladder stops below its own width), the original `url` is the top
  `srcSet` candidate. `alt` is
  `localizedText(altText, locale)`, else the title, else `''` (decorative); `localizedText`
  takes a flattened string, the `locale` key of a map, or without a `locale` the map's first
  non-empty value. `objectPosition` is the focal point in percent, clamped to 0–100;
  `backgroundColor` is `placeholder.dominantColor` only when it is `#rrggbb`; URLs that aren't
  http(s) or relative are dropped. `priority` gives `loading: 'eager'` and `fetchPriority:
  'high'`, else `'lazy'`. With no ladder (no media origin, as in local development) it is `src`
  alone. The implementation is `packages/sdk/core/src/image.ts`.
- With `preview: true` the client keeps [read-your-writes](#read-your-writes) by default. A
  Delivery client never sends a bookmark: the delivery host is cached, reads replicas by design
  and doesn't accept the header.
- `DeliveredAsset.placeholder` is `{ thumbhash, dominantColor } | null`: the ThumbHash (base64;
  decode it with the `thumbhash` package) and `#rrggbb` ingest computed for a raster image, `null`
  for videos, other kinds and assets processed before it existed. Codegen's `DeliveredAsset`
  prelude declares it.

- **Redirects.** CommerceWorker serves no site, so redirects are data a front end applies.
  `client.redirects()` fetches the enabled set once; `resolveRedirect(path, { locale? })` asks
  Delivery about one path (one request each, so prefer the set). The subpath
  `@commerceworker/sdk/redirects` (`packages/sdk/core/src/redirects.ts`, zero dependencies)
  matches them locally with Delivery's rules (kept in step by a test):
  `createRedirectMatcher(set).match(pathOrPathWithQuery, locale?)`;
  `createRedirectHandler(source, { ttlMs?, locale? })`, a front-door helper that returns
  `(request) => Promise<Response | null>` (the redirect `Response`, or `null` to serve the request
  as usual), caching the set for `ttlMs` (default 60 000) and keeping the last set while a refresh
  runs or fails; `locale` is `(request) => string | undefined`; and
  `applyRedirects(request, redirects, { locale? })` for a one-off. See
  [the guide](https://docs.commerceworker.com/content/guides/redirects/).
- **Menus.** `client.menus()` lists the navigation menus' handles; `client.menu(handle, { locale? })`
  returns one resolved for rendering: each `DeliveredMenuItem` has `label`, `url` (`null` for a term
  link), optional `target`, `attrs`, `entry` or `term`, and `children`. Only published entries
  appear; an item whose link doesn't resolve is dropped and its children lifted. See
  [the guide](https://docs.commerceworker.com/content/guides/menus/).

Shapes:

```ts
interface DeliveredEntry<F = Fields> {
  id: string;
  contentType: string;
  fields: F;
  publishedAt: string;
}
interface SearchHit {
  entryId: string;
  score: number;
  snippet: string;
}
type DeliveryClient = ReturnType<typeof createDeliveryClient>;
```

## `@commerceworker/sdk/react` — React hooks

Hooks layered over `@commerceworker/sdk`. Provide a client once via context, then call hooks.

```tsx
import { createDeliveryClient } from '@commerceworker/sdk';
import {
  CommerceworkerProvider,
  useEntry,
  useEntries,
  useSemanticSearch,
  useEditable,
  InlineEditor, // inline editing — see below
} from '@commerceworker/sdk/react';

const client = createDeliveryClient({ baseUrl, space, environment, token });

function App() {
  return (
    <CommerceworkerProvider client={client}>
      <YourApp />
    </CommerceworkerProvider>
  );
}
```

Hooks (all return `AsyncState<T> = { data?: T; error?: Error; loading: boolean }`):

- `useEntry<F>(id, { locale?, include? })`
- `useEntries<F>(query?)`
- `useAsset(id, { locale? })`
- `useSemanticSearch(query, { topK? })` — returns `[]` for an empty query (no request)
- `useDeliveryClient()` — the injected client
- `useEditable()` — returns `editable(entry, field, locale?)`, which spreads the inline-edit mark
  onto an element (see [Inline editing](#inline-editing))

`<InlineEditor adminUrl onEdit defaultEnabled toggle />` mounts the click-to-edit overlay and
renders no markup. `<Image asset sizes? width? rendition? locale? priority? …img />` renders
`imageProps(asset, …)` as an `<img>` (nothing while `asset` is unset, or for an asset with no
image); other `<img>` attributes pass through, and an `alt` or `style` given wins over or merges
into its own. `createDeliveryClient`, `DeliveryError`, `assetUrl`, `srcset`, `imageProps` and
`localizedText` are re-exported, so `@commerceworker/sdk/react` alone is enough.

SSR-safe: no fetch happens on the server unless a hook is actually invoked.

## `@commerceworker/sdk/vue` — Vue 3 composables

The same surface as the React hooks, as composables. Install the client once as an app
plugin; inputs accept plain values, refs, or getters and re-fetch on change.

```ts
// main.ts (Nuxt: inside a plugin — nuxtApp.vueApp.use(...))
import { createDeliveryClient } from '@commerceworker/sdk';
import { createCommerceworker } from '@commerceworker/sdk/vue';

app.use(createCommerceworker(createDeliveryClient({ baseUrl, space, environment, token })));
```

```vue
<script setup lang="ts">
import { useEntry } from '@commerceworker/sdk/vue';
const props = defineProps<{ id: string }>();
// Getter input: re-fetches whenever props.id changes.
const { data, error, loading } = useEntry(() => props.id, { locale: 'en-US' });
</script>
```

Composables (all return `AsyncRefs<T> = { data, error, loading }` as refs):

- `useEntry<F>(id, { locale?, include? })`
- `useEntries<F>(query?)`
- `useAsset(id, { locale? })`
- `useSemanticSearch(query, { topK? })` — returns `[]` for an empty query (no request)
- `useDeliveryClient()` — the injected client

`<CwImage :asset sizes width rendition locale priority />` renders `imageProps` as an `<img>`
(`srcset`, `fetchpriority` as attributes), nothing while `asset` is unset; fallthrough `alt`,
`class` and `style` win or merge. The same helpers as `@commerceworker/sdk/react` are re-exported.

Fetching starts on mount (client-side), matching the React hooks' SSR behavior — this
holds outside components too (plugins, stores): on the server nothing fetches. Rapid
input changes are race-safe (stale settlements are discarded) and a re-fetch clears the
previous data. Query tracking is top-level: replace the query or its nested
`filters`/`order` arrays (or pass a getter) — in-place mutation of a nested element is
not observed. For server-fetched Nuxt data, wrap the client's promise methods in
`useAsyncData` instead.

## `@commerceworker/sdk/edge` — tiny single-locale client

Minimal client for edge functions and constrained devices (IoT, wearables, kiosks). Always resolves to **one locale** and supports
field projection to keep payloads small.

```ts
import { createEdgeClient } from '@commerceworker/sdk/edge';

const client = createEdgeClient({ baseUrl, space, environment, token, locale: 'en-US' });

await client.get('entry-42', ['title', 'body']); // pick only these fields
await client.list('article', { limit: 20, pick: ['title'] });
```

Returns `CompactEntry` = `{ id, contentType, fields }` where `fields` is already flattened to the
client locale (no locale nesting). It asks for no `include`, so an asset field is the bare link
`{ id, linkType: 'Asset' }`; fetch the asset with `@commerceworker/sdk`'s `getAsset` (and render it with
`imageProps`) where a device shows images.

## `@commerceworker/sdk/webhooks` — verify a webhook delivery

```ts
import { verifyWebhook } from '@commerceworker/sdk/webhooks';

const event = await verifyWebhook(request, secret); // the event, or null
```

It checks `x-commerceworker-signature` (HMAC-SHA256 of `<timestamp>.<raw body>`) in constant time
with Web Crypto and rejects timestamps outside a window (default 5 minutes, `toleranceMs`).
`verifyWebhookSignature({ body, timestamp, signature, secret })` takes the parts, for frameworks
that parse the request first.

## `@commerceworker/sdk/rich-text` — render rich text anywhere

Rich text is delivered as a `RichTextDocument` tree, never as HTML. Every channel renders it
for itself. This package does that for web and text channels, with no dependencies, in any
framework or runtime.

```ts
import { toHtml, toMarkdown, toPlainText, excerpt } from '@commerceworker/sdk/rich-text';

const html = toHtml(entry.fields.body, {
  entryHref: (target) => `/${target.fields?.slug}`,      // links to other entries
  renderEntry: (target) => renderMyBlock(target),          // embedded entries: your components
  imageSizes: '(min-width: 900px) 800px, 100vw',           // embedded images' `sizes`
});
```

- **Safe by default.** All text is escaped. Links pass `safeLinkUri`, the same rule the CMS
  applies on save (http, https, mailto, tel or relative; `java\tscript:` and entity-hidden
  colons are refused), so the output can go straight into a page.
- **Embedded assets** render as a sized, lazy `<img>` with the delivered `srcset`. Embedded
  entries render nothing until you pass `renderEntry`, because only your app knows what a CTA
  or a product card looks like. Third-party `embed` nodes render as a plain link; render an
  iframe yourself if you want one.
- **Overrides:** `nodes: { paragraph: (node, next) => … }` replaces one node type (return
  `undefined` to keep the default). `next()` renders the node's children. `marks: { bold: (html)
  => … }` does the same for marks.
- **`toMarkdown`** gives CommonMark with GFM tables, for agents, feeds and `.md` endpoints.
  **`toPlainText`** and **`excerpt`** give search text and meta descriptions.

## `@commerceworker/sdk/react-native` — offline Delivery sync

Hooks and helpers for React Native: an offline entry cache, delta sync via `since`, and image
helpers (`imageUrl`, `imageSource`). Builds on `@commerceworker/sdk`.
`imageUrl(asset, { width?, dpr?, rendition? })` takes a delivered asset and returns the rendition
when it exists, else the ladder step for `ceil(width × dpr)` (through `assetUrl`), else `url`; it
never appends parameters to a URL.

```ts
import {
  createDeliveryClient, // re-exported from @commerceworker/sdk
  createOfflineDelivery,
  InMemoryStorage,
  imageSource,
  imageUrl,
  useOfflineEntries,
} from '@commerceworker/sdk/react-native';
```

- **Storage is injected.** `createOfflineDelivery({ client, storage, contentType, locale?, pageSize? })`
  writes through a `Storage` interface (`getItem` / `setItem` / `removeItem`, sync or async), which
  both AsyncStorage and MMKV satisfy. `InMemoryStorage` ships for tests.
- `store.sync()` delta-syncs entries published since the stored cursor and returns
  `{ synced, cursor }`; `get(id)`, `list()` and `reset()` read and clear local storage. An entry
  unpublished on the server is not removed locally yet.
- `useOfflineEntries(store)` serves the cache first, syncs in the background, and returns
  `{ entries, syncing, error, sync }`; call `sync()` on reconnect or pull-to-refresh.
- `imageSource(asset, { width?, dpr?, rendition? })` is an `<Image source>`: `{ uri, width?,
  height? }`, the same URL `imageUrl` picks (through `imageProps`, so a hosted video gives its thumbnail
  and audio or a document gives `undefined`) with `width` and, from the aspect ratio, `height` in
  dp (no `height` for a rendition, which may crop). `imageProps(asset)?.alt` (re-exported) gives
  its alt, with the same title fallback as the web.

## `@commerceworker/sdk/management` — Management (CMA) client

Zero-dependency client for the Management API: content types, entries (draft → publish →
version history), the asset library, releases, scheduled actions, webhooks, and space
administration.
Authenticate with a CMA key or the admin token — the server enforces RBAC scopes per
operation, so the client is only as powerful as its token.

```ts
import { createManagementClient } from '@commerceworker/sdk/management';

const cma = createManagementClient({
  baseUrl: 'https://api.example.com',
  space: 'space-1',
  environment: 'main',
  token: '<cma-token>',
  fetch, // optional: inject a fetch (SSR/edge/test)
  readYourWrites: true, // optional: echo x-cw-bookmark (default true)
  bookmark: undefined, // optional: a bookmark to start from
});
```

The surface is namespaced; every method maps 1:1 onto a Management route (`opts` on `upload`
and `replaceFile` is `UploadOptions`: `onProgress`, `concurrency`, `attempts`, `signal`):

```ts
cma.me()                                              // principal probe (/auth/me)
cma.bookmark                                          // read-your-writes position; assignable
cma.approvals.count()                                 // what waits on a person

cma.contentTypes.list() / .get(apiId) / .create(draft) / .publish(apiId) / .entryCounts()
cma.contentTypes.fieldValues(apiId, field, { locale?, limit?, cursor? }): Promise<FieldValuesPage>
cma.contentTypes.dependents(apiId) / .delete(apiId, { purgeEntries? }) / .clone(apiId, { apiId, name })
                                                      // create on an existing apiId revises it

cma.entries.list({ contentType?, locale?, limit?, skip?, order?, query? })  // Preview: drafts included
cma.entries.create({ contentTypeApiId, fields })      // fields are locale-keyed
cma.entries.get(id) / .update(id, fields)             // update = new draft version
cma.entries.publish(id, { expectedVersion? }) / .unpublish(id, { expectedVersion? })
cma.entries.bulkCreate(items) / .bulkPublish(ids) / .bulkUnpublish(ids)
cma.entries.reverseReferences(id)                     // "what links here"
cma.entries.versions.list(id) / .get(id, v) / .diff(id, from, to)
cma.entries.versions.restore(id, v, { expectedVersion? })

// Imports (CSV, JSON, WXR) into one content type, as drafts
cma.imports.sources() / .analyze(input) / .run(input) / .start(input)   // start = durable job

// Assets: reading
cma.assets.list(query?) → AssetPage                   // { kind, mime, tag, folder, status, sort, order, limit, cursor }
cma.assets.iterate(query?) → AsyncGenerator<Asset>    // follows nextCursor as the loop reads
cma.assets.get(id) / .search({ q, kind?, tag?, folder?, status?, limit? }) / .usage(id) → AssetLink[]
cma.assets.versions(id) → AssetVersion[]              // newest first, file.url signed
cma.assets.transformUrl(id, { width?, height?, fit?, format?, quality? }) → { url, transform }

// Assets: uploading and replacing
cma.assets.upload({ fileName, contentType, body, title?, description?, folderId? }, opts?) → Asset
cma.assets.create({ fileName, contentType, … }) → { asset, upload }   // one signed PUT, by hand
cma.assets.replaceFile(id, { fileName, contentType, body }, opts?) → Asset   // any size; the new version
cma.assets.startReplace(id, { fileName, contentType }) → { asset, upload, commit }
cma.assets.commitFile(id, commit) → Asset
cma.assets.restoreVersion(id, version) → Asset
cma.assets.uploads.start({ fileName, contentType, size, … }) / .startReplace(id, { fileName, contentType, size })
cma.assets.uploads.signParts(assetId, uploadId, partNumbers) / .complete(assetId, uploadId, parts) / .abort(assetId, uploadId)
cma.assets.videos.create({ fileName, contentType, title?, description?, maxDurationSeconds? }) → { asset, upload }
cma.assets.videos.refresh(id) → Asset                 // poll until file.video.status is ready

// Assets: editing and publishing
cma.assets.setMetadata(id, { altText?, tags?, focalPoint?, fields? }) → Asset
cma.assets.generateAltText(id, { locale?, context?, apply?, tier? }) → { altText, locale, applied, usage }
cma.assets.autoTag(id, { apply?, tier? }) → { tagIds, newTags, applied, usage }
cma.assets.setRights(id, { license?, credit?, expiresAt?, embargoUntil? }) → Asset   // content:publish
cma.assets.publish(id) / .unpublish(id) / .archive(id) / .restore(id) → Asset
cma.assets.delete(id)                                 // archived only; 409 asset_in_use while linked
cma.assets.move(ids, folderId | null) → { moved }
cma.assets.reingest(id) / .reindex({ all? })
cma.assets.bulk({ action: 'move' | 'tag' | 'publish' | 'unpublish' | 'archive', ids, … }) → BulkJob

// Assets: organizing and sharing
cma.assets.folders.list() / .create({ name, parentId? }) / .update(id, { name?, parentId? }) / .delete(id)
cma.assets.collections.list({ limit?, cursor? }) / .iterate({ limit? }) / .get(id) / .create({ name, description? })
cma.assets.collections.update(id, { name?, description? }) / .delete(id)
cma.assets.collections.assets(id, query?) / .iterateAssets(id, query?)   // members, in order
cma.assets.collections.add(id, assetIds) / .remove(id, assetIds) / .reorder(id, assetIds)
cma.assets.shareLinks.list({ targetType?, targetId?, includeInactive? }) / .get(id) / .create(input) / .revoke(id)
cma.assets.zips.create({ assetIds, name? } | { collectionId, name? }) / .get(id) / .list()
cma.assets.renditions.list() / .get(name) / .create({ name, width?, height?, fit?, format?, quality? })
cma.assets.renditions.update(name, spec) / .delete(name)   // content:manage; update replaces the preset

cma.bulkJobs.list({ limit? }) / .get(id) / .report(id) / .cancel(id)
cma.bulkJobs.setFields({ contentTypeApiId, entryIds, fields })   // field → locale → value; null clears

cma.entries.setSeo(id, { locale?, title?, description?, canonicalUrl?, noindex?, ogImage? })   // one locale of the Seo field; null clears
cma.entries.move(id, { after: id | null } | { before: id | null })   // manual order; live, no publish
cma.entries.outlineBlocks(id, { field?, locale? })   // blocks as a tree of keys, types, labels; version
cma.entries.patchBlocks(id, { expectedVersion, ops })   // by _key, all or none; → { entry, fields, keys, inverse }
cma.entries.checkBlocks(id, { expectedVersion, ops })   // the same patch's dry run; nothing written
cma.entries.previewLink(id, { ttlHours?, previewBaseUrl?, locale? })   // { url, frontendUrl?, token, expiresAt }

cma.redirects.list({ q?, limit?, cursor? }) / .get(id) / .create(input) / .update(id, changes) / .delete(id)
cma.redirects.import({ format: 'csv' | 'json', data, dryRun? }) / .resolve(path, { locale? }) / .analyze() / .collapseChains()

cma.savedViews.list({ contentType? }) / .get(id) / .run(id, { limit?, cursor?, locale? }) / .create(input) / .update(id, changes) / .delete(id, { revision? })

cma.menus.list() / .get(id) / .preview(id, { locale? }) / .resolve(handle, { locale? }) / .create(input) / .update(id, changes) / .moveItem(id, move) / .delete(id, { revision? })

cma.webhooks.list() / .create(input) / .update(id, patch) / .delete(id) / .deliveries(id)
  / .test(id) / .resend(id, deliveryId)
cma.taxonomy.tags.list() / .create({ name, slug?, description?, labels? }) / .update(id, patch) / .delete(id)   // list: each with usage
cma.taxonomy.schemes.list() / .create({ name }) / .delete(id)
cma.taxonomy.concepts.list({ scheme? }) / .create(input) / .update(id, patch) / .setBroader(id, broaderId) / .delete(id)
cma.taxonomy.repair() → { slugsAssigned }   // recount published usage, fill missing slugs

cma.releases.create({ title }) / .addEntry(id, { entityId }) / .removeEntry(id, entityId)
cma.releases.list() / .get(id) / .publish(id) / .delete(id)   // list: each with itemCount

cma.scheduledActions.list({ status? }) / .create(input) / .cancel(id)

cma.spaces.list() / .create({ spaceId, name, defaultLocale, starter? })  // deployment-wide
cma.spaces.starters() / .starterInstall(spaceId, environmentId, install)
cma.environments.list() / .create(id, name)           // space-level
cma.environments.aliases.list() / .set(alias, envId) / .delete(alias)
cma.apiKeys.list() / .create({ kind, name }) / .revoke(id)   // admin scope
```

- Entry `fields` use the Management shape: field apiId → locale → value
  (e.g. `{ title: { 'en-US': 'Hello' } }`).
- `Asset` is fully typed: `file` (`AssetFile`: `url`, `fileName`, `contentType`, `size`, `width`,
  `height`, `placeholder`, and `video` with `status`, `hlsUrl`, `dashUrl`, `thumbnailUrl`,
  `durationSeconds`, `errorReason` on a hosted video), `metadata` (`altText`, `tags`, `focalPoint`,
  `fields`), `rights`, `version`, `ingestStatus`, `duplicateOf`, `aiSuggestions`, `folderId`. A
  test in `packages/http` holds it to the API's schema.
- `assets.upload` and `replaceFile` take any size: one signed PUT up to 100 MiB, a multipart upload
  above it with each part retried on its own and progress after each; a failed or aborted
  multipart upload is aborted on the server too. A signed PUT stores once, so a second PUT through
  it is a `412`: on a retry the SDK counts that as stored (an earlier attempt's bytes landed and its
  answer was lost); on a first attempt it throws a `ManagementError` with status 412.
- `assets.startReplace` + `commitFile` is the single-PUT replace one step at a time; past 100 MiB,
  `uploads.startReplace` and `uploads.complete` (which commits). A replace another commit beat is a
  `409`.
- `iterate`, `collections.iterate` and `collections.iterateAssets` fetch a page (`limit`) at a time
  as the loop reads; break out and no further page is fetched. Share links and zips aren't paged.
- `bulkJobs.cancel` stops a job taking new work: chunks not started are skipped, one already running
  finishes, and nothing done is rolled back. Cancelling a finished job returns it unchanged.
- `contentTypes.create(draft)` takes `urlPattern` (e.g. `/blog/{slug}`; `null` clears it), which makes
  a publish that changes a slug write a redirect. `redirects.import` is all or nothing, and
  `redirects.resolve` answers `null` on `404`.
- `menus.update` replaces the whole tree when given `items`; with `revision` (and on `moveItem` and
  `delete`) a menu saved since is a `409`.
- `savedViews.create` stores `query` in the structured form (`filters`, `where`, `order`, `search`,
  `extra`); `savedViews.run` is the caller's own Preview list query, `{ view, items, total,
  nextCursor?, ignored?, typeMissing? }`. Another person's personal view is a `404`, and a view's
  `createdBy` is left out for a key that isn't served author ids.
- `apiKeys.create` returns the raw token exactly once; only its hash is stored.
- `entries.list` reads `GET /preview/:space/:env/entries` on the same origin (the Management API
  has no entry list): the latest saved version, drafts included, `{ items, total }` with `total`
  counting the page. It needs `preview:read`.
- `imports.analyze`, `run` and `start` take the same `ImportInput` (`source`, `payload`,
  `mapping`, `sourceOptions?`, `conflicts?`); `analyze` writes nothing and is the plan the other two
  execute. `start` returns `{ job, analysis }`; follow `job.id` with `bulkJobs.get`.
- `publish`, `unpublish` and `versions.restore` take `{ expectedVersion }`, the `currentVersion` you
  read; if a draft was saved since, the server answers 409 and changes nothing (`?expectedVersion=`
  on the route; see [Consistency](./consistency.md#invariants)).
- `spaces.create` takes the deployment's admin token (a space's own keys are refused);
  `starter: 'sample'` installs the sample content before it returns; `'enterprise'`, where
  `spaces.starters()` lists it, returns `installing` at once, followed with `spaces.starterInstall`.
- A read after the client's own write sees it: see [Read-your-writes](#read-your-writes).

### Errors

A failed request throws `ManagementError` with `status`, the API's error `code`, the parsed
`error` object (`code`, `message` and the details a code carries) and the raw `body`. Guards
narrow it to the bodies a client branches on:

```ts
import { isAssetInUse, isAssetRightsError, isValidationError } from '@commerceworker/sdk/management';

try {
  await cma.assets.archive(id); // deleting needs an archived asset
  await cma.assets.delete(id);
} catch (err) {
  if (isAssetInUse(err)) {
    // err.error.usage: the first 50 links, each with contentTypeApiId and entryTitle
    // err.error.total: every link, counted
  } else throw err;
}
```

| Guard                | `code`                              | Details on `err.error`                                   |
| -------------------- | ---------------------------------------- | ----------------------------------------- |
| `isAssetInUse`       | `asset_in_use` (409)                | `usage`, `total`                                         |
| `isAssetRightsError` | `asset_embargoed`, `asset_expired` (409) | `embargoUntil` or `expiresAt`, by `code`            |
| `isValidationError`  | `validation_failed` (422)           | `issues`: `{ field, locale?, message }[]`                 |
| `isConflict`         | `conflict` (409)                    |                                                          |
| `isNotFound`         | `not_found` (404)                   |                                                          |
| `isRateLimited`      | `rate_limited` (429)                |                                                          |

`code` is read from `{ error: { code } }` and from the flat `{ code }` of a refusal made before a
route runs (the 413, a request-rate 429). The full list is in the
[REST API reference](https://docs.commerceworker.com/content/reference/rest-api/#errors).

## Read-your-writes

The api answers every request with `x-cw-bookmark`, the database session's bookmark after its
queries, and a request that sends one back reads a database at least that fresh, even from a read
replica ([Consistency](./consistency.md#database-sessions-and-replicas)). The Management client and
a Delivery client in `preview: true` mode do this for you:

- Each client instance keeps the newest bookmark it has been answered with (bookmarks sort oldest
  to newest as strings, so a late response to an earlier request never moves it back, and a
  failed request's bookmark counts too) and sends it with its next request.
- It goes only to, and is taken only from, the origin of `baseUrl` (a relative `baseUrl` is the
  page's own origin); a response redirected elsewhere is ignored.
- `client.bookmark` reads it, and assigning replaces it (`undefined` clears it). `bookmark` in the
  options seeds it. A value that isn't shaped like a database bookmark is dropped, as the api would.
- `readYourWrites: false` turns it off: nothing is kept or sent, and `bookmark` stays `undefined`.

To carry it from a write on the server to a reader in the browser, hand the bookmark across:

```ts
// Server action
await cma.entries.update(id, fields);
return { bookmark: cma.bookmark };

// Browser
const preview = createDeliveryClient({ ...previewOptions, preview: true, bookmark });
```

A Delivery client (not preview) never sends one: Delivery is served from the cache and replicas
and is eventually consistent after a publish (see [Consistency](./consistency.md)). The
in-memory cache (`cacheTtlMs`) answers without asking the api, so a cached read does not see a
later write; `clearCache()` after writing.

## `@commerceworker/sdk/catalog` — the storefront catalog client

Zero-dependency client for the catalog's public read edge (`catalog.<host>`, the `CatalogDelivery`
entrypoint of `apps/delivery`). No token, safe in a browser or on a server. It covers exactly the
routes in `apps/delivery/src/catalog/routes.ts` (product, batch, SKU, slug, categories, a faceted
listing, search), one method each, plus `listingPages` and `searchPages` generators that follow
`next` until it is `null`.

```ts
import { createCatalogClient } from '@commerceworker/sdk/catalog';

const catalog = createCatalogClient({ origin: 'https://catalog.example.com', channel: 'web', locale: 'en' });
const page = await catalog.listing('shirts', { filters: { brand: ['acme'] }, ranges: { price: { max: 5000 } } });
for await (const p of catalog.searchPages('blue cott')) console.log(p.products);
```

- **Canonical urls.** The edge caches each request under `canonical(route)` and drops everything
  else, so a client that spells a request differently still works but spreads one page over
  several cache entries. `src/urls.ts` builds the canonical spelling itself (filters in name order,
  values sorted and unique, the search query normalized, defaults omitted, `keys=a,b` with a raw
  comma, a slug percent-encoded) and refuses with a `TypeError`, before sending, what the edge would
  refuse. `test/parity.test.ts` imports the edge's own `parse` and `canonical` (tests only) and
  checks every URL the client builds parses to the expected request and round-trips to itself, and
  that `normalizeQuery` matches core's. A cursor is opaque: it is passed back as it came.
- **Generated limits.** No constant is copied by hand. `scripts/generate.ts` reads `BATCH_MAX`,
  `CODE`, `LOCALE`, `SLUG` (`@commerceworker/core/product/paths`), `QUERY_MAX`, `SEARCH_DEPTH`
  (`/search`) and `PAGE`, `MAX_FILTERS`, `MAX_VALUES`, `SLUG_MAX`, `SORT`, `NUMBER` (the edge's
  `routes.ts`, which exports them for this) and writes the committed `src/generated/limits.ts`.
  `pnpm sdk:generate` regenerates it (with the commerce client's operations); `test/generated.test.ts`
  runs `generate.ts --check` and fails when it is stale. Nothing under `src/` imports core or the
  delivery app.
- **Errors.** `CatalogError` is the base (`<Surface>Error` naming, as `CommerceError`): a non-2xx is
  a `CatalogApiError` (`status`, `body`, `retryAfterSec`) with `CatalogBadRequestError`,
  `CatalogNotFoundError` and `CatalogRateLimitError`; no answer is a `CatalogConnectionError`, past
  `timeoutMs` a `CatalogTimeoutError`. Narrow with `isCatalogError`, `isCatalogApiError(e, kind?)` and
  `isCatalogConnectionError` (a `Symbol.for` brand, so both builds agree). The commerce client's
  error code is not shared: there is no common package that fits, and the two brands differ so one
  client's guard never claims the other's errors.
- **Retries.** Every request is a public GET, so every one is resent on a 429, a 5xx (a listing that
  is rebuilding answers 503) or a connection error: `maxRetries` (default 2), exponential backoff
  with full jitter, `Retry-After` honored up to a minute. A 400 or 404 is never retried. The client
  sends no headers, so a browser makes no CORS preflight.
- **Bundle.** `packages/sdk/sdk/test/catalog-bundle.test.ts` builds the entry and fails on zod,
  `@commerceworker/core` or a `node:` import.

## `@commerceworker/sdk/commerce` — the commerce client

Zero-dependency client for the commerce REST API (`/api/v1` on the app host), for servers and
scripts (an API token never belongs in a browser). Unlike the content clients it is **generated**:
`packages/sdk/commerce/scripts/generate.ts` imports `openApiDocument()` from
`apps/web/app/lib/openapi.ts` (the way `apps/docs/src/pages/openapi.json.ts` does) and writes
`src/generated/operations.ts`: a request type and a `<OperationId>Result` type per operation, from
the JSON Schemas the web app builds from its zod schemas, and the table of how to call each
(`OPERATIONS`: method, path, path params, where the input goes) and which page by cursor
(`PAGINATION`). The generator lives in the package's `scripts/`, not `src/`, so nothing the package
ships imports web source; the file it writes is committed.

```sh
pnpm sdk:generate   # after any change to apps/web/app/lib/openapi.ts, rest-operations.ts or a tool's schema
```

`test/generated.test.ts` runs `generate.ts --check` and fails when the committed file is stale, so a
REST change can't merge without its regenerated types. The script is named `generate:operations`,
not `generate`, because turbo's `generate` task runs a package's `generate` before its tests and
would rewrite the file the drift test is checking. `test/emit.test.ts` holds the emitter to small
hand-written documents; it throws on a JSON Schema keyword it doesn't know rather than guess.

```ts
import { createCommerceClient, CommerceRateLimitError } from '@commerceworker/sdk/commerce';

const commerce = createCommerceClient({
  baseUrl: 'https://app.your-workspace.commerceworker.com',
  token: process.env.COMMERCEWORKER_API_TOKEN!,
  fetch, // optional
});

const { orderId } = await commerce.startOrder(
  { flowId: 'checkout', input: { model: 'b2c', lines: [{ sku: 'A1', qty: 1 }] } },
  { idempotencyKey: 'cart-42' },
);
for await (const quote of commerce.paginate('list_quotes', { status: 'sent' })) console.log(quote.id);
```

- **One method per `operationId`**, camel-cased (`list_orders` → `listOrders`), plus
  `call('list_orders', input)`. Path params are taken from the input; the rest of a `GET` or
  `DELETE` input is the query string, a `POST`'s is the JSON body, and an operation with a file body
  (`importCatalogFeed`, `receiveEdi850`) takes `{ body, contentType?, …query }`. An input with no
  required field may be left out.
- **Not generated:** the receivers a provider calls with a signature instead of a token
  (`receive_order_event`, `receive_stripe_webhook`, `receive_shopify_order`,
  `receive_inbound_order`), which the generator skips because their OpenAPI `security` is `[]`.
- **Idempotency.** `{ idempotencyKey }` sends `Idempotency-Key`. Only an operation whose OpenAPI
  parameters name that header (`start_order`) takes one; the client throws for the rest instead of
  implying a safety it doesn't have. `{ headers }` sends others (`If-Match` for `submitCart`).
- **Errors.** Every failure is a `CommerceError` (naming follows `ManagementError`: `<Surface>Error`
  for the base, `is…` guards to narrow), with `kind`, `operationId`, a `requestId` (`x-request-id`,
  else `cf-ray`) and, for a network failure, the original as `cause`. A non-2xx is a
  `CommerceApiError` (`status`, `body`, `issues`, `retryAfterSec` from `Retry-After`), with a
  subclass for 400, 401, 403, 404, 409, 422 and 429 (`CommerceBadRequestError`,
  `CommerceUnauthorizedError`, `CommerceForbiddenError`, `CommerceNotFoundError`,
  `CommerceConflictError`, `CommerceUnprocessableError`, `CommerceRateLimitError`). A request with no
  answer is a `CommerceConnectionError`; one past `timeoutMs` (client or call option, per attempt)
  is a `CommerceTimeoutError`. A caller's own `AbortSignal` abort is rethrown as it is.
  **Narrow with `isCommerceError(e)`, `isCommerceApiError(e, kind?)` and
  `isCommerceConnectionError(e)`, not `instanceof`**: they check a `Symbol.for` brand and `kind`, so
  they hold when an app loads both the ESM and the CJS build, each with its own classes.
- **Retries.** `maxRetries` (client or call option; default 2, 0 turns them off) resends on 429, 5xx
  and connection errors, with exponential backoff and full jitter (500 ms doubling, capped at 8 s)
  or the `Retry-After` the server sent (over a minute is not waited for: the error is thrown). Only
  a GET, a DELETE, or a write sent with an `idempotencyKey` is resent; any other write may have
  happened already.
- **Method names are part of the API.** They are the flat camelCase of the operationIds, and
  `test/client.test.ts` snapshots the sorted list, so renaming an operationId fails there until the
  snapshot is updated on purpose (a breaking change for SDK users).
- **Paging.** `pages(op, input)` and `paginate(op, input)` follow `cursor` for the operations whose
  input takes a `cursor` and whose result returns one (`PAGINATION`). A cursor field named
  otherwise is not detected, so `list_price_books` (`after`/`next`) and the audit events (`before`
  and `after`) are plain calls. A result's cursor is named `cursor` or `nextCursor`, and the generator
  throws if a result has more than one array.
- **Every result is typed.** `apps/web/tests/openapi.test.ts` fails if an operation's `200`, `201` or
  `202` has no JSON schema, so no result is `unknown`. The schemas are core's zod schemas, in a
  `*-schemas.ts` beside the types they describe (`api-schemas.ts`, `product/api-schemas.ts`,
  `webhook-schemas.ts`…), registered by name in `COMPONENTS` in `openapi.ts` so each is one `$ref`,
  one type in the generated file. Three tests keep them true: `packages/core/tests/response-schemas.test.ts`
  holds each to the TypeScript type it describes (`branded.toEqualTypeOf`, so a field added to one side
  fails), `apps/web/tests/rest-responses.test.ts` runs each route's handler and validates what it
  answers, and the engine's and the catalog's own `rest-responses.test.ts` validate what real orders
  and real shards answer. A new route's response goes in core next to its type, in `COMPONENTS`
  and in those tests, then `pnpm sdk:generate`.
- **Webhooks.** `@commerceworker/sdk/commerce/webhooks` is `verifyCommerceWebhook(rawBody, header,
  secrets, { toleranceSec })` for `X-CommerceWorker-Signature: t=…,k=…,v1=…` (`packages/core/src/webhooks.ts`),
  on Web Crypto. It returns `{ ok, timestamp, keyId? }` or `{ ok: false, reason }`; `secrets` may be
  several during a rotation. Its test signs with core's `signWebhook` (a devDependency, tests only)
  so the two can't drift apart.
- **Bundle.** `packages/sdk/sdk/test/commerce-bundle.test.ts` builds the two commerce entries and
  fails if the output contains zod, `@commerceworker/core` or a `node:` import. Only types are
  generated from zod's output; nothing of it ships.

## `@commerceworker/sdk/codegen` — typed field shapes from your content model

Every SDK client is generic over the field shape (`getEntry<F>`, `EntryFields`), and
`commerceworker types` generates those shapes from a space's actual content types — so entry fields
are typed end to end instead of `Record<string, unknown>`.

```bash
# The signed-in space (commerceworker login), or COMMERCEWORKER_URL / _TOKEN / _SPACE / _ENVIRONMENT:
npx commerceworker types --out src/generated/content-types.ts
```

```ts
// From content types you already have ({ items: [...] } JSON, a build step):
import { generateTypes } from '@commerceworker/sdk/codegen';
const source = generateTypes(contentTypes);
```

For each content type it emits two interfaces plus shared helpers and lookup maps:

- `<Name>Fields` — Delivery shape (locale-flattened values — request entries with
  `?locale=`; without one, Delivery returns locale-keyed values, i.e. the draft shape):
  `Symbol`/`Text`/`Date` → `string`, `Integer`/`Number` → `number`, `Boolean` → `boolean`,
  `Location` → `{ lat, lon }`, `JSON` → `Record<string, unknown>`, `RichText` →
  `RichTextDocument`, `Link` → `EntryLink` / `AssetLink | DeliveredAsset` (an asset link can be
  embedded), `Seo` → `{ title?, description?, canonicalUrl?, noindex?, ogImage? }`, `Array` → element type `[]`. The generated prelude declares `DeliveredAsset`.
  An `in` validation becomes a literal union of its stored values (`status: 'draft' | 'live'`;
  a labelled option contributes its `value`) exactly where the domain enforces it
  (`Symbol`/`Text`/`Integer`/`Number`); `required` controls optionality, except that a required
  field a conditional rule can hide is optional (a hidden field is not required). A list of
  `Integer` or `Number` is `number[]`, of `Symbol`, `Text` or `Date` `string[]`. A field's
  `description` (else its `help`) goes into the property's doc comment, with a Date field's
  format (`date: YYYY-MM-DD`) and a note when rules hide or disable it. An older codegen types a
  list of numbers as `string[]` and a hideable required field as required: regenerate after
  upgrading.
  **Breaking (types):** the management SDK's `FieldDefinition.validations` was typed as an array
  of records; it is now the `FieldValidations` object the API returns (with `in: FieldOption[]`
  and `messages`). Code that indexed it as an array reads the rule by name instead.
  **Breaking (codegen):** an `in` list may hold `{ value, label }` objects. A codegen release from
  before labelled options throws on one. Upgrade
  `@commerceworker/sdk` before a content type gains a labelled option, regenerate the types, and
  read an option with `typeof o === 'object' ? o.value : o` wherever your code walks
  `validations.in` itself.
  When rendering `RichTextDocument` values, handle the full node vocabulary (headings, lists,
  code blocks, tables, hyperlinks, embeds — see the domain model doc) and skip unrecognized
  `nodeType`s defensively; writes are validated against the vocabulary, but it can grow without an
  SDK change. With `include`, a reference node's `data.target` is the embedded entry or asset,
  or still a `{ id, linkType }` stub when the target is unpublished or past the depth. An
  `embed` node's `data` is typed `EmbedData` (`{ url, provider, kind?, title?, authorName?,
  thumbnail?, width?, height?, aspectRatio? }`), structured metadata, never markup.
- `<Name>DraftFields` — Management shape (locale-keyed: `Localized<T>`), usable with
  `@commerceworker/sdk/management`.
- `ContentTypeApiId` (union of apiIds), `FieldsByContentType`, and `DraftFieldsByContentType`.

Pass the shape as the type argument, e.g. `client.getEntry<ArticleFields>(id, { locale })`.

`commerceworker types` is the [CLI](./developer-tooling.md)'s command over the same generator. The
workspace package `sdk-codegen` still has its own `commerceworker-codegen` bin for local use; it
isn't published.
Generated modules are self-contained and compile clean under `strict`.

## Inline editing

Turns a previewed page into click-to-edit: hovering a rendered value outlines it and names its
field, and clicking opens that field in the admin. It has two halves — marking rendered values with
the field they came from, and an overlay that reads those marks back out of the DOM.

**Marking values.** Spread `editable()` onto whatever element renders the value:

```tsx
const editable = useEditable();                        // @commerceworker/sdk/react
<h1 {...editable(entry, 'title')}>{entry.fields.title}</h1>
<p {...editable(entry, 'summary', 'de-DE')}>{entry.fields.summary}</p>
```

It emits a single `data-cw-ref` attribute — and **only when the client is in preview mode**. On a
production client the call returns `{}`, so the same components ship unchanged without disclosing
entry ids, field names, or that there is a CMS behind the page. There is nothing to strip before
deploying and no second code path to keep in step.

Refs are derived on the client, not served in delivery payloads: the space, environment and locale
are already known to whoever configured the client, and the entry id and content type are already
in the response, so having the API repeat all five on every field of every entry would add weight
to the hottest read path to carry nothing new.

**The overlay.** In React, render it anywhere in the tree:

```tsx
import { InlineEditor } from '@commerceworker/sdk/react';

<InlineEditor adminUrl="https://example.com" />;
```

Outside React, mount it directly — it is framework-free and reads the DOM, so it works against
markup rendered by anything:

```ts
import { mountInlineEditor } from '@commerceworker/sdk/inline-edit';

const editor = mountInlineEditor({ adminUrl: 'https://example.com' });
editor.setEnabled(true);
editor.destroy();
```

| Option           | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `adminUrl`       | Admin base URL. Required unless `onEdit` handles the click itself. |
| `onEdit(ref)`    | Called instead of navigating — open a side panel, or route in-app. |
| `defaultEnabled` | Start with editing on. Default `false`.                            |
| `toggle`         | Render the built-in toggle button. Default `true`.                 |

Editing starts **off** and is switched on from the toggle (or `setEnabled`). A previewed page is
still a page: with every click intercepted, following a link to the next page — the reason to
preview a site rather than one entry — would be impossible. While it is on, clicks on marked
elements are claimed in the capture phase, so a heading inside a link opens the editor instead of
navigating.

**In the admin.** The link opens the entry editor on the referenced field; see
[Admin UI](./admin-ui.md#inline-edit-links).

## GraphQL

If you prefer GraphQL over the REST client, the Delivery API also exposes a per-space GraphQL
schema generated from your content types at `POST /delivery/:space/:env/graphql` (scope
`delivery:read`). It needs no SDK — use any GraphQL client with a CDA token. `asset(id)` is a
typed `Asset` with `url(rendition, width)`, `srcset`, `placeholder`, per-field `locale` arguments and `video`. See
[API reference → GraphQL Delivery](./api-reference.md#graphql-delivery).
**Breaking (GraphQL):** a list of `Symbol` values is now typed `[String]`, not `JSON`; regenerate
client types made from the schema.
