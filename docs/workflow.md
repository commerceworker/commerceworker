# Order Workflow

How one generic Workflow interprets a pinned flow version durably, with deterministic step names, saga rollback and continue-as-new.

`OrderWorkflow` (`apps/engine/src/workflow.ts`, Workflow `commerceworker-order`, binding `ORDER_WORKFLOW`)
interprets every flow. One instance runs one order generation; its params are `OrderWorkflowParams`:
`orderId`, `flowId`, `version`, `generation`, `order` and `vars`.

## Run

1. **`load-flow`** step: loads the pinned `FlowVersion` from D1 (`loadFlowVersion`). A missing
   version throws `NonRetryableError` (the order then fails like any throw outside a node's step;
   see [Failure paths](#failure-paths)).
2. Builds the plan (`initPlan`) and the [run context](https://docs.commerceworker.com/reference/expressions/): `order`, `nodes: {}`,
   `vars` from params, `input` = `order.meta`, and `now` = the event's timestamp, not the wall
   clock, so it replays identically.
3. Reports a `running` snapshot to the agent.
4. Loops: `readyNodes` → `beginNode` for each ready node (waiting node types are marked `waiting`)
   → snapshot, sent alongside the batch (awaited in the same `Promise.all`, not before it) → run
   the whole batch concurrently with `Promise.all` → apply the outcomes **in graph order** →
   snapshot. It stops when nothing is ready or an End node ran.
5. Reports the final status. For `failed` it throws `NonRetryableError(reason)`, which fails the
   instance and makes Workflows run the registered rollbacks. Otherwise it returns
   `{ outcome, total }`.

Applying in graph order matters: the batch runs concurrently, so completions arrive in any order,
but the plan they produce must be the same on every replay.

## Step names

Every node run is one memoized step named by its key, `${nodeId}#${run}` (`beginNode`). Run counts
make loop iterations distinct: the third pass of `charge` is `charge#3`. Some node types add
suffixed steps around their main one:

| Step | Node types | Purpose |
|---|---|---|
| `${key}` | executors, `control.loop`, and the batch's `control.continue_as_new` | The node's effect, memoized |
| `${key}:open` | approval, wait for event | Registers the wait with the agent (`openWait`) |
| `${key}` (waitForEvent) | approval, wait for event | `step.waitForEvent` with the node's timeout |
| `${key}:close` | approval, wait for event | Clears the wait (`closeWait`) with the outcome |
| `${key}:until` | `control.wait` with `until` | Evaluates the timestamp once |
| `${key}:period` | `control.wait` with `every` | Reads the clock and computes the next period boundary once |
| `${key}` (sleep) | `control.wait` | `step.sleep` or `step.sleepUntil` |
| `${key}:emit` | nodes that emit, End, a thrown node | Outbound webhook delivery |
| `run:failed`, `run:failed:emit` | none: only a run that fails | Reports the order failed durably, then `order.failed` unless an End node sent it ([Failure paths](#failure-paths)) |
| `release:failed` | none: only an ended order whose release step failed for good | Timeline line and audit event; the order keeps its outcome |

:::caution
Step names are durable identity. Never rename a node id, or change how keys are built, in a way
that would change the step names of a published flow: an in-flight instance replays by name, and a
renamed step runs again.
:::

Effects use a separate key. `effectKey(generation, key)` is `${nodeId}#${run}` in generation 1 and
`${nodeId}#${run}@g${generation}` after a continue-as-new, because run counts restart in every
generation and the step names repeat while their effects must not (a second generation's `charge#1`
charges again). The effect key is what executors receive as `stepKey` (so connector write ids
embed it), what `emit` keys webhook deliveries on, what the wait event types below derive from, and
the `key` of the node's timeline entries. Step names themselves are always the plain key.

Wait event types are derived from the effect key: `approval-${key}` or `event-${key}`, with characters
outside `[a-zA-Z0-9_-]` replaced by `-` (so `mgr#1` becomes `approval-mgr-1`), truncated to 100.

## Executor nodes

Nodes that run inside one step are `EXECUTORS` in `apps/engine/src/nodes.ts`. The step is
configured with:

- `retries`: `{ limit, delay: '5 seconds', backoff: 'exponential' }`, where `limit` is the node's
  `retries`, else the catalog's `retries`, else 3.
- `timeout`: the node's `timeout`, else `'5 minutes'`.

An executor returns a `NodeResult`: `branches`, `output`, `summary`, and optional `order` and
`vars` patches. The interpreter applies the patches (`applyResult`) from the memoized result, so a
replay patches the context the same way without running the executor again.

Inside the step the executor sends a durable report when it starts (with an `attempt N` timeline
entry from the second attempt on) and when it finishes.

The executor gets `retriesLeft` (`ExecInput`): true while `sctx.attempt <= limit`, false on the last
attempt (`limit + 1`). The AI nodes pass it to the model call as `AiCall.retry`: a failed call
(Workers AI or gateway error, or the 20-second cap) throws while attempts are left, so the step
retries with its backoff, and only the last attempt stores the heuristic's answer. A malformed,
empty or truncated answer is not retried. A node with `retries: 0` falls back at once.

A thrown executor, once its retries are exhausted, reports the node `failed` with its whole error,
reports the order `failed`, emits `order.failed` with the node and its error, and rethrows, which
fails the instance. The order's reason is a summary (`failureReason` in `packages/core/src/reasons.ts`):
`<step label>: <first line of the error>`, capped at 200 characters, or "Database error at
<step label>" for a database error, whose message is the SQL statement and its parameters. It is
shown on one line in the overview and the orders list, so it never carries a statement or a stack;
the full error is on the step's run (`NodeRun.error`) and in the timeline. A reason stored before this
summary existed still holds the statement; the web app reads it the same way where it shows a
reason (`readableReason` in `apps/web/app/lib/format.ts`).

## Interpreted nodes

Waiting and control nodes are handled in `runNode` itself:

- **`control.approval` / `control.wait_event`.** `:open`, then `step.waitForEvent` with
  `TIME_SCALE`-scaled timeout (the catalog default, `'2 days'` for an approval and `'30 days'`
  for an event, when the node's `timeout` is missing or blank), then `:close`. An approval
  takes `approved` when the payload's `decision` is `approved`, otherwise `rejected`; a timeout
  takes `escalated`. An event wait takes `received` or `timeout`, and stores the payload in
  `vars[eventVar(event)]`, so `payment.received` lands in `vars.payment_received`.
- **`control.wait`.** `until` is evaluated in its own step; a positive result sleeps until that
  epoch-ms. Else, with `every` (`week`, `month` or `year`, `count` of them), a `${key}:period` step
  reads the clock once and computes `nextPeriodBoundary` (`packages/core/src/subscriptions.ts`) from
  the `from` anchor (an expression over the context giving epoch ms or an ISO date; the step's own
  clock when unset), counting from the anchor so month-end days clamp without drifting; an anchor
  still ahead is itself the first boundary. Under `TIME_SCALE` time since the anchor runs faster
  (`calendarWait`), so renewals report advancing dates. An anchor that isn't a finite date, or a
  count over a hundred years of the unit, comes back from the step as a refusal (not a throw) and the
  node fails the order through the End path with that reason. The node `sleepUntil`s the deadline. Otherwise it sleeps for the scaled `duration` (default
  `'1 day'`). Only flows that set `every` have a `:period` step, so published flows' step names
  are unchanged.
- **`control.loop`.** One step decides `next = runs <= maxIterations && truthy(while)`; the
  outcome goes to `completeLoop`.
- **`control.end`.** Reports, emits `order.${outcome}`, and ends the run with that outcome and the
  interpolated reason, capped at 200 characters. An end `declined` or `cancelled` is not a failure,
  so no rollback runs; once the batch it ended in has finished, one more step (`<key>:void`) voids
  the order's open authorizations (`voidAuthorizations`, keyed per payment row) and logs a
  `rollback` timeline entry when it voided any. A `completed` end keeps its holds.
- **`control.continue_as_new`.** See below.

## Reports to the agent

Two kinds of report go to `OrderAgent.report` (types in `apps/engine/src/agent.ts`):

- **Plan snapshots** (status, plan, order, vars) are sent from outside steps, so a replay sends
  them again. They carry a `seq` that increments per run; the agent drops any snapshot whose `seq`
  is not newer than what it has for that generation.
- **Detail reports** (node start, finish, summary, output, timeline entries) are sent from inside
  executor steps (or, for waits and loops, once the memoized step has returned) and carry no `seq`. Timeline entries have a `key`, and the agent replaces an entry with the
  same key instead of appending, so a retried step does not duplicate history.

Report failures are logged and swallowed: the UI must never fail an order. See
[OrderAgent](order-agent.md#reports).

## Failure paths

Three throws can reach `run()`, and each leaves the order `failed` with a reason and one
`order.failed`. The OrderAgent starts watching the instance (`checkInstance`, which records the
rollback) only when a report flips the order to `failed`, so a throw nobody reports leaves it running,
waiting or queued for good.

| Throw | Who reports it |
|---|---|
| An End node with outcome `failed` | The End step emits `order.failed`; `run` sends the `failed` snapshot, then throws |
| A throw from a node's own step (retries exhausted) | `runNode`'s catch: the node `failed` and its timeline line; `run`'s catch then fails the order and sends `order.failed` with the node |
| Anything else: `load-flow`, `load-plugins`, `load-account`, a wait's `:open`, `:until` or `:close` step, a loop's decision step, `continue_as_new`, or a node type with no executor | `run`'s catch, below |

All three also go through `run`'s catch, which sends the `failed` status once more from a step, so
the first two do not depend on a snapshot that is dropped when the agent is briefly unreachable.

`run` wraps the whole body (`runOrder`) in a try/catch. A throw that neither of the first two paths
reported is tagged on its way out (`blame`: the node's label) and reported by `failOrder`, then rethrown, so Workflows still runs the
registered rollbacks. `failOrder` is up to two steps, `run:failed` (the `failed` status, the reason, the
blamed node's `failed` status and a timeline line, unless that node's own step already sent them
(`reportedNodes`, tracked per node because the first to reject a batch may be another one), sent from
inside the step so a failed send retries
rather than being dropped, as a plan snapshot would be) and `run:failed:emit` (`order.failed`,
keyed `run:failed` like any emit; skipped only for an End node that failed the order, which sent its
own). It is the one `order.failed` for every thrown failure (its outbox key is `run:failed`; it replaced
the per-node `<key>:emit` a node's own throw used to send), so two nodes of a batch failing together,
or one failing beside a wait that cannot open, still send one. Neither exists unless the run fails, so no published flow's step
names change, and a replay returns both memoized results: one report, one delivery. The agent folds a
repeated `failed` into no change. A throw before the first snapshot (the flow version is missing)
reports with no plan; the stub is made before `load-flow`.

A continue-as-new step is done once the next generation's instance exists: a failing `continuedAs`
note to the agent is logged, not thrown. If the step still throws, `failOrder` first checks, in a
step (`run:failed:continued`), whether the next generation's instance exists. Only a definite
not-found counts as absent; any other error from the check retries the step. When it exists,
`run` reports nothing and returns `{ continuedAs }` instead of rethrowing, so Workflows compensates
none of this generation's steps under a live next one, and a continued order is never marked failed.

An approval's `:open` step fails for good only when the node's approval fields don't read
(`readApprovalSpec`, a flow that bypassed publish validation). A database or network error while
resolving the approvers retries like any step.

The release steps after an End (`<key>:void`, `<key>:budgets`, `credit:release`) keep retrying. One
that fails for good never fails the order: its End node has already announced `order.completed`,
`order.declined` or `order.cancelled`, and an error out of `run` would make Workflows roll back an
order the buyer was told is done (refunding a capture, releasing its stock). The order keeps its
outcome and the instance returns. Each release is tried on its own, and the failures are recorded in
one step, `release:failed` (only on that path): a `rollback` timeline line ("Completed, but
releasing its credit holds failed: ...") and an `order.release_failed` audit event, which staff see in the audit log. It names the order, the
outcome and what failed (a release step has only counts in hand, not hold or payment ids), so staff
look the order up for the holds. No `order.failed` is sent. The attention list
(`OrderQueries.attention`, the assistant's `needs_attention`) is keyed on order status, so it
does not list such an order; making it do so needs a column on the order index and a change to the
port and both stores, which this change leaves out. What the order still holds is released by hand.

When a batch's nodes run in parallel, the first to throw fails `run` and the instance errors while a
sibling may still be inside its step. Workflows runs a rollback for that sibling too (the rollback
for an in-flight step runs with no output) and cancels it; a node's compensation therefore works from
the order id and step key, not from its output.

## Rollback

A node type with `rollback: true` in the catalog registers a compensation on its step from
`ROLLBACKS`:

| Node type | Compensation |
|---|---|
| `commerce.reserve_inventory` | `releaseInventory`: releases every held reservation |
| `commerce.authorize_payment` | `voidAuthorizations`: voids every open authorization; a Stripe one is canceled in Stripe first (an already-canceled PaymentIntent counts) and marked `voided` only after |
| `commerce.split_by_seller` | The marketplace store's `cancel` (`@commerceworker/db/marketplace-store`): cancels every pending or accepted seller order |
| `commerce.payout` | The marketplace store's `reversePayouts`: reverses every scheduled payout |
| `commerce.ship` | For shipments a provider labelled, the `voidShipmentLabels` use-case (`@commerceworker/application/commerce`) voids them at the provider first; one it can't void is kept as `void_failed` (retried daily) rather than failing the rollback, so earlier compensations still run. Then the shipping store's `cancel` for every other shipment id in the step's output (`shipments`; one per source location on a split), then the inventory store's `restoreShipped`: once none of the order's shipments is live (`label_created`, `ready_for_pickup`, `collected`), stock its shipments consumed goes back, each reservation once |
| `commerce.pickup_ready` | The shipping store's `cancel` for the staged pickup's shipment id in the step's output |
| `commerce.deliver_digital` | `revokeEntitlements`: revokes every issued code |
| `commerce.invoice` | The `voidInvoices` use-case (`packages/application/src/commerce/invoices.ts`): voids each unpaid Stripe invoice in Stripe (a draft is deleted) before marking it `void`; one Stripe reports paid is left alone and named in the summary. Then the balance store's `reverse` (`@commerceworker/db/balance-store`): reverses each on-account balance entry once, with a negative `rev_` entry, skipping one its paid invoice already settled (`set_`) |

Each runs with `{ retries: { limit: 3, delay: '10 seconds', backoff: 'linear' }, timeout: '2 minutes' }`
and reports the node `rolled_back`. A failed report is logged, not thrown, so Workflows never reruns a compensation that already ran. When the instance fails (an End node with outcome `failed`, or a
thrown node) Workflows runs the compensations in reverse order. The agent then polls the instance
to record the rollback outcome (see [OrderAgent](order-agent.md#rollback-outcome)).

Cancelling does not go through rollback: the agent terminates the instance and calls
`compensateOrder` directly.

## Outbound webhooks

`emitStep` delivers one event in its own `${key}:emit` step with
`{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' }`. The
step calls `emit` (`apps/engine/src/outbox.ts`), which records one `webhook_deliveries` row per
matching subscription, keyed `whd_${orderId}_${stepKey}_${subscriptionId}`, then makes one attempt
at every row for that key not yet `delivered` (each receiver has a 10 second timeout, in parallel).
The Workflow never waits on a receiver: when deliveries are still pending the step hands them to the
OrderAgent (`queueWebhookRetry`, once per key, marked in the agent's KV so a retried step or a
replay queues nothing more), whose alarm schedule runs `retryWebhook` for about a day
(`EVENT_RETRIES`, `eventRetryDelaySec`: 10 seconds doubling to an hour, then hourly). A retry is
`resend`: it sends the rows as recorded (same id, same payload) and records nothing, so an order
erased meanwhile (its rows `forget`ten) has nothing left to send. The step's own retries cover only
the database and the agent call, both safe to repeat; a failure that outlasts them is swallowed, the
rows stay `failed`, and the order carries on. The step keeps its name and the hand-off is inside it,
so a published flow's step names don't change and a run replaying an old `${key}:emit` finds its
stored result. A delivery that runs out of retries stays `failed` for an operator to send again
with `redeliver_webhook_delivery` (`redeliver` in `outbox.ts`: the same row, id and payload, signed
with the subscription's current secret, one attempt recorded on it).

Which nodes emit is `NODE_EVENTS` in `packages/core/src/webhooks.ts`. Cart events (`CART_EVENTS`)
don't come from a Workflow: `CartAgent` (`apps/engine/src/cart/agent.ts`) schedules its own
`emitWebhook` when a cart opens or ends (`announce`), which calls `emitCart` with the cart's
`cartSummary`, keyed `whd_${cartId}_${event}_${subscriptionId}`. The schedule is written with the
state change, before the `carts` row, and retries for about a day (`EVENT_RETRIES`,
`eventRetryDelaySec`, the schedule an order's events share). An erasure bumps the agent's `cart_erasures` count: a queued event from
before it is dropped, and one in flight deletes the rows it wrote. See
[Outbound webhooks](https://docs.commerceworker.com/guides/outbound-webhooks/).

## Continue as new

A long-lived flow (the subscription template) would otherwise grow its step history without bound.
`control.continue_as_new` only returns `{ kind: 'continue' }` from its node; the next generation
starts after the whole batch is applied, so the outputs of its siblings in the batch carry over in
`order` and `vars`. `continueAsNew` then runs one step, named by the node's key, that creates a new
instance with id `${orderId}-g${generation + 1}` and params carrying the current `order` and `vars`,
then calls `agent.continuedAs(id, generation)`. It is retry-safe: if `create` threw but the
instance exists (a retry after it succeeded), the step goes on to `continuedAs`. If the batch also
reached an End node, the end wins and no new generation starts. The current run returns
`{ continuedAs }`.

Generation 1's instance id is `${orderId}-g1` (set by `startOrder` in `apps/engine/src/orders.ts`).
Each generation starts its own `seq` from zero, and the agent accepts any report from a newer
generation.

## Time scale

`scaled(env, duration)` divides every wait, sleep and wait timeout by `TIME_SCALE`
(default `"1440"`: a day becomes a minute) and never goes below one second. Step retry delays and
timeouts are not scaled. Set `TIME_SCALE` to `"1"` for real time.

## Determinism rules

- Every effect happens inside a `step.do`; anything that reads time or calls a model is a step too.
- The planner is pure, and nodes are applied in graph order after each batch.
- `ctx.now` is the instance's start timestamp.
- Step names never change for a published flow.
