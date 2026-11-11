---
name: building-on-commerceworker
description: Build a website, app or service that reads and writes content in CommerceWorker, a headless CMS, or drive its commerce side from a terminal. Use when choosing a CommerceWorker SDK, reading published content (Delivery) or drafts (Preview), writing through the Management API, keeping reads consistent after a write, generating TypeScript types from the content model, rendering rich text (including embeds), deciding how to cache, or running orders, flows and approvals with the commerceworker command.
---

# Building on CommerceWorker

CommerceWorker serves content as typed JSON, never HTML. Your code picks an API by what it needs,
types itself from the content model, and renders rich text from a node tree.

## Pick the API and the key

| You need                         | API and origin                        | Key (kind)          | SDK                                             |
| -------------------------------- | ------------------------------------- | ------------------- | ----------------------------------------------- |
| Published content on a live site | Delivery, `https://cdn.<workspace>`   | Delivery (`cda`)    | `@commerceworker/sdk` (or `/react`, `/vue`, `/edge`) |
| Drafts on a staging site         | Preview, `https://api.<workspace>`    | Preview (`cpa`)     | `@commerceworker/sdk` with `preview: true`  |
| Writes: create, update, publish  | Management, `https://api.<workspace>` | Management (`cma`)  | `@commerceworker/sdk/management` (server only)   |

Only a Delivery key may ship to a browser or app. Preview and Management keys stay on a server.
Delivery is cached at the edge; Preview and Management are not.
Docs: https://docs.commerceworker.com/content/guides/sdks/ and https://docs.commerceworker.com/content/guides/api-keys/

## Read

```ts
import { createDeliveryClient } from '@commerceworker/sdk';

const client = createDeliveryClient({
  baseUrl: 'https://cdn.your-workspace.commerceworker.com',
  space: 'your-space',
  environment: 'main',
  token: process.env.COMMERCEWORKER_CDA_TOKEN!,
});

const article = await client.getEntry(id, { locale: 'en-US', include: 1 });
const latest = await client.query().contentType('article').locale('en-US').order('-sys.publishedAt').limit(10).fetch();
```

- `include` (0 to 10) embeds linked entries and assets, inside rich text too; without it a link
  stays `{ id, linkType }`.
- Pass `locale` to get plain values with the fallback chain applied; without it each field is
  keyed by locale.
- Lists return `{ items, total }` where `total` counts this page: page with `limit` (at most 100)
  and `skip` until a page comes back short.
- `client.search(text)` is semantic search; `client.getAsset` and `client.iterateAssets` read
  delivered assets, and `imageProps` turns one into `<img>` attributes.
- React: `CommerceworkerProvider`, `useEntry`, `useEntries`, `Image` from `@commerceworker/sdk/react`.
  Vue: `@commerceworker/sdk/vue`. Edge functions: `createEdgeClient` from `@commerceworker/sdk/edge`.
- Rich text is a document tree, never HTML: render it with `toHtml` / `toMarkdown` from
  `@commerceworker/sdk/rich-text` (escaped, safe links, `entryHref` and `renderEntry` hooks).

Filters, ordering and every parameter: https://docs.commerceworker.com/content/guides/reading-content/

## Write, and read your own writes

```ts
import { createManagementClient } from '@commerceworker/sdk/management';

const cma = createManagementClient({ baseUrl: 'https://api.your-workspace.commerceworker.com', space: 'your-space', environment: 'main', token: process.env.COMMERCEWORKER_CMA_TOKEN! });
const { entry } = await cma.entries.create({ contentTypeApiId: 'article', fields: { title: { 'en-US': 'Hello' } } });
await cma.entries.publish(entry.id, { expectedVersion: entry.currentVersion });
```

- Field values are keyed by field, then locale: `{ title: { 'en-US': 'Hello' } }`, even for a
  field that isn't localized (it uses the default locale).
- `cma.entries.update(id, fields)` saves the whole draft: send every field, or read it first.
- Pass `expectedVersion` to `publish`: if someone saved since you read, it's a 409 and nothing
  publishes.
- Errors throw `ManagementError`; narrow with `isValidationError`, `isConflict`, `isNotFound`,
  `isRateLimited`.
- **Read-your-writes.** A read right after a write may hit a lagging read replica. The Management
  client and a preview client echo the `x-cw-bookmark` header for you. To hand a write's freshness
  to another client (a server action to the browser's preview client), pass `cma.bookmark` as that
  client's `bookmark` option. Delivery never takes one: it is cached and catches up shortly after
  a publish.

## Type against the model

Generate types from the live model, then type reads with them:

```sh
commerceworker types --out src/generated/content-types.ts
```

```ts
import type { ArticleFields } from './generated/content-types';
const article = await client.getEntry<ArticleFields>(id, { locale: 'en-US' });
```

Each type gets a delivery shape (`ArticleFields`) and a management shape (`ArticleDraftFields`).
Regenerate in CI after the model changes (the `content_type.published` webhook fires on publish).
`commerceworker types` and `GET …/content-types?format=typescript` give the same output.

## Render rich text

A `RichText` field is a `RichTextDocument`: `{ nodeType: 'document', content: [...] }`. Render it
by switching on `nodeType`, and render unknown types as nothing rather than failing. Never store or
send HTML back; the API refuses anything but the node vocabulary. See
[references/rendering-rich-text.md](references/rendering-rich-text.md) for every node type, a
renderer and how to treat embeds (`embedCard` from `@commerceworker/sdk` gives a safe link card).

## Caching

- Delivery responses are fresh for a minute, purged on publish, unpublish or an alias change, and
  carry an `ETag`. Don't add a long cache of your own in front.
- Static sites: rebuild on the `entry.published` webhook, or fetch only what changed with
  `since=`. Live pages: `GET /delivery/{space}/{env}/live` streams publish events.
- `cacheTtlMs` on a Delivery client adds a short in-memory cache per process.
- Point production at an environment alias (`/delivery/acme/production`) so promoting a new
  environment needs no deploy.

Docs: https://docs.commerceworker.com/content/guides/reading-content/#caching and
https://docs.commerceworker.com/content/guides/webhooks/

## Check your setup

```sh
commerceworker login --url https://api.your-workspace.commerceworker.com
commerceworker doctor
commerceworker whoami --json
```

`doctor` checks sign-in, reachability, the API version and access to the space. In CI set
`COMMERCEWORKER_TOKEN` and `COMMERCEWORKER_URL` instead of logging in.
CLI reference: https://docs.commerceworker.com/content/guides/cli/

## Run commerce from the terminal

The same `commerceworker` command works a commerce workspace. Sign in against its admin address;
every commerce command prints JSON and exits 0 ok, 1 API error, 2 usage, 3 not signed in.

```sh
commerceworker login --url https://app.your-workspace.commerceworker.com --role operator
commerceworker whoami
commerceworker orders list --status waiting
commerceworker orders get ord_123
commerceworker approvals decide ord_123 mgr --decision approved
commerceworker flows get checkout
commerceworker flows publish checkout --draft DRAFT
commerceworker carts list --status open
commerceworker catalog products get tee
commerceworker run start_order --input @order.json --idempotency-key order-42
```

- A profile belongs to one product: a content command with a commerce profile is refused, and the
  reverse. In CI set `COMMERCEWORKER_TOKEN` (an API token) and `COMMERCEWORKER_URL`.
- `commerceworker run --list` names every REST operation; `run <operationId> --input <json|@file>`
  calls one, including those with no command of their own.
- An API error is a JSON line on stderr with `code`, `status`, `requestId` and `issues`. A price,
  rate or tax change is done by a person, never a token: the error's `adminLink` says where.

Docs: https://docs.commerceworker.com/reference/cli/
