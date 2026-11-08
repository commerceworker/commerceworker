---
name: new-use-case
description: Scaffold a new application capability in CommerceWorker end to end. The use-case and its test, the HTTP route with its OpenAPI description, the MCP tool, the store and D1 changes if any, the SDK method and the docs. Use when adding any behaviour that API clients or agents can invoke (a new endpoint, MCP tool, or operation on content, assets, releases, workflows, roles and so on).
argument-hint: "<capability-name> [short description]"
---

# Scaffold a capability: $ARGUMENTS

The core invariant: an AI agent must never be able to do something a human API client can't, so
every capability is one application use-case exposed through **both** surfaces. Follow this order.

1. **Study the closest analogous capability first.** Pick the most similar file in
   `packages/application/src/` (and its test in `packages/application/test/`) and mirror its
   structure, naming and error handling. Don't invent new patterns.

2. **Use-case:** `packages/application/src/<capability>.ts`, exported from `src/index.ts`.
   - Exported functions take `(ctx: AppContext, scope: Scope, input)` and thread `Scope`
     (`{ spaceId, environmentId }`) into every store call.
   - Time from `ctx.clock.now()`; ids from `ctx.ids.newId()` (UUIDv7).
   - Writes inside `ctx.store.withTransaction`, which is a **unit of work**: read everything first,
     then write; a read in the unit doesn't see its own writes; a lost compare-and-set throws
     `TransactionConflictError` at commit (retry, or treat it as a no-op). If the capability emits a
     domain event, append it to the outbox in the same unit.
   - Pure rules (validation, state transitions) belong in `@commerceworker/domain`, called from the
     use-case.
   - Entries: apply the content-level checks from `packages/domain/src/auth/auth.ts`
     (`authorizeContent`, field masking, writable fields).

3. **Test:** `packages/application/test/<capability>.test.ts` (named for the capability, never a
   roadmap phase), on `@commerceworker/test-kit` fakes. At least: the happy path, a failure path, a
   **two-scope isolation** case, and, if it publishes, the outbox event. If it writes conditionally,
   a lost-race case.

4. **Store changes (only if needed).** A new `ContentStore` method goes in
   `packages/ports/src/content-store.ts` (domain types only), the in-memory store in
   `packages/test-kit/src/in-memory-store.ts`, and the D1 store in `packages/db/src/store.ts`
   (lists through `chunked` / `selectChunked`: D1 binds at most 100 parameters), with a contract
   test in `packages/db/test/`. A schema change is a migration: `d1-migration` skill.

5. **Both surfaces** in `packages/http`:
   - Route in its area's file, `packages/http/src/api/routes/management/<area>.ts` (or
     `routes/{delivery,preview,team,workflows}.ts`): `requireScope(<scope>)` against the route's
     `:space`, `parseBody` with a zod schema, call the use-case, serialize. Thin; no business
     logic. No trailing-z paths. A new area adds its own file and one line in `management.ts`'s
     `AREAS` (mount order is match order); import only the use-cases the file uses.
   - Describe it with `doc(tag, summary, { body, ok, … })` (`packages/http/src/api/docs/openapi.ts`),
     passing the **same** zod schema the handler parses with, so the OpenAPI document and the docs
     site's REST reference stay true. Response schemas live in
     `packages/http/src/api/docs/schemas/<area>.ts`; import them from that file
     (`import * as assetDocs from '../../docs/schemas/assets'`), never through a barrel.
   - MCP tool in its area's file, `packages/http/src/mcp/tools/<area>.ts` (`register<Area>Tools(server, t)`,
     closing over the `ToolContext` `t`), calling the _same_ use-case with the same scope. A new
     area adds its own file and one line in `server.ts`'s `TOOL_AREAS`. A tool that changes
     nothing declares `annotations: { readOnlyHint: true }` (or `READ_ONLY` from `tools/shared.ts`):
     that is what exempts it from the audit trail; every other tool is audited.
   - Tests: `packages/http/test/api/` and `packages/http/test/mcp/`.
   - A new scope goes in `SCOPES` (`packages/domain/src/auth/auth.ts`); the docs scope reference
     renders from it.

6. **Clients and docs.**
   - Management SDK method in `packages/sdk/management/src/` for a management operation, with a
     test.
   - Admin UI only if asked (`apps/web/app/cms/`, `.claude/rules/web.md`).
   - `docs/api-reference.md` (then `pnpm --filter @commerceworker/docs generate`) and the site guide
     the `docs-impact` hook names.
   - If agents should know how to use it, a note in the MCP skills under `packages/http/skills/`
     (then `pnpm --filter @commerceworker/http generate:skills`).

7. **Verify:** `pnpm --filter @commerceworker/application test -- <capability>.test.ts`,
   `pnpm --filter @commerceworker/http test`, `pnpm --filter @commerceworker/db test` if the store
   changed, then the `preflight` skill. Finish by recommending `/review-change`.
