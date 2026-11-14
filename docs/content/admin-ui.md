# Admin UI

The deployed admin is `apps/web`, with content under `/content`: overview, entries, approvals,
releases, workflows, assets, taxonomy and settings. Commerce owns sign-in, accounts, team, sign-out
and the Ledger shell. `packages/content-admin` holds the content screens and client providers;
Studio consumes the same package for standalone local development.

Web forwards browser API calls under `/content-api` to `apps/api` through `CONTENT_API`, stripping
cookies, bearer credentials and caller-supplied principal headers before signing the live caller.
Media URLs retain `/media/*` so existing signatures remain valid. Content sockets recheck the
commerce session through Web's default service binding (`ContentIdentity` methods).

`CONTENT_DB` is bound only for explicit legacy identity links, through Web's composition root.
The **Content accounts** page (`/content/accounts`) requires an admin and step-up; its one-time
link preserves the old content subject and history without changing the commerce role. A matching
email alone never adopts an old account. New identities use `commerce:<id>`; space invitations
link on first use only if they do not already belong to a subject.

`pnpm --filter @commerceworker/web e2e:content` runs the unified iPhone, iPad and desktop checks.
For a local unified stack, migrate commerce normally, apply the content migrations with
`pnpm --filter @commerceworker/web exec wrangler d1 migrations apply DB --local --config dev/content-database.jsonc`,
then run `COMMERCEWORKER_CONTENT=1 pnpm web:dev`. Both local databases remain separate.

## Standalone Studio reference

The rest of this page describes Studio without `COMMERCE_ORIGIN`, as used in standalone local
development. Fleet renders set that origin: human GETs redirect to Web, old form POSTs answer 410,
and native Studio sessions no longer sign API calls. Machine bearer APIs and SCIM remain at the
old host. OAuth authorization/device pages enter `/content-api/oauth/*`; Web rewrites their form
actions while the issuer and token endpoints stay unchanged. Its design context is
`PRODUCT.md` and `apps/studio/DESIGN.md` ("Ledger", from `@commerceworker/design` and
`@commerceworker/ui`); read both before designing a screen, and compose the existing tokens and
components rather than stock defaults.

## Running locally

`pnpm dev` (see [Development](./development.md#running-locally)) serves the admin at
http://localhost:5173 together with the api, engine and delivery workers. While the local
database has no people the admin is open; once someone is added through `/setup`, sign-in is on.

## In production

The web worker is deployed at `<domain>` (custom domain rendered by `scripts/fleet.ts`). Static
assets are served by the platform; HTML responses default to `private, no-cache`. Every response
carries the security headers from `app/lib/csp.ts`, and state-changing browser requests from
another origin are refused (403).

## Sign-in and people

| Route                                                  | What it does                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                    | Signed in, redirects to `/dashboard`; signed out, `requireUser` sends the browser to sign-in                                                                                     |
| `/setup`                                               | Redeems the one-time `SETUP_TOKEN` to create an Admin account (`app/lib/setup.server.ts`)                                                                                        |
| `/login`                                               | Email and password (PBKDF2, peppered with `PASSWORD_PEPPER`)                                                                                                                     |
| `/login/passkey`, `/account/passkeys`                  | Passkeys (WebAuthn)                                                                                                                                                              |
| `/login/two-factor`                                    | TOTP second factor, or a recovery code                                                                                                                                           |
| `/login/forgot`, `/login/reset/:token?`                | Self-service password reset by an emailed code (`app/lib/password-reset.server.ts`); the emailed link moves its code into a cookie and redirects to `/login/reset`                |
| `/logout`                                              | Signing out is a POST (the origin check covers it); a GET asks first                                                                                                             |
| `/login/sso`, `/login/sso/callback`, `/login/sso/link` | OpenID Connect single sign-on with the deployment's provider (`app/lib/sso.server.ts`)                                                                                           |
| `/scim/v2/*`                                           | SCIM provisioning from the identity provider, with its own bearer token. Answered by `workers/app.ts` (`scimFetch`) before React Router, so it is not a route in `app/routes.ts` |
| `/invite/:token`                                       | Moves the token into a cookie and redirects to `/invite`, which accepts: a password or SSO for someone new, or Accept when signed in as the invited address                      |
| `/team`                                                | People, invitations, deployment roles (Member, Admin), SSO and SCIM settings (admins)                                                                                            |
| `/audit`                                               | The deployment's admin audit log (`admin_audit`, hash-chained)                                                                                                                   |
| `/account`                                             | Your password, passkeys, two-factor                                                                                                                                              |

Sessions, users, passkeys and challenges live in the database (`0002_auth.sql`; reset codes,
`0021_password_resets.sql`). Authenticator secrets are
sealed with `DATA_KEY`. Sign-in paths that need no session, and SCIM, are rate-limited per address
(`API_LIMIT`).

## How screens reach the API

The CMS screens (`app/cms`) call the Management API in the browser with TanStack Query
(`packages/content-admin/src/lib/management.ts`) on the same origin: `/spaces/...`, `/preview/...`, `/delivery/...`,
`/mcp`, `/media/...`. The web worker's gateway forwards those to the api with a signed
`x-cw-principal` (60 s, bound to the path) in place of the session cookie, and passes the
`x-cw-bookmark` read-your-writes header both ways. The admin keeps the newest bookmark it has seen
(`rememberBookmark`: database bookmarks sort as strings, so an older reply arriving late never
moves it back, and a value not shaped like a database bookmark is ignored), as the SDKs do. See
[Architecture](./architecture.md#appsweb-the-admin-and-the-gateway) and
[Auth & RBAC](./auth-and-rbac.md#the-web-principal).

The admin is not a composition root. All business logic, validation and RBAC run in
`@commerceworker/application` behind the api. A new capability is exposed through the API and MCP
first; the admin then calls the route.

## Layout

From `md` a sidebar lists the day's work (Overview, Content, Approvals, Releases), then Build
(Workflows), Library (Assets, Taxonomy) and Settings, with the account and theme at its foot; it
collapses to an icon rail. A sticky header holds the breadcrumbs, the space / environment / locale
scope, search and New entry. Below `md` a bottom tab bar holds the day's work and More.
`packages/content-admin/src/components/layout/nav.ts` is the one source of the pages and their `g`-letter shortcuts
(`?` lists them).

`/team`, `/audit` and `/account` are not in `NAV` (`nav.ts`). The shell adds them: admins get a
Deployment group (People and sign-in, Audit log) after Settings, and Account sits in the account
menu at the sidebar's foot (the More sheet on a phone). Settings sections are addressed as
`/settings/:section` (default `team`, Space access): **Access** (Space access, API keys, Roles, Connected apps), **Automation**
(Webhooks, Functions, AI actions), **Extensions** (App extensions, Plugins), **Workspace**
(Environments, Redirects, Menus, Audit log).

## Features

- **Overview** (`/dashboard`): what needs attention, live activity, AI usage and throughput.
- **Content** (`/content`): content types and their schema editor; entries per type with filters,
  search, sorting from the column headers, a bulk bar for publishing and unpublishing what is
  ticked, and Load more past the first 100 (`/content/:typeId`; `/content/:typeId/new` starts a new
  entry). The list's filters, search, sort, columns and open saved view are its URL, in the Preview
  API's own query string (`?fields.title[match]=cat&order=-sys.updatedAt&columns=sys.status,team&view=<id>`;
  `cms/lib/entry-url.ts`), so a link and a view agree and Back undoes a picked view; a parameter nothing
  here reads is kept and saved with a view, never sent, and a key something does read (a filter, a
  list or connection parameter) never comes out of a view's `extra`. A **views menu** (`entries/SavedViewsMenu.tsx`)
  before the search picks a saved view (yours, then those shared with the space), saves the list as a
  new view (shared with the space when the role holds `content:manage`), saves changes over the open
  one (the trigger says "edited" once the list has moved off it), renames, shares or (for the view's
  creator) stops sharing, and deletes; a shared view is offered to pick but not to change without
  `content:manage`. Over a view of every type, field columns aren't saved. **Columns**
  (`entries/ColumnPicker.tsx`) picks what shows after the title: Status, Updated and the type's own
  fields, kept with the view; a singleton type's sidebar and overview links go to
  `/content/:typeId/entry` (`SingletonEntry.tsx`), which opens its one entry in the editor, or a new one when it has none,
  and its rows offer no Duplicate; each type's row on the overview has a menu (`More actions for
  “…”`) with Clone… and Delete… (`ContentTypeActions.tsx`): the delete dialog reads
  `…/dependents`, names what blocks it, offers to delete the entries too (a `content_type_delete`
  job), and is confirmed by typing the API ID. The job's card (`ContentTypeDeleteJob.tsx`) is kept
  by `ContentLayout`, so it survives a visit to an entry; it polls until the job records the type's
  outcome (`config.typeDeletion`), then reloads and shows that the type was deleted, or kept with
  the failed entries from the job's report or the refusal's reason; Stop cancels the job. A
  singleton's pages offer no Import (nor the palette's New/Import, which become "Open ‹type›");
  the entry editor (TipTap rich text, components and repeaters, references, localized fields; a
  `Seo` field renders as a component of `SEO_FIELDS` in `EntryForm.tsx`, each part with a helper
  line wired to `aria-describedby`: title and description count characters against what search
  results show, 60 and 160; canonical URL, hide from search engines, social image (asset picker);
  a type's layout as tabs and field groups; date inputs by format and list editors; fields its
  rules hide, or make read-only with the reason linked, announced in a polite live line; see
  DESIGN.md),
  version history, diff and restore, comments and tasks, metadata, AI assist; import
  (`/content/:typeId/import`) from CSV, JSON or a WordPress export, with a dry-run report before
  anything is written and a resumable job past 10,000 records; a whole space export
  (`/content/space-import`, linked from the empty content list, or the **Space export** format on
  the import screen) into an environment with no content types, with the same report first.
- **Coworker**: the assistant panel in the shell, open from any page; its conversation and any
  confirm card waiting for an answer survive navigation. A page's edit can go through it (the
  exact MCP tool call, no model); when the assistant is off or its socket is down, the page makes
  the edit through the API itself. See
  [AI, agents & search](./ai-agents-and-search.md#coworker-the-admins-assistant).
- **Approvals** (`/approvals`): the editorial workflow task inbox.
- **Releases** (`/releases`): bundle entries and assets, publish as a unit, schedule.
- **Workflows** (`/workflows`, `/workflows/:id`): editorial workflow definitions and the graph
  editor (React Flow), with server-side validation, versions, and AI drafting.
- **Assets** (`/assets`; the old `/media` address redirects): the asset library. A folder tree (all
  assets, those in no folder, nested folders to create, rename, and delete once empty) beside a
  filter bar (kind, status including archived, tag, sort) and a grid or list (the choice is kept
  per browser), paged with the API's cursor. Pick or drop any number of files to upload them into
  the open folder, each with its progress and a live summary ("Uploaded 2 files; 1 failed"), then
  one toast for the batch; select several to move them to a folder, publish them, or archive them
  after an in-place "Archive N assets?" (ids a bulk action fails for stay selected and are named in
  an alert); archive (with Undo) or restore one; delete one, and when entries still link to it the
  screen lists them by title (from the 409's `usage`, five shown, then "and N more"), each a link
  to the entry, and offers to archive it instead. A failed load shows an alert with Retry, and the
  first load shows skeletons. On a phone the folder tree becomes a select of folder paths with its
  actions in a sheet, and the list view stacks as rows. Each asset's sheet holds its alt text,
  focal point, tags and usage. The web build's own files are served from `/_static/` (Vite's
  `build.assetsDir`, cached immutable by `public/_headers`), so nothing under `/assets` is ever a
  static file.
- **Taxonomy** (`/taxonomy`): concept schemes, concepts, tags. Each term shows its slug and how
  many published entries carry it; Edit opens a sheet (`TermEditor`) for its label, slug,
  description and a label per other locale of the space, saving only what changed.
- **Settings**: API keys, roles, OAuth connected apps, webhooks, functions, AI actions, app
  extensions (iframe panels, `ExtensionFrame`), plugins, environments and aliases, branch
  compare/merge, redirects, menus, the space audit log.
- **Audit log** (`/settings/audit-log`, `packages/content-admin/src/components/AuditLog.tsx`): the space's trail, with
  fields for actor, action, target type, target id and a range of days on the reader's clock.
  Filters match exactly, so pressing a row's actor, action or target fills its field. Pages of 50
  read in through Load more; a new filter starts from the first page. The Changed column shows a
  row's `detail`: its paths without the `fields.` prefix on one truncated line (whole in the `title`,
  wrapped on a phone) and its locales, or how many entries when the row changed several.
- **Redirects** (`/settings/redirects`, `packages/content-admin/src/components/Redirects.tsx`): the environment's
  redirect set ([Domain model](./domain-model.md#redirects)) as a list with search over source,
  destination and note, an enable switch per row, and an add/edit dialog (source, destination,
  status, locale, note, enabled). Import takes CSV or JSON: _Check_ runs a dry run and reports
  what would be created, updated or left alone, then _Import_ writes it. When the set holds
  chains an alert offers _Collapse chains_. Reading needs `preview:read`; changing anything,
  `content:manage`. The content type dialog has a **URL pattern** field (`/blog/{slug}`), the
  input to slug-change redirects and the sitemap; it offers the `Seo` field type until one row
  already is one (a type has at most one).
- **Menus** (`/settings/menus`, `packages/content-admin/src/components/Menus.tsx`): the environment's navigation
  menus ([Domain model](./domain-model.md#menus)) as a list (name, handle, item count; New menu,
  Edit, Delete), and an editor for one menu's item tree. Add or edit an item in a dialog: a URL
  (with a label), an entry (the entry search picker; the label defaults to its title) or a tag or
  concept, and _Open in a new tab_; an item's attributes are kept but not edited here. Each row
  shows the status Delivery's resolution gives it (`GET …/menus/:id/preview`): Live, Not
  published, Missing or No URL, in words. Reorder by keyboard: every row has Move up, Move down,
  Move out a level and Move in a level (also Alt+arrows on a focused row), each one `POST
  …/menus/:id/move` with the revision read; focus stays on the moved item and an sr-only line
  says what moved. Move in a level is disabled where the item's subtree would nest past three
  levels. Every change names the revision it was made against: a menu someone else saved since
  is a 409, and the editor stops with a _Reload_ alert rather than overwrite it. Reading needs
  `preview:read`; changing anything, `content:manage`.

### Inline-edit links

The `@commerceworker/sdk/react` inline editor links to
`/content/:type/:entryId?field=&locale=&space=&env=` ([SDKs](./sdks.md#inline-editing)). The entry
editor selects the locale tab and focuses that field. If the link names a different space or
environment than the current connection, the editor says so rather than loading: the id either
404s or, if it exists in both, opens the wrong entry looking entirely correct.

### Installing plugins

Settings → Plugins is a consent surface before it is a list ([Plugins](./plugins.md) covers the
model). Installing takes either two files (the manifest and the bundle) or an `https` package URL,
which is inspected first so the screen shows the verified manifest and checksum. Only once the
manifest has been read does the screen ask for anything: what the code will run on, what it is
asking to be able to do (in plain language, one checkbox each, pre-approved as requested so that
the only direction consent can move without a second look is _narrower_), and which of those this
deployment cannot enforce. The plugin lands disabled regardless; the button says so.

The list then shows, per plugin, what it runs on, what it can do (its effective grant), and what it
asked for and did not get. That last fact exists because a plugin behaving oddly is usually a
plugin doing without something, and nothing else on the screen would say so.

**Access** opens the same checkboxes in place, as a confirmation under the row. If ticking a box
would grow the grant, the button reads _Approve and disable_ before it is pressed. A plugin flagged
`needsReapproval` shows _Needs review_ instead of a running state. Its only way back on is
**Review access**.

**Upgrade** takes a new manifest and bundle for the same plugin id. Capabilities the installed
version never asked for are marked _New_ and pre-checked. Earlier decisions carry over: a granted
capability stays checked and a declined one stays unchecked. If the upgrade would grow the grant,
the button reads _Upgrade disabled_.

**Settings** (named for the plugin, "SEO helper settings") opens a sheet with a form drawn from the
fields the installed manifest declares: a text input for a `string`, a numeric one for a `number`,
a switch for a `boolean`, a select for a `select` (with _Not set_, or _Default (…)_ when the field
has one). Each field's description and default are its hint, and a required one is marked. A
secret is write-only: the sheet says _Set_ or _Not set_ and offers **Set** or **Replace** (an
empty password input) and **Clear** (undone in place before saving); no secret value ever reaches the browser, so
there is none to show. Saving sends only the fields that changed, against the `version` the sheet
loaded. A 422 puts each issue beside its field (`aria-invalid`, tied by `aria-describedby`) and
moves focus to the first; a 409 says someone saved first and offers **Reload settings**; a role
without `space:admin` is told so in place of the form.

## Testing

```bash
pnpm --filter @commerceworker/studio test   # vitest: auth, sessions, gateway, lib units
pnpm --filter @commerceworker/studio e2e    # Playwright in WebKit and Chromium, with axe
```

The e2e suite (`apps/studio/e2e`) runs the dev server offline on port 5390 against a fresh local
database (`.wrangler/e2e`): shell layout on iPhone, iPad and desktop (both orientations), the CMS
flows, space access (`space-access.spec.ts`), OAuth for MCP clients end to end (`oauth.spec.ts`),
the workflow list and editor (`workflows.spec.ts`), an axe WCAG 2.1 A/AA sweep
(`accessibility.spec.ts`; `contrast-settle.spec.ts` checks a re-enabled button is at full opacity at
once, so the sweep cannot catch it mid-fade), and sign-in last (the `auth` project signs up the
first admin, which turns sign-in on). CI runs it in four parallel `devices (…)` jobs, split by
`E2E_PART` (`webkit`, `axe`, `cms`, `sign-in`); `E2E_PART=cms pnpm --filter @commerceworker/studio e2e`
runs one part locally.

Assert accessible names only in Playwright: jsdom names some controls a real browser does not.
