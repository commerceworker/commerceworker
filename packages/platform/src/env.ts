import type { WorkersAiRun, WorkersAiToMarkdown } from '@commerceworker/adapters/ai-workers';
import type { KvGateBinding } from '@commerceworker/adapters/asset-gate-kv';
import type { R2BucketLike } from '@commerceworker/adapters/blob-r2';
import type { ImagesBindingLike } from '@commerceworker/adapters/images-cf';
import type { WorkerLoaderBinding } from '@commerceworker/adapters/plugins-cf-loader';
import type { StreamBindingLike } from '@commerceworker/adapters/video-stream';
import type { CostGuardDO } from './do/cost-guard';
import type { LiveHubDO } from './do/live-hub';
import type { RateLimiterDO } from './do/rate-limiter';
import type { SearchShardDO } from './do/search-shard';

/** A native `ratelimit` binding (limits are declared in wrangler.jsonc, not env). */
export interface CfRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Bindings + vars for the Cloudflare deployment (documented in
 * docs/configuration.md); bindings are the Cloudflare-native resources that
 * replace URLs where one exists. Every binding is optional: absent bindings
 * select dev fallbacks (in-memory store, fake blob, stub AI, no cache), which
 * the fail-closed adapter guard refuses on a persistent deployment.
 */
export interface EdgeEnv {
  /** Binding-only identity directory for content hosted in the commerce admin. */
  readonly CONTENT_IDENTITY?: import('@commerceworker/ports').PeopleDirectory;
  /**
   * Worker Loader binding. Present only where sandboxed plugins are enabled;
   * absent means installed plugins are never executed, which is the safe
   * default rather than a fallback to running them unsandboxed.
   */
  readonly PLUGIN_LOADER?: WorkerLoaderBinding;
  // ---- Cloudflare bindings -------------------------------------------------
  /**
   * D1, the system of record. Absent → the seeded in-memory store (demo mode and the node
   * route tests), which the fail-closed adapter guard refuses on a persistent deployment.
   * Requests open a read-replica session on it (`withSession`), see wire.ts.
   */
  readonly DB?: D1Database;
  /** Producer side of the `commerceworker-events` queue (domain-event pipeline). */
  readonly EVENTS_QUEUE?: Queue;
  /**
   * Producer side of the `commerceworker-agents` queue. When bound, on-publish agent runs
   * are enqueued here (consumed one message at a time) instead of running
   * inline in the commerceworker-events consumer, so a batch of published entries never
   * has to fit N agent workflows inside one consumer invocation.
   */
  readonly AGENTS_QUEUE?: Queue;
  /**
   * Producer side of the `commerceworker-bulk` queue. When bound, `bulk.chunk_due`
   * control events route here instead of `commerceworker-events`, so a 100k-entry bulk
   * job's chunks drain on their own consumer without starving event delivery.
   */
  readonly BULK_QUEUE?: Queue;
  /**
   * Producer side of `commerceworker-purge`: delivery cache tags to purge (consumed, rationed, by
   * the delivery Worker). Absent → delivery responses age out on their max-age alone.
   */
  readonly PURGE_QUEUE?: Queue;
  /**
   * Producer side of `commerceworker-media-purge`: media cache tags to purge (consumed, rationed,
   * by the media Worker, whose Workers Caching only it can purge). Absent → a revoked asset's
   * cached media stays until the media Worker's own cache lets it go.
   */
  readonly MEDIA_PURGE_QUEUE?: Queue;
  /**
   * Producer side of `commerceworker-asset-events`, the queue R2's object-create notifications for
   * the media bucket land on: the api adds a message when an upload through its signed PUT
   * completes (local development has no notifications), and asks for re-ingest there. Absent →
   * uploads are ingested only from R2's notifications, and re-ingest answers 501.
   */
  readonly ASSET_EVENTS_QUEUE?: Queue;
  /**
   * Asset ingest runs (`AssetIngestWorkflow`, one instance per file version), started by the
   * engine's asset-events consumer. Absent → asset events are acknowledged and nothing is ingested.
   */
  readonly ASSET_INGEST_WF?: Workflow;
  /**
   * Zip downloads (`AssetZipWorkflow`, one instance per job), started by the engine's events
   * consumer from `asset_zip.requested`. Absent → a requested zip fails at once.
   */
  readonly ASSET_ZIP_WF?: Workflow;
  /**
   * R2 bucket holding asset bytes (native binding — no access keys). When
   * bound it is THE BlobStore: uploads and downloads go through this Worker's
   * signed `/media/*` route (see @commerceworker/adapters/blob-r2).
   */
  readonly MEDIA_BUCKET?: R2BucketLike;
  /**
   * Cloudflare Images binding. Executes resize/crop/format transforms over R2
   * bytes on `/media/*` GETs carrying transform params; absent → the original
   * bytes are served. The engine reads image dimensions with it (`info`) during ingest.
   */
  readonly IMAGES?: ImagesBindingLike;
  /**
   * Cloudflare Stream binding: video assets upload straight to Stream and play
   * back as HLS/DASH. Absent → video-asset routes answer 501.
   */
  readonly STREAM?: StreamBindingLike;
  /** Delivery cache (tag-versioned; see @commerceworker/adapters/cache-kv). */
  readonly KV_CACHE?: KVNamespace;
  /** Vectorize index for RAG/semantic search (bge-base-en-v1.5: 768 dims, cosine). */
  readonly VECTORIZE?: VectorizeIndex;
  /** Live Content API fan-out hub (one object per space:environment). */
  readonly LIVE_HUB?: DurableObjectNamespace<LiveHubDO>;
  /**
   * Lexical search index: FTS5 shards, `SEARCH_SHARDS` objects per space:environment. Absent →
   * the lexical leg falls back to the store's bounded substring scan.
   */
  readonly SEARCH?: DurableObjectNamespace<SearchShardDO>;
  /** Shards per space:environment (default 8). Changing it requires a reindex. */
  readonly SEARCH_SHARDS?: string;
  /**
   * The deployment's resource suffix (scripts/fleet.ts renders it; `""` for the base names). Queue
   * consumers route by queue name, and a deployment's queues are named `<base><suffix>`.
   */
  readonly QUEUE_SUFFIX?: string;
  /** `eu` or `fedramp`: Durable Objects are pinned there with D1 and R2 (see withJurisdiction). */
  readonly DATA_JURISDICTION?: string;
  /** Distributed failed-auth rate limiter (one object per client IP). */
  readonly AUTH_LIMITER?: DurableObjectNamespace<RateLimiterDO>;
  /**
   * Per-client request-rate limiters, one native `ratelimit` binding per cost
   * class (limits are declared in wrangler.jsonc, not env — see rate-limit.ts).
   * Absent → that class is unlimited.
   */
  readonly RATE_LIMIT_READ?: CfRateLimiter;
  readonly RATE_LIMIT_WRITE?: CfRateLimiter;
  readonly RATE_LIMIT_AI?: CfRateLimiter;
  /**
   * The media Worker's limit on share-link password attempts, per link and client address.
   * Absent → attempts are limited only by PBKDF2's cost.
   */
  readonly RATE_LIMIT_SHARE_UNLOCK?: CfRateLimiter;
  /** AI budget governor (one object per space). */
  readonly AI_BUDGET?: DurableObjectNamespace<CostGuardDO>;
  /**
   * The admin's assistant (`AssistantAgent`, one object per person, named for them). The api
   * forwards `/agents/assistant-agent/<person>` to it after checking the signed principal names
   * that person. Untyped here: the class lives in `@commerceworker/http`, above this package.
   * Absent → the api answers 404 there.
   */
  readonly ASSISTANT_AGENT?: DurableObjectNamespace;
  /** Agent workflows (enrich/moderate/curate/repurpose) on Cloudflare Workflows. */
  readonly AGENT_WF?: Workflow;
  /**
   * Editorial workflow runs (`EditorialWorkflow`, one instance per run generation). Absent →
   * workflow definitions still work, but starting/deciding/delivering/cancelling runs answers 501.
   */
  readonly EDITORIAL_WF?: Workflow;
  /**
   * Cloudflare Email Sending (`send_email` binding) for workflow `content.notify` nodes. Needs
   * EMAIL_FROM on an onboarded domain. Absent → notify nodes fail with "email sending is not
   * configured".
   */
  readonly EMAIL?: SendEmail;
  /** Static admin SPA assets (configured via wrangler `assets`). */
  readonly ASSETS?: Fetcher;
  /**
   * Workers Analytics Engine dataset for operational counters (outbox relays,
   * consumed events, dead letters). Absent → counters fall back to structured log lines.
   */
  readonly METRICS?: AnalyticsEngineDataset;

  // ---- Vars / secrets ---------------------------------------------------------
  readonly ROLE?: string;
  /**
   * Secret. Seals secrets stored in the database (webhook signing secrets and
   * header values) with AES-256-GCM. Required on persistent deployments unless
   * REQUIRE_SECURE_SECRETS=false; the same value on every Worker of a deployment.
   */
  readonly DATA_KEY?: string;
  /**
   * Secret, rotation only: the key DATA_KEY replaced. Opens values sealed under
   * it until the daily reseal sweep has moved them; unset it afterwards.
   */
  readonly DATA_KEY_PREVIOUS?: string;
  readonly ADMIN_TOKEN?: string;
  /**
   * One-time first-run / recovery setup code (secret). `/setup` redeems it to create an
   * administrator; its hash is recorded on use so it never works twice.
   */
  readonly SETUP_TOKEN?: string;
  readonly TOKEN_PEPPER?: string;
  readonly SESSION_SECRET?: string;
  /**
   * Secret shared with the web Worker: verifies its signed `x-cw-principal` header (the api, and
   * the engine's assistant, which checks the socket's principal itself).
   */
  readonly PRINCIPAL_KEY?: string;
  /** Rotation only: the key PRINCIPAL_KEY replaced, accepted until the web Worker has moved. */
  readonly PRINCIPAL_KEY_PREVIOUS?: string;
  /**
   * The engine's secret: the assistant's principal key, derived from PRINCIPAL_KEY with HKDF
   * (`deriveAssistantPrincipalKey`; CI derives it, `scripts/derive-assistant-key.ts`). It verifies
   * the principal the web Worker signs for the assistant's socket, and nothing else.
   */
  readonly ASSISTANT_PRINCIPAL_KEY?: string;
  /** Rotation only: derived from PRINCIPAL_KEY_PREVIOUS, accepted until the web Worker has moved. */
  readonly ASSISTANT_PRINCIPAL_KEY_PREVIOUS?: string;
  /** The media Worker's `/a/` route: the space and environment an `asset:` reference resolves in. */
  readonly ASSET_REF_SPACE?: string;
  readonly ASSET_REF_ENV?: string;
  readonly SEED_DEV?: string;
  readonly SEED_SPACE_ID?: string;
  readonly SEED_ENV_ID?: string;
  readonly SEED_DEFAULT_LOCALE?: string;
  readonly SEED_LOCALES?: string;
  /**
   * `true` offers the demo starters (the enterprise starter, installed in the background) when a
   * space is created: demo deployments and local dev. Unset or anything else: empty and sample.
   */
  readonly DEMO_STARTERS?: string;
  readonly AI_PROVIDER?: string;
  /**
   * Workers AI binding — required when AI_PROVIDER / EMBEDDINGS_PROVIDER is
   * `workers-ai` (the only Workers AI transport; no credentials needed).
   */
  readonly AI?: { run: WorkersAiRun; toMarkdown?: WorkersAiToMarkdown };
  /** `live` (default) or `mock` (every generateJson answers from its heuristic). */
  readonly AI_MODE?: string;
  /** Per-call cap for generateJson, ms (default 20000). */
  readonly AI_TIMEOUT_MS?: string;
  /** Cloudflare AI Gateway id: when set, Workers AI calls route through it (logs, caching, limits). */
  readonly AI_GATEWAY_ID?: string;
  /** `true`/`false`: whether AI Gateway keeps a log entry per call (never prompt or answer). */
  readonly AI_GATEWAY_LOGS?: string;
  readonly WORKERS_AI_MODEL_FLAGSHIP?: string;
  readonly WORKERS_AI_MODEL_BALANCED?: string;
  readonly WORKERS_AI_MODEL_FAST?: string;
  readonly EMBEDDINGS_PROVIDER?: string;
  readonly EMBEDDINGS_DIM?: string;
  readonly EMBEDDINGS_MODEL?: string;
  /**
   * Local dev only (Vectorize has no local emulator): `kv` keeps vectors in KV_CACHE, which every
   * Worker in a dev session shares; `memory` keeps them in one isolate. Both ignore VECTORIZE.
   */
  readonly VECTOR_STORE?: string;
  /**
   * Public origin of this Worker for signed `/media/*` URLs (e.g.
   * `https://api.example.com`). Empty → root-relative URLs (fine for the
   * same-origin admin; set it so delivery clients get absolute URLs).
   */
  readonly MEDIA_BASE_URL?: string;
  /**
   * Public origin of the media Worker (`https://media.<domain>`; scripts/fleet.ts renders it).
   * Delivered assets' URLs are built on it at read time, and Preview's signed draft URLs point
   * there. Empty → the api's signed `/media/*` URLs, without renditions or a srcset.
   */
  readonly MEDIA_PUBLIC_URL?: string;
  /**
   * Largest file a multipart upload takes, in bytes (default 5 GiB). One signed PUT still takes
   * at most 100 MiB; past that the admin and the SDK upload in parts.
   */
  readonly ASSET_UPLOAD_MAX_BYTES?: string;
  /** HMAC key signing `/media/*` URLs. Required on persistent deployments. */
  readonly MEDIA_SIGNING_SECRET?: string;
  /**
   * Origin of a zone with Image Transformations enabled, used to transform
   * images that are NOT served from MEDIA_BUCKET (`/cdn-cgi/image/...`).
   */
  readonly IMAGES_ZONE_ORIGIN?: string;
  /** Stream webhook signing secret; enables `POST /webhooks/stream`. */
  readonly STREAM_WEBHOOK_SECRET?: string;
  readonly MCP_TOKEN?: string;
  /** Sender address for the EMAIL binding (domain onboarded to Email Sending). */
  readonly EMAIL_FROM?: string;
  /** Optional sender display name for EMAIL_FROM. */
  readonly EMAIL_FROM_NAME?: string;
  /** Delivery cache entry TTL, seconds (GC bound; tag invalidation stays authoritative). */
  readonly DELIVERY_CACHE_TTL_SECONDS?: string;
  /** TTL for cached delivery LIST results, seconds (default 3600). */
  readonly DELIVERY_LIST_TTL_SECONDS?: string;
  /** Retention for relayed outbox rows + webhook delivery records, hours (default 168). */
  readonly EVENT_RETENTION_HOURS?: string;
  readonly AGENTS_ENRICH?: string;
  readonly AGENTS_MODERATE?: string;
  readonly AGENTS_AUTO_APPLY?: string;
  /** `true` runs recurring agent schedules from the cron trigger. */
  readonly AGENTS_SCHEDULES?: string;
  /**
   * `true` moves superseded entry version bodies to the media bucket from the cron trigger.
   * Off until every Worker in the ring reads archived bodies (0004_version_bodies).
   */
  readonly VERSION_ARCHIVE?: string;
  readonly AGENT_SCHEDULE_MAX_ENTRIES?: string;
  readonly AGENT_SCHEDULE_MAX_RUN_TOKENS?: string;
  readonly AGENT_RUNTIME?: string;
  readonly REQUIRE_SECURE_SECRETS?: string;
  /** Comma-separated fake-adapter allow list (ai,blob,embeddings,vectors | all). */
  readonly ALLOW_FAKE_ADAPTERS?: string;
  readonly AUTH_RATE_LIMIT_MAX?: string;
  readonly AUTH_RATE_LIMIT_WINDOW_MS?: string;
  readonly AI_MAX_REQUESTS_PER_WINDOW?: string;
  readonly AI_MAX_TOKENS_PER_WINDOW?: string;
  readonly AI_BUDGET_WINDOW_SECONDS?: string;
  /**
   * Separate ceilings for BACKGROUND agent spend (the `agent:` counter
   * windows); unset → the background windows enforce the interactive
   * ceilings. Same semantics as the application's agentBudgetLimits.
   * Leave genuinely unset — an empty-string var counts as configured.
   */
  readonly AI_AGENT_MAX_REQUESTS_PER_WINDOW?: string;
  readonly AI_AGENT_MAX_TOKENS_PER_WINDOW?: string;
  readonly AI_AGENT_BUDGET_WINDOW_SECONDS?: string;
}

/**
 * Compile-time proof that the real Cloudflare bindings satisfy the adapters'
 * structural types (the adapters import no Cloudflare types, so nothing else
 * would catch a drift in the platform's binding shapes).
 */
type Satisfies<T extends true> = T;
export type BindingShapeChecks = [
  Satisfies<R2Bucket extends R2BucketLike ? true : false>,
  Satisfies<ImagesBinding extends ImagesBindingLike ? true : false>,
  Satisfies<StreamBinding extends StreamBindingLike ? true : false>,
  Satisfies<KVNamespace extends KvGateBinding ? true : false>,
];

/** Durable Object namespaces an EdgeEnv may carry. */
const DO_BINDINGS = ['LIVE_HUB', 'AUTH_LIMITER', 'AI_BUDGET', 'SEARCH', 'ASSISTANT_AGENT'] as const;
const pinned = new WeakSet<object>();

/**
 * The env with every Durable Object namespace pinned to the deployment's data jurisdiction
 * (`DATA_JURISDICTION`: `eu` or `fedramp`, rendered by scripts/fleet.ts for a deployment whose
 * D1 and R2 live there), so objects are created and found only inside it, as its data is. Without
 * a jurisdiction it is the env unchanged. Idempotent: every Worker entry point and `wireEdge` call
 * it, and only the first pins.
 */
export function withJurisdiction(env: EdgeEnv): EdgeEnv {
  const j = env.DATA_JURISDICTION;
  if (!j || pinned.has(env)) return env;
  const out: Record<string, unknown> = { ...env };
  for (const name of DO_BINDINGS) {
    const ns = env[name] as DurableObjectNamespace | undefined;
    if (ns) out[name] = ns.jurisdiction(j as DurableObjectJurisdiction);
  }
  pinned.add(out);
  return out as unknown as EdgeEnv;
}

/** The deployment's name for a base queue name (`commerceworker-agents` → `…-agents<suffix>`). */
export const queueName = (env: EdgeEnv, base: string): string => `${base}${env.QUEUE_SUFFIX ?? ''}`;
