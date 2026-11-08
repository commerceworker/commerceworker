import { type Principal, principalActorId } from '@commerceworker/domain';
import type {
  Cache,
  Clock,
  ContentStore,
  CostGuard,
  DecisionModel,
  HookDispatcher,
  IdGenerator,
  ImageTransformer,
  MediaPathSigner,
  PasswordHasher,
  VideoHost,
} from '@commerceworker/ports';
import type { AiCallRecord } from './ai-provenance';
import type { ChangeLog } from './change-log';

/** `live` calls the model; `mock` answers every `generateJson` from its heuristic. */
export type AiMode = 'live' | 'mock';

/**
 * The dependencies every use-case needs. Built once at the composition root
 * (`wireEdge` in packages/platform/src/wire.ts) by binding concrete adapters to the ports.
 */
export interface AppContext {
  readonly store: ContentStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Who the writes made through this context are by: stamped on entries as their authorship
   * (`createdBy`, `updatedBy`, a version's `createdBy`). Never set at the composition root; each
   * surface derives a context for the work it runs (`actingAs` per HTTP request and MCP session,
   * `withActor` for an agent, a workflow node, a job or the scheduler). Absent → unattributed (null).
   */
  readonly actor?: string;
  /**
   * Where this request's entry saves note what they changed, for its audit row. Like `actor`, never
   * set at the composition root: a surface that writes an audit row sets one per request. Absent →
   * nothing is collected and no diff runs (a queue consumer, a seed, a plugin's capability call).
   */
  readonly changes?: ChangeLog;
  /** Optional delivery cache; when absent, reads go straight to the store. */
  readonly cache?: Cache;
  /**
   * TTL for delivery cache entries, seconds. A garbage-collection bound only —
   * tag-version invalidation stays the correctness mechanism — so backends
   * don't accumulate every render ever produced. Default 86400 (1 day).
   */
  readonly deliveryCacheTtlSeconds?: number;
  /**
   * TTL for cached LIST results, seconds. Shorter than the single-entry TTL:
   * lists are invalidated by coarse content-type tags, so the TTL is the
   * backstop for the cases those tags over- or under-cover. Default 3600.
   */
  readonly deliveryListTtlSeconds?: number;
  /**
   * Whether a content type's preview URL may be plain http to localhost or 127.0.0.1: a local
   * stack only (no D1 bound, or REQUIRE_SECURE_SECRETS=false). Absent, https only, so a deployed
   * space never sends preview tokens over cleartext.
   */
  readonly previewLoopback?: boolean;
  /** Optional per-space AI budget governor; when absent, AI calls are unmetered. */
  readonly costGuard?: CostGuard;
  /**
   * Decision model (Clef on Workers AI): AI work that chooses among answers (moderation, picking
   * tags) asks it rather than a generative model. Absent → those use-cases ask the generative
   * model for JSON instead.
   */
  readonly decisions?: DecisionModel;
  /**
   * How `generateJson` calls the model: `mock` answers from the deterministic
   * heuristic without calling it (AI_MODE), `timeoutMs` caps each call
   * (AI_TIMEOUT_MS, default 20 000), and `log` receives one record per call
   * (composition roots bind it to the telemetry logger). Absent → live, 20 s,
   * no call log.
   */
  readonly ai?: {
    readonly mode: AiMode;
    readonly timeoutMs: number;
    readonly log?: (record: AiCallRecord) => void;
  };
  /**
   * Optional synchronous hooks on the write path. Absent — the default — means
   * the write path is untouched, not that an empty dispatch runs.
   */
  readonly hooks?: HookDispatcher;
  /**
   * Image transformation service (Cloudflare Images on edge). Absent → the
   * built-in query-param URL convention (`?w=&h=&fit=&fm=&q=`), which an
   * imgix-compatible CDN in front of the blob store can serve.
   */
  readonly images?: ImageTransformer;
  /**
   * Public origin of the media Worker (`https://media.<domain>`, MEDIA_PUBLIC_URL). Delivered
   * assets get their URLs there, built at read time. Absent → the stored file URL, without
   * renditions or a srcset (nothing would serve them). Used with {@link mediaPaths}.
   */
  readonly mediaPublicUrl?: string;
  /**
   * Makes the unguessable token in a published asset's media URL (the media Worker checks it).
   * Without it, published assets get the stored file URL, as without {@link mediaPublicUrl}.
   */
  readonly mediaPaths?: MediaPathSigner;
  /**
   * Video host (Cloudflare Stream on edge). Absent → video-asset use-cases
   * refuse with NotConfiguredError; plain blob uploads of video files still work.
   */
  readonly video?: VideoHost;
  /**
   * Hashes share-link passwords (PBKDF2, the admin's scheme). Absent → a link can't be given a
   * password.
   */
  readonly passwords?: PasswordHasher;
  /** Largest file a multipart upload takes, bytes (ASSET_UPLOAD_MAX_BYTES; default 5 GiB). */
  readonly maxUploadBytes?: number;
}

/** Default {@link AppContext.deliveryCacheTtlSeconds}. */
export const DEFAULT_DELIVERY_CACHE_TTL_SECONDS = 86_400;

/** Default {@link AppContext.deliveryListTtlSeconds}. */
export const DEFAULT_DELIVERY_LIST_TTL_SECONDS = 3_600;

/** `ctx` acting as `actor` for authorship (see {@link AppContext.actor}). */
export function withActor(ctx: AppContext, actor: string | undefined): AppContext {
  if (ctx.actor === actor) return ctx;
  if (actor === undefined) {
    const { actor: _actor, ...rest } = ctx;
    return rest;
  }
  return { ...ctx, actor };
}

/** The actor a write through `ctx` is recorded as, or null when nobody is named. */
export const actorOf = (ctx: AppContext): string | null => ctx.actor ?? null;

/** `ctx` acting for the principal of a request: its audit identity is the writes' author. */
export const actingAs = (ctx: AppContext, principal: Principal): AppContext =>
  withActor(ctx, principalActorId(principal));
