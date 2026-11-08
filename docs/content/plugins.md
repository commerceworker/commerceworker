# Plugins

A plugin is third-party code that runs **inside a write**, before it lands: it can transform an
entry, add validation issues, or refuse the operation outright. That is what separates it from a
webhook or a registered function, both of which fire _after_ the transaction commits and cannot
change the outcome.

Running someone else's code on the write path is only acceptable if it cannot do anything the
person who installed it could not. Everything below exists to make that true.

## The three things a plugin is

1. **A manifest** — id, version, requested capabilities, egress allowlist, hooks, entrypoint, and
   optionally the settings an operator fills in.
2. **A bundle** — one ES module, stored in the blob store, addressed by SHA-256 checksum.
3. **A grant** — the capability list a human actually approved, which may be _less_ than the
   manifest asked for and can never be more.

## Capabilities

A capability is a declared string, listed in the manifest's **`capabilities`** field:

```json
{
  "id": "com.example.seo",
  "name": "SEO helper",
  "version": "1.2.0",
  "capabilities": ["content:read", "network:request"],
  "allowedHosts": ["api.example.com"],
  "hooks": ["entry:beforeSave"],
  "entrypoint": "index.js"
}
```

The field is **required**, even when empty: `"capabilities": []` is a statement that the plugin
needs nothing, where leaving the field out says nothing a human could consent to. A manifest
without it, with an unknown capability, or with a duplicate is refused at install and upgrade.

What a plugin runs with is its **effective grant: declared ∩ approved**. Both halves are a ceiling.
The approval is the human's; the manifest is the author's. An approval that outlived the manifest
that justified it is never honoured beyond what the current manifest declares.

Every capability that reaches platform data maps to a platform scope, and installing is refused if
the installer does not themselves hold it:

| Capability                                                       | Scope the installer must hold |
| ---------------------------------------------------------------- | ----------------------------- |
| `content:read`, `assets:read`, `taxonomy:read`                   | `preview:read`                |
| `content:write`, `assets:write`, `taxonomy:write`, `ai:generate` | `content:write`               |
| `content:publish`                                                | `content:publish`             |
| `search:read`                                                    | `search:read`                 |
| `network:request`, `kv:storage`                                  | — (reach no platform data)    |

So installing a plugin is never a privilege-escalation ladder: an editor who cannot publish cannot
install a plugin that publishes. Capabilities **intersect** RBAC; they never widen it.

At call time a plugin acts as a principal holding exactly the scopes its _approved_ capabilities
imply, scoped to the space it was installed in. Every capability method it is handed is a call into
the same application use-case the HTTP API and the MCP tools call — so RBAC, per-content-type
grants, field masking and field validation all apply to a plugin exactly as they do to a person.

A capability that was not granted carries **no authority**. The application builds no method for it,
so there is no code path to reach. The sandbox then hands the plugin an inert stand-in that holds no
reference to anything. Calling it fails with an error that names what is missing:

```
capability_denied: plugin "com.example.seo" was not granted "content:write", so caps.content.create is unavailable. …
```

Each refusal is logged and written to the space's audit trail. The actor is `plugin:<id>`, the
action is `plugin.capability_denied <capability> caps.<method> (<reason>)`, and the status is 403.
A plugin reaching outside its grant is either a packaging mistake or a plugin probing its fence, and
either way the operator should see it. `caps.granted` lists the effective grant, so a plugin can
feature-detect without calling something and getting refused.

## Consent

- A plugin is installed **disabled**. Approving a capability list and starting to run code are two
  separate decisions, made at two separate moments.
- An upgrade that asks for a capability the installed version **never asked for** is refused unless
  it carries a fresh approval. The installed version keeps running on its existing grant until
  someone approves the new list. An upgrade cannot be a way to acquire capabilities quietly.
- A capability the previous version also asked for was already decided. If it was declined, it
  stays declined: asking again in a new release does not reopen the question.
- An upgrade that asks for _less_ silently drops the difference.
- Any approval that **grows** the effective grant lands the plugin disabled. This covers an upgrade
  and an approval made on an installed plugin alike. Narrowing a grant, or keeping it the same,
  leaves the plugin running.
- The bundle's checksum is verified on **every** load, not only at install. Bytes that no longer
  match what was approved are not the bytes a human consented to, and are not run.

### Plugins installed before capability manifests

A stored plugin whose manifest has no `capabilities` field (one installed before the field became
required) is treated as **requesting exactly the access it already holds**, and is flagged
`needsReapproval`:

- A deploy neither widens nor strips it. If it was running, it keeps running on the same grant.
- It cannot be switched **on** until someone approves its capabilities. Switching it off is always
  allowed.
- Because its declaration is built from its grant, re-approving it can keep or narrow that grant,
  never widen it. Re-approving saves the declaration and clears the flag. So does upgrading it to a
  version whose manifest declares capabilities.

## Hooks

| Hook                  | Fires                                                                | May mutate | May veto |
| --------------------- | -------------------------------------------------------------------- | ---------- | -------- |
| `entry:beforeSave`    | after defaults, before slug normalization and validation             | yes        | yes      |
| `entry:beforePublish` | inside the publish transaction — a veto rolls the whole publish back | no         | yes      |
| `entry:beforeTrash`   | before an entry leaves the published read model                      | no         | yes      |
| `entry:beforePurge`   | before a hard delete                                                 | no         | yes      |
| `asset:beforeCreate`  | before an upload URL is minted, so a refusal costs no storage        | yes        | yes      |

Where a hook cannot mutate, a returned payload is _ignored_ rather than applied: publish, trash and
purge act on an entry that already exists, and letting a plugin rewrite it mid-transaction would
mean the version being published is not the version that was reviewed. `entry:beforeSave` runs
before normalization and validation on purpose, so nothing a plugin produces escapes either.

Plugins registered for the same hook run sequentially in id order, each seeing the previous one's
mutations. The first veto wins and the rest do not run.

A plugin that throws, times out, or fails its checksum check is **skipped**, and the write proceeds.
A broken plugin must not make the CMS unwritable: failure means "did not run".

Validating an entry without saving it (`POST …/entries/validate`, `entries_validate`) runs
`entry:beforeSave` as a dry run (`HookDispatchOptions.pureOnly`): only plugins whose effective grant
is empty run, since with no capability object a plugin can compute an answer and nothing else. A
plugin holding any capability could write, store or fetch, so it is skipped, and its id is returned
in `skippedHooks`: on the real save it may still rewrite or refuse the fields.

## The sandbox

Plugins execute through `@commerceworker/adapters/plugins-cf-loader`, backed by the platform's
worker loader (`PLUGIN_LOADER` binding): each plugin runs in its own dynamic edge worker — a
separate v8 isolate with no bindings and no ambient authority.

- `globalOutbound: null` severs the isolate from the network. `fetch()` inside it throws rather than
  escaping.
- Capabilities are passed as **arguments on the RPC call**, not as load-time `env`. A warm isolate
  therefore cannot retain authority granted for an earlier invocation.
- The isolate is keyed by `pluginId@checksum`, so changed bytes can never reuse an isolate warmed
  from the old ones.
- The plugin's compatibility date is pinned separately from the host's: a plugin should not change
  behaviour because the platform's date moved.
- The host bounds how long it waits (default 2 s, so a plugin cannot hold an editor's save open);
  the runtime bounds CPU, memory and subrequests.
- The adapter **re-derives** what the isolate receives from the invocation's effective grant. It
  does not trust the object the host passed in. For each method in the capability → method map,
  the plugin gets the host implementation only if the method's capability is granted _and_ the
  deployment provides it. Otherwise it gets a refusing stand-in. A host key the map does not list,
  such as a stray binding, never reaches the plugin. This is deny by default, enforced at the last
  point before the isolate.

**`network:request` is granted as a capability method, not as ambient `fetch`.** The isolate stays
severed either way. A plugin with the capability gets `caps.network.fetch(url)`, which checks the
manifest's `allowedHosts` before anything leaves. The sandbox adapter checks it first and records a
`host-not-allowed` denial, and the application checks it again behind that.

That is not the obvious design, because the obvious one does not work: filtering the isolate's own
outbound needs `globalOutbound` to be a real `Fetcher` carrying a _per-plugin_ allowlist, and
the runtime offers no way to build one (a plain `{ fetch }` object, a dynamically loaded guard
worker's entrypoint and a per-plugin parent entrypoint were all tried and refused). So network
access arrives the way every other capability does: handed in as an RPC argument. Ambient `fetch`
stays dead, which means there is nothing to bypass — a plugin cannot reach the network except
through the method, and the method cannot reach a host nobody approved.

**Reads only.** A POST to a third party is a side effect on someone else's system, which is a larger
thing to grant than "may read from these hosts" and deserves its own consent rather than riding
along. Responses are bounded in size and time, because a plugin is holding an editor's save open.

A URL is screened for SSRF _as well as_ checked against the allowlist: an operator who allowlists a
hostname that resolves internally should not thereby hand a plugin the inside of their network.

Without the `PLUGIN_LOADER` binding the hook seam stays unwired and installed plugins simply do not
execute. There is no in-host fallback: running untrusted code in the host isolate is not a
degraded mode of isolation, it is the absence of it.

## Writing a plugin

One ES module exporting a class named `Plugin`, with a method per hook:

```js
export class Plugin {
  // (payload, capabilities) — capabilities holds only what was approved.
  async onEntryBeforeSave(entry, caps) {
    if (entry.fields?.title?.['en-US']?.length > 120) {
      return { veto: { reason: 'Title is too long for the card layout' } };
    }
    const siblings = await caps.content.list({ contentType: 'article' });
    return { payload: { ...entry, fields: { ...entry.fields, related: siblings.slice(0, 3) } } };
  }
}
```

| Hook                  | Method                 |
| --------------------- | ---------------------- |
| `entry:beforeSave`    | `onEntryBeforeSave`    |
| `entry:beforePublish` | `onEntryBeforePublish` |
| `entry:beforeTrash`   | `onEntryBeforeTrash`   |
| `entry:beforePurge`   | `onEntryBeforePurge`   |
| `asset:beforeCreate`  | `onAssetBeforeCreate`  |

Return nothing to pass through, `{ payload }` to replace it, or `{ veto: { reason, issues } }` to
refuse. Anything unrecognised is treated as pass-through, so a plugin returning junk cannot corrupt
an entry. A plugin cannot attribute its refusal to a different plugin — the veto is stamped with the
id of whoever raised it.

Capability methods. Each one calls the same application use-case the HTTP API calls:

| Capability        | Methods                                                                                 | Provided |
| ----------------- | --------------------------------------------------------------------------------------- | -------- |
| `content:read`    | `caps.content.list(query)`, `caps.content.get(id)`, `caps.content.listPublished(query)` | yes      |
| `content:write`   | `caps.content.create(input)`, `caps.content.update(id, fields)`                         | yes      |
| `content:publish` | `caps.content.publish(id)`                                                              | yes      |
| `assets:read`     | `caps.assets.list(query)` → `{ items, nextCursor? }`, `caps.assets.get(id)`             | yes      |
| `assets:write`    | `caps.assets.create(…)`                                                                 | not yet  |
| `taxonomy:read`   | `caps.taxonomy.listTags()`                                                              | yes      |
| `taxonomy:write`  | `caps.taxonomy.createTag({ name })`                                                     | yes      |
| `search:read`     | `caps.search.query(…)`                                                                  | not yet  |
| `ai:generate`     | `caps.ai.generate(…)`                                                                   | not yet  |
| `network:request` | `caps.network.fetch(url)` → `{ status, contentType, body }`                             | yes      |
| `kv:storage`      | `caps.kv.get(key)`, `.put(key, value)`, `.delete(key)`, `.list({ prefix, cursor })`     | yes      |

A manifest may declare a capability marked "not yet", and a human may approve it. A call to it is
refused as `not-provided` until the platform wires an implementation. The consent screen says this,
so approving one is never mistaken for granting something that works.

Every plugin also gets `caps.settings.get()`, with no capability (see [Settings](#settings)).

There is no `email:send` or admin-page capability. A plugin runs inside a write and has no host API
for either. Admin pages are app extensions, a separate mechanism, and outbound email has no port. A
capability goes into the vocabulary when there is something real behind it.

### `kv:storage`

A key/value store of the plugin's own, **per environment**: what a plugin writes while saving in
`staging` is not there when it runs in `main`. Values are anything JSON can encode, and come back
in the same shape.

Isolation is structural. The host binds the plugin id from the installed record before the plugin
is called, and every statement the store runs filters on the space, the environment and that id. No
argument a plugin passes reaches that part of the key, so there is no key one plugin can name that
reads another's.

| Limit                           | Value                                 |
| ------------------------------- | ------------------------------------- |
| Key length                      | 512 characters                        |
| Value size (its JSON encoding)  | 64 KiB                                |
| Keys per plugin per environment | 1,000 (overwriting is always allowed) |
| Keys per `list` page            | 100                                   |

A refused call throws with a stable prefix a plugin can match: `kv_invalid:` (a bad key or a value
JSON cannot encode) or `kv_limit:` (too large, or at the key cap). The cap is checked in the same
statement that writes, so concurrent puts cannot overshoot it. `list` returns keys in byte order;
pass the `cursor` it returns to read the next page. `%` and `_` in a prefix are ordinary
characters.

A put is written when it is called, not with the write the hook is part of: a key a plugin stores
during `entry:beforePublish` stays even if a later plugin vetoes the publish. Store state that is
harmless when the write it rode on never lands: a cache, a cursor, a counter that tolerates drift.

The keys live in the database (`plugin_kv`), next to everything else a plugin touches, because a
plugin only ever runs on a write path, where the primary is already being written. They go with
their environment when it is deleted, and with the plugin when it is uninstalled, so reinstalling
the same id starts clean.

## Settings

A manifest may declare the settings an operator fills in:

```json
{
  "settings": [
    { "key": "apiKey", "label": "API key", "type": "string", "secret": true, "required": true },
    { "key": "maxLength", "label": "Max title length", "type": "number", "default": 120 },
    { "key": "tone", "label": "Tone", "type": "select", "options": ["plain", "formal"] }
  ]
}
```

| Field      | Rule                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `key`      | A letter, then letters, digits or `_` (64 at most); unique                              |
| `type`     | `string`, `number`, `boolean` or `select` (with 1–100 `options`)                        |
| `secret`   | `string` only, and no `default`: a default would sit in the manifest for anyone to read |
| `required` | A save that leaves it without a value (and it has no default) is refused                |
| `default`  | What the plugin reads until an operator sets a value; must fit the type                 |

At most 50 settings; a string value holds at most 4,096 characters. An invalid declaration is
refused at install and upgrade like the rest of the manifest.

**The plugin reads its settings with `caps.settings.get()`**, which returns every declared key's
value or default, secrets in plaintext. It needs no capability: settings are the plugin's own
configuration, and what it can learn from them is exactly what an operator chose to tell it. The
host binds the call to the installed plugin's record, so a plugin cannot ask for another's.

**Secret values are sealed at rest** under `DATA_KEY`, each bound to its space, plugin and key, and
included in the daily reseal sweep (see [Auth & RBAC](./auth-and-rbac.md#secrets-at-rest)). No read
API returns one: an operator sees `secretsSet`, the secret keys that hold a value.

Changing settings is a patch: each key in `values` is set, `null` clears it, and a key left out
keeps its value, so a secret need not be retyped to change something else. Values are checked
against the manifest's fields. Every save bumps `version`; pass the one you read as
`expectedVersion` and a concurrent change is refused with 409 rather than overwritten. A save that
races another without it also fails with 409, never by dropping a field. A value whose field an
upgrade removed or retyped is ignored when read and dropped at the next save. Uninstalling removes
the settings.

In the admin, each installed plugin's **Settings** opens a form generated from these fields, with
secrets shown only as set or not set ([Admin UI](./admin-ui.md#installing-plugins)). A refused
value comes back as a 422 whose `issues[].field` names the setting (`apiKey`, or `values.apiKey`
when the body itself fails to parse), which is how the form puts it beside the field.

## Managing plugins

Space-admin scope (`space:admin`). HTTP has every operation; MCP has five of them (below):

| Operation             | HTTP                                           |
| --------------------- | ---------------------------------------------- |
| List                  | `GET /spaces/:space/plugins`                   |
| Get                   | `GET /spaces/:space/plugins/:id`               |
| Install               | `POST /spaces/:space/plugins`                  |
| Upgrade               | `PUT /spaces/:space/plugins/:id`               |
| Inspect a package URL | `POST /spaces/:space/plugins/from-url/inspect` |
| Install from a URL    | `POST /spaces/:space/plugins/from-url`         |
| Upgrade from a URL    | `PUT /spaces/:space/plugins/:id/from-url`      |
| Approve capabilities  | `POST /spaces/:space/plugins/:id/capabilities` |
| Enable / disable      | `POST /spaces/:space/plugins/:id/enabled`      |
| Read settings         | `GET /spaces/:space/plugins/:id/settings`      |
| Change settings       | `PATCH /spaces/:space/plugins/:id/settings`    |
| Uninstall             | `DELETE /spaces/:space/plugins/:id`            |

A plugin summary carries `requestedCapabilities` (the manifest), `approvedCapabilities` (the human
decision), `grantedCapabilities` (the effective grant, what it runs with) and `needsReapproval`.

**Approve capabilities** records a fresh decision without changing the code. Use it to re-approve a
flagged plugin, to narrow a grant, or to grant something the manifest asked for that was declined
earlier. The same checks as an install apply: nothing beyond the manifest, and nothing beyond the
approver's own scopes. A grant that grows lands the plugin disabled.

MCP exposes `plugins_list`, `plugin_set_enabled`, `plugin_approve_capabilities`,
`plugin_get_settings` and `plugin_set_settings`. The settings tools call the same use-cases as the
routes. The approve tool
calls the same use-case in **narrow-only** mode. An agent may confirm a grant (which clears a legacy
plugin's flag) or reduce it, and is refused if it tries to widen it. Granting authority to code
stays a human decision on the consent screen. Plugins are scoped to a space: a grant approved in one
does not travel to another.

## Where a plugin comes from

Two ways in, both landing at the same consent screen.

**From files** — a manifest and a bundle you already have. The checksum is computed from the bytes
you uploaded, which proves they have not changed _since_, and nothing about where they came from.

**From a URL** — a package descriptor hosted over HTTPS:

```json
{
  "manifest": { "id": "com.example.seo", "version": "1.2.0", "...": "..." },
  "bundleUrl": "https://plugins.example.com/seo/1.2.0.js",
  "checksum": "<sha256 of the bundle, hex>",
  "publishedAt": "2026-08-01T00:00:00Z"
}
```

The server fetches the descriptor, then the bundle, and refuses the install unless the bundle's
SHA-256 matches the checksum the descriptor declares. That check is the point: it is what makes a URL
an acceptable way to obtain code that will be executed.

Everything is verified _before_ a byte reaches the blob store, so a package that fails any check
leaves nothing behind.

| Refused                                                                  | Because                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Plaintext `http://`                                                      | The bytes are executed; anyone on the path would choose the code |
| A loopback, link-local or private address                                | An install endpoint is otherwise an SSRF                         |
| A redirect (3xx)                                                         | The URL that was screened is not the URL that would be fetched   |
| A descriptor with no valid SHA-256                                       | There would be nothing to verify the bundle against              |
| A bundle whose bytes disagree with the checksum                          | Whatever the descriptor said, these are not those bytes          |
| A package that is a different plugin or version than the caller expected | The operator approved something else                             |
| A package whose checksum differs from a pinned `expectedChecksum`        | The release changed since it was approved                        |

### Consent, when there is nothing to look at yet

A consent screen exists to show a human what they are approving, and a URL shows nothing until
someone fetches it. So the flow is: **inspect**, then **install**.

`POST …/plugins/from-url/inspect` fetches and verifies exactly as an install would, and returns the
manifest, the checksum of the bytes it actually fetched, the publish date and the size. The admin
renders the same consent screen from that, then installs with `expectedChecksum` set to what it
displayed — so a release swapped in between the two calls is refused rather than installed under an
approval given for something else.

### Deployment policy

| Env var                        | Effect                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `PLUGIN_MIN_RELEASE_AGE_HOURS` | Refuse releases younger than this                                                               |
| `PLUGIN_SOURCE_HOSTS`          | Comma-separated hosts packages may come from (`*.example.com` matches subdomains, not the apex) |

A caller may ask for a **longer** wait than `PLUGIN_MIN_RELEASE_AGE_HOURS`, never a shorter one — a
policy a caller can turn off is not a policy. A package with no `publishedAt` is refused outright
when a minimum age is set, so the knob cannot be bypassed by omitting a field.

The waiting period exists because a compromised release is usually caught within hours: a deployment
that waits is not exposed to the window where it is public and unnoticed. The cost is that a genuine
fix also waits, which is why it is a deployment decision rather than a default.

**There is no registry service, deliberately.** A URL and a checksum cover the real need; a
federated index is a distribution convenience layered on top, and building it first would mean a
trust root nobody asked for.

**MCP cannot install plugins.** Listing them and toggling what a human already approved is exposed;
introducing new executable code is not. An agent that could install a plugin could grant itself
capabilities its own principal was never given.

## Installing one

Settings → Plugins is a consent surface before it is a list; see [Admin UI](./admin-ui.md#installing-plugins).
