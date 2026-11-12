/**
 * commerceworker-engine. No public routes: the web app reaches it through a service binding, as RPC
 * (`EngineApi`) or plain fetch for the health check, the agent WebSockets it proxies, MCP
 * (`/mcp`, see ./mcp.ts), A2A (`/a2a`, see ./a2a/) and UCP (`/ucp/*`, see ./ucp/).
 * Cloudflare Email Routing delivers inbound order email to `email()` (see ./email.ts).
 */

import { retryLabelVoids } from '@commerceworker/application/commerce';
import { UCP_PATH } from '@commerceworker/core';
import { A2A_PATH, handleA2A } from './a2a/route';
import { routeAgents } from './agent-routes';
import { settleOrphanedHolds } from './checkout/hosted';

import { receiveEmail } from './email';
import { refreshRates } from './fx';
import { handleMcp, MCP_PATH } from './mcp';
import { failUnstartedOrders } from './orders';
import { reindexProducts } from './product-index';
import { sweep } from './retention';
import { handleUcp } from './ucp/rest';
import { commercePorts } from './wire';

export { A2AAgent } from './a2a/agent';
export { OrderAgent } from './agent';
export { EngineApi } from './api';
export { AssistantAgent } from './assistant/agent';
export { CartAgent } from './cart/agent';
// The deploy smoke test's write check object (health.ts).
export { HealthProbe } from './health';
// What a plugin can ask of the core, bound into it as COMMERCEWORKER (plugin-api.ts).
export { PluginHost } from './plugin-api';
// The sandbox's capabilities, reached as `ctx.exports` by the plugins it loads (plugin-host.ts).
export {
  PluginDb,
  PluginEgress,
  PluginSecrets,
  PluginStorage,
  PluginTail,
} from './plugin-host';
export { DryRunSecrets } from './plugin-installs';
export { Replenish } from './replenish';
// The public storefront's entrypoint: all it may ask of the engine (storefront-api.ts).
export { StorefrontApi } from './storefront-api';
export { OrderWorkflow } from './workflow';

/** The hourly cron in wrangler.jsonc: `reindexProducts`, `settleOrphanedHolds` and `failUnstartedOrders`. */
const REINDEX_CRON = '15 * * * *';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health')
      return Response.json({ ok: true, service: 'commerceworker-engine' });
    if (url.pathname === MCP_PATH) return handleMcp(request);
    if (url.pathname === A2A_PATH) return handleA2A(request, env);
    if (url.pathname === UCP_PATH || url.pathname.startsWith(`${UCP_PATH}/`))
      return handleUcp(request, env);
    return routeAgents(request, env);
  },

  // `triggers.crons` in wrangler.jsonc: hourly, the product index catches up with `products`;
  // daily, the retention sweep, another try at labels a provider couldn't void, and the exchange
  // rates of the currencies the deployment sells in.
  async scheduled(controller, env) {
    if (controller.cron === REINDEX_CRON) {
      // Hourly: a hold a card payment left behind is settled within the hour, not the day, and so is
      // an order that never got its Workflow.
      const failed: string[] = [];
      for (const [name, run] of Object.entries({
        'product index': () => reindexProducts(env),
        'card holds': () => settleOrphanedHolds(env),
        'unstarted orders': () => failUnstartedOrders(env),
      })) {
        try {
          await run();
        } catch (err) {
          console.error(name, 'failed', err);
          failed.push(name);
        }
      }
      if (failed.length) throw new Error(`Hourly jobs failed: ${failed.join(', ')}`);
      return;
    }
    // Each daily job runs whatever the others do, so one failing every day can't starve the rest;
    // the invocation still fails afterwards, so the failure shows.
    const jobs = {
      'retention sweep': () => sweep(env),
      'label voids': () => retryLabelVoids(commercePorts(env)),
      'fx rates': () => refreshRates(env),
    };
    const failed: string[] = [];
    for (const [name, run] of Object.entries(jobs)) {
      try {
        console.log(name, JSON.stringify(await run()));
      } catch (err) {
        console.error(name, 'failed', err);
        failed.push(name);
      }
    }
    if (failed.length) throw new Error(`Daily jobs failed: ${failed.join(', ')}`);
  },

  async email(message, env) {
    try {
      const outcome = await receiveEmail(message, env);
      console.log('email intake', JSON.stringify({ to: message.to, ...outcome }));
    } catch (err) {
      // Thrown on, so Email Routing answers with a temporary failure and the sender retries.
      console.error('email intake failed', JSON.stringify({ to: message.to }), err);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
