# Developer tooling: the CLI and agent skills

How `packages/cli` (`@commerceworker/cli`, the `commerceworker` command) and the developer skills in
`skills/` are built, tested and published. The user-facing pages are
https://docs.commerceworker.com/content/guides/cli/ and https://docs.commerceworker.com/content/guides/agent-skills/.

## Two kinds of skill

| Folder                  | For                                                    | Served                                                  |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `packages/http/skills/` | An agent working _in_ a workspace through MCP tools    | Embedded and served by the MCP server ([MCP](./mcp.md)) |
| `skills/`               | A coding agent building _on_ a workspace: SDKs and CLI | Installed by developers from this repo                  |
| `.claude/skills/`       | Agents changing CommerceWorker itself                   | This repo's Claude Code toolkit                         |

The `skills/` ones follow the open `SKILL.md` format: frontmatter with only `name` (the folder
name) and `description` (what it covers and "Use when …"), a body under 500 lines, and detail in
`references/` linked from it.

## The CLI

`packages/cli/src`:

| File             | Holds                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `bin.ts`         | The entry: `run(process.argv.slice(2), processIo())`                                                                            |
| `run.ts`         | Argument parsing (`node:util` `parseArgs`, strict), dispatch, `--json`, errors to exit codes, help                              |
| `commands.ts`    | `COMMANDS`, the registry: each command's name, product, options and handler. Help and the skills test read it                   |
| `args.ts`        | The `Command` and `CommandContext` types and the flag helpers every command file reads its options with                        |
| `commerce.ts`    | The commerce half: `login` against an admin origin, `whoami` through `/me`, and the commerce commands over `createCommerceClient` |
| `session.ts`     | Which token and target a command uses: `COMMERCEWORKER_TOKEN`, else the stored profile, refreshed when within a minute of expiry |
| `oauth.ts`       | The RFC 8628 device flow against the authorization server: discovery (issuer check), registration, polling, refresh, revocation  |
| `credentials.ts` | `credentials.json` in the user config dir, written 0600 in a 0700 directory, atomically (temp file and rename), and the refresh lock |
| `model.ts`       | Model files (JSON or a TypeScript module), normalization, and the plan `model apply` shows                                      |
| `io.ts`          | `Io`: process, fetch, clock, config dir and prompt, injected so tests run without a network or a terminal                       |

Design points:

- **Built on `@commerceworker/sdk-management`**, with `@commerceworker/sdk-codegen` for `types`.
  Both are dev dependencies that tsup bundles into `dist/bin.js`, so the published package has no
  runtime dependencies. Runs on Node 24+, not workerd.
- **Login is the MCP device flow.** The CLI registers itself as a public client
  (`grant_types: [device_code, refresh_token]`, no redirect), reusing the client id on the next
  login, and polls `/oauth/token` at the server's `interval`, five seconds more after each
  `slow_down`. The token is a space-bound API key with `issuance: 'oauth'`, capped by the
  approver's role and the OAuth scope ceiling, which excludes `space:admin` and `content:manage`.
  So `model apply` needs a Management key or personal access token (`login --token`, or
  `COMMERCEWORKER_TOKEN`). The space comes from `GET /auth/me`.
- **Output contract.** `--json` prints exactly one JSON document on stdout; everything else goes
  to stderr (the device code as a JSON line, plans, errors as `{ error: { code, message, status?,
  details? } }`). Exit codes: 0 ok, 1 failure, 2 usage or confirmation needed, 3 auth, 4 a
  destructive change refused. They are part of the interface the skills rely on.
- **No prompts off a terminal.** `Io.interactive` is true only when stdin and stdout are TTYs;
  otherwise a write that would ask (`model apply`, `import`) needs `--yes` or exits 2.
- **`model apply` plans before it writes.** `planModel` compares normalized drafts with
  `GET …/content-types`: removing a field or block variant at any depth, and changing `type`,
  `linkType`, `localized` or `items.type`/`items.linkType`, are destructive and need
  `--allow-destructive`. It upserts through `POST …/content-types` (an existing apiId is revised)
  and publishes each type, so the server's own guard (`assertNoRemovedContentInUse`) still has the
  last word on removals. Types not in the file are reported, never deleted (there is no delete
  route).
- **`entries list`** reads Preview (`GET /preview/:space/:env/entries`), since the Management API
  has no entry list; `entries update` merges by field and locale before the `PUT`, because the API
  replaces the whole draft.
- **`import`** always analyzes first and stops if the plan isn't executable; `--job` uses the
  durable import job. The payload is sent as a string, so the api's body cap (`MAX_BODY_BYTES`,
  5 MiB by default) bounds the file.
- **`doctor`** checks credentials file permissions, the session, `GET /health`, the API version
  (`info.version` of `/openapi.json` against `API_VERSION` in `commands.ts`; same major, and same
  minor while 0.x), `GET /auth/me` and a read of the space's content types.

### Commerce commands

Public reference: https://docs.commerceworker.com/reference/cli/. The commands are built on
`createCommerceClient` from `@commerceworker/sdk-commerce` (bundled like the other SDKs), and
`run <operationId>` reaches every operation in its generated `OPERATIONS` table, so a new REST
operation needs no CLI change.

- **Profiles carry a `product`** (`commerce` or `content`); `space` and `environment` are content
  only. A `credentials.json` written before commerce commands has no `product` and loads as
  content (`readCredentials` fills it in), so nobody signs in again. A command works with its own
  product's profile only (`Command.product`; `login`, `logout` and `whoami` serve both):
  `session.ts` refuses the other with `wrong_product` (exit 2) before any request.
- **`login --url <admin origin>`** takes the product from `--product`, else from the metadata
  (`isCommerceMetadata`): a commerce deployment is its own issuer and its `scopes_supported` are
  roles; a content deployment's are `content:*` (and its issuer is the admin, or the API's own host).
  The commerce path checks `issuer` equals the origin given (RFC 8414 §3.3) and refuses otherwise
  (with `--product commerce`, a mismatch is refused; without it, such a server is not taken for commerce), then runs the device flow with
  `scope=<role>` (`--role`, default `viewer`, never `admin`) and `resource=<origin>/api/v1`
  (RFC 8707) on the device request and on each poll. Commerce signs in as the pre-registered
  first-party client `commerceworker-cli` (`FIRST_PARTY_CLIENT_ID` in `oauth.ts`; no registration;
  content still registers one), and every endpoint in the metadata must be https on the issuer's origin. `--token cmw_live_…` stores an API token after `GET /api/v1/me` accepts it.
  The browser opens only with `--open` (`Io.openUrl`).
- **Refresh is under a lock.** Refresh tokens rotate, so `refreshed()` in `session.ts` takes an
  advisory lock (`credentials.lock`, created with `O_EXCL`, broken after 30 s) and re-reads
  `credentials.json` before refreshing: a process that waited finds the other's new tokens and
  uses them. Content sessions refresh the same way. The lock holds a random nonce and is
  removed only while it still holds ours; a stale lock is broken by renaming it to a unique name
  (and put back if what was moved proves fresh), and a refresh's requests time out at 10 s, inside
  the 30 s window. A commerce refresh sends `resource`.
- **Trust.** `assertSecureOrigin` (`origin.ts`) allows https, or http on localhost, 127.0.0.0/8
  and [::1], for login, env URLs and `--url`; `--url` with a stored profile must be that profile's
  origin. `--open` parses the page with `new URL`, refuses anything but https (commerce: the
  deployment's origin) or one holding `&`, `"`, spaces or control characters, and opens the parsed
  href (Windows: `rundll32 url.dll,FileProtocolHandler`). Server strings in errors, the device code
  and human output lose C0/C1 control characters (JSON data is only escaped, so entry text keeps
  its newlines). The credentials temp file is created `wx`, and a config dir others can write to
  draws a warning. `--token -` reads stdin.
- **Output.** Commerce commands print one compact JSON document on stdout (`Result.jsonDefault`;
  `--pretty` indents) and their errors as one JSON line on stderr: the SDK error's `kind` as
  `code`, `status`, `requestId`, `operationId`, `issues` (`ApiFailure` in `output.ts`). A 401 is exit 3,
  any other API error exit 1, a bad command line or `--input` exit 2. A `403` whose message says a
  person must act adds `adminLink` (the resource's admin page; the REST API refuses what a person
  alone confirms to a token and says so in prose, so this matches the message).

When the API's `info.version` changes in `packages/http/src/api/docs/openapi.ts`, update
`API_VERSION` in `packages/cli/src/commands.ts` in the same change.

## Tests

| Suite                                | Proves                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/auth.test.ts`     | Device-flow polling (interval, `slow_down`, deny, expiry), token file and directory modes, refresh and rotation, `COMMERCEWORKER_TOKEN`, logout and revocation                          |
| `packages/cli/test/model.test.ts`    | The plan (safe and destructive changes, nested components and block variants), JSON and TS model files, dry run, refusal, `--yes`, partial failure                                     |
| `packages/cli/test/commands.test.ts` | Each command's request and `--json` shape, merge on update, bulk publish, import flow, doctor, exit codes                                                                              |
| `packages/cli/test/commerce.test.ts` | Commerce sign-in (issuer check, `resource`, role, `--open`, `slow_down`, expiry, `--token`), logout revocation, two concurrent refreshes and a stale lock, today's `credentials.json` loading as content, the product guard both ways, each command's request, JSON and exit codes, the admin link |
| `packages/cli/test/skills.test.ts`   | Every skill's frontmatter, and that each `commerceworker` command and flag, `client.`/`cma.` method, SDK import, docs link and anchor, and relative link in `skills/` exists            |
| `packages/http/test/api/cli.test.ts` | The CLI against the in-process api: device flow approved by a signed-in person, the 403 for a model change over OAuth, model round trip, entries, CSV import and re-run, types, doctor |

The unit suites use a scripted fake server (`packages/cli/test/harness.ts`) whose `sleep` advances
the clock, so no test waits. `packages/cli/turbo.json` adds `skills/`, the docs content and the SDK
sources to the test task's inputs, so editing a skill reruns its check.

## Publishing

- **The CLI** ships inside `@commerceworker/sdk` as its `commerceworker` binary
  (`packages/sdk/sdk/src/bin.ts`, bundled to `dist/bin.js`); `@commerceworker/cli` itself stays a
  private workspace package. See [SDKs](./sdks.md) for the release.
- **The skills** install straight from this repository with the open `skills` CLI
  (`npx skills add commerceworker/commerceworker@<skill>`), or by copying `skills/*` into a
  project's `.claude/skills/`. A separate repository (for example `commerceworker/skills`) would
  give a smaller clone and a listing of its own; it would be a copy of `skills/` pushed by CI on
  release, never edited by hand, so the drift test here stays the gate.
