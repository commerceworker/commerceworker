# CommerceWorker documentation

These are the maintainer docs: how CommerceWorker is built and how to run, extend and integrate
with it. They are not published; the public site is `apps/docs`. CommerceWorker runs entirely at
the edge, one isolated stack per customer: five edge workers (`apps/studio`, `apps/api`,
`apps/delivery`, `apps/media`, `apps/pipeline`) on an edge SQL database, with object storage, a
key-value cache, queues, stateful edge objects, durable workflows, a vector index, edge inference
through an AI gateway, edge image transforms, video streaming, edge email and plugin isolates.

## Contents

1. **[Architecture](./architecture.md)**: the workers and why they are split, data placement,
   the hexagonal layers and package map, request and event flow, editorial workflow runs, assets
   and the media worker, and the hook seam.
2. **[Reference architecture](./reference-architecture.md)**: one diagram of a whole deployment
   with numbered callouts, then the publish-to-deliver, delivery-read and asset paths, each with a
   text equivalent.
3. **[Domain model](./domain-model.md)**: field types, the validation engine, the entry publish
   state machine, localization and fallback, references, assets, platform aggregates and domain
   events.
4. **[API reference](./api-reference.md)**: the Management, Delivery and Preview endpoints, which
   host serves it, the query language, hybrid search, Live Content SSE and error mapping.
5. **[Auth & RBAC](./auth-and-rbac.md)**: web sign-in (passwords, passkeys, TOTP, OIDC, SCIM,
   setup), the signed web principal, API key kinds, scopes, roles, OAuth 2.1, and the `authorize`
   decision.
6. **[AI, agents & search](./ai-agents-and-search.md)**: edge inference and model tiers, the AI
   budget, hybrid search (FTS5 search shards + the vector index), Coworker and the agent runtime.
7. **[MCP server](./mcp.md)**: transport, auth, per-request cost, connecting a client, the tool
   catalog by area, and skills.
8. **[Events & webhooks](./events-and-webhooks.md)**: the transactional outbox, lease-claimed
   relay, the engine's queue consumers, delivery cache purges and their pacing, webhooks and
   event payloads.
9. **[Consistency & guarantees](./consistency.md)**: the database unit of work, read replicas and
   the `x-cw-bookmark` header, database limits, optimistic concurrency (`expectedVersion`), the
   delivery cache and its staleness bounds, and durable state that isn't derived.
10. **[Configuration](./configuration.md)**: every binding, var and secret, and which worker uses
    it.
11. **[Deployment](./deployment.md)**: the fleet registry, provisioning, secrets, the CI pipeline
    (migrate, deploy engine → media → api → delivery → web, smoke, rollback) and admin recovery.
12. **[Environments & snapshots](./environments-and-snapshots.md)**: export, import and clone,
    their background jobs, environment delete and purge, and importing from other formats.
13. **[Backup & restore](./backup-and-restore.md)**: what holds state, point-in-time recovery,
    environment snapshots, outbox replay and the restore runbook.
14. **[Development](./development.md)**: running the stack locally, test suites, conventions,
    adding a use-case, changing the database schema, and the schema reference.
15. **[Admin UI](./admin-ui.md)**: the React Router admin on the web worker, sign-in routes,
    layout, features and its tests.
16. **[SDKs](./sdks.md)**: the one published package `@commerceworker/sdk`: the Delivery clients
    (core, react, vue, edge, react-native), the Management client (`/management`), rich text,
    webhooks, codegen and the `commerceworker` CLI, and how it is bundled and released.
17. **[Plugins](./plugins.md)**: sandboxed write-path plugins in isolated edge workers:
    manifests, capabilities, hooks and distribution policy.
18. **[Developer tooling](./developer-tooling.md)**: the `commerceworker` CLI (`packages/cli`) and
    the developer agent skills (`skills/`): design, output contract, tests and publishing.

## Conventions used in these docs

- **Scope** means `{ spaceId, environmentId }`, the boundary carried through every operation. An
  _environment_ is a branch within a _space_ (e.g. `main`, `staging`). A _deployment_ is one
  customer's whole stack; spaces live inside it.
- **CMA / CDA / CPA** are the Content Management / Delivery / Preview API key kinds.
- Hosts: the admin at `<domain>`, the api at `api.<domain>`, public delivery at `cdn.<domain>`.
- Paths shown like `/spaces/:space/environments/:env/...` use `:param` for path segments.
- **`…`** abbreviates `/spaces/:space/environments/:env` in Management API tables; space-level
  routes are written out in full.
- The rules every change keeps are in [`AGENTS.md`](../AGENTS.md); shipped and planned work is in
  [`ROADMAP.md`](../ROADMAP.md).
