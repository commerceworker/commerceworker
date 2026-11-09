import {
  type AppContext,
  type RagDeps,
  type SchedulerState,
  schedulerState,
} from '@commerceworker/application';
import { type ApiConfig, mountsRole } from '@commerceworker/platform/config';
import type { AIProvider, BlobStore, EventBus } from '@commerceworker/ports';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { WEB_SIGN_IN } from './access-policy';
import type { AuthDeps, AuthRateLimit } from './auth';
import { createApiHasher } from './auth';
import { describeDelivery } from './docs/delivery-docs';
import { doc, mountDocs } from './docs/openapi';
import { health, ready, schedulerHealth } from './docs/schemas/health';
import { onError } from './http';
import { oauthEnabled, oauthRoutes } from './oauth/routes';
import {
  InProcessRequestRateLimiter,
  type RequestRateLimit,
  rateLimitEnabled,
  requestRateLimitMiddleware,
} from './request-rate-limit';
import { deliveryRoutes } from './routes/delivery';
import { inviteRoutes } from './routes/invites';
import { managementRoutes } from './routes/management';
import { previewRoutes } from './routes/preview';
import { teamRoutes } from './routes/team';

/** How long one isolate reuses the scheduler state it read for `/health`. */
export const HEALTH_SCHEDULER_TTL_MS = 30_000;

/** A bus that never emits — the Live Content API then yields only keepalives. */
const noopBus: EventBus = {
  publish: async () => {},
  subscribe: () => ({ close: async () => {} }),
};

/**
 * Builds the HTTP app. The ROLE config gates which modules mount; every module
 * resolves a Principal from the bearer token and enforces RBAC scopes per route.
 */
export function createApp(
  ctx: AppContext,
  config: ApiConfig,
  rag: RagDeps,
  blob: BlobStore,
  ai: AIProvider,
  /**
   * The adapters the composition root bound (`wireEdge`, `platform/in-memory`): the import and
   * fetch adapters, and the runtime on-demand agent actions run on.
   */
  edge: Pick<AuthDeps, 'importSources' | 'spaceExportReader' | 'remoteFetcher'> & {
    /** The failed-auth limiter (`AuthDeps.rateLimiter`). */
    readonly authRateLimit: AuthRateLimit;
    readonly inProcessAgents: (deps: { ctx: AppContext; ai: AIProvider }) => AuthDeps['agents'];
  },
  bus: EventBus = noopBus,
  signalReview?: AuthDeps['signalReview'],
  requestLimiter?: RequestRateLimit,
  /**
   * Adapters bound by the caller rather than derived from config.
   *
   * The positional parameters above cover what every deployment sets; this is
   * for the rest, and for tests that need to drive a seam without an
   * environment behind it.
   */
  overrides: Partial<AuthDeps> = {},
): Hono {
  const app = new Hono();
  app.onError(onError);

  // Baseline security headers on every response: nosniff, clickjacking and
  // MIME-sniffing protection, HSTS, and a strict referrer policy. No restrictive
  // Content-Security-Policy is set here because this app also serves the admin
  // SPA and third-party app-extension iframes in some deployments; the edge sets
  // a CSP tuned for the admin bundle.
  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'DENY',
      xContentTypeOptions: 'nosniff',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      // same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` on a form
      // POST, so the OAuth consent form (served here, on the admin origin) reads as cross-site
      // and the web gateway rightly withholds the session. same-origin still sends nothing to
      // another origin, so an OAuth redirect never leaks its code in a Referer.
      referrerPolicy: 'same-origin',
    }),
  );

  // Per-client request-rate limiting, ahead of the body reader and of the auth
  // chain: a rejected flood then costs one hash — no body buffered, no database
  // round-trip. The Worker injects the Cloudflare `ratelimit` binding; otherwise
  // the in-process sliding window applies (tests, bare `createApp` callers). Mounting is skipped entirely when no
  // class carries a budget, so the default path is unchanged.
  const budgets = config.rateLimit;
  if (budgets && rateLimitEnabled(budgets)) {
    const limiterHasher = createApiHasher(config.tokenPepper);
    app.use(
      '*',
      requestRateLimitMiddleware({
        limiter: requestLimiter ?? new InProcessRequestRateLimiter(budgets),
        hash: (value) => limiterHasher.hash(value),
        windowSeconds: budgets.windowSeconds,
        trustedProxyCount: config.trustedProxyCount,
      }),
    );
  }

  // Reject oversized request bodies before any handler reads them (DoS guard).
  app.use(
    '*',
    bodyLimit({
      maxSize: config.maxBodyBytes ?? 5 * 1024 * 1024,
      onError: (c) => c.json({ code: 'payload_too_large', message: 'Request body too large' }, 413),
    }),
  );

  // The probe also says whether the engine's cron is ticking (`scheduler`), and only that: it is
  // public, so it names no job and no error (GET /deployment/scheduler has those). The answer is
  // kept for HEALTH_SCHEDULER_TTL_MS per isolate, so a probe flood costs one D1 read a window,
  // and the api stays live (200) whatever the scheduler is doing.
  let schedulerSeen: { state: SchedulerState; at: number } | undefined;
  const schedulerNow = async (): Promise<SchedulerState> => {
    const now = ctx.clock.now().getTime();
    if (!schedulerSeen || now - schedulerSeen.at >= HEALTH_SCHEDULER_TTL_MS) {
      schedulerSeen = { state: await schedulerState(ctx), at: now };
    }
    return schedulerSeen.state;
  };
  app.get(
    '/health',
    doc('System', 'Liveness probe, with whether the engine cron is ticking', { ok: health }),
    async (c) => {
      return c.json({ status: 'ok' as const, scheduler: await schedulerNow() });
    },
  );
  // The check for an external uptime monitor. The cron alerts on its own sweeps, but when the cron
  // itself stops nothing of it runs to say so: only something outside the deployment can notice
  // that. `/health` stays 200 (it is the api's liveness, and the deploy smoke test's), so this
  // answers 503 while the scheduler is stale or unreadable. Same cached read, same privacy.
  app.get(
    '/health/scheduler',
    doc('System', 'Scheduler probe for uptime monitors: 503 unless the engine cron is ticking', {
      ok: schedulerHealth,
      description:
        '200 `{ "scheduler": "ok" }` while the engine cron has ticked in the last five minutes; ' +
        '503 with `stale` or `unknown` otherwise. Point an external uptime check at it: the ' +
        'cron cannot report its own outage.',
    }),
    async (c) => {
      const scheduler = await schedulerNow();
      return c.json({ scheduler }, scheduler === 'ok' ? 200 : 503);
    },
  );
  app.get(
    '/ready',
    doc('System', 'Readiness probe (reports the mounted role)', { ok: ready }),
    (c) => c.json({ status: 'ready', role: config.role }),
  );

  const deps: AuthDeps = {
    ctx,
    hasher: createApiHasher(config.tokenPepper),
    adminToken: config.adminToken,
    webPrincipalKeys: config.principalKeys,
    rag,
    blob,
    ai,
    bus,
    // On-demand agent actions are synchronous request/response, so they always
    // run in-process; the durable Cloudflare Workflows path serves the queue
    // consumer's on-publish runs (AGENT_RUNTIME=cloudflare-workflows).
    agents: edge.inProcessAgents({ ctx, ai }),
    importSources: edge.importSources,
    spaceExportReader: edge.spaceExportReader,
    // Downloading a plugin package is a fetch like any other, bounded and
    // redirect-refusing; the policy that decides *whether* is config, not code.
    remoteFetcher: edge.remoteFetcher,
    pluginSources: config.pluginSources ?? {},
    rateLimiter: edge.authRateLimit,
    signalReview,
    trustedProxyCount: config.trustedProxyCount,
    moderateBeforePublish: config.moderateBeforePublish,
    demoStarters: config.demoStarters,
    accessPolicy: WEB_SIGN_IN,
    ...(config.oauthIssuer ? { inviteOrigin: config.oauthIssuer.replace(/\/$/, '') } : {}),
    ...overrides,
  };

  const mountManagement = mountsRole(config, 'management');
  const mountDelivery = mountsRole(config, 'delivery');
  const mountPreview = mountsRole(config, 'preview');

  if (mountManagement) {
    // The authorization server rides with the management plane: a grant is approved by a person
    // signed in to the web app (its signed principal) and capped by their role in the space.
    if (oauthEnabled(config)) app.route('/', oauthRoutes(deps, config));
    app.route('/', managementRoutes(deps));
    // After managementRoutes: its `/spaces/*` principal + audit middleware cover these routes.
    app.route('/', teamRoutes(deps));
    // Also after it: its `/deployment/*` principal middleware covers these.
    app.route('/', inviteRoutes(deps));
  }
  if (mountDelivery) app.route('/', deliveryRoutes(deps, describeDelivery));
  if (mountPreview) app.route('/', previewRoutes(deps));

  // Last: the OpenAPI spec walks the routes mounted above, so /openapi.json
  // (and the Scalar UI at /docs) reflects exactly this deployment's ROLE.
  mountDocs(app, config);

  return app;
}
