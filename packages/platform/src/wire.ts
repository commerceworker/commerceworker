import {
  createWorkersAIDecisionModel,
  createWorkersAIEmbeddings,
  createWorkersAIProvider,
  createWorkersAITextExtractor,
  type WorkersAiRun,
  workersAiModelsFromEnv,
} from '@commerceworker/adapters/ai-workers';
import { createKvAssetGate } from '@commerceworker/adapters/asset-gate-kv';
import {
  createMediaPathSigner,
  createMediaUrlSigner,
  createR2BlobStore,
  type MediaUrlSigner,
} from '@commerceworker/adapters/blob-r2';
import { createKvCache } from '@commerceworker/adapters/cache-kv';
import { createCfEmailSender } from '@commerceworker/adapters/email-cf';
import { createRemoteFetcher, createWebhookSender } from '@commerceworker/adapters/http-effects';
import { createCfImageProbe, createCfImageTransformer } from '@commerceworker/adapters/images-cf';
import { createSpaceExportReader } from '@commerceworker/adapters/import-space-export';
import { createWorkerLoaderRuntime } from '@commerceworker/adapters/plugins-cf-loader';
import { createAssetIngestQueue, createCfQueueProducer } from '@commerceworker/adapters/queue-cf';
import { createKvDevVectorStore } from '@commerceworker/adapters/vector-kv-dev';
import { createVectorizeStore } from '@commerceworker/adapters/vector-vectorize';
import { createStreamVideoHost } from '@commerceworker/adapters/video-stream';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AgentRunner,
  type AppContext,
  type AssetIngestDeps,
  type AssetSearchDeps,
  aiCallLevel,
  aiModeFakes,
  aiRuntimeConfig,
  assertNoFakeAdapters,
  assetSearchDeps,
  BULK_TOPIC,
  createHasher,
  createPluginHookDispatcher,
  EVENTS_TOPIC,
  type FakeAdapterBinding,
  type PublishAgentsConfig,
  type RagDeps,
  recordPluginCapabilityDenial,
  type WorkflowNodeDeps,
  withSealedSecrets,
} from '@commerceworker/application';
import { type ApiKeyKind, type OutboxEntry, scopesForKind } from '@commerceworker/domain';
import type {
  AIProvider,
  AssetGate,
  AssetIngestQueue,
  AssetIngestStarter,
  AssetZipStarter,
  BlobStore,
  Cache,
  ContentStore,
  DecisionModel,
  EmailSender,
  EmbeddingsProvider,
  EventBus,
  GenerateRequest,
  IdGenerator,
  MediaPathSigner,
  PasswordHasher,
  Queue as QueuePort,
  RemoteFetcher,
  SecretSealer,
  SpaceExportReader,
  TextExtractor,
  VectorStore,
  WorkflowEngine,
} from '@commerceworker/ports';
import { pbkdf2PasswordHasher } from '@commerceworker/security/credentials';
import { createD1Store } from '@commerceworker/store';
import {
  FakeBlobStore,
  InMemoryContentStore,
  InMemoryEventBus,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  StubAIProvider,
  StubDecisionModel,
} from '@commerceworker/test-kit';
import { CloudflareAssetIngestStarter } from './asset-ingest';
import { CloudflareAssetZipStarter } from './asset-zip';
import { type ApiConfig, loadConfig } from './config';
import { sealerFromEnv } from './data-key';
import { doCostGuardFromEnv } from './do/cost-guard';
import { createShardedSearchIndex, DEFAULT_SEARCH_SHARDS } from './do/search-shard';
import { type EdgeEnv, withJurisdiction } from './env';
import { newId } from './ids';
import { CloudflareWorkflowEngine, CloudflareWorkflowsAgentRuntime } from './workflows';

const clock = { now: () => new Date() };
// UUIDv7 (time-ordered) — consistent with the rest of the platform's PKs.
const ids: IdGenerator = { newId };

export interface EdgeWired {
  readonly ctx: AppContext;
  readonly config: ApiConfig;
  readonly rag: RagDeps;
  /**
   * Asset search's indexes, the one place that decides whether queries and documents are
   * embedded: only with EMBEDDINGS_PROVIDER set, never the dev fallback, so a query is embedded
   * by the model the index was written with. Management, Delivery, MCP, the engine and ingest
   * all read it.
   */
  readonly assetSearch: AssetSearchDeps;
  readonly blob: BlobStore;
  /** Signs/verifies `/media/*` URLs; present when MEDIA_BUCKET is bound. */
  readonly mediaSigner?: MediaUrlSigner;
  /**
   * The media origin's published-asset gate (KV_CACHE). Only the engine writes it, from asset
   * events; the media Worker reads it.
   */
  readonly assetGate?: AssetGate;
  /** Hands files to ingest (the asset-events queue); absent when ASSET_EVENTS_QUEUE is unbound. */
  readonly assetIngest?: AssetIngestQueue;
  /** Starts ingest runs (the engine's ASSET_INGEST_WF); absent elsewhere. */
  readonly assetIngestStarter?: AssetIngestStarter;
  /** Starts zip builds (the engine's ASSET_ZIP_WF); absent elsewhere. */
  readonly assetZipStarter?: AssetZipStarter;
  readonly ai: AIProvider;
  /** Decision model (Clef on Workers AI): typed questions in, probabilities out. */
  readonly decisions: DecisionModel;
  readonly bus: EventBus;
  readonly cache?: Cache;
  /** Producer onto the commerceworker-events queue; absent when the binding is not set. */
  readonly queue?: QueuePort;
  /** Relay topic router; set only when the deployment lacks a commerceworker-bulk queue
   *  (falls everything back to the events topic). */
  readonly routeTopic?: (event: OutboxEntry) => string;
  /**
   * Starts/signals/cancels editorial workflow runs on the EDITORIAL_WF binding; absent when the
   * binding is not set (run actions then answer 501).
   */
  readonly workflowEngine?: WorkflowEngine;
  /** The AI, email and webhook ports workflow nodes use (and cancel's compensations). */
  readonly workflowNodes: WorkflowNodeDeps;
  /** Bounded, redirect-refusing outbound GETs, for callers outside the HTTP app (MCP's embed_resolve,
   *  the engine's copies of a space export's asset files). */
  readonly remoteFetcher: RemoteFetcher;
  /** Reads the JSON space export format, for MCP's space export tools. A pure parser. */
  readonly spaceExportReader: SpaceExportReader;
  /** True when backed by D1 vs the in-memory demo store. */
  readonly persistent: boolean;
  /**
   * The D1 Sessions API bookmark after this invocation's queries: hand it back to the caller
   * (`x-cw-bookmark`) so its next request reads at least this fresh, even from a replica.
   * Undefined on the in-memory store.
   */
  bookmark(): string | undefined;
  /** Seals secrets at rest under DATA_KEY; the reseal sweep needs it directly. */
  readonly sealer: SecretSealer;
  /** Releases per-invocation resources. D1 holds none; kept so callers stay uniform. */
  close(): Promise<void>;
}

/**
 * Composition root for the Cloudflare deployment: D1 (read-replica sessions), KV cache, Queues,
 * Vectorize, R2, Images, Stream, Workers AI, Worker Loader. Called once per request / queue batch
 * / cron tick; it opens nothing expensive (D1 is a binding, not a connection), so per-invocation
 * wiring is cheap. The in-memory fallback is memoized at module scope so demo-mode data survives
 * across requests within an isolate.
 */
export interface EdgeWireOptions {
  /**
   * D1 Sessions API constraint for this invocation's reads: a bookmark the caller got back from
   * an earlier write (read-your-writes from any replica), `first-unconstrained` (any replica,
   * cheapest), or `first-primary` (default: the primary, for request paths that write).
   */
  readonly bookmark?: string;
}

export function wireEdge(rawEnv: EdgeEnv, options: EdgeWireOptions = {}): EdgeWired {
  const env = withJurisdiction(rawEnv);
  const config = loadConfig(env as unknown as NodeJS.ProcessEnv);
  const cache = env.KV_CACHE ? createKvCache(env.KV_CACHE) : undefined;
  const queue = env.EVENTS_QUEUE
    ? createCfQueueProducer({
        [EVENTS_TOPIC]: env.EVENTS_QUEUE,
        ...(env.BULK_QUEUE ? { [BULK_TOPIC]: env.BULK_QUEUE } : {}),
      })
    : undefined;
  // Without a commerceworker-bulk binding, chunk_due events fall back to the events topic
  // (single-queue deployments still work; the consumer handles both).
  const routeTopic = env.BULK_QUEUE ? undefined : () => EVENTS_TOPIC;

  const persistent = Boolean(env.DB);
  // Secrets at rest: fails closed (throws) on a persistent deployment without DATA_KEY.
  const sealer = sealerFromEnv(env, persistent);
  // Fail fast when a persistent (D1-backed) deployment would run
  // behind dev fakes.
  const fakes: FakeAdapterBinding[] = [];
  const rag = makeRag(env, fakes);
  const mediaSigner = env.MEDIA_BUCKET
    ? createMediaUrlSigner(mediaSigningSecret(env, persistent))
    : undefined;
  const blob = makeBlob(env, fakes, mediaSigner);
  const session = env.DB?.withSession(options.bookmark ?? 'first-primary');
  const store: ContentStore = withSealedSecrets(
    // Archived version bodies live in the media bucket (version-archive.ts).
    session ? createD1Store(session, { versionBodies: blob }) : inMemoryStore(config),
    sealer,
  );
  const ai = makeAI(env, fakes);
  const decisions = makeDecisions(env, fakes);
  const aiContext = aiContextFromEnv(env, fakes);
  assertNoFakeAdapters({
    persistent,
    allowFakeAdapters: env.ALLOW_FAKE_ADAPTERS,
    fakes,
  });
  // Meter AI spend per space via the CostGuard Durable Object (shared across
  // isolates/colos). Absent binding or 0-ceilings → unmetered (demo/dev).
  const costGuard = doCostGuardFromEnv(env);
  const posNum = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const ttlRaw = Number(env.DELIVERY_CACHE_TTL_SECONDS);
  const baseCtx: AppContext = {
    store,
    clock,
    ids,
    cache,
    decisions,
    ...(Number.isFinite(ttlRaw) && ttlRaw > 0 ? { deliveryCacheTtlSeconds: ttlRaw } : {}),
    ...(posNum(env.DELIVERY_LIST_TTL_SECONDS) !== undefined
      ? { deliveryListTtlSeconds: posNum(env.DELIVERY_LIST_TTL_SECONDS) as number }
      : {}),
    costGuard,
    ai: aiContext,
    // A local stack (no D1, or REQUIRE_SECURE_SECRETS=false, as `pnpm dev` sets) may preview on a
    // plain-http dev server; a deployment, whose templates require secure secrets, never.
    ...(!persistent || env.REQUIRE_SECURE_SECRETS === 'false' ? { previewLoopback: true } : {}),
    // Cloudflare Images: signed /media transform URLs over R2 bytes (executed
    // by the IMAGES binding in the /media route), /cdn-cgi/image for others.
    ...(mediaSigner
      ? {
          images: createCfImageTransformer({
            signer: mediaSigner,
            zoneOrigin: env.IMAGES_ZONE_ORIGIN || undefined,
          }),
        }
      : {}),
    ...(env.STREAM ? { video: createStreamVideoHost(env.STREAM) } : {}),
    passwords,
    ...(posNum(env.ASSET_UPLOAD_MAX_BYTES) !== undefined
      ? { maxUploadBytes: posNum(env.ASSET_UPLOAD_MAX_BYTES) as number }
      : {}),
    ...(env.MEDIA_PUBLIC_URL
      ? {
          mediaPublicUrl: env.MEDIA_PUBLIC_URL.replace(/\/$/, ''),
          // The same key the media Worker checks published paths with.
          mediaPaths: createMediaPathSigner(mediaSigningSecret(env, persistent)),
        }
      : {}),
  };

  const ctx: AppContext = env.PLUGIN_LOADER
    ? {
        ...baseCtx,
        // Built over `baseCtx`, which has no hooks: a plugin's own capability
        // calls therefore cannot re-enter the plugin chain.
        hooks: createPluginHookDispatcher(
          baseCtx,
          blob,
          createWorkerLoaderRuntime(env.PLUGIN_LOADER, {
            onError: (message, detail) => console.error(message, { detail: String(detail) }),
            // A plugin reaching outside its grant: logged, and put on the
            // space's audit trail so an operator sees it, not just the plugin.
            onDenied: async (denial) => {
              console.warn('plugin capability denied', denial);
              await recordPluginCapabilityDenial(baseCtx, denial);
            },
          }),
          {
            // No principal override: each plugin acts as exactly the scopes its
            // approved capabilities imply.
            onError: (message, detail) => console.error(message, { detail: String(detail) }),
            // Backs `network:request`. The isolate itself has no network, so
            // this is the only way out and it checks the allowlist first.
            fetcher: createRemoteFetcher(),
          },
        ),
      }
    : // No Worker Loader means no isolate to run plugins in, so the hook seam
      // stays unwired: installed plugins simply do not execute. Running
      // untrusted code in the host isolate is not an available fallback.
      baseCtx;

  const email = makeEmail(env);
  const workflowEngine = makeWorkflowEngine(env);
  return {
    ctx,
    config,
    rag,
    assetSearch: assetSearchDeps(rag, { embed: Boolean(env.EMBEDDINGS_PROVIDER) }),
    ...(workflowEngine ? { workflowEngine } : {}),
    remoteFetcher: createRemoteFetcher(),
    spaceExportReader: createSpaceExportReader(),
    workflowNodes: {
      ai,
      decisions,
      webhooks: createWebhookSender(),
      ...(email ? { email } : {}),
    },
    blob,
    ...(mediaSigner ? { mediaSigner } : {}),
    ...(env.KV_CACHE ? { assetGate: createKvAssetGate(env.KV_CACHE) } : {}),
    ...(env.ASSET_EVENTS_QUEUE
      ? { assetIngest: createAssetIngestQueue(env.ASSET_EVENTS_QUEUE) }
      : {}),
    ...(env.ASSET_INGEST_WF
      ? { assetIngestStarter: new CloudflareAssetIngestStarter(env.ASSET_INGEST_WF) }
      : {}),
    ...(env.ASSET_ZIP_WF
      ? { assetZipStarter: new CloudflareAssetZipStarter(env.ASSET_ZIP_WF) }
      : {}),
    ai,
    decisions,
    bus: new InMemoryEventBus(),
    cache,
    queue,
    ...(routeTopic ? { routeTopic } : {}),
    persistent,
    sealer,
    bookmark: () => session?.getBookmark() ?? undefined,
    close: async () => {},
  };
}

/** Share-link passwords: PBKDF2-SHA256, the admin's own scheme (no pepper: the api has none). */
export const passwords: PasswordHasher = pbkdf2PasswordHasher;

/** What the media Worker reads with, all of it read-only. */
export interface MediaWired {
  /**
   * Through a read-replica session: the gate's fallback, the rendition presets, and the share
   * links, collections and space locales a share page reads.
   */
  readonly store?: Pick<
    ContentStore,
    'assets' | 'assetRenditions' | 'assetShareLinks' | 'assetCollections' | 'spaces'
  >;
  /** The engine's published-asset gate (KV_CACHE). */
  readonly assetGate?: AssetGate;
  /** Checks a share link's password. */
  readonly passwords: PasswordHasher;
  /** Checks the token in a published asset's path. */
  readonly mediaPaths: MediaPathSigner;
  /** Checks Preview's short-lived signed `/media/*` reads. */
  readonly mediaSigner: MediaUrlSigner;
}

/**
 * The media Worker's composition root. Not {@link wireEdge}: the media Worker holds one secret
 * (MEDIA_SIGNING_SECRET) and no AI, queue producer or DATA_KEY, and it never writes, so it binds
 * only the ports it reads. Like wireEdge, a persistent deployment (DB bound) refuses the dev key.
 */
export function wireMedia(rawEnv: EdgeEnv, options: EdgeWireOptions = {}): MediaWired {
  const env = withJurisdiction(rawEnv);
  const secret = mediaSigningSecret(env, Boolean(env.DB));
  const session = env.DB?.withSession(options.bookmark ?? 'first-unconstrained');
  return {
    ...(session ? { store: createD1Store(session) } : {}),
    ...(env.KV_CACHE ? { assetGate: createKvAssetGate(env.KV_CACHE) } : {}),
    passwords,
    mediaPaths: createMediaPathSigner(secret),
    mediaSigner: createMediaUrlSigner(secret),
  };
}

/**
 * What an ingest run uses, from a wired invocation: the bytes (R2), the Images binding's `info`
 * for dimensions, Workers AI's Markdown conversion and Whisper for text, the generation model for
 * alt text and tags, and the asset search indexes (`wired.assetSearch`).
 */
export function makeAssetIngestDeps(env: EdgeEnv, wired: EdgeWired): AssetIngestDeps {
  const extractor = makeTextExtractor(env, wired.ctx);
  return {
    blob: wired.blob,
    ai: wired.ai,
    ...(env.IMAGES ? { images: createCfImageProbe(env.IMAGES) } : {}),
    ...(extractor ? { extractor } : {}),
    search: wired.assetSearch,
  };
}

/**
 * Text extraction on Workers AI, when the AI binding (with Markdown conversion) is there. None
 * under AI_MODE=mock, which never calls a model: documents and recordings are then not read.
 */
export function makeTextExtractor(
  env: EdgeEnv,
  ctx: Pick<AppContext, 'ai'>,
): TextExtractor | undefined {
  if (ctx.ai?.mode === 'mock' || !env.AI?.toMarkdown) return undefined;
  return createWorkersAITextExtractor({
    toMarkdown: env.AI.toMarkdown.bind(env.AI),
    run: env.AI.run.bind(env.AI),
    gatewayId: env.AI_GATEWAY_ID || undefined,
    ...gatewayLogs(env),
  });
}

/** The editorial workflow engine over the EDITORIAL_WF binding, when bound. */
export function makeWorkflowEngine(env: EdgeEnv): WorkflowEngine | undefined {
  return env.EDITORIAL_WF ? new CloudflareWorkflowEngine(env.EDITORIAL_WF) : undefined;
}

/**
 * Cloudflare Email Sending over the `send_email` binding (EMAIL) from EMAIL_FROM. Unbound means no
 * sender, and `content.notify` nodes fail with "email sending is not configured". A bound EMAIL
 * without EMAIL_FROM is a configuration error, refused here rather than at the first send.
 */
export function makeEmail(env: EdgeEnv): EmailSender | undefined {
  if (!env.EMAIL) return undefined;
  if (!env.EMAIL_FROM) {
    throw new Error(
      'The EMAIL send_email binding is set but EMAIL_FROM is not; set it to an address on a domain onboarded to Email Sending',
    );
  }
  return createCfEmailSender(env.EMAIL, {
    from: env.EMAIL_FROM,
    ...(env.EMAIL_FROM_NAME ? { fromName: env.EMAIL_FROM_NAME } : {}),
  });
}

/** On-publish agent configuration (used by the queue consumer). */
export function agentConfigFromEnv(env: EdgeEnv): PublishAgentsConfig {
  return {
    enrich: env.AGENTS_ENRICH === 'true',
    moderate: env.AGENTS_MODERATE === 'true',
    autoApply: env.AGENTS_AUTO_APPLY === 'true',
  };
}

/**
 * Agent runtime for on-publish runs: Cloudflare Workflows when selected
 * (durable), else in-process (non-durable; dev/demo and tests).
 */
export function makeAgents(env: EdgeEnv, ctx: AppContext, ai: AIProvider): AgentRunner | undefined {
  const cfg = agentConfigFromEnv(env);
  // Schedules need a runner even when no on-publish agent is enabled.
  if (!cfg.enrich && !cfg.moderate && env.AGENTS_SCHEDULES !== 'true') return undefined;
  if (env.AGENT_RUNTIME === 'cloudflare-workflows' && env.AGENT_WF) {
    return new CloudflareWorkflowsAgentRuntime(env.AGENT_WF, ids);
  }
  return new InProcessAgentRuntime(makeActivities({ ctx, ai }));
}

/**
 * How `generateJson` calls the model (AI_MODE / AI_TIMEOUT_MS), with one
 * structured log line per call (the telemetry shim's console JSON on Workers).
 * AI_MODE=mock is recorded as an `ai` fake, so a persistent deployment refuses
 * it unless ALLOW_FAKE_ADAPTERS says otherwise.
 */
export function aiContextFromEnv(
  env: EdgeEnv,
  fakes?: FakeAdapterBinding[],
): NonNullable<AppContext['ai']> {
  const config = aiRuntimeConfig(env as unknown as Record<string, string | undefined>);
  fakes?.push(...aiModeFakes(config));
  return {
    ...config,
    log: (record) => {
      const line = JSON.stringify(record);
      if (aiCallLevel(record) === 'warn') console.warn(line);
      else console.log(line);
    },
  };
}

/** The Workers `AI` binding's `run`, required when AI_PROVIDER / EMBEDDINGS_PROVIDER is workers-ai. */
function workersAiRun(env: EdgeEnv): WorkersAiRun {
  if (!env.AI) {
    throw new Error(
      'workers-ai selected but the AI binding is missing — add "ai": { "binding": "AI" } to this wrangler env',
    );
  }
  return env.AI.run.bind(env.AI);
}

/**
 * The AI provider: Workers AI (through AI Gateway when AI_GATEWAY_ID is set), or the stub
 * placeholder provider when AI_PROVIDER is unset, which the fake-adapter guard refuses on a
 * persistent deployment.
 */
export function makeAI(env: EdgeEnv, fakes?: FakeAdapterBinding[]): AIProvider {
  if (env.AI_PROVIDER === 'workers-ai' || (env.AI_PROVIDER === undefined && env.AI)) {
    return createWorkersAIProvider({
      run: workersAiRun(env),
      models: workersAiModelsFromEnv(env as unknown as Record<string, string | undefined>),
      gatewayId: env.AI_GATEWAY_ID || undefined,
      ...gatewayLogs(env),
    });
  }
  fakes?.push({
    key: 'ai',
    detail: 'StubAIProvider (placeholder generations) — bind AI and set AI_PROVIDER=workers-ai',
  });
  return new StubAIProvider(devGenerate);
}

/**
 * The decision model: Clef on Workers AI wherever the AI binding is (it shares the binding and
 * the AI Gateway settings with generation). Without one, a stub that answers the first option,
 * no, or the lowest level — refused on a persistent deployment like the other fakes.
 */
export function makeDecisions(env: EdgeEnv, fakes?: FakeAdapterBinding[]): DecisionModel {
  if (env.AI_PROVIDER === 'workers-ai' || (env.AI_PROVIDER === undefined && env.AI)) {
    return createWorkersAIDecisionModel({
      run: workersAiRun(env),
      gatewayId: env.AI_GATEWAY_ID || undefined,
      ...gatewayLogs(env),
    });
  }
  fakes?.push({
    key: 'decisions',
    detail: 'StubDecisionModel (placeholder decisions) — bind AI and set AI_PROVIDER=workers-ai',
  });
  return new StubDecisionModel();
}

/** Placeholder generation from the requested JSON schema (dev/no-key fallback). */
function devGenerate(req: GenerateRequest): unknown {
  const props =
    (req.outputSchema as { properties?: Record<string, { type?: string; description?: string }> })
      ?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (def.type === 'integer' || def.type === 'number') out[key] = 0;
    else if (def.type === 'boolean') out[key] = false;
    else if (/ISO-8601|date/i.test(def.description ?? '')) out[key] = '2024-01-01';
    else out[key] = `Sample ${def.description ?? key}`;
  }
  return out;
}

/** Dev-only signing key; refused on persistent deployments (see below). */
const DEV_MEDIA_SIGNING_SECRET = 'dev-media-signing-secret';

/**
 * The `/media/*` HMAC key. A persistent deployment must set its own: with the
 * dev key anyone could mint upload URLs into the bucket.
 */
function mediaSigningSecret(env: EdgeEnv, persistent: boolean): string {
  if (env.MEDIA_SIGNING_SECRET) return env.MEDIA_SIGNING_SECRET;
  if (persistent && env.REQUIRE_SECURE_SECRETS !== 'false') {
    throw new Error(
      'MEDIA_BUCKET is bound but MEDIA_SIGNING_SECRET is unset (wrangler secret put MEDIA_SIGNING_SECRET)',
    );
  }
  return DEV_MEDIA_SIGNING_SECRET;
}

/**
 * Blob storage: the native R2 binding (MEDIA_BUCKET). Uploads and downloads go through the signed
 * /media route; unbound means the fake blob store, refused on a persistent deployment.
 */
function makeBlob(
  env: EdgeEnv,
  fakes: FakeAdapterBinding[],
  mediaSigner: MediaUrlSigner | undefined,
): BlobStore {
  if (env.MEDIA_BUCKET && mediaSigner) {
    return createR2BlobStore(env.MEDIA_BUCKET, {
      signer: mediaSigner,
      baseUrl: env.MEDIA_BASE_URL || undefined,
    });
  }
  fakes.push({
    key: 'blob',
    detail:
      'FakeBlobStore (uploads are lost) — bind MEDIA_BUCKET (R2) and set MEDIA_SIGNING_SECRET',
  });
  return new FakeBlobStore();
}

/**
 * Embeddings on Workers AI (bge-base-en-v1.5 by default) and vectors on Vectorize. Unbound means
 * hash embeddings and an in-memory vector store (dev only; refused on a persistent deployment
 * unless EMBEDDINGS_PROVIDER=local states the choice). The lexical search leg is not wired here:
 * it is the SearchShard index the engine maintains.
 */
function makeRag(env: EdgeEnv, fakes: FakeAdapterBinding[]): RagDeps {
  const provider = env.EMBEDDINGS_PROVIDER ?? (env.AI ? 'workers-ai' : undefined);
  const dim = Number(env.EMBEDDINGS_DIM ?? 768);
  if (provider !== 'workers-ai' && provider !== 'local') {
    fakes.push({
      key: 'embeddings',
      detail:
        'hash-based embeddings (semantic search returns noise) — bind AI (EMBEDDINGS_PROVIDER=workers-ai), or set EMBEDDINGS_PROVIDER=local to accept explicitly',
    });
  }
  const embeddings: EmbeddingsProvider =
    provider === 'workers-ai'
      ? createWorkersAIEmbeddings({
          run: workersAiRun(env),
          gatewayId: env.AI_GATEWAY_ID || undefined,
          ...gatewayLogs(env),
          model: env.EMBEDDINGS_MODEL,
          dimensions: dim,
        })
      : new LocalEmbeddingsProvider(dim);
  // Local dev: Vectorize has no local emulator, so `VECTOR_STORE=kv` (the local stack) or `memory`
  // keeps the binding declared but unused. `kv` is the one that works across Workers: the engine
  // embeds and the api searches the same local KV, where an in-memory store would split them.
  // A persistent deployment still refuses either fake (guard below).
  const devKv = env.VECTOR_STORE === 'kv' ? env.KV_CACHE : undefined;
  const vectorize =
    env.VECTOR_STORE === 'memory' || env.VECTOR_STORE === 'kv' ? undefined : env.VECTORIZE;
  if (!vectorize) {
    fakes.push({
      key: 'vectors',
      detail: devKv
        ? 'KV-backed brute-force vector store (local dev only) — bind VECTORIZE'
        : 'in-memory vector store (per-isolate, non-durable) — bind VECTORIZE',
    });
  }
  const vectors: VectorStore = vectorize
    ? createVectorizeStore(vectorize, {
        dimensions: embeddings.dimensions,
        modelId: embeddings.modelId,
      })
    : devKv
      ? createKvDevVectorStore(devKv)
      : memoInMemoryVectors();
  const shards = Number(env.SEARCH_SHARDS) || DEFAULT_SEARCH_SHARDS;
  const searchIndex = env.SEARCH ? createShardedSearchIndex(env.SEARCH, shards) : undefined;
  // Assets in shards of their own, the library's and the published ones' apart (same class, no
  // new Durable Object or tag).
  const assetSearchIndex = env.SEARCH
    ? createShardedSearchIndex(env.SEARCH, shards, 'assets')
    : undefined;
  const publishedAssetSearchIndex = env.SEARCH
    ? createShardedSearchIndex(env.SEARCH, shards, 'published-assets')
    : undefined;
  return {
    embeddings,
    vectors,
    ...(searchIndex ? { searchIndex } : {}),
    ...(assetSearchIndex ? { assetSearchIndex } : {}),
    ...(publishedAssetSearchIndex ? { publishedAssetSearchIndex } : {}),
  };
}

// ---- module-scope memoization for demo mode --------------------------------
// Workers isolates persist across requests; keeping the in-memory store at
// module scope makes no-database demo deployments behave like a dev
// server (create → read works across requests within an isolate).

let memoStore: InMemoryContentStore | undefined;
let memoVectors: InMemoryVectorStore | undefined;

function memoInMemoryVectors(): InMemoryVectorStore {
  memoVectors ??= new InMemoryVectorStore();
  return memoVectors;
}

function inMemoryStore(config: ApiConfig): ContentStore {
  if (memoStore) return memoStore as unknown as ContentStore;
  const store = new InMemoryContentStore();
  store.seedSpace({
    spaceId: config.seed.spaceId,
    defaultLocale: config.seed.defaultLocale,
    locales: config.seed.locales,
  });
  const hasher = createHasher(config.tokenPepper);
  const tokens: Record<ApiKeyKind, string> = {
    cma: config.cmaKey,
    cda: config.cdaKey,
    cpa: config.cpaKey,
  };
  for (const [kind, token] of Object.entries(tokens) as [ApiKeyKind, string][]) {
    store.seedApiKey({
      id: ids.newId(),
      spaceId: config.seed.spaceId,
      kind,
      name: `dev-${kind}`,
      hashedToken: hasher.hash(token),
      scopes: scopesForKind(kind),
      revoked: false,
    });
  }
  memoStore = store;
  return store as unknown as ContentStore;
}

/** AI_GATEWAY_LOGS as the adapter's collectLogs: unset leaves the gateway's own setting. */
function gatewayLogs(env: EdgeEnv): { collectLogs?: boolean } {
  return env.AI_GATEWAY_LOGS === undefined || env.AI_GATEWAY_LOGS === ''
    ? {}
    : { collectLogs: env.AI_GATEWAY_LOGS === 'true' };
}
