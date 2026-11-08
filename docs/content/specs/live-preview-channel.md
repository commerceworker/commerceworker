# Live preview channel

Status: **proposed** (M6, "Live preview channel" in `ROADMAP.md`). Nothing here is built yet.
This file sits in `docs/specs/`, which the docs embed does not read (it takes `docs/*.md` only),
so MCP clients never mistake it for a description of shipped behaviour.

## What it is

The canvas editor frames the customer's real frontend and draws its overlays on top of it. The
live preview channel is how the two windows talk:

- **admin → frontend:** the editor's unsaved form state, as patches, so the page re-renders
  before anything is saved; which field or block is selected; Coworker's proposed blocks.
- **frontend → admin:** what was clicked or hovered, which entries the page shows, where it
  navigated, and whether a patch was applied.

It ships as `@commerceworker/sdk/live-preview`. The frontend half runs in the customer's page
(wired in by `@commerceworker/frontend`, or by hand for other frameworks). The admin half runs in
`apps/studio`. It is a browser `postMessage` protocol between two windows: no Worker, route or
store change, and neither side can write content through it. Saving is the admin's ordinary
save.

## Terms

- **Admin**: the `apps/studio` window that holds the iframe. Called the host in code.
- **Frontend**: the customer's page inside the iframe. Called the guest in code.
- **Session**: one connected page load. Navigating inside the iframe ends it, and the new
  page connects again.
- **Connect**: how a session starts: `connect.offer`, then `connect.accept` or
  `connect.reject`. (Never "handshake".)

## Connecting the preview

```
frontend                                   admin
   │  connect.offer {versions, capabilities, channel}
   │ ───────────────────────────────────────▶ │  check origin + source, pick a version
   │                                          │
   │  connect.accept {version, capabilities}  │  or connect.reject {reason, versions}
   │ ◀─────────────────────────────────────── │
   │  … session messages, all stamped {v, channel} …
```

1. The admin builds the iframe URL from the content type's preview URL template, adds a preview
   token for the entry (the existing per-entry preview tokens), and frames it.
2. When the page loads, the frontend half checks that it is framed and that
   `connectPreview({ adminOrigin })` was configured. If either is missing, it does nothing: a
   page that isn't being edited behaves exactly as it does today.
3. It generates a random `channel` (128 bits from `crypto.getRandomValues`, base64url) and
   posts `connect.offer` to `window.parent`, targeted at `adminOrigin` (never `'*'`).
4. The admin checks the offer (below), picks the highest version both sides speak, narrows the
   capabilities, and answers `connect.accept`. From then on the admin pins `channel`, the
   iframe's `contentWindow` and its origin for the rest of the session.
5. If no version is shared, the admin answers `connect.reject { reason: 'unsupported-version',
   versions }`. The frontend logs one actionable console error naming both version lists, and
   the admin shows "This site's CommerceWorker SDK is too old (or too new) for live preview"
   instead of waiting on a timeout.
6. The frontend resends the offer up to three times, 1 s apart. If nothing answers, the admin
   reports "This site isn't connected for live preview" with a link to the setup screen.

### The three checks

Every message, in both directions, is dropped unless all three hold. Each check catches
something the other two miss.

| Check | Admin side | Frontend side |
| --- | --- | --- |
| Origin | `event.origin` equals the origin of the URL the admin framed (updated on `navigated`, see below) | `event.origin` equals the configured `adminOrigin` |
| Sender | `event.source === iframe.contentWindow` | `event.source === window.parent` |
| Channel | `data.channel` equals the pinned channel (on an offer: new, well formed) | `data.channel` equals its own channel |

The checks run in one function per side (`acceptMessage`), and every handler goes through it.
After the checks, the message shape is validated (below), and only then dispatched.

### Version negotiation

- The protocol version is an integer, `v`, stamped on every message.
- The frontend offers every version it can speak, newest first. The admin answers with one of
  them and stamps it on everything after.
- **The admin never drops an old version without notice.** Customers install the SDK into their
  own sites and update it on their own schedule, so the admin must keep speaking every version
  a supported SDK release offers. Removing one is a breaking change, called out in the
  changelog, and the admin's `SUPPORTED_VERSIONS` list carries a comment naming the last SDK
  release that needs each entry.
- An additive change (a new optional field, or a new message kind both sides can ignore) does
  **not** bump the version. A new message kind that one side must understand does, and
  is sent only on sessions that negotiated that version.
- Unknown message kinds are ignored, not errors, so a newer frontend can talk to an older admin
  at their shared version.

### Capabilities

The offer declares what the page allows. They are fixed at connect time: there is no runtime
grant.

| Capability | Lets the admin |
| --- | --- |
| `select` | Receive clicks and hovers on marked elements, and send `select` to outline one |
| `patch.fields` | Send unsaved field values for entries on the page |
| `patch.blocks` | Send key-addressed block operations (create, update, move, remove) |
| `proposals` | Send Coworker's proposed blocks, rendered as ghosts (see `patch.blocks`) |
| `scroll` | Ask the page to scroll a marked element into view |

`connect.accept` echoes the subset the admin will use: the offer, narrowed by the space's
admin config (for example a role that may only select). The admin can narrow, never widen: a
capability the page did not offer is never used, and the frontend refuses any message that
needs a capability missing from the accepted set.

## Messages

Every message is `{ v, channel, kind, ... }`. A message that fails its schema is dropped and
counted (a debug counter on each side). It is never partially applied.

### Admin → frontend

- `connect.accept { version, capabilities }` and `connect.reject { reason, versions }`.
- `entry.state { rev, entryId, locale, fields }`: the whole unsaved state of one entry. Sent
  right after connect, and after any gap the admin can't fill with patches.
- `entry.patch { rev, entryId, locale, fields }`: changed top-level field values since `rev - 1`.
- `blocks.patch { rev, entryId, locale, field, ops }`: the same key-addressed operations as the
  `patchBlocks` use-case (M6 "Layout patches"), so the editor and agents share one vocabulary.
  An op may be `proposed: true`, which the frontend renders as a ghost block that is never
  part of saved state.
- `select { ref | null }` and `scroll { ref }`.

### Frontend → admin

- `connect.offer { versions, capabilities, channel, sdk: { name, version } }`.
- `page { url, entries: [{ entryId, contentType, locale }] }`: what this page renders. It
  tells the admin which entries' state to send.
- `navigated { url }`: sent on navigation. The new page then connects again with a new
  channel. The admin accepts it only if the URL matches a preview URL template of this space.
- `pointer { kind: 'hover' | 'click', ref, rect }`: a marked element. `rect` is in iframe
  viewport coordinates, so the admin can draw its outline outside the page.
- `applied { rev }` and `failed { rev, reason }`: whether a patch rendered.

### Content values

Values cross the channel exactly as the Management API types them: rich text as a
`RichTextDocument`, blocks as `{ _type, _key, ... }`, references as links. No message carries
HTML or Markdown. The frontend renders from the same structures it gets from Delivery or
Preview, with the unsaved values layered on top.

### Ordering and gaps

`rev` increases by one per entry per session. The frontend applies a patch only when its `rev`
is exactly one more than the last it applied for that entry. Otherwise it replies
`failed { reason: 'gap' }` and the admin sends a fresh `entry.state`. A reload or navigation
starts from `entry.state` again, never by replaying patches.

## Content refs inside blocks

Clicks map back to fields through the existing `data-cw-ref` attribute
(`packages/sdk/core/src/content-ref.ts`), which today names one top-level field. Blocks need a
path. The `field` part of a ref becomes a path, using the same notation as `blocks.ts`, with
the block's `_key` in brackets: `title`, `body[0192f…].heading`, `body[0192f…].ctas[0192e…].label`.

This stays compatible in both directions. A ref is still six parts, so an older parser reads a
path as a field name, and `adminEditUrl` passes it through as `?field=`, where the entry
form falls back to the top-level field before the first `[`. A key, not an index, names each
block, so a path still points at the same block after a reorder.

## Untrusted input

- **The admin treats every frontend message as untrusted.** A ref must name an entry the page
  reported in `page` and the signed-in person may read. Otherwise it is dropped. Selection only
  moves focus in the admin. No frontend message saves, publishes or calls a use-case.
- **Page text is data, not instructions.** If Coworker later reads what the page reports (for
  example labels in `page`), it goes into the prompt as quoted, untrusted context, under the
  same rules as other content.
- **No styling crosses as CSS.** Token props are enums: the admin sends a token name
  (`"spacing.lg"`, `"tone.brand"`), the frontend resolves it from the block manifest, and drops
  a value that isn't in the manifest. As a second line, any value written into a CSS custom
  property passes `isSafeTokenValue`, which rejects `url(`, `@import`, `expression(`,
  `javascript:`, `<`, `>`, `\` and any function call except `var`, `calc`, `clamp`, `min`,
  `max`, `rgb`, `hsl`, `oklch`. It rejects the whole value, never escapes part of it.
- **Only the admin may frame the preview.** The frontend runtime sends
  `Content-Security-Policy: frame-ancestors <adminOrigin>` on preview responses (those carrying
  a preview token), so another site can't frame a customer's draft page.
- **Origins must differ.** `connectPreview` refuses an `adminOrigin` equal to the page's own
  origin. The iframe is sandboxed with `allow-scripts allow-same-origin allow-forms
  allow-popups`. `allow-same-origin` grants the frontend only its own origin (it needs its own
  cookies and storage), which is safe only because that origin is never the admin's.
- **No remote control.** The channel has no way to run script, read the DOM, take screenshots or
  trigger clicks in the page. Coworker changes the page only through `blocks.patch` proposals.

## Page-side API

```ts
import { connectPreview } from '@commerceworker/sdk/live-preview';

const preview = connectPreview({
  adminOrigin: 'https://admin.example.com',
  capabilities: ['select', 'patch.fields', 'patch.blocks', 'proposals', 'scroll'],
  onState(entryId, locale, fields) { /* re-render with these values */ },
});

preview.on('select', (ref) => { /* … */ });
preview.emit('page', { url: location.href, entries });
preview.close();
```

- `connectPreview` returns a no-op handle when the page isn't framed or isn't configured, so a
  site can call it on every page.
- `@commerceworker/frontend` wires it in for blocks it renders. A site only sets `adminOrigin`,
  which the "connect a frontend" screen prints with the delivery key.
- When connected, `mountInlineEditor` (`inline-edit.ts`) is driven by the channel. Its
  toggle is hidden, the admin turns editing on and off, and clicks go to `pointer` instead of
  opening a new tab. The overlay draws nothing in the page, since the admin draws the outline.
- Before the page unloads, a final `navigated` is posted. If the parent is gone, nothing is
  retried: the next page's `connect.offer` is the recovery.

## Where the code goes

| Part | Location |
| --- | --- |
| Message types, schemas, `acceptMessage`, version list, `isSafeTokenValue` | `packages/sdk/core/src/live-preview/` |
| Frontend half (`connectPreview`) | same, exported as the `@commerceworker/sdk/live-preview` subpath (`packages/sdk/sdk`: exports, `src/`, `tsup.config.ts`, `scripts/types.ts`, subpath test) |
| Admin half (`usePreviewChannel`, the framed canvas) | `apps/studio/app/cms/...`, importing the protocol from `@commerceworker/sdk-core` (`workspace:*`) so both sides share one definition |
| Ref paths | `content-ref.ts` (format and parse helpers for paths) |
| Runtime wiring and `frame-ancestors` | `commerceworker/site` (`@commerceworker/frontend`) |
| `blocks.patch` ops | shared with the `patchBlocks` use-case, which is exposed over HTTP and MCP (M6 "Layout patches") |

The channel adds no use-case of its own: it moves unsaved form state and focus between two
windows. Every change it previews is saved through the existing entry update, and agents get
the same edits through `patchBlocks` over HTTP and MCP.

## Test plan

- **Checks** (`sdk-core`, node): a message with the wrong origin, the wrong sender, the wrong
  channel, a missing or malformed channel, or an unknown version is dropped, on both sides.
  Table-driven, one row per factor, so removing a check fails a named test.
- **Negotiation**: the matrix of frontend offers × admin version lists, covering a shared version, no
  shared version (reject with both lists), unknown versions in the offer, and an empty offer.
- **Capabilities**: the admin never sends a message needing a capability that wasn't accepted,
  and the frontend refuses one that arrives anyway.
- **Ordering**: in-order patches apply, a gap answers `failed: gap`, and `entry.state` resets.
- **Schemas**: fuzzed and malformed messages are dropped whole. Values are typed structures. A
  string of HTML in a rich-text field fails validation.
- **Token values**: `isSafeTokenValue` accepts the allowed functions and rejects every listed
  pattern, including nested and mixed-case forms (`URL(`, `u\rl(`).
- **Refs**: path refs round-trip. An old six-part ref still parses. `adminEditUrl` with a path
  opens the top-level field.
- **Two windows** (jsdom): a host and a guest wired through real `MessageEvent`s, from connect to
  patch to `applied`.
- **End to end** (Playwright, `apps/studio/e2e`): the admin on one origin frames a fixture frontend
  on another. It connects, a typed heading appears in the frame before saving, clicking the
  heading focuses the field, and an SDK fixture that offers only an unsupported version shows
  the reject message. Plus an axe pass on the canvas states.

## Out of scope

The canvas UI (toolbox, seams, dock, inspector, undo), the `patchBlocks` use-case itself, block
renderers, and per-breakpoint overrides each have their own M6 item. This spec only fixes the
channel they use.

## Open questions

1. Does the admin pin the frontend's origin from the framed URL alone, or also from an origin
   list the space configures on the "connect a frontend" screen? The list is stricter, but it's
   one more setting.
2. Should `page` report entries from every block reference on the page, or only the entry being
   edited and its direct references? More entries means the page can show more edits, at the
   cost of larger state messages.
3. Do we want a `resize` message (frame height follows the page), or does the canvas always
   scroll inside a fixed-height frame?
