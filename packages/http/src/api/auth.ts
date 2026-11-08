import type {
  AccessPolicy,
  AgentRunner,
  AppContext,
  AssetSearchDeps,
  PluginSourcePolicy,
  RagDeps,
  WorkflowNodeDeps,
} from '@commerceworker/application';
import {
  auditActor,
  authenticate,
  type ChangeLog,
  createChangeLog,
  createdEntryOf,
  createHasher,
  principalForWebUser,
  recordAudit,
  resolveEnvironment,
  resolveWritableEnvironment,
  secureTokenEqual,
} from '@commerceworker/application';
import {
  type AgentReview,
  authorize,
  ForbiddenError,
  inScope,
  type PermissionScope,
  type Principal,
  scopesForKind,
} from '@commerceworker/domain';
import {
  type AuthRateLimit,
  AuthRateLimiter,
  clientIp,
} from '@commerceworker/platform/auth-rate-limit';
import type {
  AIProvider,
  AssetIngestQueue,
  BlobStore,
  EventBus,
  Hasher,
  ImportSource,
  RemoteFetcher,
  SpaceExportReader,
  WorkflowEngine,
} from '@commerceworker/ports';
import {
  PRINCIPAL_HEADER,
  principalTarget,
  verifyPrincipal,
} from '@commerceworker/security/principal';
import { logger } from '@commerceworker/telemetry';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

export type { AuthRateLimit } from '@commerceworker/platform/auth-rate-limit';

/** Default SHA-256 hasher (no pepper). Prefer {@link createApiHasher} in production. */
export const sha256Hasher = createHasher();

/** Builds the API hasher, applying TOKEN_PEPPER when configured. */
export function createApiHasher(pepper?: string): Hasher {
  return createHasher(pepper);
}

/**
 * Hono context variables: the resolved principal, plus `environmentId` — the
 * concrete environment a request targets after alias resolution (set by
 * {@link environmentMiddleware}; `scopeOf` reads it, falling back to the raw param).
 */
export type AuthVars = {
  Variables: {
    principal: Principal;
    environmentId?: string;
    /** Where this request's entry saves note what they changed (`auditMiddleware`). */
    changes?: ChangeLog;
  };
};

export interface AuthDeps {
  readonly ctx: AppContext;
  readonly hasher: Hasher;
  /** Root token granting all scopes across all spaces (provisioning/bootstrap). */
  readonly adminToken: string;
  /** Embeddings + vector store for the Delivery semantic-search endpoint. */
  readonly rag: RagDeps;
  /** Object storage for asset uploads/downloads. */
  readonly blob: BlobStore;
  /**
   * Asset search's indexes (`wireEdge`'s `assetSearch`, which decides once whether queries are
   * embedded). Absent (tests, local fakes): the RAG wiring's, embedding included.
   */
  readonly assetSearch?: AssetSearchDeps;
  /** Hands asset files to ingest (re-ingest and reindex, which answer 501 without it). */
  readonly assetIngest?: AssetIngestQueue;
  /** AI provider for entry generation. */
  readonly ai: AIProvider;
  /** Agent-workflow runtime for on-demand agent actions (moderation). */
  readonly agents: AgentRunner;
  /** Domain-event source for the Live Content API (SSE). */
  readonly bus: EventBus;
  /** Readers for external content formats, by source id. */
  readonly importSources?: Readonly<Record<string, ImportSource>>;
  /** Reads the JSON space export format. Absent: those import routes answer 400. */
  readonly spaceExportReader?: SpaceExportReader;
  /** Downloads plugin packages. Absent means install-from-URL is unavailable. */
  readonly remoteFetcher?: RemoteFetcher;
  /** Deployment policy for where plugin packages may come from. */
  readonly pluginSources?: PluginSourcePolicy;
  /** Delivers review decisions to a durable HITL watcher (optional). */
  readonly signalReview?: (
    review: AgentReview,
    decision: 'approved' | 'rejected',
  ) => Promise<boolean>;
  /**
   * Failed-auth rate limiter. Defaults to the in-process sliding window;
   * multi-isolate runtimes (Cloudflare Workers) inject a shared-state one.
   */
  readonly rateLimiter?: AuthRateLimit;
  /**
   * A principal already authenticated by a trusted caller in the same Worker (the delivery
   * gateway, which authenticates before the cache). When it returns one, the request's own
   * credentials are not consulted. Never set this on a surface reachable from outside.
   */
  readonly trustedPrincipal?: (c: Context) => Principal | undefined;
  /**
   * `PRINCIPAL_KEY` (then the previous key during a rotation): verifies the `x-cw-principal`
   * envelope the web Worker signs for a signed-in person. Unset → the header is ignored, and only
   * bearer credentials authenticate.
   */
  readonly webPrincipalKeys?: readonly string[];
  /** Number of trusted reverse proxies in front (for X-Forwarded-For parsing). */
  readonly trustedProxyCount?: number;
  /** When true, publish runs moderation first and blocks flagged content. */
  readonly moderateBeforePublish?: boolean;
  /**
   * Starts/signals/cancels editorial workflow runs (Cloudflare Workflows on edge). Absent → run
   * actions answer 501 while definitions, versions and reads keep working.
   */
  readonly workflowEngine?: WorkflowEngine;
  /** AI, email and webhook ports for workflow node compensations (cancel). */
  readonly workflowNodes?: WorkflowNodeDeps;
  /**
   * Whether people sign in through SSO here, which decides whether they count toward the
   * last-administrator rule. Absent means no SSO.
   */
  readonly accessPolicy?: AccessPolicy;
  /**
   * The admin's origin (`OAUTH_ISSUER`), where an invitation's `/invite/<token>` link opens. Unset:
   * invitations come back with their token only, and none is emailed.
   */
  readonly inviteOrigin?: string;
  /**
   * Whether creating a space offers the demo starters (`DEMO_STARTERS`): the enterprise starter,
   * installed in the background. Absent: empty and sample only.
   */
  readonly demoStarters?: boolean;
}

const ADMIN: Principal = {
  spaceId: '*',
  kind: 'admin',
  scopes: [...scopesForKind('cma')],
};

const authRateLimiter = new AuthRateLimiter(
  Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
  Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000),
);

async function resolvePrincipal(deps: AuthDeps, token: string): Promise<Principal> {
  if (deps.adminToken && secureTokenEqual(token, deps.adminToken)) {
    return ADMIN;
  }
  return authenticate(deps.ctx, deps.hasher, token);
}

function resolveRequestToken(_deps: AuthDeps, c: Context): string {
  return (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
}

/**
 * Resolves the bearer token (or admin SSO session cookie) to a Principal and
 * stores it on the context. The admin token short-circuits to a wildcard
 * principal; everything else is looked up as a hashed API key.
 */
function requestIp(deps: AuthDeps, c: Context): string {
  // CF-Connecting-IP first (Cloudflare-set, not forgeable); otherwise parse
  // X-Forwarded-For from the right by trusted-proxy depth so a client can't
  // spoof a fresh rate-limit key per request.
  return clientIp({
    cfConnectingIp: c.req.header('cf-connecting-ip'),
    forwardedFor: c.req.header('x-forwarded-for'),
    realIp: c.req.header('x-real-ip'),
    trustedProxyCount: deps.trustedProxyCount,
  });
}

/** The space a scoped route names (`/spaces/:space/…`, `/preview/:space/…`, `/delivery/:space/…`). */
export function spaceFromPath(pathname: string): string | undefined {
  const m = /^\/(?:spaces|preview|delivery)\/([^/]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1] as string) : undefined;
}

/**
 * The principal of a person signed in to the admin web app, when the request carries the web
 * Worker's signed `x-cw-principal` and this deployment holds the key to verify it; null when it
 * carries none. A header that fails verification is a 401, and a person who may not act in the
 * route's space a 403: never a fall-through to other credentials.
 */
export async function resolveWebPrincipal(deps: AuthDeps, c: Context): Promise<Principal | null> {
  const forwarded = c.req.header(PRINCIPAL_HEADER);
  if (!forwarded || !deps.webPrincipalKeys?.length) return null;
  const url = new URL(c.req.url);
  const user = await verifyPrincipal(
    deps.webPrincipalKeys,
    forwarded,
    principalTarget(c.req.method, url.pathname),
  );
  if (!user) throw new HTTPException(401, { message: 'Invalid or expired web session' });
  try {
    return await principalForWebUser(deps.ctx, spaceFromPath(url.pathname), {
      sub: user.sub,
      email: user.email,
      role: user.role === 'admin' ? 'admin' : 'member',
    });
  } catch (err) {
    if (err instanceof ForbiddenError) throw new HTTPException(403, { message: err.message });
    throw err;
  }
}

/**
 * Runs a credential resolution under the failed-auth rate limiter: rejects with
 * 429 when the client IP is already blocked, clears the window on success, and
 * records a failure (429 once the limit trips) on error. Shared by the bearer
 * middleware and the preview route so every credential-checking path is
 * throttled uniformly.
 */
export async function throttleAuth<T>(
  deps: AuthDeps,
  c: Context,
  resolve: () => Promise<T>,
): Promise<T> {
  const ip = requestIp(deps, c);
  const limiter = deps.rateLimiter ?? authRateLimiter;
  if (await limiter.isBlocked(ip)) {
    logger.warn({ ip, path: c.req.path }, 'auth: rate limit exceeded');
    throw new HTTPException(429, { message: 'Too many authentication attempts' });
  }
  try {
    const result = await resolve();
    await limiter.clear(ip);
    return result;
  } catch (err) {
    // Only failed authentication counts against the IP: a signed-in person refused a space
    // (403) authenticated fine, and counting it would lock out everyone behind their NAT.
    const forbidden =
      err instanceof ForbiddenError || (err instanceof HTTPException && err.status === 403);
    if (forbidden) throw err;
    const limited = await limiter.recordFailure(ip);
    logger.warn({ ip, path: c.req.path, method: c.req.method }, 'auth: invalid credentials');
    if (limited) throw new HTTPException(429, { message: 'Too many authentication attempts' });
    throw err;
  }
}

export function principalMiddleware(deps: AuthDeps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    // No credentials presented → plain 401 with no limiter interaction: an
    // empty bearer can't brute-force anything, and unauthenticated probes
    // (e.g. the admin SPA checking for a session) must never exhaust the IP's
    // failure budget.
    const trusted = deps.trustedPrincipal?.(c);
    if (trusted) {
      c.set('principal', trusted);
      await next();
      return;
    }
    const web = await resolveWebPrincipal(deps, c);
    if (web) {
      c.set('principal', web);
      await next();
      return;
    }
    const token = resolveRequestToken(deps, c);
    if (!token) {
      throw new HTTPException(401, { message: 'Invalid or missing API key' });
    }
    let principal: Principal;
    try {
      principal = await throttleAuth(deps, c, () => resolvePrincipal(deps, token));
    } catch (err) {
      // Preserve the limiter's 429; collapse any auth failure to a plain 401.
      if (err instanceof HTTPException) throw err;
      throw new HTTPException(401, { message: 'Invalid or missing API key' });
    }
    c.set('principal', principal);
    await next();
  };
}

/**
 * Resolves the route's `:env` param through environment aliases and stamps the
 * concrete environment id onto the context. Mounted on the scoped path prefixes
 * so an alias name works anywhere `:env` does. A direct environment reference
 * resolves to itself (one indexed lookup).
 */
export function environmentMiddleware(deps: AuthDeps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    const space = c.req.param('space');
    const env = c.req.param('env');
    if (space && env) {
      // A write must land in an environment that exists; a read of an unknown one is just empty.
      // Only checked for a caller who may act in the space, so nobody else learns which
      // environments exist there (the route's scope check refuses them with 403 instead).
      const principal = c.get('principal');
      const member = Boolean(principal && inScope(principal, space));
      c.set(
        'environmentId',
        MUTATING.has(c.req.method) && member
          ? await resolveWritableEnvironment(deps.ctx, space, env)
          : await resolveEnvironment(deps.ctx, space, env, { refusePurging: member }),
      );
    }
    await next();
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The route parameters that name an audit row's target, the first one present winning. */
const TARGET_PARAMS = ['id', 'apiId', 'alias'] as const;

/**
 * What kind of thing a route's parameter names: the collection before it, singular, in the words
 * the use-cases' own rows use (`/content-types/:apiId` is `content_type`).
 */
export function routeTargetType(route: string, param: string): string | undefined {
  const segments = route.split('/');
  const collection = segments[segments.indexOf(`:${param}`) - 1];
  if (!collection || collection.startsWith(':')) return undefined;
  const noun = collection.replace(/-/g, '_');
  return noun.endsWith('aliases') ? noun.slice(0, -2) : noun.replace(/ies$/, 'y').replace(/s$/, '');
}

/**
 * Records successful mutating requests to the append-only audit trail. Runs
 * after the handler so it can capture the response status; a failed audit write
 * never fails the request. The handler's use-cases note what they changed on the
 * log set here (`actingCtx` hands it to them), and the row carries it as `detail`.
 */
export function auditMiddleware(deps: AuthDeps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    const changes = createChangeLog();
    c.set('changes', changes);
    await next();
    const space = c.req.param('space');
    if (!MUTATING.has(c.req.method) || !space || c.res.status >= 400) return;
    try {
      const principal = c.get('principal');
      const target = TARGET_PARAMS.find((name) => c.req.param(name) !== undefined);
      const detail = changes.detail();
      // A create's route can't name what it made; what it saved can.
      const created = target ? undefined : createdEntryOf(detail);
      await recordAudit(deps.ctx, {
        spaceId: space,
        environmentId: c.get('environmentId') ?? c.req.param('env'),
        actor: auditActor(principal),
        action: `${c.req.method} ${c.req.routePath}`,
        targetType: target ? routeTargetType(c.req.routePath, target) : created && 'entry',
        targetId: target ? c.req.param(target) : created?.entryId,
        status: c.res.status,
        detail,
      });
    } catch {
      /* auditing must never break the request path */
    }
  };
}

/** Guards a route: the principal must hold `scope` within the route's :space. */
export function requireScope(scope: PermissionScope): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    const principal = c.get('principal');
    const space = c.req.param('space');
    // authorize throws ForbiddenError → mapped to 403 by the error handler.
    authorize(principal, scope, space ?? '*');
    await next();
  };
}
