# AI, agents & search

CommerceWorker treats AI as a first-class client. Everything here ultimately calls the **same
application use-cases** as the HTTP API, so generated and agent-authored content is validated and
authorized identically to human writes.

## AI provider port

`AIProvider` (`packages/ports/src/infra.ts`) is the generation seam. Callers pick a **tier**, not
a model:

```ts
type ModelTier = 'flagship' | 'balanced' | 'fast';

interface GenerateRequest {
  system?: string;
  prompt: string; // with `messages`, the final user turn when non-empty ('' sends `messages` alone)
  messages?: ChatMessage[]; // earlier turns, oldest first (user / assistant / tool)
  tools?: ToolSpec[]; // { name, description?, inputSchema } the model may call
  tier?: ModelTier; // default 'balanced'
  maxTokens: number;
  outputSchema?: Record<string, unknown>; // when set, provider returns JSON matching this schema
}
interface GenerateResult {
  text: string;
  object?: unknown; // parsed when outputSchema was supplied
  toolCalls?: ToolCall[]; // { id, name, input }; only when `tools` were offered
  usage: { inputTokens: number; outputTokens: number };
}
```

A `tool` message answers an assistant `ToolCall` by its `id`.

### The edge inference adapter

`@commerceworker/adapters/ai-workers` is the only provider. It runs through the worker's `AI`
binding, so it needs no credentials, and maps tier → model (overridable per tier with
`WORKERS_AI_MODEL_FLAGSHIP` / `_BALANCED` / `_FAST`):

| Tier       | Default model                              |
| ---------- | ------------------------------------------ |
| `flagship` | `@cf/moonshotai/kimi-k2.6`                 |
| `balanced` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `fast`     | `@cf/zai-org/glm-4.7-flash`                |

With `AI_GATEWAY_ID` set (the fleet renders one gateway per deployment), calls route through
the AI gateway via the binding's `gateway` option; the gateway applies its rate limit,
retries and, when `aiGatewayLogs` is on, request logging. Without the `AI` binding the stub
provider answers with placeholder values, which the fail-closed adapter guard refuses on a
persistent deployment. `AI_MODE=mock` (local dev, demos, tests) answers every `generateJson` from
its heuristic without calling a model. See [Configuration](./configuration.md) for
`AI_TIMEOUT_MS`.

### Decision models

Some AI work is a decision, not a text: which label, which route, is this unsafe, does this need a
person. That goes to a second port, `DecisionModel`. It takes a state (text or JSON) and up to 64
typed questions, and answers each with a probability for every allowed answer:
- `noul`: yes/no, answered with the probability of yes;
- `choice`: one of a set of options, answered with each option's probability and a confidence;
- `score`: a level on an ordered rubric, answered with a probability-weighted score.

There's no text to parse, so no schema to check and no off-menu answer. The probabilities are the
model's, not a number it writes, so they can carry thresholds. Hostile content in the state can
still sway an answer, but it can't make the model answer outside the options.

`createWorkersAIDecisionModel` runs the platform's Clef models over the same `AI` binding and AI
gateway settings as generation: `@cf/cloudflare/clef` for `flagship` and `balanced`, and
`@cf/cloudflare/clef-flash` (much faster and cheaper) for `fast`. Clef bills input tokens only.
Calls go through `decide()` (`ai-decide.ts`), with the same guarantees as `generateJson`:
- `decideWithBudget` meters input tokens against the space's AI budget;
- `AI_MODE=mock` and budget refusals answer with the caller's heuristic;
- a failure retries while the durable step can, then falls back;
- every call is an `ai_call` record with its provenance.

Without the `AI` binding the stub answers the first option, no, or the lowest level, and the
adapter guard refuses it on a persistent deployment. The platform binds it both to the workflow
node deps and to `ctx.decisions`, so use-cases reach it without another parameter. Beyond the nodes
below:
- The **moderation agent** asks the same questions as `ai.moderate` (see [moderate](#moderate)).
- **Tag suggestions** (`suggestEntryTags`, the `ai.suggest_tags` node, `entry_suggest_tags`) ask
  one yes/no per existing tag, 64 to a request, and take the tags at or above 0.5. A new tag name is
  writing, not choosing, so the generative model is asked for new names only when no existing tag
  fits. It doesn't get to overrule that decision by picking existing tags itself.

Workflow nodes that choose ask the decision model when one is bound (the platform always binds one),
and fall back to a generative model's JSON otherwise:

| Node          | Questions                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.classify` | one `choice` over the node's labels; `output.probabilities` carries each label's                                                                                                                                      |
| `ai.router`   | one `choice` over the routes whose guards hold; the author's instructions are the question                                                                                                                            |
| `ai.moderate` | a `noul` per category (hate, violence, sexual, harassment, self-harm, anything else unsafe or illegal, plus house rules when set); a category at or above the node's `threshold` (between 0 and 1, default 0.5) flags |
| `ai.assess`   | the node's own questions, which already use this shape                                                                                                                                                                |

The entry is always the state and never the question, capped at 20,000 characters as the
generative prompts are, so the author's instructions and the house rules stay out of reach of the
content being judged. A router with one allowed route, or a classifier with one label, answers
without asking. Gating nodes fail closed exactly as before: an
answer the model couldn't give flags (moderation), takes the careful route (router) or goes to
`unsure` (assess).

Embeddings are a **separate port** (`EmbeddingsProvider`): edge inference
(`createWorkersAIEmbeddings`, `@cf/baai/bge-base-en-v1.5`, 768 dims by default), or the test-kit's
deterministic `LocalEmbeddingsProvider` (`EMBEDDINGS_PROVIDER=local`) for development.

### Which tier each use-case asks for

A use-case's `tier` input overrides these defaults.

| Use-case                                                      | Default tier                                                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content-ai`: `translateEntry`, `autofillField`               | `balanced`                                                                                                                                                      |
| `content-ai`: `summarizeEntry`, `suggestEntryTags`            | `fast`                                                                                                                                                          |
| `media-ai`: alt text, asset auto-tag                          | `fast`                                                                                                                                                          |
| `draftEntry`, `canvasToEntry` (`generation.ts`), `auditEntry` | `balanced`                                                                                                                                                      |
| `ai-actions` (`runAIAction`)                                  | the action's own `tier` (default `balanced`)                                                                                                                    |
| `workflow-copilot` (`workflow_copilot`)                       | `balanced`                                                                                                                                                      |
| Workflow AI nodes (`workflow-nodes/ai.ts`)                    | `fast` for `ai.classify`, `ai.summarize`, `ai.suggest_tags`, `ai.moderate`, `ai.enrich`; `balanced` for `ai.router`, `ai.assess`, `ai.translate`, `ai.autofill` |
| Agent runtime activities (`generateFields`, `classify`)       | `fast`                                                                                                                                                          |
| Coworker (assistant)                                          | `flagship`, falling back to `fast`                                                                                                                              |

### Budget and untrusted content

Every interactive AI call goes through `generateWithBudget` (`packages/application/src/ai-budget.ts`),
so the HTTP API, MCP and agents are metered the same way. It consults the per-space `CostGuardDO`
before the call (`consume`: a request against `AI_MAX_REQUESTS_PER_WINDOW`, default 60, and
`AI_MAX_TOKENS_PER_WINDOW`, default 200 000, per `AI_BUDGET_WINDOW_SECONDS`, default 60), throws a
`RateLimitedError` (HTTP 429, with a retry-after hint) when the space is over a ceiling, then
`settle`s the observed tokens. Setting either ceiling to `0` turns metering off, and without the
binding nothing is metered. Background agent spend has its own `AI_AGENT_*` window (see
[Agent schedules](#agent-schedules)); the Coworker meters each model step against the interactive
budget. `AI_MODE=mock` skips the model and the budget. See [Configuration](./configuration.md).

Entry field values are untrusted: any writer, or an agent, can set them, yet they flow into
prompts. Prompt builders wrap them with `wrapUntrusted` (a `<user_content>` span; a closing tag in
the content is stripped) and add `UNTRUSTED_CONTENT_GUARD` to the system prompt, telling the model
to treat that span only as data (`packages/application/src/ai-prompt.ts`). The assistant wraps
tool results the same way. It blunts instruction hijacks, notably a moderation classifier being
talked into `flagged: false`; moderation additionally fails closed (see [moderate](#moderate)).

## Content generation

`draftEntry(ctx, ai, scope, input)` generates field values for a content type from a natural-language prompt:

```ts
interface DraftEntryInput {
  contentTypeApiId: string;
  prompt: string;
  tier?: ModelTier; // default 'balanced'
}
```

- It builds a strict JSON Schema (`additionalProperties: false`) from the content type's
  **scalar** fields (`Symbol`, `Text`, `Integer`, `Number`, `Boolean`, `Date` — not links or
  rich text), asks the provider for structured output, then **validates the result against the
  content model** with the same `validateEntryFields` path as human writes. Each property's
  `description` is `describeFieldForModel(field)`: the name, then the field's guidance as one
  capped line, labelled as describing the field and wrapped in `<user_content>` (delimiter tags in
  it, spaced or nested, are stripped until none is left: `stripDelimiters`; the system prompt
  carries `UNTRUSTED_CONTENT_GUARD`). Its validations become JSON Schema constraints (`in` as an
  `enum` of option values). Its conditional `rules` are named in words inside the same delimited
  span (`describeFieldRules`), since a rule quotes author values. Autofill, the `ai.enrich` node and
  the agent runtime describe fields the same way.
- Values for fields the draft's own values hide or disable are left out of the result
  (`withoutClosedFields`, settled to a fixed point), so a draft never fills a field nobody sees or
  one that is read-only. Autofill refuses such a field; `ai.enrich`, translation and the agent
  runtime skip them.
- Generated values are wrapped in the space's default locale.
- Returns `{ contentTypeApiId, fields, usage }`. Pair it with `createEntry` to actually author.

The rule: _an agent can never produce an entry a person couldn't_ — generation output is rejected
if it fails validation.

## Semantic search / RAG

`packages/application/src/rag.ts`, backed by the `VectorStore` + `EmbeddingsProvider` ports
(`RagDeps`).

**Indexing** (on `entry.published`, driven by the queue consumer's event dispatch):

1. `removeEntryEmbeddings` clears any existing vectors for the entry (idempotent).
2. `extractTextByLocale` collects the entry's string values — plus rich-text bodies flattened
   to plain text via `richTextToPlainText` — grouped by locale.
3. `chunk(text, 400)` splits each locale's text into ≤ 400-word, word-bounded chunks.
4. Chunks are embedded (`taskType: 'document'`) and upserted as `VectorRow`s carrying
   `{ scope, entryId, locale, chunkIndex, chunkText, embedding, entryVersion }`.

On `entry.unpublished`, `removeEntryEmbeddings` deletes the entry's vectors.

**Bulk reindex** — re-embeds every published entry in a scope (optionally one content
type). Use after a change to text extraction or the embedding model so already-published
content becomes searchable without a republish. Exposed as
`POST /spaces/:space/environments/:env/search/reindex` (body: `{ contentTypeApiId? }`,
scope `content:manage`) and the `content_reindex_embeddings` MCP tool.

The trigger (`requestReindex`) is **asynchronous**: it appends a `search.reindex_requested`
event to the transactional outbox and returns **202 Accepted** (`{ enqueued: true }`) — the
`commerceworker-events` queue consumer then runs the actual embed loop (`reindexEmbeddings`) off the request
path. It is rate-limited per scope via the shared cache (a retrigger within
`REINDEX_COOLDOWN_SECONDS` returns 429), a single run is bounded by `MAX_REINDEX_ENTRIES`
(reported as `truncated`), and each entry reindex is idempotent (stale vectors are replaced).

**Index health** — answers "is search returning everything it should?" without querying it.
`GET /spaces/:space/environments/:env/search/index` (optional `?content_type=`, scope
`content:manage` — a CDA token carries `search:read` and ships in browsers, and this reports
operational posture, not content) and the `search_index_health` MCP tool compare the documents the
lexical index (`SearchShardDO` shards) holds for the environment against the number of entries
published in it:

```json
{
  "bound": true,
  "engine": "fts5-shards",
  "documents": 1204,
  "publishedEntries": 1207,
  "drift": -3,
  "inSync": false
}
```

- `bound: false` means no `SEARCH` binding, so the lexical leg runs on the store's bounded
  substring scan; a configuration answer, not a health problem.
- Negative `drift` means published entries are missing from the index and searches will not
  find them; positive means it holds documents for entries that are no longer published,
  which surface as hits resolving to nothing.
- `documents` is omitted when the engine cannot count cheaply. It reports the number as
  unavailable rather than estimating one, so drift is never invented.
- Asking about one content type narrows `publishedEntries` but not the index-wide document
  count, so `drift` and `inSync` are withheld — subtracting them would report drift that
  does not exist.
- `inSync` is a cheap negative signal, not a guarantee: one missing and one stale document
  cancel out. It catches the common failure — an index that silently stopped being written
  to — and the remedy is the bulk reindex above, which rewrites both legs.

Read-only and two counts, so it is safe to poll from a monitor.

**Querying** (`semanticSearch(deps, scope, query, { topK = 10, minScore })`):

1. The query is embedded (`taskType: 'query'`).
2. The vector store returns top matches by cosine similarity (over-fetched, then deduplicated to
   the best-scoring chunk per entry).
3. Returns `SearchHit[]` of `{ entryId, score, snippet }`.

The `VectorStore` is the vector index (`@commerceworker/adapters/vector-vectorize`, bound via
`VECTORIZE`; 768 dimensions, cosine, metadata-indexed on `spaceId` and `environmentId`). The index
applies mutations asynchronously, so search-after-publish lags by a few seconds, and caps a query
at 50 matches (`MAX_TOP_K`, honored by the over-fetch). Without a `VECTORIZE` binding, or with
`VECTOR_STORE=memory`, the worker uses a per-isolate, non-durable in-memory vector store. The local
stack sets `VECTOR_STORE=kv` instead: vectors live in `KV_CACHE`, which every worker in the dev
session shares, so what the engine embeds the api can search (brute-force cosine; dev scale only).
The fail-closed adapter guard refuses both on a persistent deployment unless `ALLOW_FAKE_ADAPTERS`
includes `vectors`.

**Hybrid search** (`hybridSearch(deps, ctx, scope, query, { topK = 10 })`) fuses two legs with
Reciprocal Rank Fusion (`score = Σ 1/(60 + rank)`; rank-based, so the legs' incomparable
scores never need calibrating):

- **Semantic**: `semanticSearch` above.
- **Lexical**: the `SearchIndex` port, implemented by `SearchShardDO`
  (`packages/platform/src/do/search-shard.ts`): FTS5 in stateful edge objects, `SEARCH_SHARDS`
  (default 8) objects per space:environment, keyed `${spaceId}:${environmentId}:${n}`. An entry
  lives on the shard its id hashes to; a query asks every shard for its best `topK` and merges. The
  tokenizer folds accents (`unicode61 remove_diacritics 2`) with 2- and 3-character prefix indexes;
  a `versions` table makes indexing idempotent and order-independent. BM25 is per shard, which RRF
  tolerates. The events consumer keeps the shards fresh on publish and unpublish, and reindex slices
  refresh them in bulk. Keeping FTS out of the database keeps search writes off its single writer
  (and a database holding a virtual table cannot be exported). If a shard query fails, or no
  `SEARCH` binding exists, the leg falls back to `EntryRepo.searchPublished`, a bounded
  term-prefiltered scan of the published read model. The in-memory test-kit store mirrors the
  semantics so hybrid search is testable.

Lexical-only hits derive their snippet from the published fields. Exposed at
`GET /delivery/:space/:env/search` (hybrid by default; `?mode=semantic` / `?mode=lexical`
selects one leg), the GraphQL `search` resolver, and the `content_search` MCP tool.

## Asset search

Assets are searched apart from entries (`packages/application/src/asset-search.ts`), in two corpora
(`AssetSearchCorpus`): the library, every asset as it is now, and the published assets, their
published snapshots. Ingest writes one vector per asset and corpus into a vector-index namespace of
the corpus's own (`VectorStore.upsertAsset`, metadata `kind: 'asset'`, `spaceId`, `environmentId`,
`assetId`) and one document into that corpus's shards of `SearchShardDO` (`space:env:assets:<n>`,
`RagDeps.assetSearchIndex`; `space:env:pubassets:<n>`, `RagDeps.publishedAssetSearchIndex`), so
`semanticSearch`, `relatedEntries` and RAG answers never return an asset or its text, and Delivery's
candidates are published assets only. The indexed text is the file name, title, description, alt
text, tag names and an excerpt of the text ingest extracted from the snapshot's own file version
(1,500 characters embedded, 100,000 indexed). The published corpus is written on `asset.published`
and by ingest of a published asset, and emptied for the asset on `asset.unpublished`. Embedding
(documents and queries) happens only with `EMBEDDINGS_PROVIDER` set, decided once in `wireEdge`
(`EdgeWired.assetSearch`).

`searchAssets` (Management `GET …/assets/search`, scope `preview:read`) and
`searchDeliveredAssets` (Delivery `GET …/assets?q=`) take `q` (1–256 characters), `limit`
(default 20, at most 100) and the filters `kind`, `tag`, `folder` and, for the library, `status`.
Each leg contributes up to 100 candidates, fused by RRF; the response is `{ items, total,
facets }`, with `facets.kind`, `facets.tag` and `facets.folder` each counted under every filter
but its own. Delivery returns published assets only, in the delivered shape, and needs
`search:read` as well as `delivery:read`; a key with content grants gets an empty result. MCP's
`assets_search` runs either (`delivered: true` for Delivery's, with the same scopes). Without a
bound index the lexical leg scans the 500 most recent assets.

Extracted text and model output are untrusted. Text from a file is only stored, embedded and
indexed; it never reaches a generation prompt (alt text and tags are generated from the file name,
title and description, each wrapped with `wrapUntrusted` under `UNTRUSTED_CONTENT_GUARD`). Text
extraction is a model call metered by the space's AI budget (`runWithBudget`). What a model returns is written only where the field is empty, through
`applyAssetMetadata`, as one line of at most 300 characters, and tags only from the space's
existing vocabulary: ingest never creates a tag.

## MCP server

The api worker serves MCP at `/mcp`, with 248 tools and published agent skills. Transport, auth,
connecting a client, the tool catalog and skills are in [MCP server](./mcp.md). The assistant in the
admin calls the same tools in-process (see [Coworker](#coworker-the-admins-assistant)).

## Coworker: the admin's assistant

`AssistantAgent` (`packages/http/src/assistant/agent.ts`) is the chat panel in the admin, one
stateful edge object per person hosted by the engine (binding `ASSISTANT_AGENT`, reached at
`/agents/assistant-agent/<person>` through the web worker and the api). It is built on
`AIChatAgent`, so the conversation lives in the object's SQLite and a reply keeps streaming if the
tab goes away. User-facing behaviour is in the
[Coworker guide](https://docs.commerceworker.com/content/guides/coworker/).

- **Model.** `assistantModel` (`model.ts`) uses edge inference's `flagship` tier (through the AI
  gateway when `AI_GATEWAY_ID` is set), falls back to `fast`, and behind both sits a deterministic
  mock that speaks the same tool protocol. The mock answers every turn when `AI_MODE=mock` or the
  `AI` binding is absent, and takes over a turn when the models error or say nothing within 20 s.
  Gateway requests carry `NO_LOG_PAYLOAD`, so the gateway keeps no prompt or answer.
- **Tools are MCP tools, run in-process as the person** (`tools.ts`): each call is a JSON-RPC
  request to the handler `/mcp` serves, authenticated as the person's own principal and pinned to
  the page's space and environment, so the assistant can never do what an MCP client with their
  access couldn't. Only the tools named in `ASSISTANT_TOOLS` (`packages/domain/src/assistant`) are
  offered. Reads run directly, and every write a model proposes waits for the person's confirm
  (`needsApproval`). A page edit made through `act` confirms only actions (publish,
  unpublish, trash, purge, restore a version, bulk change, schedule, publish a release), which stop
  at a confirm card; plain edits (save a draft, create, tag, comment) run at once. A confirm on `entries_publish`, `entries_unpublish` or
  `entries_restore_version` is held to the entry's version when the card was made, so a newer
  draft makes it a 409.
- **No space yet.** With no space, the panel (and setup's second step, `/setup/space`) sends
  `SETUP_SCOPE` (space and environment `*`). Only a deployment admin's turn runs there, as their
  deployment-wide principal, with `SETUP_TOOLS` (`space_starters_list`, `space_create`) and a
  system prompt that asks what the space is for and proposes one `space_create`. `offeredIn` holds
  every call to its scope: setup tools never run in a space, and a space's tools never run in setup.
  The AI budget meters setup turns under the `*` scope.
- **Page edits skip the model.** `act` runs the exact tool call for what was pressed and joins the
  conversation as a tool call of its own (`direct_` ids); `resolve` answers its confirm card.
- **Trust.** The object verifies the principal the web worker signed for its path (the
  `ASSISTANT_PRINCIPAL_KEY`, see [Auth & RBAC](./auth-and-rbac.md)), re-checks the person (enabled,
  session live) on every frame, turn and `act`, and runs only tool calls it made itself (`model:`
  records) or `act` made (`direct:`). Tool results and page labels are wrapped with `wrapUntrusted`.
- **Limits.** At most 30 page edits and turns per person per minute (`ASSISTANT_RATE`); each model
  step is one request against the space's interactive AI budget, a refused step aborts the turn,
  and mock steps are not metered. A conversation untouched for 30 days is deleted
  (`RETENTION_MS`); an unanswered confirm card lapses after a day.

## Agent runtime

`packages/agent-runtime` runs durable agent **workflows** behind an engine-agnostic facade.
Editorial workflow definitions (the graphs authored in the admin) run on a different path: the
graph interpreter `runGraph` in the same package, hosted by `EditorialWorkflow`; see
[Architecture](./architecture.md#editorial-workflow-runs).

```ts
type WorkflowName = 'enrich' | 'moderate' | 'curate' | 'repurpose' | 'review';
interface AgentRuntime {
  run(workflow, input): Promise<AgentRunResult>;
}
```

On-publish hooks (`AGENTS_ENRICH`, `AGENTS_MODERATE`) run `enrich` then `moderate`. `curate` and
`repurpose` are available for on-demand orchestration (API, MCP, and agent schedules). `review` is
the detached watcher that waits for a human decision (see
[Human-in-the-loop reviews](#human-in-the-loop-reviews)); it is not recorded in the agent ledger.

`AGENT_RUNTIME=cloudflare-workflows` (with the `AGENT_WF` workflow binding) routes on-publish and
scheduled agent runs through `CloudflareWorkflowsAgentRuntime` (`packages/platform/src/workflows.ts`),
which starts instances of the durable `AgentWorkflow` (`apps/pipeline/src/workflows/agent-workflow.ts`). When
`AGENTS_QUEUE` is bound, the events consumer forwards each `entry.published` to the
`commerceworker-agents` queue; that consumer starts one workflow instance per chunk of up to 25
entries and acks without waiting on the result. Otherwise, and whenever the binding is absent,
agents run on `InProcessAgentRuntime` (non-durable).

The crucial seam is `Activities` — the side-effecting operations (`loadEntry`, `generateFields`,
`applyFields`, `classify`, `record`, `createReview`, `armReview`, `recordRun`, `retractEntry`,
`settleReview`). Workflow functions are **pure orchestration** over
`Activities`, so the _same_ workflow code runs:

- **`InProcessAgentRuntime`** — directly in the calling isolate (dev, tests, and every
  synchronous on-demand action from the API or MCP, which need the result in the response). Not
  durable (no crash replay).
- **Durable workflows** (production) — `AgentWorkflow` hosts `enrich`/`moderate`/`curate`/
  `repurpose`, with each `Activities` call as a durable step. `CloudflareWorkflowsAgentRuntime`
  implements the same `AgentRuntime` interface — callers swap executors with no logic change.

### enrich

Fills empty text/symbol fields (excluding the display field) on a freshly-published entry:

1. Load the entry; if missing → `skipped`.
2. Find empty text fields; if none → `skipped`.
3. `generateFields` (tier `fast`) with the existing text as context.
4. If `autoApply` **and** the model filled every requested field → `applyFields` (a new validated
   draft version) → `completed`.
5. Otherwise → `record` the proposal and return `needs_review` with the `proposed` fields (the
   human-in-the-loop path).

### moderate

1. Load the entry; if missing → `skipped`.
2. `classify` the concatenated text. With a decision model (`ctx.decisions`, always bound on the
   platform) it asks the same per-category questions as the `ai.moderate` node (`moderation.ts`),
   with the text as the state, capped at 20,000 characters. A category at or above 0.5 flags, and
   a question left unanswered counts as flagged. Without one, it asks the `fast` generative model
   for a strict `{ flagged, categories }` schema, where only an explicit `flagged: false` passes
   and anything else holds the entry as `unclassified`.
3. If flagged → `record` a hold → `held`; else → `completed`. A failed call throws, so the
   workflow step retries; content is never waved through.

### curate

Improves already-filled text/symbol fields (excluding the display field) on a published entry:

1. Load the entry; skip if missing or no filled non-display text fields.
2. `generateFields` with an "improve" instruction; compare proposed vs. current values.
3. If `autoApply` and values changed → `applyFields` → `completed`; else → `needs_review`.

### repurpose

Derives channel variants (e.g. social, newsletter) from entry text:

1. Load the entry; skip if missing or no text.
2. `generateFields` with a repurpose instruction for variant fields.
3. Always records the proposal → `needs_review` (never auto-applies).

### Result

```ts
interface AgentRunResult {
  workflow: WorkflowName;
  entryId: string;
  status: 'completed' | 'needs_review' | 'held' | 'skipped' | 'rejected';
  decisions: string[]; // audit trail
  usage: { inputTokens: number; outputTokens: number };
  proposed?: EntryFields; // present when needs_review
  reviewId?: string; // the persisted review awaiting a decision (when needs_review)
}
```

The queue consumer runs the on-publish workflows on `entry.published` events: `AGENTS_ENRICH=true`
enables `enrich`, `AGENTS_MODERATE=true` enables `moderate` (enrich runs first so moderation
classifies the enriched content), and `AGENTS_AUTO_APPLY` toggles auto-apply vs. routing
enrichment to human review. Every run is recorded in the agent ledger.

Moderation is also available on demand — `POST .../entries/:id/moderate` (Management API) and
the `entry_moderate` MCP tool both call the same `moderateEntry` use-case, which runs the
workflow in-process and returns `{ flagged, status, decisions, usage }`. A flagged result is a
recorded hold, not a state change: callers (or a webhook consumer) decide whether to unpublish.

## Human-in-the-loop reviews

A workflow run that ends `needs_review` (autoApply off, or low confidence) persists its
proposal as a pending **agent review** — the field values, the agent's reasoning notes, and
the entry it targets. Reviewers list and decide them on both surfaces:

- HTTP: `GET …/agent-reviews?status=pending`, `POST …/agent-reviews/:id/approve`,
  `POST …/agent-reviews/:id/reject` (`preview:read` to list, `content:write` to decide).
  A key whose role grants only some content types sees only the reviews of entries it may read,
  with denied fields masked out of `proposed`. `GET …/approvals/count` counts what waits
  (pending reviews and workflow tasks) without listing it.
- MCP: `agent_review_list`, `agent_review_approve`, `agent_review_reject`, `approvals_count`.

Approval applies the proposed values as a new draft version through the normal update
use-case (validated, versioned) — **exactly once**, guarded by a CAS apply marker.

On durable runtimes the decision travels as a real signal: after a `needs_review` outcome
the runtime arms a detached **review-watcher workflow** (instance id `review-<reviewId>`)
that parks — for up to 7 days — until the decision arrives as a **durable workflow event**
(`review-decision`), then applies/records durably. The
decide use-case signals the watcher when one is armed and falls back to applying directly
when it isn't (in-process runtime, watcher timed out, or signal delivery failed) — the CAS
markers make every combination race-safe: concurrent reviewers can't both decide, and no
path can double-apply. The initiating consumer never waits on a human: the agent run
completes immediately at `needs_review`; only the detached watcher parks.

## Agent schedules

A recurring agent job: on a cron cadence, run one agent workflow (`enrich`, `moderate`,
`curate`, or `repurpose`) over the entries **published since the schedule's previous run** —
delta-based, so a run never reprocesses the whole space. The cron expression is 5-field
(minute hour day-of-month month day-of-week), evaluated in **UTC**, supporting `*`, lists,
ranges, and steps (dependency-free parser in `packages/domain/src/scheduling/cron.ts`).

Window semantics (`runDueAgentSchedules`, `packages/application/src/agent-schedules.ts`):

- **First run = baseline.** A schedule's first due run only records the cursor — schedules
  watch changes going forward, they don't backfill history.
- **Compound delta cursor.** Each run processes entries published strictly after
  `(lastRunAt, cursorEntryId)` in publish order — the entry-id tie-break keeps the boundary
  exact across same-instant publishes (same-transaction publishes share a publish instant).
- **Bounded runs.** A run stops at an entry cap (`AGENT_SCHEDULE_MAX_ENTRIES`, default 25), a
  token ceiling (`AGENT_SCHEDULE_MAX_RUN_TOKENS`, default 100 000, checked mid-batch), and the
  firing instant (entries published while the run executes belong to the next firing). A
  truncated window resumes at the next firing.
- **Failure defers, never drops.** On error the cursor still points at the last successful
  entry, so the remainder of the window is retried at the next firing.
- **Claimed firings.** Each firing is claimed up front via compare-and-swap on the schedule's
  `nextRunAt`, so concurrent runners (overlapping cron ticks, a deploy mid-run) never
  double-run one. Missed runs (e.g. re-enabling a stale schedule) are skipped, never
  burst-replayed.

Every scheduled run goes through the same `AgentRunner` as on-publish agents (in-process or
durable workflows) and is recorded in the agent ledger. `autoApply` is
per-schedule: off routes proposals to human review.

**Budget.** Scheduled runs are background spend. They count under a separate `agent:` counter
window on the per-space `CostGuardDO`, so batch spend can't exhaust the interactive budget; that
window enforces the `AI_AGENT_*` ceilings when set and the interactive `AI_*` ceilings otherwise.
Durable `AgentWorkflow` runs are metered the same way. See [Configuration](./configuration.md).

**Host.** The engine worker runs due schedules on its 1-minute cron tick when
`AGENTS_SCHEDULES=true`.

**Surfaces.** CRUD on both, backed by the same use-cases: the Management API
(`GET`/`POST …/agent-schedules`, `PATCH`/`DELETE …/agent-schedules/:id` — listing needs
`preview:read`, mutations `content:publish`; see the
[API reference](./api-reference.md#agent-schedules)) and the MCP tools
`agent_schedule_create` / `agent_schedule_list` / `agent_schedule_update` /
`agent_schedule_delete`.
