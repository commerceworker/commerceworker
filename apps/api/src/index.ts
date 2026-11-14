/**
 * The api Worker: Management and Preview REST, the MCP server, OAuth, setup/OIDC, media and the
 * live (SSE) route. Synchronous request/response only: queue consumers, cron, Durable Objects and
 * Workflows belong to the engine Worker, bound here by script name.
 */
import { createHasher, drainOutbox } from '@commerceworker/application';
import { WEB_SIGN_IN } from '@commerceworker/http/api/access-policy';
import { createApp } from '@commerceworker/http/api/app';
import { type AuthDeps, createApiHasher } from '@commerceworker/http/api/auth';
import {
  deriveGateKeys,
  isAssistantPath,
  routeAssistant,
} from '@commerceworker/http/assistant/gate';
import type { McpDeps } from '@commerceworker/http/mcp/deps';
import { mcpRoutes } from '@commerceworker/http/mcp/routes';
import { liveRoutes } from '@commerceworker/http/routes/live';
import { mediaRoutes } from '@commerceworker/http/routes/media';
import { mountsRole } from '@commerceworker/platform/config';
import { type EdgeEnv, withJurisdiction } from '@commerceworker/platform/env';
import { mediaAdapters } from '@commerceworker/platform/media';
import { makeMetrics } from '@commerceworker/platform/metrics';
import { validateApiSecrets } from '@commerceworker/platform/secure-secrets';
import { type EdgeWired, wireEdge } from '@commerceworker/platform/wire';
import { sendReviewDecision } from '@commerceworker/platform/workflows';
import { seedConfigFrom, seedDev } from '@commerceworker/seed';
import { Hono } from 'hono';

/**
 * The D1 Sessions API bookmark, in both directions: a client echoes the value of its last
 * response so its next read is at least that fresh even when served by a read replica
 * (read-your-writes), and every response carries the bookmark after its own queries.
 */
const BOOKMARK_HEADER = 'x-cw-bookmark';
/** D1 Sessions bookmarks are hex groups joined by dashes (e.g. `00000000-00000033-…`). */
const BOOKMARK_SHAPE = /^[0-9a-f]+(?:-[0-9a-f]+){2,8}$/i;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Idempotent dev bootstrap runs once per isolate (SEED_DEV + real database). */
let devSeeded = false;

function buildApp(wired: EdgeWired, env: EdgeEnv): Hono {
  const app = new Hono();
  const { assetIngest } = wired;

  // Signed R2 transfers (+ Images transforms) and Stream webhooks. Mounted on
  // every role: delivery serves downloads, management takes uploads.
  app.route(
    '/',
    mediaRoutes({
      ctx: wired.ctx,
      media: mediaAdapters({
        bucket: env.MEDIA_BUCKET,
        signer: wired.mediaSigner,
        images: env.IMAGES,
        streamWebhookSecret: env.STREAM ? env.STREAM_WEBHOOK_SECRET : undefined,
      }),
      // A completed upload starts its ingest (local dev has no R2 notifications to do it).
      ...(assetIngest
        ? { onUploaded: (key: string, etag?: string) => assetIngest.objectCreated(key, etag) }
        : {}),
    }),
  );
  const mountManagement = mountsRole(wired.config, 'management');
  if (env.LIVE_HUB) {
    // Pre-mounted (first match wins): the DO-served Live Content API replaces
    // the stock in-process SSE route, with the identical auth chain.
    const authDeps: AuthDeps = {
      ctx: wired.ctx,
      hasher: createApiHasher(wired.config.tokenPepper),
      adminToken: wired.config.adminToken,
      webPrincipalKeys: wired.config.principalKeys,
      rag: wired.rag,
      assetSearch: wired.assetSearch,
      blob: wired.blob,
      ai: wired.ai,
      bus: wired.bus,
      importSources: wired.importSources,
      spaceExportReader: wired.spaceExportReader,
      remoteFetcher: wired.remoteFetcher,
      agents: wired.inProcessAgents({ ctx: wired.ctx, ai: wired.ai }),
      rateLimiter: wired.authRateLimit,
    };
    app.route('/', liveRoutes(authDeps, env.LIVE_HUB));
  }

  // MCP mounts only with an explicit MCP_TOKEN on persistent (production)
  // deployments — the dev fallback token would otherwise grant wildcard-space
  // admin on a public URL. Demo mode (in-memory) keeps the dev token.
  const mcpToken = env.MCP_TOKEN ?? (wired.persistent ? undefined : 'dev-mcp-token');
  if (mountManagement && mcpToken) {
    const mcpDeps: McpDeps = {
      defaultScope: wired.config.seed,
      ctx: wired.ctx,
      ai: wired.ai,
      rag: wired.rag,
      assetSearch: wired.assetSearch,
      // On-demand agent actions are synchronous request/response, so they run
      // in-process (same policy as the HTTP API's createApp); the durable
      // Workflows runtime serves the queue consumer's on-publish runs.
      agents: wired.inProcessAgents({ ctx: wired.ctx, ai: wired.ai }),
      hasher: createHasher(env.TOKEN_PEPPER),
      adminToken: mcpToken,
      blob: wired.blob,
      moderateBeforePublish: wired.config.moderateBeforePublish,
      // The enterprise starter, where the deployment offers it (as the HTTP API's).
      demoStarters: wired.config.demoStarters,
      accessPolicy: WEB_SIGN_IN,
      // Where invitation links open: the admin's origin, as the HTTP API's.
      ...(wired.config.oauthIssuer
        ? { inviteOrigin: wired.config.oauthIssuer.replace(/\/$/, '') }
        : {}),
      // Bounded and redirect-refusing, as the HTTP API's: embed_resolve fetches with it.
      remoteFetcher: wired.remoteFetcher,
      // The import tools' readers and the space export reader, as the HTTP API's routes use.
      importSources: wired.importSources,
      spaceExportReader: wired.spaceExportReader,
      signalReview: env.AGENT_WF
        ? (review, decision) => sendReviewDecision(env.AGENT_WF as Workflow, review.id, decision)
        : undefined,
      ...(wired.workflowEngine ? { workflowEngine: wired.workflowEngine } : {}),
      workflowNodes: wired.workflowNodes,
      ...(wired.assetIngest ? { assetIngest: wired.assetIngest } : {}),
    };
    const issuer = wired.config.oauthIssuer?.replace(/\/$/, '');
    app.route(
      '/',
      mcpRoutes(
        mcpDeps,
        issuer ? { issuer, resource: wired.config.oauthResource ?? `${issuer}/mcp` } : undefined,
      ),
    );
  }

  app.route(
    '/',
    createApp(
      wired.ctx,
      wired.config,
      wired.rag,
      wired.blob,
      wired.ai,
      wired,
      wired.bus,
      // Review decisions reach the durable watcher as Workflow events.
      env.AGENT_WF
        ? (review, decision) => sendReviewDecision(env.AGENT_WF as Workflow, review.id, decision)
        : undefined,
      // Native per-colo rate limiting; absent bindings leave classes unlimited.
      wired.requestRateLimit,
      // Editorial workflow runs on the EDITORIAL_WF Workflows binding.
      {
        ...(wired.workflowEngine ? { workflowEngine: wired.workflowEngine } : {}),
        workflowNodes: wired.workflowNodes,
        assetSearch: wired.assetSearch,
        ...(wired.assetIngest ? { assetIngest: wired.assetIngest } : {}),
      },
    ),
  );
  return app;
}

export default {
  /**
   * HTTP surface: management/delivery/preview APIs + MCP + the DO live route.
   * Wiring is per request and cheap (D1 is a binding). After a mutating request, an outbox
   * relay nudge runs in waitUntil — sub-second event latency without a polling
   * loop; the cron sweeper covers crashes.
   */
  async fetch(req: Request, rawEnv: EdgeEnv, exec: ExecutionContext): Promise<Response> {
    const env = withJurisdiction(rawEnv);
    // The admin's assistant: its socket (and message history) goes to the engine's
    // AssistantAgent once the signed principal names that assistant's own person. Before any
    // wiring: it needs none here, and a WebSocket's response can't be rebuilt with a bookmark.
    if (
      isAssistantPath(new URL(req.url).pathname) &&
      mountsRole({ role: env.ROLE ?? 'all' }, 'management')
    )
      return routeAssistant(req, {
        namespace: env.ASSISTANT_AGENT,
        keys: await deriveGateKeys([env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS]),
      });
    // Writes start at the primary; reads may start at any replica unless the client brings a
    // bookmark, which pins them to at least the state it last saw.
    // A client-sent bookmark is used only when it has D1's shape; anything else would make every
    // query in the request fail, so it is ignored rather than trusted.
    const sent = req.headers.get(BOOKMARK_HEADER);
    const bookmark =
      sent && BOOKMARK_SHAPE.test(sent)
        ? sent
        : MUTATING.has(req.method)
          ? 'first-primary'
          : 'first-unconstrained';
    const wired = wireEdge(env, { bookmark });
    try {
      validateApiSecrets(wired.config, env);
      // The seed appends hundreds of events (thousands at a larger SEED_SCALE) in whatever
      // request runs first, often a GET; relay them now, since local dev has no cron sweep.
      let seededNow = false;
      if (wired.config.seedDev && wired.persistent && !devSeeded) {
        seededNow = true;
        await seedDev(wired.ctx, seedConfigFrom(wired.config), { blob: wired.blob });
        devSeeded = true;
      }
      const app = buildApp(wired, env);
      let res = await app.fetch(req, env, exec);
      const after = wired.bookmark();
      if (after) {
        res = new Response(res.body, res);
        res.headers.set(BOOKMARK_HEADER, after);
      }
      // A streamed reply (MCP over SSE) returns before its handler has committed: the write lands
      // while the body streams. The relay nudge waits for the body to finish, or it would find an
      // empty outbox and leave the event to the cron sweeper.
      let bodyDone: Promise<void> = Promise.resolve();
      if (res.body && MUTATING.has(req.method)) {
        const { readable, writable } = new TransformStream();
        bodyDone = res.body.pipeTo(writable).catch(() => {
          // The client went away mid-stream; whatever committed still gets relayed.
        });
        exec.waitUntil(bodyDone);
        res = new Response(readable, res);
      }
      exec.waitUntil(
        (async () => {
          const metrics = makeMetrics(env.METRICS);
          try {
            await bodyDone;
            if (wired.queue && (MUTATING.has(req.method) || seededNow)) {
              // Loop-until-drained: a bulk mutation can append far more rows
              // than one relay batch; its own nudge should clear them rather
              // than leaving the overflow to the cron sweeper.
              const relayed = await drainOutbox(wired.ctx, wired.queue, {
                routeTopic: wired.routeTopic,
              });
              if (relayed > 0) {
                metrics.count('commerceworker_outbox_relayed_total', relayed, { trigger: 'nudge' });
              }
            }
          } catch (err) {
            console.error('outbox relay nudge failed', err);
            metrics.count('commerceworker_relay_errors_total', 1, { trigger: 'nudge' });
          } finally {
            await wired.close();
          }
        })(),
      );
      return res;
    } catch (err) {
      exec.waitUntil(wired.close());
      throw err;
    }
  },
} satisfies ExportedHandler<EdgeEnv>;
