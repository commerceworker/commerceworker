/**
 * commerceworker-engine. No public routes: the web app reaches it through a service binding, as RPC
 * (`EngineApi`) or plain fetch for the health check, the agent WebSockets it proxies, MCP
 * (`/mcp`, see ./mcp.ts), A2A (`/a2a`, see ./a2a/) and UCP (`/ucp/*`, see ./ucp/).
 * Cloudflare Email Routing delivers inbound order email to `email()` (see ./email.ts).
 */

import { retryLabelVoids } from '@commerceworker/application/commerce';
import { UCP_PATH } from '@commerceworker/core';
import { opsMetrics, routeGroup } from '@commerceworker/telemetry/metrics';
import { A2A_PATH, handleA2A } from './a2a/route';
import { routeAgents } from './agent-routes';
import { settleOrphanedHolds } from './checkout/hosted';

import {
  applyObjectEvents,
  isDocsReplicaDlq,
  isDocsReplicaQueue,
  keepDeadLetters,
} from './docs-replica';
import { receiveEmail } from './email';
import {
  deliverEmails,
  isEmailDlq,
  isEmailEvents,
  isEmailEventsDlq,
  isEmailQueue,
  keepEmailDeadLetters,
  keepEmailEventDeadLetters,
  recordEmailEvents,
} from './email-queue';
import { refreshRates } from './fx';
import { sweepOrderInstances } from './instance-sweep';
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
// The commerce database's daily backup and its restore drill (d1-backup.ts); bound only when the
// registry's `redundancy` is on.
export { D1Backup, D1Restore } from './d1-backup';
// The nightly reconcile of the order documents replica (docs-replica.ts); bound only when the
// registry's `redundancy` is on.
export { DocsReplicaReconcile } from './docs-replica';
// The deploy smoke test's write check object (health.ts).
export { HealthProbe } from './health';
// The nightly copy of live order and cart state, the operator's restore to a point in time, and
// its drill (objects.ts); bound only when the registry's `redundancy` is on.
export { ObjectsBackup, ObjectsDrill, ObjectsRestore } from './objects';
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

/** The hourly cron in wrangler.jsonc: `reindexProducts`, `settleOrphanedHolds`, `failUnstartedOrders` and `sweepOrderInstances`. */
const REINDEX_CRON = '15 * * * *';

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health')
    return Response.json({ ok: true, service: 'commerceworker-engine' });
  if (url.pathname === MCP_PATH) return handleMcp(request);
  if (url.pathname === A2A_PATH) return handleA2A(request, env);
  if (url.pathname === UCP_PATH || url.pathname.startsWith(`${UCP_PATH}/`))
    return handleUcp(request, env);
  return routeAgents(request, env);
}

/** Request outcomes are counted by these groups, never by path: an id in a URL is no label. */
const ROUTE_GROUPS = [
  ['/health', 'health'],
  [MCP_PATH, 'mcp'],
  [A2A_PATH, 'a2a'],
  [UCP_PATH, 'ucp'],
  ['/agents', 'agents'],
] as const;

export default {
  async fetch(request, env) {
    const ops = opsMetrics(env.METRICS, 'engine');
    const group = routeGroup(new URL(request.url).pathname, ROUTE_GROUPS);
    const started = Date.now();
    let response: Response;
    try {
      response = await route(request, env);
    } catch (err) {
      ops.request(group, 500, Date.now() - started);
      throw err;
    }
    ops.request(group, response.status, Date.now() - started);
    return response;
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
        'workflow instances': () => sweepOrderInstances(env),
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

  // The order documents replica's queue (R2 event notifications), the mail queue and Email Sending's
  // event queue, each with its dead-letter queue; names carry the deployment's suffix, and the
  // dead-letter queue's starts like the queue's.
  async queue(batch, env) {
    if (isEmailEventsDlq(batch.queue)) return keepEmailEventDeadLetters(batch, env);
    if (isEmailEvents(batch.queue)) return recordEmailEvents(batch, env);
    if (isEmailDlq(batch.queue)) return keepEmailDeadLetters(batch, env);
    if (isEmailQueue(batch.queue)) return deliverEmails(batch, env);
    if (isDocsReplicaDlq(batch.queue)) return keepDeadLetters(batch, env);
    if (isDocsReplicaQueue(batch.queue)) return applyObjectEvents(batch, env);
    console.error(JSON.stringify({ type: 'queue_unknown', queue: batch.queue }));
    batch.retryAll();
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
