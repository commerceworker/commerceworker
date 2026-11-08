/**
 * The engine Worker: everything asynchronous and stateful. Queue consumers (domain events, bulk
 * chunks, agent jobs, dead letters), the cron sweeper (outbox relay, scheduled actions, asset
 * expiry, bulk-stall recovery, retention (event history, trash), secret reseal, agent schedules),
 * and the owner of every Durable Object and Workflow class (the admin's assistant among them). It
 * has no public route; the api and delivery Workers reach it through bindings.
 */
import {
  createHttpFunctionInvoker,
  createWebhookSender,
} from '@commerceworker/adapters/http-effects';
import {
  archiveSupersededVersions,
  type ConsumeDeps,
  consumeEvent,
  createHasher,
  deliverWebhookRequest,
  drainOutbox,
  pruneEventHistory,
  redeliverWebhook,
  repairAllTaxonomies,
  resealSecrets,
  resumeStalledBulkJobs,
  resumeStalledEnvironmentPurges,
  runDueAgentSchedules,
  runDueAssetExpiries,
  runDueScheduledActions,
  runPublishAgents,
  startAssetIngestForObject,
  startRequestedAssetIngest,
  sweepAbandonedMultipartUploads,
  sweepAbandonedUploads,
  sweepExpiredTrash,
  sweepExpiredZips,
} from '@commerceworker/application';
import { isWebhookSendRequest, type Scope } from '@commerceworker/domain';
import { isResealTick } from '@commerceworker/platform/data-key';
import { recordDeadLetters } from '@commerceworker/platform/dead-letters';
import { CostGuardDO, doAgentCostGuardFromEnv } from '@commerceworker/platform/do/cost-guard';
import { createDoEventBus, LiveHubDO } from '@commerceworker/platform/do/live-hub';
import { RateLimiterDO } from '@commerceworker/platform/do/rate-limiter';
import { SearchShardDO } from '@commerceworker/platform/do/search-shard';
import { type EdgeEnv, queueName, withJurisdiction } from '@commerceworker/platform/env';
import {
  type AgentJobMessage,
  isAgentJob,
  isAssetIngestMessage,
  isDomainEvent,
  isObjectCreated,
  isWebhookRetryMessage,
  type WebhookRetryMessage,
} from '@commerceworker/platform/messages';
import { makeMetrics } from '@commerceworker/platform/metrics';
import {
  agentConfigFromEnv,
  type EdgeWired,
  makeAgents,
  wireEdge,
} from '@commerceworker/platform/wire';
import { redactCredentials } from '@commerceworker/redaction';
import { starterChunkRunner } from '@commerceworker/seed';
import { AssistantAgent } from './assistant';
import {
  CRON_JOBS,
  cronSchedule,
  finishTick,
  isTaxonomyRepairTick,
  startTick,
  sweep,
} from './heartbeat';
import { runInLanes } from './lanes';
import { newPurgePlan, planPurges, sendPurges } from './purges';
import { AgentWorkflow } from './workflows/agent-workflow';
import { AssetIngestWorkflow } from './workflows/asset-ingest-workflow';
import { AssetZipWorkflow } from './workflows/asset-zip-workflow';
import { EditorialWorkflow } from './workflows/editorial-workflow';

/** A queue message's payload (kept as one accessor so every consumer reads it the same way). */
const payloadOf = (m: { body: unknown }): unknown => m.body;

// Worker-entrypoint classes must be exported from the deployed script: the engine owns every
// Durable Object and Workflow; the api and delivery Workers bind them by script name.
export {
  AgentWorkflow,
  AssetIngestWorkflow,
  AssetZipWorkflow,
  AssistantAgent,
  CostGuardDO,
  EditorialWorkflow,
  LiveHubDO,
  RateLimiterDO,
  SearchShardDO,
};

/**
 * commerceworker-events consumer body. When AGENTS_QUEUE is bound, entry.published events
 * enqueue an agent job there (before ack, so at-least-once holds) instead of
 * awaiting workflows inline — a batch of 25 published entries then costs 25
 * cheap sends, not up to 25×2 polled Workflow runs in one invocation.
 */
/** Lanes a batch of events runs in at once (see runInLanes). */
const EVENT_LANES = 6;

/**
 * The lane a queued event runs in: its entry, so one entry's events keep their order; anything
 * else (asset, content type, release, workflow, bulk events) shares one lane per scope, in order.
 */
function eventLane(msg: Message<unknown>): string {
  const body = payloadOf(msg);
  // A webhook retry, test or resend touches that webhook only: its own lane.
  if (isWebhookRetryMessage(body) || isWebhookSendRequest(body)) return `webhook:${body.webhookId}`;
  const event = body as {
    scope?: { spaceId?: string; environmentId?: string };
    entryId?: unknown;
  };
  const scope = `${event?.scope?.spaceId ?? ''}:${event?.scope?.environmentId ?? ''}`;
  return typeof event?.entryId === 'string' ? `${scope}:entry:${event.entryId}` : `${scope}:other`;
}

async function consumeEvents(batch: MessageBatch, env: EdgeEnv, wired: EdgeWired): Promise<void> {
  const metrics = makeMetrics(env.METRICS);
  const agentConfig = agentConfigFromEnv(env);
  const agentsConfigured = agentConfig.enrich || agentConfig.moderate;
  const forwardAgents = Boolean(env.AGENTS_QUEUE) && agentsConfigured;
  const deps: ConsumeDeps = {
    // One coalescing set per batch: a batch of same-type publishes writes each
    // cache tag once instead of once per message (KV rate-limits per key).
    invalidatedTags: new Set<string>(),
    sender: createWebhookSender(),
    // Invitation links go out by email only where the deployment sends it; the token is minted
    // and hashed (TOKEN_PEPPER, as the api's) at the send.
    ...(wired.workflowNodes.email
      ? {
          inviteMail: {
            email: wired.workflowNodes.email,
            hasher: createHasher(env.TOKEN_PEPPER),
          },
        }
      : {}),
    // A failed webhook delivery comes back later for that webhook alone.
    ...(env.EVENTS_QUEUE
      ? {
          scheduleWebhookRetry: async ({ webhookId, event, attempt, delaySeconds }) => {
            const message: WebhookRetryMessage = {
              kind: 'webhook.retry',
              webhookId,
              event,
              attempt,
            };
            await env.EVENTS_QUEUE?.send(message, { delaySeconds });
          },
        }
      : {}),
    invoker: createHttpFunctionInvoker(),
    cache: wired.cache,
    // RAG indexing only when embeddings are
    // explicitly configured (EMBEDDINGS_PROVIDER), never with the dev fallback.
    rag: env.EMBEDDINGS_PROVIDER ? wired.rag : undefined,
    // Independent of rag: lexical indexing works without embeddings.
    searchIndex: wired.rag.searchIndex,
    // Import chunks stage their records here rather than carrying entry ids;
    // without it they stay claimable instead of running.
    blob: wired.blob,
    // A space export import's chunks copy asset files through it (URLs screened first).
    remoteFetcher: wired.remoteFetcher,
    // The media origin's gate: written and removed here, from asset events, and nowhere else.
    ...(wired.assetGate ? { assetGate: wired.assetGate } : {}),
    // Asset search: re-indexed on publish, removed on delete. Embeds under the same rule as rag.
    assetSearch: wired.assetSearch,
    // A background starter's phases (`starter_install` chunks), each writing through the use-cases.
    starterChunk: starterChunkRunner(wired.ctx, { blob: wired.blob }),
    // `asset_reindex` bulk chunks hand their assets to ingest through this queue.
    ...(wired.assetIngest ? { assetIngest: wired.assetIngest } : {}),
    // Zip downloads: `asset_zip.requested` starts the job's Workflow.
    ...(wired.assetZipStarter ? { assetZip: wired.assetZipStarter } : {}),
    bus: env.LIVE_HUB ? createDoEventBus(env.LIVE_HUB) : undefined,
    onLiveError: (err) => console.error('live publish error', err),
    // Inline agents only when no commerceworker-agents queue is bound (dev/demo parity).
    agents: forwardAgents ? undefined : makeAgents(env, wired.ctx, wired.ai),
    agentConfig: forwardAgents ? undefined : agentConfig,
  };
  // Delivery and media cache tags made stale by this batch, sent as one message per queue after it
  // (purges are rationed, so a burst of publishes in one space costs one tag, not one call each).
  const stale = newPurgePlan();
  const handle = async (msg: Message<unknown>): Promise<void> => {
    const body = payloadOf(msg);
    if (isWebhookRetryMessage(body)) {
      try {
        const outcome = await redeliverWebhook(wired.ctx, deps, body);
        metrics.count('commerceworker_webhook_retries_total', 1, {
          outcome: outcome === null ? 'dropped' : outcome.delivered ? 'delivered' : 'failed',
        });
        msg.ack();
      } catch (err) {
        console.error('webhook retry failed; retrying', err);
        msg.retry();
      }
      return;
    }
    // An administrator's webhook test or resend. Not a domain event (no `type`), so an engine
    // without this branch drops it below as malformed instead of fanning it out by topic.
    if (isWebhookSendRequest(body)) {
      try {
        const outcome = await deliverWebhookRequest(wired.ctx, deps, body);
        metrics.count('commerceworker_webhook_requests_total', 1, {
          kind: body.test ? 'test' : 'resend',
          outcome: outcome === null ? 'dropped' : outcome.delivered ? 'delivered' : 'failed',
        });
        msg.ack();
      } catch (err) {
        console.error('webhook send request failed; retrying', err);
        msg.retry();
      }
      return;
    }
    // Validate the message shape before treating it as a DomainEvent. A
    // malformed/poison message is acked (dropped) rather than retried forever.
    const event = body;
    if (!isDomainEvent(event)) {
      console.error('dropping malformed queue message', { id: msg.id });
      metrics.count('commerceworker_events_consumed_total', 1, {
        type: 'malformed',
        outcome: 'dropped',
      });
      msg.ack();
      return;
    }
    try {
      const runs = await consumeEvent(wired.ctx, deps, event);
      for (const r of runs) {
        console.log(JSON.stringify({ msg: `${r.workflow} complete`, ...r }));
      }
      if (forwardAgents && event.type === 'entry.published' && env.AGENTS_QUEUE) {
        const job: AgentJobMessage = {
          kind: 'agent.publish_run',
          scope: event.scope,
          entryId: event.entryId,
        };
        await env.AGENTS_QUEUE.send(job);
      }
      // The event's effects already ran, so a failure to plan its purges is logged, not retried:
      // only a rendition change reads anything (the space's environments), and it has added its
      // media tag before that read; delivery responses age out on their own.
      await planPurges(wired.ctx, stale, event).catch((err: unknown) =>
        console.error('purge planning failed', redactCredentials(err)),
      );
      metrics.count('commerceworker_events_consumed_total', 1, {
        type: event.type,
        outcome: 'ok',
      });
      msg.ack();
    } catch (err) {
      console.error('event dispatch failed; retrying', err);
      metrics.count('commerceworker_events_consumed_total', 1, {
        type: event.type,
        outcome: 'error',
      });
      msg.retry();
    }
  };
  // One entry's events in order; different entries (and scopes) side by side.
  await runInLanes(batch.messages, eventLane, handle, EVENT_LANES);
  // Not fatal: delivery responses go stale for at most their max-age (60s); media for a revoked
  // asset stays cached until the media Worker's cache lets it go, so that one is counted.
  await sendPurges(env, stale, (what, err) => {
    console.error(`${what} enqueue failed`, redactCredentials(err));
    metrics.count('commerceworker_purge_enqueue_errors_total', 1, { queue: what });
  });
}

/**
 * commerceworker-asset-events consumer body: R2's object-create notifications for the media bucket
 * (and the api's own message when an upload through its signed PUT completes), plus requests to
 * run ingest again. Each starts at most one AssetIngestWorkflow instance, under an id derived
 * from the file version, so the two triggers of one upload and any redelivery start one run.
 * Objects that aren't an asset's current file (extracted text, version bodies, staged jobs) are
 * acknowledged and ignored.
 */
async function consumeAssetEvents(
  batch: MessageBatch,
  env: EdgeEnv,
  wired: EdgeWired,
): Promise<void> {
  const metrics = makeMetrics(env.METRICS);
  const starter = wired.assetIngestStarter;
  for (const msg of batch.messages) {
    const body = payloadOf(msg);
    if (!starter) {
      // Ingest isn't bound here: nothing will ever take these, so don't hold them.
      metrics.count('commerceworker_asset_events_total', 1, { outcome: 'unbound' });
      msg.ack();
      continue;
    }
    try {
      let outcome: string;
      if (isObjectCreated(body)) {
        outcome = await startAssetIngestForObject(
          wired.ctx,
          starter,
          body.object.key,
          body.object.eTag,
        );
      } else if (isAssetIngestMessage(body)) {
        outcome = await startRequestedAssetIngest(wired.ctx, starter, body);
      } else {
        // An object deletion, a lifecycle event, or something malformed: nothing to ingest.
        outcome = 'ignored';
      }
      metrics.count('commerceworker_asset_events_total', 1, { outcome });
      msg.ack();
    } catch (err) {
      console.error('asset ingest start failed; retrying', redactCredentials(err));
      metrics.count('commerceworker_asset_events_total', 1, { outcome: 'error' });
      msg.retry();
    }
  }
}

/**
 * Entries per durable agent-workflow instance.
 *
 * Sized against the per-instance STEP ceiling (~1024 on Workflows). Worst case
 * per entry is ~13 steps: enrich (loadEntry, generateFields, record,
 * createReview) + moderate (loadEntry, classify, record) + one recordRun per
 * workflow + the watcher start + the retract path (retractEntry, recordRun).
 * 25 × 13 ≈ 325 leaves room for a future activity without silently pushing an
 * instance over the limit — and still cuts instance count 25×, so 100k
 * published entries cost ~4k instances instead of 100k+.
 */
const AGENT_CHUNK = 25;

/**
 * commerceworker-agents consumer body.
 *
 * Fire-and-forget: the whole on-publish pass (enrich → moderate → record →
 * retract) now runs INSIDE the durable workflow, so this only has to start
 * instances and ack. It used to call `runPublishAgents`, which awaited each
 * run's result — and awaiting a result on Workflows means polling
 * `instance.status()`, pinning one consumer invocation per entry for up to ten
 * minutes. At 100k published entries that model needed 100k+ instances each
 * holding an invocation; this needs one instance per {@link AGENT_CHUNK}
 * entries and holds nothing.
 *
 * Runtimes without a durable start (in-process, dev/demo) keep the inline path.
 */
async function consumeAgentJobs(
  batch: MessageBatch,
  env: EdgeEnv,
  wired: EdgeWired,
): Promise<void> {
  const metrics = makeMetrics(env.METRICS);
  const agentConfig = agentConfigFromEnv(env);
  const agents = makeAgents(env, wired.ctx, wired.ai);

  const jobs = batch.messages.filter((m) => {
    if (isAgentJob(payloadOf(m))) return true;
    console.error('dropping malformed agent job', { id: m.id });
    metrics.count('commerceworker_agent_jobs_total', 1, { outcome: 'dropped' });
    m.ack();
    return false;
  });
  if (jobs.length === 0) return;
  if (!agents) {
    // Agents were disabled after the jobs were enqueued — drop, don't retry.
    for (const m of jobs) m.ack();
    metrics.count('commerceworker_agent_jobs_total', jobs.length, { outcome: 'disabled' });
    return;
  }

  if (agents.startPublishRuns) {
    // Group by scope: one instance covers entries from a single space/env.
    const byScope = new Map<string, { scope: Scope; ids: string[]; msgs: Message[] }>();
    for (const m of jobs) {
      const job = payloadOf(m) as AgentJobMessage;
      const key = `${job.scope.spaceId}::${job.scope.environmentId}`;
      const bucket = byScope.get(key) ?? { scope: job.scope, ids: [], msgs: [] };
      bucket.ids.push(job.entryId);
      bucket.msgs.push(m);
      byScope.set(key, bucket);
    }
    for (const bucket of byScope.values()) {
      // Ack/retry PER CHUNK, not per bucket: retrying messages whose instance
      // already started would re-run their agents, and the pass now performs a
      // real state change (retracting a held entry), so duplicates are not
      // free the way recorded proposals were.
      for (let at = 0; at < bucket.ids.length; at += AGENT_CHUNK) {
        const ids = bucket.ids.slice(at, at + AGENT_CHUNK);
        const msgs = bucket.msgs.slice(at, at + AGENT_CHUNK);
        try {
          await agents.startPublishRuns({
            scope: bucket.scope,
            entryIds: ids,
            enrich: agentConfig.enrich,
            moderate: agentConfig.moderate,
            ...(agentConfig.autoApply !== undefined ? { autoApply: agentConfig.autoApply } : {}),
          });
          for (const m of msgs) m.ack();
          metrics.count('commerceworker_agent_jobs_total', msgs.length, { outcome: 'started' });
        } catch (err) {
          // Instance creation failed (rate limit, transient) — only this
          // chunk's messages redeliver.
          console.error('agent workflow start failed; retrying chunk', err);
          for (const m of msgs) m.retry();
          metrics.count('commerceworker_agent_jobs_total', msgs.length, { outcome: 'error' });
        }
      }
    }
    return;
  }

  // Non-durable runtime: run the pass inline, one entry at a time.
  for (const m of jobs) {
    const job = payloadOf(m) as AgentJobMessage;
    try {
      const runs = await runPublishAgents(wired.ctx, agents, job.scope, job.entryId, agentConfig);
      for (const r of runs) console.log(JSON.stringify({ msg: `${r.workflow} complete`, ...r }));
      metrics.count('commerceworker_agent_jobs_total', 1, { outcome: 'ok' });
      m.ack();
    } catch (err) {
      console.error('agent job failed; retrying', err);
      metrics.count('commerceworker_agent_jobs_total', 1, { outcome: 'error' });
      m.retry();
    }
  }
}

export default {
  /**
   * Queue consumers, routed by queue name:
   * - commerceworker-events: the application's consumeEvent body — webhooks,
   *   cache invalidation, RAG indexing (one bounded slice per reindex message),
   *   functions, live fan-out. On-publish agent runs are forwarded to commerceworker-agents
   *   when that queue is bound, else run inline (dev parity).
   * - commerceworker-agents: one agent job per invocation (batch size 1) — each job can
   *   await durable Workflow runs for minutes without starving event delivery.
   * - commerceworker-asset-events: R2 object-create notifications (and the api's upload and
   *   re-ingest messages), each starting one AssetIngestWorkflow run.
   * - commerceworker-events-dlq, commerceworker-asset-events-dlq: dead letters are logged, kept
   *   redacted under `dlq/` in the media bucket, and acked, never silent.
   * Per-message ack/retry so one poison message doesn't recycle a batch.
   */
  async queue(batch: MessageBatch, rawEnv: EdgeEnv, _exec: ExecutionContext): Promise<void> {
    const env = withJurisdiction(rawEnv);
    if (
      batch.queue === queueName(env, 'commerceworker-events-dlq') ||
      batch.queue === queueName(env, 'commerceworker-asset-events-dlq')
    ) {
      const metrics = makeMetrics(env.METRICS);
      await recordDeadLetters(batch, env.MEDIA_BUCKET, () =>
        metrics.count('commerceworker_dead_letters_total'),
      );
      return;
    }

    const wired = wireEdge(env);
    try {
      if (batch.queue === queueName(env, 'commerceworker-agents')) {
        await consumeAgentJobs(batch, env, wired);
      } else if (batch.queue === queueName(env, 'commerceworker-asset-events')) {
        await consumeAssetEvents(batch, env, wired);
      } else {
        await consumeEvents(batch, env, wired);
      }
      // Events appended during consumption (reindex continuation slices, moderation
      // retractions) relay now instead of waiting for the cron.
      if (wired.queue) {
        const metrics = makeMetrics(env.METRICS);
        await drainOutbox(wired.ctx, wired.queue, { routeTopic: wired.routeTopic }).then(
          (relayed) => {
            if (relayed > 0) {
              metrics.count('commerceworker_outbox_relayed_total', relayed, {
                trigger: 'post-batch',
              });
            }
          },
          (err) => {
            console.error('post-batch outbox relay failed', redactCredentials(err));
            metrics.count('commerceworker_relay_errors_total', 1, { trigger: 'post-batch' });
          },
        );
      }
    } finally {
      await wired.close();
    }
  },

  /**
   * Cron sweeper (every minute): drains any outbox rows the post-commit nudge
   * missed (crash/eviction), fires due scheduled publish/unpublish actions and
   * unpublishes assets whose rights expired. Each sweep's outcome, and the tick
   * itself, is written as the scheduler's heartbeat at the end (./heartbeat.ts):
   * the api's /health reads it. Then the stale alerts: a sweep that has gone two of
   * its runs (five minutes for the every-minute ones) without a success emails the
   * deployment's alert recipients once, and again when it recovers.
   */
  async scheduled(ctrl: ScheduledController, rawEnv: EdgeEnv, _exec: ExecutionContext) {
    const env = withJurisdiction(rawEnv);
    const wired = wireEdge(env);
    const metrics = makeMetrics(env.METRICS);
    const tick = startTick(wired.ctx);
    try {
      // Retention sweeps on the top-of-hour tick only (the cron fires every
      // minute): trims relayed outbox rows + old webhook delivery records, then
      // abandoned uploads.
      if (wired.persistent && new Date(ctrl.scheduledTime).getUTCMinutes() === 0) {
        await sweep(
          tick,
          CRON_JOBS.prune,
          async () => {
            const pruned = await pruneEventHistory(wired.ctx, {
              ...(env.EVENT_RETENTION_HOURS
                ? { retentionHours: Number(env.EVENT_RETENTION_HOURS) }
                : {}),
            });
            if (pruned.outboxDeleted > 0 || pruned.webhookDeliveriesDeleted > 0) {
              console.log(JSON.stringify({ msg: 'event history pruned', ...pruned }));
              metrics.count('commerceworker_events_pruned_total', pruned.outboxDeleted, {
                table: 'outbox',
              });
              metrics.count('commerceworker_events_pruned_total', pruned.webhookDeliveriesDeleted, {
                table: 'webhook_deliveries',
              });
            }
          },
          (err) => console.error('event history prune failed', err),
        );
        // Multipart uploads left unfinished a day on: aborted, so R2 drops their parts. Before
        // the drafts below, whose sweep then finds no bytes and removes them.
        await sweep(
          tick,
          CRON_JOBS.abandonedMultipart,
          async () => {
            const swept = await sweepAbandonedMultipartUploads(wired.ctx, wired.blob);
            if (swept.aborted + swept.failed > 0) {
              console.log(JSON.stringify({ msg: 'abandoned multipart uploads swept', ...swept }));
              for (const outcome of ['aborted', 'failed'] as const) {
                if (swept[outcome] > 0) {
                  metrics.count('commerceworker_abandoned_multipart_total', swept[outcome], {
                    outcome,
                  });
                }
              }
            }
          },
          (err) => console.error('abandoned multipart sweep failed', redactCredentials(err)),
        );
        // Zip downloads past their day: the archive and its job go.
        await sweep(
          tick,
          CRON_JOBS.expiredZips,
          async () => {
            const swept = await sweepExpiredZips(wired.ctx, wired.blob);
            if (swept.removed + swept.failed > 0) {
              console.log(JSON.stringify({ msg: 'expired zips swept', ...swept }));
              metrics.count('commerceworker_zips_swept_total', swept.removed, {
                outcome: 'removed',
              });
              if (swept.failed > 0) {
                metrics.count('commerceworker_zips_swept_total', swept.failed, {
                  outcome: 'failed',
                });
              }
            }
          },
          (err) => console.error('expired zip sweep failed', redactCredentials(err)),
        );
        // Entries in the trash past their space's retention window, purged as "Delete
        // permanently" would (never forced: a published link keeps one). Off unless a space set a
        // window; bounded per tick, one purge at a time (one writer), and resumed next hour.
        await sweep(
          tick,
          CRON_JOBS.trashRetention,
          async () => {
            const swept = await sweepExpiredTrash(wired.ctx, { blob: wired.blob });
            if (swept.purged + swept.refused > 0) {
              console.log(JSON.stringify({ msg: 'expired trash swept', ...swept }));
              for (const outcome of ['purged', 'refused'] as const) {
                if (swept[outcome] > 0) {
                  metrics.count('commerceworker_trash_purged_total', swept[outcome], { outcome });
                }
              }
            }
          },
          (err) => console.error('trash retention sweep failed', redactCredentials(err)),
        );
        // Drafts whose presigned upload never landed, a day on (bounded per tick).
        await sweep(
          tick,
          CRON_JOBS.abandonedUploads,
          async () => {
            const swept = await sweepAbandonedUploads(wired.ctx, wired.blob);
            if (swept.removed + swept.landed + swept.linked + swept.failed > 0) {
              console.log(JSON.stringify({ msg: 'abandoned uploads swept', ...swept }));
              for (const outcome of ['removed', 'landed', 'linked', 'failed'] as const) {
                if (swept[outcome] > 0) {
                  metrics.count('commerceworker_abandoned_uploads_total', swept[outcome], {
                    outcome,
                  });
                }
              }
            }
          },
          (err) => console.error('abandoned upload sweep failed', redactCredentials(err)),
        );
      }
      // Secrets-at-rest sweep, once a day (03:30 UTC): reseals values under
      // DATA_KEY_PREVIOUS onto DATA_KEY after a rotation.
      if (wired.persistent && isResealTick(ctrl.scheduledTime)) {
        await sweep(
          tick,
          CRON_JOBS.reseal,
          async () => {
            const r = await resealSecrets({ store: wired.ctx.store, sealer: wired.sealer });
            console.log(JSON.stringify({ msg: 'secrets resealed', ...r }));
            metrics.count('commerceworker_secrets_resealed_total', r.resealed);
            if (r.unreadable > 0) {
              // Never the values: only where they live.
              console.error(
                JSON.stringify({
                  msg: 'secrets unreadable with DATA_KEY or DATA_KEY_PREVIOUS',
                  unreadable: r.unreadable,
                  refs: r.unreadableRefs,
                }),
              );
              metrics.count('commerceworker_secrets_unreadable_total', r.unreadable);
            }
          },
          (err) => console.error('secret reseal failed', err),
        );
      }
      // Taxonomy repair, once a day (04:15 UTC): recounts every environment's published usage
      // counts from its snapshots and gives a slug to any term older code wrote without one.
      // The counts are kept as entries publish; this is the backstop, not the mechanism.
      if (wired.persistent && isTaxonomyRepairTick(ctrl.scheduledTime)) {
        await sweep(
          tick,
          CRON_JOBS.taxonomyRepair,
          async () => {
            const r = await repairAllTaxonomies(wired.ctx);
            console.log(JSON.stringify({ msg: 'taxonomy repaired', ...r }));
            if (r.slugsAssigned > 0) {
              metrics.count('commerceworker_taxonomy_slugs_assigned_total', r.slugsAssigned);
            }
            if (r.failed > 0) {
              metrics.count('commerceworker_taxonomy_repair_failed_total', r.failed);
            }
          },
          (err) => console.error('taxonomy repair failed', redactCredentials(err)),
        );
      }
      // Actions first: their outbox events are then picked up by the relay
      // sweep below instead of waiting a full cron interval.
      // A failure here must not skip the rest of the tick (the relay sweep is the crash backstop).
      await sweep(
        tick,
        CRON_JOBS.scheduledActions,
        async () => {
          const { executed, failed } = await runDueScheduledActions(wired.ctx);
          if (executed > 0)
            metrics.count('commerceworker_scheduled_actions_total', executed, {
              outcome: 'executed',
            });
          if (failed > 0)
            metrics.count('commerceworker_scheduled_actions_total', failed, { outcome: 'failed' });
          if (executed > 0 || failed > 0) {
            console.log(JSON.stringify({ msg: 'scheduled actions run', executed, failed }));
          }
        },
        (err) => {
          console.error('scheduled actions failed', redactCredentials(err));
          metrics.count('commerceworker_scheduled_actions_total', 1, { outcome: 'error' });
        },
      );
      // Assets whose rights expired leave Delivery (their outbox events relay below, which purges
      // the media and delivery caches and removes the gate). Before the relay for the same reason.
      await sweep(
        tick,
        CRON_JOBS.assetExpiry,
        async () => {
          const { expired, errors } = await runDueAssetExpiries(wired.ctx);
          if (expired > 0) {
            metrics.count('commerceworker_asset_expiries_total', expired, { outcome: 'expired' });
            console.log(JSON.stringify({ msg: 'expired assets unpublished', expired }));
          }
          if (errors.length > 0) {
            metrics.count('commerceworker_asset_expiries_total', errors.length, {
              outcome: 'failed',
            });
            console.error(
              JSON.stringify({
                msg: 'asset expiry failed',
                errors: errors.map((e) => ({
                  spaceId: e.scope.spaceId,
                  environmentId: e.scope.environmentId,
                  assetId: e.assetId,
                  error: redactCredentials(e.error),
                })),
              }),
            );
            // Recorded on the heartbeat, so /health and `fleet.ts doctor` show an expiry that
            // keeps failing (an expired asset still in Delivery), not only the log.
            throw new Error(`${errors.length} asset expiries failed`);
          }
        },
        (err) => {
          console.error('asset expiry sweep failed', redactCredentials(err));
          metrics.count('commerceworker_asset_expiries_total', 1, { outcome: 'error' });
        },
      );
      // A relay error must not abort the tick (agent schedules still run).
      const queue = wired.queue;
      if (queue) {
        await sweep(
          tick,
          CRON_JOBS.relay,
          async () => {
            const total = await drainOutbox(wired.ctx, queue, {
              maxIterations: 20,
              routeTopic: wired.routeTopic,
            });
            if (total > 0)
              metrics.count('commerceworker_outbox_relayed_total', total, { trigger: 'cron' });
          },
          (err) => {
            console.error('cron outbox relay failed', err);
            metrics.count('commerceworker_relay_errors_total', 1, { trigger: 'cron' });
          },
        );
      }
      // Bulk-job crash recovery: re-nudge chunks whose claim went stale or
      // whose chunk_due event was lost (normally returns 0 — one cheap
      // indexed query). The re-appended events relay on the next tick's
      // drain (or the following nudge).
      if (wired.persistent) {
        await sweep(
          tick,
          CRON_JOBS.bulkResume,
          async () => {
            const resumed = await resumeStalledBulkJobs(wired.ctx);
            if (resumed > 0) {
              console.log(JSON.stringify({ msg: 'stalled bulk chunks re-nudged', resumed }));
              metrics.count('commerceworker_bulk_chunks_resumed_total', resumed);
            }
          },
          (err) => console.error('bulk stall sweep failed', err),
        );
        // Deleted environments whose purge lost its step event (normally none).
        await sweep(
          tick,
          CRON_JOBS.purgeResume,
          async () => {
            const restarted = await resumeStalledEnvironmentPurges(wired.ctx);
            if (restarted > 0) {
              console.log(
                JSON.stringify({ msg: 'stalled environment purges restarted', restarted }),
              );
              metrics.count('commerceworker_environment_purges_resumed_total', restarted);
            }
          },
          (err) => console.error('environment purge sweep failed', err),
        );
        // Superseded version bodies out of D1 into the media bucket (bounded per tick), once the
        // deployment has turned it on: every Worker must read archived bodies first.
        if (env.VERSION_ARCHIVE === 'true') {
          await sweep(
            tick,
            CRON_JOBS.versionArchive,
            async () => {
              const moved = await archiveSupersededVersions(wired.ctx, wired.blob);
              if (moved > 0) metrics.count('commerceworker_versions_archived_total', moved);
            },
            (err) => console.error('version archive sweep failed', err),
          );
        }
      }
      // Recurring agent jobs: due schedules run here on the cron tick, metered
      // through a separate background counter window (the `agent:` DO prefix,
      // AI_AGENT_* ceilings when set) so batch spend can't exhaust the
      // interactive budget.
      if (env.AGENTS_SCHEDULES === 'true') {
        await sweep(
          tick,
          CRON_JOBS.agentSchedules,
          async () => {
            const bgGuard = doAgentCostGuardFromEnv(env);
            const scheduleCtx = { ...wired.ctx, costGuard: bgGuard ?? wired.ctx.costGuard };
            const agents = makeAgents(env, scheduleCtx, wired.ai);
            if (!agents) return;
            const s = await runDueAgentSchedules(scheduleCtx, agents, {
              entriesPerRun: Number(env.AGENT_SCHEDULE_MAX_ENTRIES ?? 25),
              maxRunTokens: Number(env.AGENT_SCHEDULE_MAX_RUN_TOKENS ?? 100_000),
            });
            if (s.schedules > 0) console.log(JSON.stringify({ msg: 'agent schedules run', ...s }));
          },
          (err) => console.error('agent schedules failed', redactCredentials(err)),
        );
      }
    } finally {
      // The heartbeat goes to D1 only: an in-memory store would hold it for nobody to read.
      if (wired.persistent) {
        await finishTick(wired.ctx, tick, {
          schedule: cronSchedule({
            queue: Boolean(wired.queue),
            versionArchive: env.VERSION_ARCHIVE === 'true',
            agentSchedules: env.AGENTS_SCHEDULES === 'true',
          }),
          ...(wired.workflowNodes.email ? { email: wired.workflowNodes.email } : {}),
        });
      }
      await wired.close();
    }
  },
} satisfies ExportedHandler<EdgeEnv>;
