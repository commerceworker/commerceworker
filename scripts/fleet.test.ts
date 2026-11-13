import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { deriveAssistantKey } from './derive-assistant-key.ts';
import {
  ALERT_POLICIES,
  alertSpec,
  alertsOn,
  backsUpObjects,
  CONTENT_QUEUES,
  CONTENT_SECRETS,
  contentHosts,
  contentSecretValues,
  emailDomains,
  foreignJobsReaching,
  healthCheckKey,
  keysProblem,
  LOG_FIELDS,
  loadDeployments,
  logpushJob,
  logpushToken,
  matrix,
  missingPluginSecrets,
  names,
  pluginBinding,
  pluginKey,
  pluginOwnSecrets,
  postWriteCheck,
  queuesEmail,
  REDUNDANCY_PARTS,
  RESERVED_PATH_SEGMENTS,
  redriveTargets,
  redundancySchedules,
  renderAll,
  renderApi,
  renderCatalog,
  renderDelivery,
  renderEngine,
  renderMedia,
  renderPipeline,
  renderPlugin,
  renderStorefront,
  renderStudio,
  renderWeb,
  replicatesDocs,
  sandboxedPlugins,
  secretsProblem,
  shellVars,
  signHealthCheck,
  storefrontKey,
  storefrontSecrets,
  toDeployment,
  tokenMatches,
  WRITE_CHECK_ATTEMPT_MS,
  WRITE_CHECK_DEADLINE_MS,
  workerPlugins,
} from './fleet.ts';
import {
  markerKey,
  parseList,
  type RedriveIo,
  redrive,
  redriveBody,
  redrivePlan,
  signR2,
} from './redrive.ts';

const base = (app: string) =>
  parse(
    readFileSync(
      join(
        import.meta.dirname,
        '..',
        'apps',
        app,
        // The delivery Worker is deployed as its catalog-only config; wrangler.jsonc is the content stack's.
        app === 'delivery' ? 'wrangler.catalog.jsonc' : 'wrangler.jsonc',
      ),
      'utf8',
    ),
  );

/** An app's content-stack template: for delivery, `wrangler.jsonc`, where `base` reads the catalog-only one. */
const contentTemplate = (app: string) =>
  parse(readFileSync(join(import.meta.dirname, '..', 'apps', app, 'wrangler.jsonc'), 'utf8'));

const acme = toDeployment({
  id: 'acme',
  ring: 'canary',
  slot: 2,
  d1Id: 'd1-acme',
  catalogKvId: 'a'.repeat(32),
  jurisdiction: 'eu',
});

test('a customer gets its own domain, names and environment by default', () => {
  assert.equal(acme.domain, 'acme.commerceworker.com');
  assert.equal(acme.suffix, '-acme');
  assert.equal(acme.environment, 'deploy-acme');
});

test('the engine config carries the deployment everywhere a name is account-wide', () => {
  const c = renderEngine(base('engine'), acme);
  assert.equal(c.name, 'commerceworker-engine-acme');
  assert.deepEqual(
    c.workflows.map((w: { name: string }) => w.name),
    ['commerceworker-order-acme', 'commerceworker-replenish-acme'],
  );
  assert.equal(c.d1_databases[0].database_name, 'commerceworker-acme');
  assert.equal(c.d1_databases[0].database_id, 'd1-acme');
  assert.deepEqual(c.r2_buckets[0], {
    binding: 'DOCS',
    bucket_name: 'commerceworker-docs-acme',
    jurisdiction: 'eu',
  });
  assert.equal(c.vars.AI_GATEWAY_ID, 'commerceworker-acme');
  assert.equal(c.vars.AI_GATEWAY_LOGS, 'false');
  assert.equal(
    renderEngine(base('engine'), { ...acme, aiGatewayLogs: true }).vars.AI_GATEWAY_LOGS,
    'true',
  );
  assert.equal(c.vars.FX_CURRENCIES, '');
  assert.equal(
    renderEngine(base('engine'), { ...acme, fxCurrencies: ['EUR', 'GBP'] }).vars.FX_CURRENCIES,
    'EUR,GBP',
  );
  assert.deepEqual(c.vectorize, [
    { binding: 'PRODUCT_VECTORS', index_name: 'commerceworker-products-acme' },
  ]);
  assert.deepEqual(c.services[0], {
    binding: 'CATALOG',
    service: 'commerceworker-catalog-acme',
    entrypoint: 'CatalogApi',
  });
  // UCP catalog search reads the catalog's cached edge entrypoint of this deployment's delivery
  // Worker, so a platform sees what the public edge serves.
  assert.deepEqual(
    c.services.find((s: { binding: string }) => s.binding === 'CATALOG_EDGE'),
    {
      binding: 'CATALOG_EDGE',
      service: 'commerceworker-delivery-acme',
      entrypoint: 'CatalogRead',
    },
  );
  assert.equal(c.workers_dev, false);
});

test('the catalog config has its own name, bucket, card namespace and jurisdiction', () => {
  const c = renderCatalog(base('catalog'), acme);
  assert.equal(c.name, 'commerceworker-catalog-acme');
  assert.deepEqual(c.r2_buckets[0], {
    binding: 'PUBLISHED',
    bucket_name: 'commerceworker-catalog-acme',
    jurisdiction: 'eu',
  });
  assert.deepEqual(c.kv_namespaces[0], { binding: 'CARDS', id: 'a'.repeat(32) });
  assert.deepEqual(
    c.workflows.map((w: { name: string }) => w.name),
    [
      'commerceworker-catalog-feed-acme',
      'commerceworker-catalog-backup-acme',
      'commerceworker-catalog-restore-acme',
    ],
  );
  // The backup keeps its daily schedule under its suffixed name.
  assert.deepEqual(c.workflows[1].schedules, ['45 2 * * *']);
  assert.equal(c.queues.producers[0].queue, 'commerceworker-catalog-feed-parts-acme');
  assert.equal(c.queues.consumers[0].queue, 'commerceworker-catalog-feed-parts-acme');
  assert.equal(
    c.queues.consumers[0].dead_letter_queue,
    'commerceworker-catalog-feed-parts-dlq-acme',
  );
  assert.deepEqual(
    c.queues.consumers.map((q: { queue: string }) => q.queue),
    [
      'commerceworker-catalog-feed-parts-acme',
      'commerceworker-catalog-changes-acme',
      'commerceworker-catalog-feed-parts-dlq-acme',
      'commerceworker-catalog-changes-dlq-acme',
      'commerceworker-catalog-purge-dlq-acme',
    ],
  );
  assert.ok(
    c.queues.producers.some(
      (p: { queue: string }) => p.queue === 'commerceworker-catalog-changes-acme',
    ),
  );
  assert.equal(c.vars.DATA_JURISDICTION, 'eu');
  assert.equal(c.workers_dev, false);
  // It writes variant names and prices into the deployment's own D1.
  assert.deepEqual(c.d1_databases, [
    { binding: 'DB', database_name: 'commerceworker-acme', database_id: 'd1-acme' },
  ]);
});

test("delivery serves catalog.<domain> from the deployment's bucket, cards and purge queue, with content off", () => {
  const c = renderDelivery(base('delivery'), acme);
  assert.equal(acme.catalogDomain, 'catalog.acme.commerceworker.com');
  assert.equal(c.name, 'commerceworker-delivery-acme');
  assert.deepEqual(c.routes, [{ pattern: 'catalog.acme.commerceworker.com', custom_domain: true }]);
  assert.deepEqual(c.r2_buckets[0], {
    binding: 'PUBLISHED',
    bucket_name: 'commerceworker-catalog-acme',
    jurisdiction: 'eu',
  });
  assert.deepEqual(c.kv_namespaces[0], { binding: 'CARDS', id: 'a'.repeat(32) });
  assert.equal(c.queues.consumers[0].queue, 'commerceworker-catalog-purge-acme');
  assert.equal(c.queues.consumers[0].dead_letter_queue, 'commerceworker-catalog-purge-dlq-acme');
  assert.equal(c.queues.consumers[0].max_concurrency, 1);
  assert.equal(c.analytics_engine_datasets[0].dataset, 'commerceworker_catalog_delivery_acme');
  // Content is off: none of the content stack's bindings are bound, and the catalog's cached
  // entrypoint is the one with Workers Caching.
  for (const k of ['d1_databases', 'vectorize', 'ai', 'durable_objects', 'ratelimits', 'vars'])
    assert.equal(c[k], undefined, k);
  assert.equal(c.exports.CatalogDelivery.cache.enabled, true);
  // The engine's CATALOG_EDGE binding names this entrypoint, so the catalog-only delivery exports it
  // (the dispatcher with content does too: see the content deployment's exports below).
  assert.equal(c.exports.CatalogDelivery.type, 'worker');
  assert.equal(c.exports.CatalogRead.cache.enabled, false);
  // Search goes to this deployment's own catalog.
  assert.deepEqual(c.services, [
    { binding: 'CATALOG', service: 'commerceworker-catalog-acme', entrypoint: 'SearchApi' },
  ]);
  // The catalog sends to the same purge queue.
  const producers = renderCatalog(base('catalog'), acme).queues.producers;
  assert.ok(
    producers.some((p: { queue: string }) => p.queue === 'commerceworker-catalog-purge-acme'),
  );
  assert.equal(
    toDeployment({ id: 'beta', ring: 'canary', slot: 5, catalogDomain: 'products.b.example' })
      .catalogDomain,
    'products.b.example',
  );
  assert.throws(
    () => toDeployment({ id: 'beta', ring: 'canary', slot: 5, catalogDomain: 'x' }),
    /catalogDomain/,
  );
});

test("the catalog consumes every dead-letter queue, its own and delivery's, by the deployment's names", () => {
  type Consumer = { queue: string; dead_letter_queue?: string; retry_delay?: number };
  const catalog: Consumer[] = renderCatalog(base('catalog'), acme).queues.consumers;
  const edge: Consumer[] = renderDelivery(base('delivery'), acme).queues.consumers;
  const dlqs = [...catalog, ...edge].flatMap((c) => c.dead_letter_queue ?? []);
  const n = names(acme);
  assert.deepEqual(
    dlqs.sort(),
    [n.catalogChangesDlq, n.catalogFeedPartsDlq, n.catalogPurgeDlq].sort(),
  );
  const consumed = new Set(catalog.map((c) => c.queue));
  for (const q of dlqs) assert.ok(consumed.has(q), `${q} has no consumer`);
  // A dead-letter queue's consumer has no dead-letter queue of its own.
  for (const c of catalog.filter((c) => dlqs.includes(c.queue)))
    assert.equal(c.dead_letter_queue, undefined);
  // Every consumer delays a retry after a thrown invocation instead of redelivering at once.
  for (const c of [...catalog, ...edge])
    assert.ok((c.retry_delay ?? 0) > 0, `${c.queue} retry_delay`);
});

test('the web config binds its own engine, domain and rate-limit namespaces', () => {
  const c = renderWeb(base('web'), acme);
  assert.equal(c.name, 'commerceworker-web-acme');
  assert.deepEqual(c.routes, [{ pattern: 'acme.commerceworker.com', custom_domain: true }]);
  assert.equal(c.services[0].service, 'commerceworker-engine-acme');
  assert.equal(c.services[1].service, 'commerceworker-catalog-acme');
  assert.deepEqual(
    c.ratelimits.map((r: { namespace_id: string }) => r.namespace_id),
    ['2001', '2002', '2003', '2004', '2005'],
  );
  assert.equal(c.d1_databases[0].migrations_dir, '../../packages/db/migrations');
});

test('the storefront config binds the engine’s narrow entrypoint and its own host, and no data', () => {
  const c = renderStorefront(base('storefront'), acme);
  assert.equal(acme.storefrontDomain, 'shop.acme.commerceworker.com');
  assert.equal(c.name, 'commerceworker-storefront-acme');
  assert.deepEqual(c.routes, [{ pattern: 'shop.acme.commerceworker.com', custom_domain: true }]);
  // Reached only at its own host: no workers.dev or preview URL as a second way in.
  assert.equal(c.workers_dev, false);
  assert.equal(c.preview_urls, false);
  assert.deepEqual(c.services, [
    { binding: 'ENGINE', service: 'commerceworker-engine-acme', entrypoint: 'StorefrontApi' },
  ]);
  // It is public, so nothing but the engine's StorefrontApi: no database, no bucket, no queue, no
  // other Worker, in the template or in what a deployment renders.
  for (const config of [c, base('storefront')])
    for (const binding of [
      'd1_databases',
      'r2_buckets',
      'kv_namespaces',
      'queues',
      'durable_objects',
      'workflows',
      'vectorize',
      'ai',
    ])
      assert.equal(config[binding], undefined, `the storefront binds ${binding}`);
  // Namespaces follow the web Worker's five (<slot>001 to <slot>005): <slot>006 to <slot>012.
  assert.deepEqual(
    c.ratelimits.map((r: { name: string; namespace_id: string }) => [r.name, r.namespace_id]),
    [
      ['API_LIMIT', '2006'],
      ['AGENT_LIMIT', '2007'],
      ['PROMO_LIMIT', '2008'],
      ['CATALOG_LIMIT', '2009'],
      ['PAY_LIMIT', '2010'],
      ['SIGNIN_EMAIL_LIMIT', '2011'],
      ['SIGNIN_IP_LIMIT', '2012'],
    ],
  );
  // No two Workers of the fleet share a rate-limit namespace.
  const seen = new Map<string, string>();
  for (const d of [...loadDeployments().filter((x) => x.d1Id), acme])
    for (const [app, render] of [
      ['web', renderWeb],
      ['storefront', renderStorefront],
    ] as const)
      for (const r of render(base(app), d).ratelimits) {
        const key = r.namespace_id as string;
        assert.equal(seen.get(key), undefined, `${d.id} ${app} ${r.name} reuses ${key}`);
        seen.set(key, `${d.id} ${app} ${r.name}`);
      }
  // It binds nothing the buyer's pages don't need: no catalog, KV, queue or Durable Object.
  for (const key of ['kv_namespaces', 'queues', 'durable_objects', 'vectorize', 'ai'])
    assert.equal(c[key], undefined, key);
  // The web Worker is told where it is, to send a buyer to a cart's start link and nowhere else.
  assert.equal(
    renderWeb(base('web'), acme).vars.STOREFRONT_ORIGIN,
    'https://shop.acme.commerceworker.com',
  );
});

test('a storefront host is a host name, and the registry may name it', () => {
  assert.equal(
    toDeployment({ ...acme, storefrontDomain: 'buy.acme.example' }).storefrontDomain,
    'buy.acme.example',
  );
  const d = toDeployment({ ...acme, storefrontDomain: 'buy.acme.example' });
  assert.deepEqual(renderStorefront(base('storefront'), d).routes, [
    { pattern: 'buy.acme.example', custom_domain: true },
  ]);
  assert.equal(renderEngine(base('engine'), d).vars.STOREFRONT_ORIGIN, 'https://buy.acme.example');
  assert.match(renderEngine(base('engine'), d).vars.OWN_HOSTS, /buy\.acme\.example/);
  for (const bad of ['https://buy.acme.example', 'buy', 'Buy.Acme.Example', 7])
    assert.throws(() => toDeployment({ ...acme, storefrontDomain: bad }), /storefrontDomain/);
  // Defaults to shop.<domain>, following a customer's own domain.
  assert.equal(
    toDeployment({ ...acme, domain: 'orders.acme.example', storefrontDomain: undefined })
      .storefrontDomain,
    'shop.orders.acme.example',
  );
  assert.equal(shellVars(d).STOREFRONT_DOMAIN, 'buy.acme.example');
  assert.equal(shellVars(d).STOREFRONT, 'commerceworker-storefront-acme');
});

test("a customer's limits replace the base budgets they name", () => {
  const big = toDeployment({ ...acme, limits: { webhooks: 6000 } });
  // Takes the rendered config as fleet.ts types it (a loose record), so the shape is read, not checked.
  const limit = (c: Record<string, unknown>) =>
    Object.fromEntries(
      (c.ratelimits as { name: string; simple: { limit: number; period: number } }[]).map((r) => [
        r.name,
        r.simple,
      ]),
    );
  const c = limit(renderWeb(base('web'), big));
  assert.deepEqual(c.WEBHOOK_LIMIT, { limit: 6000, period: 60 });
  assert.deepEqual(c.API_LIMIT, limit(base('web')).API_LIMIT);
  // The storefront's two budgets follow the same keys.
  const agents = toDeployment({ ...acme, limits: { agents: 900 } });
  const s = limit(renderStorefront(base('storefront'), agents));
  assert.deepEqual(s.AGENT_LIMIT, { limit: 900, period: 60 });
  assert.deepEqual(s.API_LIMIT, limit(base('storefront')).API_LIMIT);
  // A platform's catalog budget is its own: raising agents leaves it, and `catalog` sets only it.
  assert.deepEqual(s.CATALOG_LIMIT, { limit: 120, period: 60 });
  const catalog = toDeployment({ ...acme, limits: { catalog: 500 } });
  const c2 = limit(renderStorefront(base('storefront'), catalog));
  assert.deepEqual(c2.CATALOG_LIMIT, { limit: 500, period: 60 });
  assert.deepEqual(c2.AGENT_LIMIT, limit(base('storefront')).AGENT_LIMIT);
  assert.throws(() => toDeployment({ ...acme, limits: { mcp: 10 } }), /limits.mcp/);
  assert.throws(() => toDeployment({ ...acme, limits: { api: 0 } }), /positive/);
});

test("app.commerceworker.com's own deployment renders the base configs unchanged", () => {
  const d = loadDeployments().find((x) => x.id === 'commerceworker')!;
  assert.deepEqual(renderCatalog(base('catalog'), d), base('catalog'));
  assert.deepEqual(renderDelivery(base('delivery'), d), base('delivery'));
  assert.deepEqual(renderEngine(base('engine'), d), base('engine'));
  assert.deepEqual(renderWeb(base('web'), d), base('web'));
  assert.deepEqual(renderStorefront(base('storefront'), d), base('storefront'));
  // Its punchout cancels the POs a buyer calls off: the grant ships in the same engine deploy as
  // the check, and the pinned bundle whose manifest asks for it.
  assert.deepEqual(JSON.parse(base('engine').vars.PLUGIN_GRANTS).punchout.capabilities, [
    'carts:external',
    'orders:start',
    'orders:cancel',
  ]);
});

// A deployment's Durable Objects take their classes and migrations from the base config alone:
// scripts/do-migrations.test.ts guards those, and a render that touched them would skip the guard.
test('rendering never changes Durable Object bindings or migrations', () => {
  const demo = toDeployment({ ...acme, id: 'acme-demo', demo: true });
  for (const d of [...loadDeployments().filter((x) => x.d1Id && x.catalogKvId), acme, demo]) {
    for (const [app, render] of [
      ['engine', renderEngine],
      ['catalog', renderCatalog],
    ] as const) {
      const c = render(base(app), d);
      assert.deepEqual(c.migrations, base(app).migrations, `${d.id}: ${app} migrations`);
      assert.deepEqual(c.durable_objects, base(app).durable_objects, `${d.id}: ${app} bindings`);
    }
    for (const [app, render] of [
      ['web', renderWeb],
      ['storefront', renderStorefront],
      ['delivery', renderDelivery],
    ] as const) {
      const c = render(base(app), d);
      assert.equal(c.migrations, undefined, `${d.id}: ${app} migrations`);
      assert.equal(c.durable_objects, undefined, `${d.id}: ${app} bindings`);
    }
  }
});

test('bad entries are refused', () => {
  assert.throws(() => toDeployment({ id: 'Acme', ring: 'canary', slot: 2, d1Id: 'x' }), /id must/);
  assert.throws(() => toDeployment({ id: 'acme', ring: 'beta', slot: 2, d1Id: 'x' }), /ring/);
  assert.throws(() => toDeployment({ id: 'api', ring: 'general', slot: 2 }), /reserved/);
  // CommerceWorker's own staging deployment may use the name, with its domain set.
  assert.equal(
    toDeployment({ id: 'staging', ring: 'staging', slot: 3, domain: 'staging.commerceworker.com' })
      .id,
    'staging',
  );
  assert.throws(
    () => renderEngine(base('engine'), toDeployment({ id: 'acme', ring: 'canary', slot: 2 })),
    /provision/,
  );
  assert.throws(
    () =>
      toDeployment({ id: 'acme', ring: 'canary', slot: 2, catalogKvId: 'commerceworker-cards' }),
    /catalogKvId/,
  );
  assert.throws(
    () =>
      renderCatalog(
        base('catalog'),
        toDeployment({ id: 'acme', ring: 'canary', slot: 2, d1Id: 'x' }),
      ),
    /catalogKvId: run scripts\/provision.sh acme/,
  );
});

test('an unprovisioned deployment blocks the matrix unless it is held', () => {
  const fresh = toDeployment({ id: 'new', ring: 'general', slot: 4 });
  assert.throws(() => matrix([acme, fresh]), /not provisioned/);
  // D1 alone isn't enough: the catalog needs its card namespace too.
  assert.throws(() => matrix([acme, { ...fresh, d1Id: 'x' }]), /not provisioned/);
  assert.deepEqual(matrix([acme, { ...fresh, hold: true }]).general, []);
});

test('the matrix groups by ring and leaves held deployments out', () => {
  const held = toDeployment({ id: 'beta', ring: 'canary', slot: 3, d1Id: 'x', hold: true });
  const m = matrix([acme, held]);
  assert.deepEqual(
    m.canary.map((d) => d.id),
    ['acme'],
  );
  assert.deepEqual(m.general, []);
});

test('a demo mocks models, speeds up time and turns on demo sign-in', () => {
  const demo = toDeployment({
    id: 'demo',
    ring: 'internal',
    slot: 5,
    d1Id: 'd',
    domain: 'demo.commerceworker.com',
    demo: true,
  });
  const engine = renderEngine(base('engine'), demo);
  assert.equal(engine.vars.AI_MODE, 'mock');
  assert.equal(engine.vars.AI_GATEWAY_ID, '');
  assert.equal(engine.vars.TIME_SCALE, '1440');
  assert.equal(engine.vars.SIMULATE_FAILURES, 'true');
  // No model calls, so no product index to provision or bind.
  assert.equal(engine.vectorize, undefined);
  assert.equal(renderEngine(base('engine'), acme).vars.SIMULATE_FAILURES, '');
  assert.equal(renderWeb(base('web'), demo).vars.DEMO_MODE, 'true');
  assert.equal(renderWeb(base('web'), acme).vars.DEMO_MODE, '');
});

test("a customer's auditRetentionDays sets the engine's retention, at least 90 days", () => {
  const long = toDeployment({ ...acme, auditRetentionDays: 2555 });
  assert.equal(renderEngine(base('engine'), long).vars.AUDIT_RETENTION_DAYS, '2555');
  assert.equal(renderEngine(base('engine'), toDeployment(acme)).vars.AUDIT_RETENTION_DAYS, '400');
  assert.throws(() => toDeployment({ ...acme, auditRetentionDays: 30 }), /at least 90/);
  assert.throws(() => toDeployment({ ...acme, auditRetentionDays: '400' }), /auditRetentionDays/);
});

test('workflow AI nodes see personal data only where the registry says send', () => {
  assert.equal(renderEngine(base('engine'), toDeployment(acme)).vars.AI_PERSONAL_DATA, 'redact');
  const send = toDeployment({ ...acme, aiPersonalData: 'send' });
  assert.equal(renderEngine(base('engine'), send).vars.AI_PERSONAL_DATA, 'send');
  assert.throws(() => toDeployment({ ...acme, aiPersonalData: 'all' }), /aiPersonalData/);
  assert.equal(toDeployment(acme).aiGatewayLogs, false);
  assert.equal(toDeployment({ ...acme, aiGatewayLogs: true }).aiGatewayLogs, true);
  assert.deepEqual(toDeployment(acme).fxCurrencies, []);
  assert.deepEqual(toDeployment({ ...acme, fxCurrencies: ['EUR', 'GBP', 'EUR'] }).fxCurrencies, [
    'EUR',
    'GBP',
  ]);
  for (const bad of [['USD'], ['eur'], 'EUR', ['EURO']])
    assert.throws(() => toDeployment({ ...acme, fxCurrencies: bad }), /fxCurrencies/);
});

test("a customer's personalDataRetentionDays sets the sweep's, at least 30 days", () => {
  // `acme` already carries the default logRetentionDays (400), longer than this: leave it out.
  const short = toDeployment({
    ...acme,
    personalDataRetentionDays: 365,
    logRetentionDays: undefined,
  });
  assert.equal(renderEngine(base('engine'), short).vars.PERSONAL_DATA_RETENTION_DAYS, '365');
  assert.equal(
    renderEngine(base('engine'), toDeployment(acme)).vars.PERSONAL_DATA_RETENTION_DAYS,
    '',
  );
  assert.throws(() => toDeployment({ ...acme, personalDataRetentionDays: 7 }), /at least 30/);
  assert.throws(() => toDeployment({ ...acme, auditArchiveDays: 0 }), /auditArchiveDays/);
});

test('catalogBackupDays sets how long provision.sh keeps and locks catalog backups, at least 31', () => {
  assert.equal(toDeployment(acme).catalogBackupDays, 90);
  assert.equal(shellVars(toDeployment(acme)).CATALOG_BACKUP_DAYS, '90');
  const year = toDeployment({ ...acme, catalogBackupDays: 365 });
  assert.equal(shellVars(year).CATALOG_BACKUP_DAYS, '365');
  assert.equal(toDeployment({ ...acme, catalogBackupDays: 31 }).catalogBackupDays, 31);
  // Shorter than Durable Objects' 30 days of point-in-time recovery adds nothing.
  assert.throws(() => toDeployment({ ...acme, catalogBackupDays: 30 }), /at least 31/);
  assert.throws(() => toDeployment({ ...acme, catalogBackupDays: 45.5 }), /catalogBackupDays/);
  assert.throws(() => toDeployment({ ...acme, catalogBackupDays: '90' }), /catalogBackupDays/);
});

test("an EU customer's Durable Objects are in the EU, like their D1 and R2", () => {
  const eu = toDeployment({ ...acme, jurisdiction: 'eu' });
  const c = renderEngine(base('engine'), eu);
  assert.equal(c.vars.DATA_JURISDICTION, 'eu');
  assert.equal(c.r2_buckets[0].jurisdiction, 'eu');
  const anywhere = toDeployment({ ...acme, jurisdiction: undefined });
  assert.equal(renderEngine(base('engine'), anywhere).vars.DATA_JURISDICTION, '');
});

test("a customer's sso sets the web Worker's identity provider", () => {
  const sso = toDeployment({
    ...acme,
    sso: { issuer: 'https://acme.okta.com', clientId: '0oa123' },
  });
  const c = renderWeb(base('web'), sso);
  assert.equal(c.vars.OIDC_ISSUER, 'https://acme.okta.com');
  assert.equal(c.vars.OIDC_CLIENT_ID, '0oa123');
  assert.equal(renderWeb(base('web'), acme).vars.OIDC_ISSUER, '');
  assert.throws(
    () => toDeployment({ ...acme, sso: { issuer: 'http://acme.okta.com', clientId: 'x' } }),
    /https issuer/,
  );
  assert.throws(
    () => toDeployment({ ...acme, sso: { issuer: 'https://acme.okta.com' } }),
    /clientId/,
  );
  // An email without email_verified is trusted only when the registry says so (Entra ID).
  assert.equal(c.vars.OIDC_TRUST_EMAIL, '');
  const entra = toDeployment({
    ...acme,
    sso: { issuer: 'https://login.microsoftonline.com/t/v2.0', clientId: 'app', trustEmail: true },
  });
  assert.equal(renderWeb(base('web'), entra).vars.OIDC_TRUST_EMAIL, 'true');
  assert.throws(
    () =>
      toDeployment({
        ...acme,
        sso: { issuer: 'https://acme.okta.com', clientId: 'x', trustEmail: 'yes' },
      }),
    /trustEmail/,
  );
});

test("a customer's assistantDailyTokens sets the assistant's budget", () => {
  const big = toDeployment({ ...acme, assistantDailyTokens: 0 });
  assert.equal(renderEngine(base('engine'), big).vars.ASSISTANT_DAILY_TOKENS, '0');
  assert.equal(renderEngine(base('engine'), acme).vars.ASSISTANT_DAILY_TOKENS, '1000000');
  assert.throws(() => toDeployment({ ...acme, assistantDailyTokens: -1 }), /assistantDailyTokens/);
});

test('payments are mocked unless the registry says stripe, with its publishable key', () => {
  const mocked = renderEngine(base('engine'), acme);
  assert.equal(mocked.vars.PAYMENTS_MODE, 'mock');
  assert.equal(mocked.vars.STRIPE_PUBLISHABLE_KEY, '');
  const live = toDeployment({
    ...acme,
    payments: 'stripe',
    stripePublishableKey: 'pk_live_abc123',
    turnstileSiteKey: '0x4AAAAAAABkMYinukE8nzY',
  });
  const engine = renderEngine(base('engine'), live);
  assert.equal(engine.vars.PAYMENTS_MODE, 'stripe');
  assert.equal(engine.vars.STRIPE_PUBLISHABLE_KEY, 'pk_live_abc123');
  assert.throws(() => toDeployment({ ...acme, payments: 'paypal' }), /payments must/);
  assert.throws(
    () => toDeployment({ ...acme, payments: 'stripe', stripePublishableKey: 'sk_live_abc' }),
    /publishable key/,
  );
  assert.throws(
    () => toDeployment({ ...acme, stripePublishableKey: 'pk_test_abc' }),
    /needs payments/,
  );
  assert.throws(
    () => toDeployment({ id: 'demo', ring: 'internal', slot: 5, demo: true, payments: 'stripe' }),
    /demo/,
  );
});

test('a Stripe deployment needs STRIPE_SECRET_KEY in the same mode as its publishable key', () => {
  assert.equal(secretsProblem(acme, {}, 'engine'), null);
  const stripe = toDeployment({
    ...acme,
    payments: 'stripe',
    stripePublishableKey: 'pk_test_abc',
    turnstileSiteKey: '0x4AAAAAAABkMYinukE8nzY',
  });
  assert.match(secretsProblem(stripe, {}, 'engine') ?? '', /STRIPE_SECRET_KEY/);
  // (A site key makes the storefront and the web Worker want the widget's secret too.)
  assert.match(
    secretsProblem(stripe, { STRIPE_SECRET_KEY: 'sk_live_x' }, 'engine') ?? '',
    /both test or both live/,
  );
  assert.equal(secretsProblem(stripe, { STRIPE_SECRET_KEY: 'rk_test_x' }, 'engine'), null);
  // The web Worker doesn't take payments; it needs the widget's secret, which the key brings.
  assert.equal(secretsProblem(stripe, { TURNSTILE_SECRET_KEY: 'x' }, 'web'), null);
});

test("a customer's turnstileSiteKey turns on the web Worker's Turnstile check", () => {
  const key = '0x4AAAAAAABkMYinukE8nzY';
  const guarded = toDeployment({ ...acme, turnstileSiteKey: key });
  assert.equal(renderWeb(base('web'), guarded).vars.TURNSTILE_SITE_KEY, key);
  assert.equal(renderStorefront(base('storefront'), guarded).vars.TURNSTILE_SITE_KEY, key);
  assert.equal(renderStorefront(base('storefront'), acme).vars.TURNSTILE_SITE_KEY, '');
  // Always rendered, so a deployment without one never keeps another's.
  assert.equal(renderWeb(base('web'), acme).vars.TURNSTILE_SITE_KEY, '');
  assert.equal(shellVars(guarded).TURNSTILE_SITE_KEY, key);
  assert.equal(shellVars(acme).TURNSTILE_SITE_KEY, '');
  for (const bad of ['', 'pk_live_abc', '0x4AAA AAAA', '0x1', 42, '0x4AAAAAAABkMYinukE8nzY;'])
    assert.throws(() => toDeployment({ ...acme, turnstileSiteKey: bad }), /turnstileSiteKey/);
});

test("Cloudflare's Turnstile test keys are refused in production and on customers", () => {
  const test = '1x00000000000000000000AA';
  const production = {
    id: 'commerceworker',
    ring: 'internal',
    slot: 1,
    domain: 'commerceworker.com',
    suffix: '',
    environment: 'production',
  };
  for (const k of [test, '2x00000000000000000000AB', '3x00000000000000000000FF']) {
    assert.throws(() => toDeployment({ ...production, turnstileSiteKey: k }), /test key/);
    assert.throws(() => toDeployment({ ...acme, turnstileSiteKey: k }), /test key/);
  }
  assert.equal(
    toDeployment({ ...production, turnstileSiteKey: '0x4AAAAAAABkMYinukE8nzY' }).turnstileSiteKey,
    '0x4AAAAAAABkMYinukE8nzY',
  );
});

test('a demo may use a Turnstile test key', () => {
  const demo = {
    id: 'demo',
    ring: 'internal',
    slot: 5,
    domain: 'demo.commerceworker.com',
    demo: true,
  };
  const d = toDeployment({ ...demo, turnstileSiteKey: '1x00000000000000000000AA' });
  assert.equal(d.turnstileSiteKey, '1x00000000000000000000AA');
  assert.equal(
    renderWeb(base('web'), { ...d, d1Id: 'd1-demo' }).vars.TURNSTILE_SITE_KEY,
    '1x00000000000000000000AA',
  );
  assert.throws(
    () => toDeployment({ ...demo, turnstileSiteKey: '4x00000000000000000000AA' }),
    /turnstileSiteKey/,
  );
});

test("the storefront's secrets file holds its derived keys and never the principal key", () => {
  const dir = mkdtempSync(join(tmpdir(), 'storefront-secrets-'));
  try {
    const out = join(dir, 'storefront-secrets.json');
    const key = 'a'.repeat(64);
    const previous = 'b'.repeat(64);
    const run = (extra: Record<string, string>) =>
      execFileSync('node', ['scripts/fleet.ts', 'secrets', 'storefront', out, 'commerceworker'], {
        cwd: join(import.meta.dirname, '..'),
        env: {
          PATH: process.env.PATH,
          PRINCIPAL_KEY: key,
          DATA_KEY: key,
          PASSWORD_PEPPER: key,
          STRIPE_SECRET_KEY: 'sk_test_x',
          TURNSTILE_SECRET_KEY: 'x',
          SETUP_TOKEN: 'x',
          ...extra,
        },
        stdio: 'pipe',
      });
    run({ PRINCIPAL_KEY_PREVIOUS: previous });
    // The storefront's key and its previous one (which verifies the buyer's cookie during a
    // rotation), derived, and the Turnstile widget's secret (it checks a card payment); no principal
    // key, and nothing else of the admin's: no data key, pepper, setup code or payment secret.
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(written, {
      STOREFRONT_KEY: storefrontKey(key),
      STOREFRONT_KEY_PREVIOUS: storefrontKey(previous),
      TURNSTILE_SECRET_KEY: 'x',
    });
    assert.ok(!readFileSync(out, 'utf8').includes(key));
    assert.ok(!('PRINCIPAL_KEY' in written));
    // Outside a rotation there is no previous key.
    run({});
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
      STOREFRONT_KEY: storefrontKey(key),
      TURNSTILE_SECRET_KEY: 'x',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Like the web Worker's, it is never held back by another app's secret.
  assert.equal(
    secretsProblem(toDeployment({ ...acme, payments: 'stripe' }), {}, 'storefront'),
    null,
  );
});

test('the storefront is rendered with no PRINCIPAL_KEY secret and no D1 binding', () => {
  for (const d of loadDeployments().filter((x) => x.d1Id)) {
    const c = renderStorefront(base('storefront'), d);
    assert.equal(c.d1_databases, undefined, d.id);
    assert.equal(c.r2_buckets, undefined, d.id);
    // A secret is never in the config; the template's comments name the one it expects.
    assert.ok(!JSON.stringify(c).includes('PRINCIPAL_KEY'), d.id);
  }
  const template = readFileSync(
    join(import.meta.dirname, '..', 'apps', 'storefront', 'wrangler.jsonc'),
    'utf8',
  );
  assert.ok(!/\bDB\b|\bDOCS\b/.test(template.replace(/\/\/.*$/gm, '')));
  // The deploy's secrets for it are derived: PRINCIPAL_KEY is not among them.
  const secrets = storefrontSecrets({ PRINCIPAL_KEY: 'p'.repeat(40) });
  assert.deepEqual(Object.keys(secrets), ['STOREFRONT_KEY']);
  // With a Turnstile widget it also gets that widget's secret: the same one the web Worker checks with.
  assert.deepEqual(
    storefrontSecrets({ PRINCIPAL_KEY: 'p'.repeat(40), TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecret' }),
    { STOREFRONT_KEY: storefrontKey('p'.repeat(40)), TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecret' },
  );
});

test('a deployment that takes cards through Stripe needs a Turnstile site key for the storefront', () => {
  const live = { ...acme, payments: 'stripe', stripePublishableKey: 'pk_test_abc' };
  assert.throws(() => toDeployment(live), /turnstileSiteKey/);
  assert.equal(
    toDeployment({ ...live, turnstileSiteKey: '0x4AAAAAAABkMYinukE8nzY' }).payments,
    'stripe',
  );
  // Without a publishable key the storefront offers no card, so nothing needs guarding.
  assert.equal(toDeployment({ ...acme, payments: 'stripe' }).payments, 'stripe');
});

test("a customer's turnstileSiteKey turns on the storefront's Turnstile check of a card payment", () => {
  const key = '0x4AAAAAAABkMYinukE8nzY';
  const guarded = toDeployment({ ...acme, turnstileSiteKey: key });
  assert.equal(renderStorefront(base('storefront'), guarded).vars.TURNSTILE_SITE_KEY, key);
  // Always set, so one deployment's widget is never another's.
  assert.equal(renderStorefront(base('storefront'), acme).vars.TURNSTILE_SITE_KEY, '');
  // The widget's secret is the storefront's own, beside its derived key; a deploy needs it.
  assert.match(
    secretsProblem(guarded, {}, 'storefront') ?? '',
    /TURNSTILE_SECRET_KEY to the deploy-acme GitHub environment/,
  );
  assert.equal(secretsProblem(guarded, { TURNSTILE_SECRET_KEY: 'x' }, 'storefront'), null);
  assert.equal(secretsProblem(acme, {}, 'storefront'), null);
  assert.deepEqual(
    Object.keys(storefrontSecrets({ PRINCIPAL_KEY: 'p'.repeat(40), TURNSTILE_SECRET_KEY: 'x' })),
    ['STOREFRONT_KEY', 'TURNSTILE_SECRET_KEY'],
  );
});

test("the engine's secrets include the Apple Pay domain file, and the publishable key is a var, never a secret", () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-secrets-'));
  try {
    const out = join(dir, 'engine-secrets.json');
    execFileSync('node', ['scripts/fleet.ts', 'secrets', 'engine', out, 'commerceworker'], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        PATH: process.env.PATH,
        PRINCIPAL_KEY: 'a'.repeat(64),
        DATA_KEY: 'a'.repeat(64),
        PASSWORD_PEPPER: 'a'.repeat(64),
        STRIPE_SECRET_KEY: 'sk_test_x',
        APPLE_PAY_DOMAIN_ASSOCIATION: '7B227073',
      },
      stdio: 'pipe',
    });
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(written.APPLE_PAY_DOMAIN_ASSOCIATION, '7B227073');
    assert.ok(!('STRIPE_PUBLISHABLE_KEY' in written));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const pk = toDeployment({
    ...acme,
    payments: 'stripe',
    stripePublishableKey: 'pk_test_abc',
    turnstileSiteKey: '0x4AAAAAAABkMYinukE8nzY',
  });
  assert.equal(renderEngine(base('engine'), pk).vars.STRIPE_PUBLISHABLE_KEY, 'pk_test_abc');
});

test("the storefront's key is derived as core derives it, and is neither the principal key nor another derived one", () => {
  // The same vector as packages/core/tests/roles.test.ts.
  assert.equal(
    storefrontKey('test-principal-key'),
    '58f5d0618f717f32946e47fdca333e17c0028a75a0f2db4c78f0bb57f17dad5d',
  );
  assert.notEqual(storefrontKey('test-principal-key'), 'test-principal-key');
  assert.notEqual(storefrontKey('test-principal-key'), healthCheckKey('test-principal-key'));
  assert.notEqual(
    storefrontKey('test-principal-key'),
    pluginKey('test-principal-key', 'storefront'),
  );
});

test('a deployment with a Turnstile site key needs its secret to deploy', () => {
  const guarded = toDeployment({ ...acme, turnstileSiteKey: '0x4AAAAAAABkMYinukE8nzY' });
  assert.match(
    secretsProblem(guarded, {}, 'web') ?? '',
    /TURNSTILE_SECRET_KEY to the deploy-acme GitHub environment/,
  );
  assert.equal(secretsProblem(guarded, { TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecret' }, 'web'), null);
  // The storefront checks them too, on asking for a shopper's code, and is vetted the same way.
  assert.match(secretsProblem(guarded, {}, 'storefront') ?? '', /TURNSTILE_SECRET_KEY/);
  assert.equal(
    secretsProblem(guarded, { TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecret' }, 'storefront'),
    null,
  );
  assert.equal(secretsProblem(acme, {}, 'storefront'), null);
  // The engine never checks tokens.
  assert.equal(secretsProblem(guarded, {}, 'engine'), null);
  assert.equal(secretsProblem(acme, {}, 'web'), null);
});

const withLedger = toDeployment({
  id: 'acme',
  ring: 'canary',
  slot: 2,
  d1Id: 'd1-acme',
  catalogKvId: 'a'.repeat(32),
  plugins: { ledger: { d1Id: 'd1-ledger' } },
});

test('no plugins changes nothing in the engine and web configs', () => {
  const none = toDeployment({ id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1-acme' });
  assert.deepEqual(none.plugins, {});
  const bindings = (c: Record<string, unknown>) =>
    (c.services as { binding: string }[]).map((s) => s.binding);
  assert.deepEqual(bindings(renderEngine(base('engine'), none)), bindings(base('engine')));
  assert.deepEqual(bindings(renderWeb(base('web'), none)), bindings(base('web')));
});

test('a plugin is bound to the engine and the web Worker by its own Worker name', () => {
  const binding = { binding: 'PLUGIN_LEDGER', service: 'commerceworker-plugin-ledger-acme' };
  assert.deepEqual(renderEngine(base('engine'), withLedger).services.at(-1), binding);
  assert.deepEqual(renderWeb(base('web'), withLedger).services.at(-1), binding);
});

test('a plugin config gets its own name and database', () => {
  const pluginBase = { name: 'commerceworker-plugin-ledger', d1_databases: [{ binding: 'DB' }] };
  const c = renderPlugin(pluginBase, withLedger, 'ledger');
  assert.equal(c.name, 'commerceworker-plugin-ledger-acme');
  assert.deepEqual(c.d1_databases[0], {
    binding: 'DB',
    database_name: 'commerceworker-plugin-ledger-acme',
    database_id: 'd1-ledger',
  });
  assert.throws(
    () => renderPlugin(pluginBase, { ...withLedger, plugins: { ledger: {} } }, 'ledger'),
    /no d1Id/,
  );
});

test('plugins are checked: ids, fixtures and provisioning', () => {
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  assert.throws(() => toDeployment({ ...raw, plugins: ['ledger'] }), /plugins must be an object/);
  assert.throws(() => toDeployment({ ...raw, plugins: { Bad_Id: {} } }), /not a plugin id/);
  assert.throws(() => toDeployment({ ...raw, plugins: { example: {} } }), /test fixture/);
  assert.throws(
    () => matrix([toDeployment({ ...raw, plugins: { ledger: {} } })]),
    /not provisioned/,
  );
  assert.equal(pluginBinding('qbd-sync'), 'PLUGIN_QBD_SYNC');
});

test('a plugin may declare only its database and vars, and gets one D1 binding', () => {
  const base = { name: 'commerceworker-plugin-ledger', main: 'src/index.ts', vars: { A: '1' } };
  for (const key of [
    'services',
    'durable_objects',
    'r2_buckets',
    'kv_namespaces',
    'queues',
    'routes',
  ])
    assert.throws(
      () => renderPlugin({ ...base, [key]: [] }, withLedger, 'ledger'),
      new RegExp(`may not declare ${key}`),
    );
  assert.throws(
    () =>
      renderPlugin(
        { ...base, d1_databases: [{ binding: 'DB' }, { binding: 'OTHER' }] },
        withLedger,
        'ledger',
      ),
    /one D1 binding, named DB/,
  );
  assert.throws(
    () => renderPlugin({ ...base, d1_databases: [{ binding: 'CORE' }] }, withLedger, 'ledger'),
    /named DB/,
  );
  assert.deepEqual(renderPlugin(base, withLedger, 'ledger').vars, { A: '1' });
});

test('a plugin gets only its own PLUGIN_<ID>_* secrets, under their own names', () => {
  const source = {
    PRINCIPAL_KEY: 'p',
    STRIPE_SECRET_KEY: 'sk',
    PLUGIN_SHIPSTATION_API_KEY: 'k1',
    PLUGIN_SHIPSTATION_API_SECRET: 's1',
    PLUGIN_SHIPSTATION_UNSET: '',
    PLUGIN_LEDGER_API_KEY: 'k2',
  };
  assert.deepEqual(pluginOwnSecrets('shipstation', source), { API_KEY: 'k1', API_SECRET: 's1' });
  assert.deepEqual(pluginOwnSecrets('qbd-sync', { PLUGIN_QBD_SYNC_TOKEN: 't' }), { TOKEN: 't' });
  assert.throws(
    () => pluginOwnSecrets('ledger', { PLUGIN_LEDGER_PLUGIN_KEY: 'x' }),
    /can't be a secret name/,
  );
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  assert.throws(
    () => toDeployment({ ...raw, plugins: { ship: {}, 'ship-rates': {} } }),
    /can't both be installed/,
  );
});

test("a plugin's key is derived from the principal key, as core derives it", () => {
  // The same vector as packages/core/tests/plugins.test.ts.
  assert.equal(
    pluginKey('test-principal-key', 'example'),
    'bfc9294662be00d5e8ec7e7a857bee5a04f3bb77e41fb5155f6813b6171ec44b',
  );
  assert.notEqual(
    pluginKey('test-principal-key', 'ledger'),
    pluginKey('test-principal-key', 'example'),
  );
});

test("the smoke test's write check is signed as core derives and checks it", () => {
  // The same vectors as packages/core/tests/roles.test.ts.
  assert.equal(
    healthCheckKey('test-principal-key'),
    '18d9a956eaa3d6d22a3d7ecb24841ac3681037cbdac7c959ec4769600bac71bf',
  );
  assert.equal(
    signHealthCheck('test-principal-key', 0),
    'h1.eyJwYXRoIjoiL2hlYWx0aC93cml0ZSIsImV4cCI6NjAwMDB9.rbJ6ESveYOBQJ3QeIU0aTX9A8yT7goUa44TzGYYf_p8',
  );
  // Its own key: never the principal key, nor any plugin's.
  assert.notEqual(healthCheckKey('test-principal-key'), 'test-principal-key');
  assert.notEqual(healthCheckKey('test-principal-key'), pluginKey('test-principal-key', 'health'));
});

/** A local server answering each request with `answer(n)` (`null`: never answers), and its URL. */
async function server(answer: (n: number) => { status: number; body: string } | null) {
  let n = 0;
  const headers: (string | undefined)[] = [];
  const s = createServer((req, res) => {
    headers.push(req.headers['x-commerceworker-health-check'] as string | undefined);
    const a = answer(++n);
    if (a) res.writeHead(a.status).end(a.body);
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/health/write`,
    headers,
    close: () => {
      s.closeAllConnections();
      s.close();
    },
  };
}

test('the write check retries until the report is ok, signing each attempt', async () => {
  const s = await server((n) =>
    n < 3 ? { status: 503, body: '{"ok":false}' } : { status: 200, body: '{"ok":true}' },
  );
  const lines: string[] = [];
  try {
    const report = await postWriteCheck(s.url, 'test-principal-key', {
      deadlineMs: 5_000,
      delayMs: 10,
      log: (l) => lines.push(l),
    });
    assert.equal(report, '{"ok":true}');
    assert.equal(s.headers.length, 3);
    assert.ok(s.headers.every((h) => h?.startsWith('h1.')));
    // The log says which attempt failed and how, never the header.
    assert.deepEqual(lines, [
      'write check attempt 1 failed: 503 {"ok":false}',
      'write check attempt 2 failed: 503 {"ok":false}',
    ]);
  } finally {
    s.close();
  }
});

test('the write check gives up at its deadline, even when the deployment never answers', async () => {
  const s = await server(() => null);
  const started = Date.now();
  try {
    await assert.rejects(
      postWriteCheck(s.url, 'test-principal-key', {
        deadlineMs: 600,
        attemptMs: 250,
        delayMs: 100,
        log: () => {},
      }),
      /write check failed/,
    );
    // Within the deadline and a little slack: no attempt or wait outlives it.
    assert.ok(Date.now() - started < 900, `took ${Date.now() - started} ms`);
    assert.ok(s.headers.length >= 2);
  } finally {
    s.close();
  }
  // The defaults keep it to the smoke test's five minutes, an attempt to ten seconds.
  assert.equal(WRITE_CHECK_DEADLINE_MS, 300_000);
  assert.equal(WRITE_CHECK_ATTEMPT_MS, 10_000);
});

test('buyer details are granted to a plugin only by its registry entry', () => {
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  const granted = toDeployment({
    ...raw,
    plugins: { ledger: { d1Id: 'x', personalData: 'send' }, qbd: { d1Id: 'y' } },
  });
  assert.equal(
    renderEngine(base('engine'), granted).vars.PLUGIN_GRANTS,
    '{"ledger":{"personalData":"send"}}',
  );
  assert.equal(renderEngine(base('engine'), withLedger).vars.PLUGIN_GRANTS, '');
  assert.throws(
    () => toDeployment({ ...raw, plugins: { ledger: { personalData: 'yes' } } }),
    /can only be "send"/,
  );
  assert.throws(
    () => toDeployment({ ...raw, plugins: { ledger: { events: ['*'] } } }),
    /unknown keys: events/,
  );
});

test('capabilities are granted by the registry, and bind the host API as the plugin itself', () => {
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  const d = toDeployment({
    ...raw,
    plugins: {
      punchout: { d1Id: 'x', capabilities: ['carts:external', 'orders:start', 'orders:cancel'] },
      qbd: { d1Id: 'y' },
    },
  });
  assert.equal(
    renderEngine(base('engine'), d).vars.PLUGIN_GRANTS,
    '{"punchout":{"capabilities":["carts:external","orders:start","orders:cancel"]}}',
  );
  // Cancelling is its own grant: starting orders doesn't bring it.
  assert.equal(
    renderEngine(
      base('engine'),
      toDeployment({
        ...raw,
        plugins: { punchout: { d1Id: 'x', capabilities: ['orders:start'] } },
      }),
    ).vars.PLUGIN_GRANTS,
    '{"punchout":{"capabilities":["orders:start"]}}',
  );
  const pluginBase = { name: 'x', main: 'src/index.ts', d1_databases: [{ binding: 'DB' }] };
  assert.deepEqual(renderPlugin(pluginBase, d, 'punchout').services, [
    {
      binding: 'COMMERCEWORKER',
      service: renderEngine(base('engine'), d).name,
      entrypoint: 'PluginHost',
      props: { id: 'punchout' },
    },
  ]);
  const vars = renderEngine(base('engine'), d).vars;
  // An external cart's start link is on the storefront; its return never posts to any host we serve.
  assert.equal(vars.STOREFRONT_ORIGIN, 'https://shop.acme.commerceworker.com');
  assert.equal(vars.APP_ORIGIN, undefined);
  assert.equal(
    vars.OWN_HOSTS,
    'acme.commerceworker.com,shop.acme.commerceworker.com,catalog.acme.commerceworker.com',
  );
  // No capability, no host binding.
  assert.equal(renderPlugin(pluginBase, d, 'qbd').services, undefined);
  assert.throws(
    () => toDeployment({ ...raw, plugins: { punchout: { capabilities: ['orders:delete'] } } }),
    /capabilities must list/,
  );
  assert.throws(
    () =>
      toDeployment({
        ...raw,
        plugins: { punchout: { capabilities: ['orders:start', 'orders:start'] } },
      }),
    /at most once/,
  );
});

const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
const STORE = '0123456789abcdef0123456789abcdef';

test('a sandboxed plugin has no Worker, binding or database of its own', () => {
  const d = toDeployment({
    ...raw,
    plugins: { ledger: { d1Id: 'd1-ledger' }, carrier: { runtime: 'sandboxed' } },
  });
  assert.deepEqual(workerPlugins(d), ['ledger']);
  assert.deepEqual(sandboxedPlugins(d), ['carrier']);
  const bindings = (c: { services?: { binding: string }[] }) =>
    (c.services ?? []).map((s) => s.binding).filter((b) => b.startsWith('PLUGIN_'));
  assert.deepEqual(bindings(renderEngine(base('engine'), d)), ['PLUGIN_LEDGER']);
  assert.deepEqual(bindings(renderWeb(base('web'), d)), ['PLUGIN_LEDGER']);
  assert.throws(() => renderPlugin({}, d, 'carrier'), /sandboxed: no Worker/);
  // Needs no d1Id to deploy.
  assert.doesNotThrow(() => matrix([d]));
  assert.throws(
    () => toDeployment({ ...raw, plugins: { carrier: { runtime: 'sandboxed', d1Id: 'x' } } }),
    /sandboxed: it has no D1 database/,
  );
  assert.throws(() => toDeployment({ ...raw, plugins: { carrier: { runtime: 'vm' } } }), /runtime/);
});

test('plugin ids are refused when reserved or with a double dash', () => {
  for (const id of ['bundles', 'secrets', 'grants', 'key', 'publishers'])
    assert.throws(() => toDeployment({ ...raw, plugins: { [id]: {} } }), /reserved/);
  assert.throws(() => toDeployment({ ...raw, plugins: { 'a--b': {} } }), /not a plugin id/);
  assert.throws(() => toDeployment({ ...raw, plugins: { 'ab-': {} } }), /not a plugin id/);
});

test('on its own account, plugin secrets are bound from the Secrets Store', () => {
  const d = toDeployment({
    ...raw,
    secretsStore: { storeId: STORE },
    plugins: {
      ledger: { d1Id: 'd1-ledger', secrets: ['API_KEY'] },
      carrier: { runtime: 'sandboxed', secrets: ['API_KEY', 'HOOK'] },
    },
  });
  assert.deepEqual(renderEngine(base('engine'), d).secrets_store_secrets, [
    {
      binding: 'PLUGIN_SECRET_CARRIER__API_KEY',
      store_id: STORE,
      secret_name: 'PLUGIN_CARRIER_API_KEY',
    },
    { binding: 'PLUGIN_SECRET_CARRIER__HOOK', store_id: STORE, secret_name: 'PLUGIN_CARRIER_HOOK' },
  ]);
  const plugin = renderPlugin({ name: 'x', d1_databases: [{ binding: 'DB' }] }, d, 'ledger');
  assert.deepEqual(plugin.secrets_store_secrets, [
    { binding: 'API_KEY', store_id: STORE, secret_name: 'PLUGIN_LEDGER_API_KEY' },
  ]);
  assert.throws(() => toDeployment({ ...raw, secretsStore: { storeId: 'nope' } }), /secretsStore/);
  assert.throws(
    () => toDeployment({ ...raw, plugins: { carrier: { secrets: ['lower'] } } }),
    /secret names/,
  );
});

test('a shared account binds no Secrets Store', () => {
  const d = toDeployment({ ...raw, plugins: { carrier: { runtime: 'sandboxed' } } });
  assert.equal(renderEngine(base('engine'), d).secrets_store_secrets, undefined);
});

test('the deploy finds a plugin’s missing secrets, by name only', () => {
  const shared = toDeployment({ ...raw, plugins: { carrier: { runtime: 'sandboxed' } } });
  assert.deepEqual(
    missingPluginSecrets(shared, 'carrier', ['API_KEY', 'HOOK'], {
      env: { PLUGIN_CARRIER_API_KEY: 'k', PLUGIN_CARRIER_HOOK: '' },
    }),
    ['HOOK'],
  );
  const own = toDeployment({
    ...raw,
    secretsStore: { storeId: STORE },
    plugins: { carrier: { runtime: 'sandboxed', secrets: ['API_KEY'] } },
  });
  assert.deepEqual(
    missingPluginSecrets(own, 'carrier', ['API_KEY', 'HOOK'], {
      stored: ['PLUGIN_CARRIER_API_KEY', 'PLUGIN_CARRIER_HOOK'],
    }),
    // HOOK is in the store but not listed in the registry, so nothing binds it.
    ['HOOK'],
  );
  assert.deepEqual(missingPluginSecrets(own, 'carrier', ['API_KEY'], { stored: [] }), ['API_KEY']);
});

test('runtime installs are off unless the registry lists publishers', () => {
  const key = 'gzGcgrEQxp3cOiLXbe8UXlTefRdy8Xrf_p9OxPz7dNI';
  const on = toDeployment({ ...raw, pluginInstalls: { publishers: { acme: key } } });
  assert.equal(renderEngine(base('engine'), on).vars.PLUGIN_PUBLISHERS, `{"acme":"${key}"}`);
  assert.equal(renderEngine(base('engine'), toDeployment(raw)).vars.PLUGIN_PUBLISHERS, undefined);
  // Not the base config's (app.commerceworker.com's) "on": only a registry that asks for it.
  assert.equal(base('engine').vars.ASSISTANT_PLUGINS, 'on');
  assert.equal(renderEngine(base('engine'), on).vars.ASSISTANT_PLUGINS, undefined);
  assert.equal(renderEngine(base('engine'), toDeployment(raw)).vars.ASSISTANT_PLUGINS, undefined);
  const drafts = toDeployment({ ...raw, pluginInstalls: { assistant: true } });
  assert.equal(renderEngine(base('engine'), drafts).vars.ASSISTANT_PLUGINS, 'on');
  assert.equal(renderEngine(base('engine'), drafts).vars.PLUGIN_PUBLISHERS, undefined);
  for (const bad of [
    {},
    { publishers: {} },
    { publishers: { Acme: key } },
    { publishers: { acme: 'short' } },
    { publishers: { assistant: key } },
    { publishers: { acme: key }, extra: true },
    { assistant: 'yes' },
  ])
    assert.throws(() => toDeployment({ ...raw, pluginInstalls: bad }), /pluginInstalls/);
});

test('the publisher tool signs what core verifies', async () => {
  const { keygen, signBundle, signingMessage } = await import('./plugin-pack.ts');
  const { publicKey, privatePem } = keygen();
  const file = signBundle(
    { body: '{}', sha: 'a'.repeat(64), manifest: { id: 'carrier', version: '2' } },
    'acme',
    privatePem,
  );
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(publicKey, 'base64url'),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    Buffer.from(file.signature, 'base64url'),
    new TextEncoder().encode(signingMessage('carrier', '2', 'a'.repeat(64))),
  );
  assert.equal(ok, true);
  assert.equal(signingMessage('a', 'b', 'c'), 'commerceworker-plugin:1:a:b:c');
});

test('a plugin alias is one free path segment, rendered into the web Worker', () => {
  const raw = { id: 'acme', ring: 'canary', slot: 2, d1Id: 'd1', catalogKvId: 'a'.repeat(32) };
  const d = toDeployment({
    ...raw,
    plugins: { punchout: { alias: '/punchout/', runtime: 'sandboxed' } },
  });
  assert.equal(renderWeb(base('web'), d).vars.PLUGIN_ALIASES, '{"/punchout/":"punchout"}');
  // None: empty, so the base config's never carries over.
  const none = toDeployment({ ...raw, plugins: { punchout: { runtime: 'sandboxed' } } });
  assert.equal(renderWeb(base('web'), none).vars.PLUGIN_ALIASES, '');
  const refused = (alias: unknown, more = {}) =>
    assert.throws(() =>
      toDeployment({ ...raw, plugins: { punchout: { alias, runtime: 'sandboxed' }, ...more } }),
    );
  for (const alias of ['punchout', '/Punchout/', '/a/', '/punch/out/', '/punchout', 7, '/../'])
    refused(alias);
  for (const reserved of ['/orders/', '/api/', '/plugins/', '/carts/', '/login/'])
    refused(reserved);
  assert.throws(
    () =>
      toDeployment({
        ...raw,
        plugins: {
          punchout: { alias: '/buy/', runtime: 'sandboxed' },
          ledger: { alias: '/buy/', runtime: 'sandboxed' },
        },
      }),
    /also/,
  );
});

test('the reserved path segments cover every top-level path the web app serves', () => {
  const routes = readFileSync(new URL('../apps/web/app/routes.ts', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../apps/web/workers/app.ts', import.meta.url), 'utf8');
  const segments = new Set<string>();
  for (const m of routes.matchAll(/route\('([a-z0-9-]+)/g)) segments.add(m[1]!);
  for (const m of worker.matchAll(/'\/([a-z0-9-]+)[/']/g)) segments.add(m[1]!);
  for (const s of ['scim', 'mcp', 'a2a', 'oauth']) segments.add(s); // via *_PATH constants
  const missing = [...segments].filter((s) => !RESERVED_PATH_SEGMENTS.has(s));
  assert.deepEqual(missing, []);
});

test('the deploy refuses a shared key too short to sign with', () => {
  const key = 'a'.repeat(64);
  assert.equal(keysProblem({ PRINCIPAL_KEY: key, DATA_KEY: key }), null);
  // The password pepper too, when it's set.
  assert.equal(keysProblem({ PRINCIPAL_KEY: key, DATA_KEY: key, PASSWORD_PEPPER: key }), null);
  assert.match(
    keysProblem({ PRINCIPAL_KEY: key, DATA_KEY: key, PASSWORD_PEPPER: 'short' }) ?? '',
    /^PASSWORD_PEPPER must be at least 32 characters/,
  );
  assert.match(
    keysProblem({ PRINCIPAL_KEY: 'short', DATA_KEY: key, DATA_KEY_PREVIOUS: 'x'.repeat(31) }) ?? '',
    /^PRINCIPAL_KEY, DATA_KEY_PREVIOUS must be at least 32 characters/,
  );
});

test('logRetentionDays sets how long the logs bucket keeps pushed logs, at least 30', () => {
  assert.equal(toDeployment(acme).logRetentionDays, 400);
  assert.equal(shellVars(toDeployment(acme)).LOG_RETENTION_DAYS, '400');
  assert.equal(shellVars(toDeployment(acme)).LOGS_R2, 'commerceworker-logs-acme');
  const month = toDeployment({ ...acme, logRetentionDays: 30 });
  assert.equal(shellVars(month).LOG_RETENTION_DAYS, '30');
  // Workers Logs already keeps 7 days; a week or two more is not worth a bucket.
  assert.throws(() => toDeployment({ ...acme, logRetentionDays: 7 }), /at least 30/);
  assert.throws(() => toDeployment({ ...acme, logRetentionDays: 90.5 }), /logRetentionDays/);
  assert.throws(() => toDeployment({ ...acme, logRetentionDays: '400' }), /logRetentionDays/);
});

test("every Worker of a deployment sends its trace events to Logpush, plugins' too", () => {
  const demo = toDeployment({ ...acme, id: 'acme-demo', demo: true });
  for (const d of [...loadDeployments().filter((x) => x.d1Id && x.catalogKvId), acme, demo]) {
    for (const [app, render] of [
      ['engine', renderEngine],
      ['web', renderWeb],
      ['storefront', renderStorefront],
      ['catalog', renderCatalog],
      ['delivery', renderDelivery],
    ] as const)
      assert.equal(render(base(app), d).logpush, true, `${d.id}: ${app}`);
  }
  const pluginBase = { name: 'commerceworker-plugin-ledger', d1_databases: [{ binding: 'DB' }] };
  assert.equal(renderPlugin(pluginBase, withLedger, 'ledger').logpush, true);
  // The deployment decides, not the plugin.
  assert.throws(
    () => renderPlugin({ ...pluginBase, logpush: false }, withLedger, 'ledger'),
    /may not declare logpush/,
  );
});

test("a deployment's Logpush job takes only its own Workers, without the request", () => {
  const d = toDeployment({
    ...acme,
    plugins: { ledger: { d1Id: 'd1-ledger' }, carrier: { runtime: 'sandboxed' } },
  });
  const job = logpushJob(d);
  assert.equal(job.name, 'commerceworker-workers-acme');
  assert.equal(job.bucket, 'commerceworker-logs-acme');
  // A sandboxed plugin runs in the engine: no Worker of its own to name.
  assert.deepEqual(job.scripts, [
    'commerceworker-web-acme',
    'commerceworker-storefront-acme',
    'commerceworker-engine-acme',
    'commerceworker-catalog-acme',
    'commerceworker-delivery-acme',
    'commerceworker-plugin-ledger-acme',
  ]);
  assert.deepEqual(JSON.parse(job.filter), {
    where: { key: 'ScriptName', operator: 'in', value: job.scripts },
  });
  assert.deepEqual(job.output_options.field_names, LOG_FIELDS);
  assert.ok(LOG_FIELDS.includes('Logs') && LOG_FIELDS.includes('Exceptions'));
  // The request's URL, headers and client details stay out of the bucket.
  assert.ok(!LOG_FIELDS.includes('Event'));
  // On a shared account each job is filtered to its own deployment's Workers, so none takes
  // another's, and no two deployments share a job or a bucket.
  const all = [...loadDeployments(), d];
  const seen = new Map<string, string>();
  for (const x of all)
    for (const s of logpushJob(x).scripts) {
      assert.equal(seen.get(s), undefined, `${s} is in ${seen.get(s)}'s job and ${x.id}'s`);
      seen.set(s, x.id);
    }
  assert.equal(new Set(all.map((x) => logpushJob(x).name)).size, all.length);
  assert.equal(new Set(all.map((x) => logpushJob(x).bucket)).size, all.length);
});

test("a Logpush filter past Logpush's 1,000 bytes is refused before provisioning", () => {
  const plugins = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`plugin-number-${i}`, { d1Id: `d1-${i}` }]),
  );
  assert.throws(() => logpushJob(toDeployment({ ...acme, plugins })), /Logpush filter/);
});

test('provision.sh parses', () => {
  execFileSync('bash', ['-n', join(import.meta.dirname, 'provision.sh')]);
});

test('logs never outlast the personal data the sweep erases', () => {
  // With personalDataRetentionDays, logRetentionDays defaults to it rather than 400.
  const unset = { ...acme, logRetentionDays: undefined };
  assert.equal(toDeployment({ ...unset, personalDataRetentionDays: 90 }).logRetentionDays, 90);
  assert.equal(
    toDeployment({ ...acme, personalDataRetentionDays: 90, logRetentionDays: 60 }).logRetentionDays,
    60,
  );
  assert.throws(
    () => toDeployment({ ...acme, personalDataRetentionDays: 90, logRetentionDays: 400 }),
    /can't be longer than personalDataRetentionDays/,
  );
  assert.equal(toDeployment({ ...acme, logRetentionDays: 800 }).logRetentionDays, 800);
});

test("provisioning finds any other Logpush job that would take the deployment's logs", () => {
  const d = toDeployment(acme);
  const where = (w: unknown) => JSON.stringify({ where: w });
  const jobs = [
    // Its own job, by name.
    { id: 1, name: 'commerceworker-workers-acme', filter: logpushJob(d).filter },
    // Another project's job, filtered to its own Workers.
    { id: 2, name: 'blog', filter: where({ key: 'ScriptName', operator: 'in', value: ['blog'] }) },
    // Another deployment's job.
    { id: 3, name: 'commerceworker-workers', filter: logpushJob(loadDeployments()[0]!).filter },
    // One that keeps out every commerceworker Worker.
    {
      id: 4,
      name: 'not-ours',
      filter: where({ key: 'ScriptName', operator: '!startsWith', value: 'commerceworker-' }),
    },
    // No filter at all: every Worker that sets logpush.
    { id: 5, name: 'everything', filter: '' },
    { id: 6, name: 'null filter', filter: null },
    // Names one of ours.
    {
      id: 7,
      name: 'snoop',
      filter: where({ key: 'ScriptName', operator: 'eq', value: 'commerceworker-engine-acme' }),
    },
    // Filters on something else only: still every Worker.
    {
      id: 8,
      name: 'errors',
      filter: where({ key: 'Outcome', operator: 'eq', value: 'exception' }),
    },
    // An `or` with a branch that lets ours in.
    {
      id: 9,
      name: 'mixed',
      filter: where({
        or: [
          { key: 'ScriptName', operator: 'eq', value: 'blog' },
          { key: 'ScriptName', operator: 'startsWith', value: 'commerceworker-web' },
        ],
      }),
    },
    // An `and` that keeps them out.
    {
      id: 10,
      name: 'blog errors',
      filter: where({
        and: [
          { key: 'ScriptName', operator: 'eq', value: 'blog' },
          { key: 'Outcome', operator: 'eq', value: 'exception' },
        ],
      }),
    },
    // A filter that doesn't parse is taken as none.
    { id: 11, name: 'garbled', filter: '{where' },
  ];
  assert.deepEqual(
    foreignJobsReaching(jobs, d).map((j) => j.id),
    [5, 6, 7, 8, 9, 11],
  );
  assert.deepEqual(foreignJobsReaching(jobs.slice(0, 4), d), []);
});

test("Logpush's R2 token writes objects in the logs bucket and nothing else", () => {
  const account = 'f'.repeat(32);
  const groups = [
    { id: 'g-read', name: 'Workers R2 Storage Bucket Item Read' },
    { id: 'g-write', name: 'Workers R2 Storage Bucket Item Write' },
    { id: 'g-admin', name: 'Workers R2 Storage Write' },
  ];
  const plain = toDeployment({ ...acme, jurisdiction: undefined });
  const t = logpushToken(plain, account, groups);
  assert.deepEqual(t, {
    name: 'commerceworker-logpush-acme',
    policies: [
      {
        effect: 'allow',
        resources: {
          [`com.cloudflare.edge.r2.bucket.${account}_default_commerceworker-logs-acme`]: '*',
        },
        permission_groups: [{ id: 'g-write' }],
      },
    ],
  });
  // An EU bucket's resource names its jurisdiction.
  assert.deepEqual(Object.keys(logpushToken(acme, account, groups).policies[0]!.resources), [
    `com.cloudflare.edge.r2.bucket.${account}_eu_commerceworker-logs-acme`,
  ]);
  // The group is taken by its exact name, and only when there is exactly one.
  assert.throws(() => logpushToken(acme, account, groups.slice(0, 1)), /found 0/);
  assert.throws(
    () => logpushToken(acme, account, [...groups, { id: 'g-2', name: groups[1]!.name }]),
    /found 2/,
  );
  assert.throws(() => logpushToken(acme, 'not-an-account', groups), /account id/);

  // An existing token is rolled only when it holds exactly that policy.
  const details = (
    policies: NonNullable<Parameters<typeof tokenMatches>[0]['policies']>,
    name = t.name,
  ) => ({ name, policies });
  const named = (p: (typeof t.policies)[0]) => ({
    id: 'policy-1',
    ...p,
    permission_groups: p.permission_groups.map((g) => ({ ...g, name: groups[1]!.name })),
  });
  assert.equal(tokenMatches(details([named(t.policies[0]!)]), t), true);
  assert.equal(tokenMatches(details([named(t.policies[0]!)], 'other'), t), false);
  assert.equal(tokenMatches(details([]), t), false);
  assert.equal(tokenMatches(details([named(t.policies[0]!), named(t.policies[0]!)]), t), false);
  assert.equal(
    tokenMatches(details([{ ...named(t.policies[0]!), resources: { '*': '*' } }]), t),
    false,
  );
  assert.equal(
    tokenMatches(
      details([
        {
          ...named(t.policies[0]!),
          resources: { ...t.policies[0]!.resources, 'com.cloudflare.edge.r2.bucket.x': '*' },
        },
      ]),
      t,
    ),
    false,
  );
  assert.equal(
    tokenMatches(
      details([
        { ...named(t.policies[0]!), permission_groups: [{ id: 'g-write' }, { id: 'g-admin' }] },
      ]),
      t,
    ),
    false,
  );
  assert.equal(tokenMatches(details([{ ...named(t.policies[0]!), effect: 'deny' }]), t), false);
});

// ---- The content stack (`content`) -----------------------------------------------------------

const ROOT = join(import.meta.dirname, '..');
const withContent = toDeployment({
  id: 'acme',
  ring: 'canary',
  slot: 2,
  d1Id: 'd1-acme',
  catalogKvId: 'a'.repeat(32),
  content: true,
  contentD1Id: 'content-d1-acme',
  contentKvId: 'b'.repeat(32),
});

/** Every content Worker's rendered config, by app. */
const contentConfigs = (d: ReturnType<typeof toDeployment>) => ({
  pipeline: renderPipeline(contentTemplate('pipeline'), d),
  media: renderMedia(contentTemplate('media'), d),
  api: renderApi(contentTemplate('api'), d),
  delivery: renderDelivery(base('delivery'), d, contentTemplate('delivery')),
  studio: renderStudio(contentTemplate('studio'), d),
});

test('the content stack is off unless the registry turns it on, and then every host has a default', () => {
  assert.equal(acme.content, false);
  assert.equal(acme.studioDomain, undefined);
  assert.throws(() => contentHosts(acme), /content stack off/);
  assert.deepEqual(contentHosts(withContent), {
    studio: 'studio.acme.commerceworker.com',
    api: 'api.acme.commerceworker.com',
    cdn: 'cdn.acme.commerceworker.com',
    media: 'media.acme.commerceworker.com',
  });
  // The commerce hosts are unchanged beside them.
  assert.equal(withContent.domain, 'acme.commerceworker.com');
  assert.equal(withContent.catalogDomain, 'catalog.acme.commerceworker.com');
  assert.equal(withContent.storefrontDomain, 'shop.acme.commerceworker.com');
  // Each follows a customer's own domain, and each can be named.
  const own = toDeployment({
    ...acme,
    domain: 'orders.acme.example',
    content: true,
    apiDomain: 'content-api.acme.example',
  });
  assert.equal(own.studioDomain, 'studio.orders.acme.example');
  assert.equal(own.apiDomain, 'content-api.acme.example');
  assert.equal(own.cdnDomain, 'cdn.orders.acme.example');
});

test('content hosts and ids are refused with the content stack off, and checked with it on', () => {
  for (const [k, v] of [
    ['studioDomain', 'studio.acme.example'],
    ['apiDomain', 'api.acme.example'],
    ['cdnDomain', 'cdn.acme.example'],
    ['mediaDomain', 'media.acme.example'],
    ['contentD1Id', 'x'],
    ['contentKvId', 'b'.repeat(32)],
  ] as const) {
    assert.throws(
      () => toDeployment({ ...acme, [k]: v }),
      new RegExp(`${k} needs "content": true`),
    );
    assert.throws(
      () => toDeployment({ ...acme, content: false, [k]: v }),
      new RegExp(`${k} needs "content": true`),
    );
  }
  assert.throws(() => toDeployment({ ...acme, content: 'yes' }), /content must be true or false/);
  for (const k of ['studioDomain', 'apiDomain', 'cdnDomain', 'mediaDomain'])
    assert.throws(
      () => toDeployment({ ...withContent, [k]: 'nope' }),
      new RegExp(`${k} must be a host`),
    );
  assert.throws(() => toDeployment({ ...withContent, contentKvId: 'short' }), /contentKvId/);
  assert.throws(() => toDeployment({ ...withContent, contentD1Id: '' }), /contentD1Id/);
  // Two of one deployment's Workers can't share a host.
  assert.throws(
    () => toDeployment({ ...withContent, cdnDomain: withContent.catalogDomain }),
    /catalog\.acme\.commerceworker\.com is the host of two/,
  );
  assert.throws(
    () => toDeployment({ ...withContent, mediaDomain: 'api.acme.commerceworker.com' }),
    /is the host of two/,
  );
});

test('a commerce-only deployment renders exactly what it did, with or without content templates', () => {
  const d = loadDeployments().find((x) => x.id === 'commerceworker')!;
  assert.equal(d.content, false);
  // Delivery stays the catalog-only config whatever template is passed beside it.
  assert.deepEqual(renderDelivery(base('delivery'), d), base('delivery'));
  assert.deepEqual(
    renderDelivery(base('delivery'), d, contentTemplate('delivery')),
    base('delivery'),
  );
  assert.equal(
    renderDelivery(base('delivery'), acme, contentTemplate('delivery')).main,
    'src/catalog/worker.ts',
  );
  // Nothing about the content stack reaches provisioning or the Logpush job.
  const vars = shellVars(acme);
  assert.equal(vars.CONTENT, 'false');
  for (const k of [
    'CONTENT_D1',
    'CONTENT_KV',
    'CONTENT_MEDIA',
    'CONTENT_VECTORS',
    'CONTENT_QUEUES',
  ])
    assert.equal(vars[k], '', k);
  assert.ok(!logpushJob(acme).scripts.some((s) => /pipeline|-api-|media|studio/.test(s)));
  assert.throws(() => renderPipeline(contentTemplate('pipeline'), acme), /content stack off/);
});

test('`render` writes the content Workers only for a deployment with the content stack', () => {
  const apps = ['catalog', 'delivery', 'engine', 'storefront', 'web'];
  const content = ['pipeline', 'media', 'api', 'studio'];
  const written = (id: string) =>
    execFileSync('node', ['scripts/fleet.ts', 'render', id], { cwd: ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((f) => f.split('/').at(-2)!)
      .sort();
  const files = () =>
    [...apps, ...content].map((a) => join(ROOT, 'apps', a, 'wrangler.commerceworker.json'));
  try {
    assert.deepEqual(written('commerceworker'), [...apps].sort());
    for (const a of content)
      assert.throws(
        () => readFileSync(join(ROOT, 'apps', a, 'wrangler.commerceworker.json')),
        /ENOENT/,
      );
  } finally {
    for (const f of files()) rmSync(f, { force: true });
  }
});

test("a content deployment's Workers all bind its content database, and no other", () => {
  const configs = contentConfigs(withContent);
  assert.deepEqual(Object.keys(configs).sort(), ['api', 'delivery', 'media', 'pipeline', 'studio']);
  for (const [app, c] of Object.entries(configs)) {
    assert.equal(c.d1_databases.length, 1, app);
    assert.deepEqual(
      { ...c.d1_databases[0], migrations_dir: undefined },
      {
        binding: 'DB',
        database_name: 'commerceworker-content-acme',
        database_id: 'content-d1-acme',
        migrations_dir: undefined,
      },
      app,
    );
    // The commerce database isn't a binding of any of them.
    assert.ok(!JSON.stringify(c).includes('"d1-acme"'), `${app} binds the commerce database`);
    assert.equal(c.workers_dev, false, app);
    assert.equal(c.preview_urls, false, app);
    assert.equal(c.logpush, true, app);
    // Only the deployment's own resources: nothing the templates keep for local work.
    assert.ok(!JSON.stringify(c).includes('"remote"'), `${app} keeps a remote binding`);
    assert.ok(!JSON.stringify(c).includes('012fecad'), app);
    assert.ok(!JSON.stringify(c).includes('staging'), `${app} names a staging resource`);
  }
  // The migrations come from the content store, applied through the pipeline's config.
  assert.equal(configs.pipeline.d1_databases[0].migrations_dir, '../../packages/store/migrations');
  // The commerce database keeps its own: engine, web and catalog are rendered as before.
  assert.equal(renderEngine(base('engine'), withContent).d1_databases[0].database_id, 'd1-acme');
});

test("every content Worker's name, bucket, index, cache and routes carry the deployment", () => {
  const n = names(withContent);
  const c = contentConfigs(withContent);
  assert.deepEqual(
    [c.pipeline.name, c.media.name, c.api.name, c.delivery.name, c.studio.name],
    [
      'commerceworker-pipeline-acme',
      'commerceworker-media-acme',
      'commerceworker-api-acme',
      'commerceworker-delivery-acme',
      'commerceworker-studio-acme',
    ],
  );
  assert.equal(c.pipeline.routes, undefined);
  assert.deepEqual(c.api.routes, [{ pattern: 'api.acme.commerceworker.com', custom_domain: true }]);
  assert.deepEqual(c.media.routes, [
    { pattern: 'media.acme.commerceworker.com', custom_domain: true },
  ]);
  assert.deepEqual(c.studio.routes, [
    { pattern: 'studio.acme.commerceworker.com', custom_domain: true },
  ]);
  for (const app of ['pipeline', 'media', 'api'] as const) {
    assert.deepEqual(c[app].kv_namespaces, [{ binding: 'KV_CACHE', id: 'b'.repeat(32) }], app);
    assert.deepEqual(
      c[app].r2_buckets,
      [{ binding: 'MEDIA_BUCKET', bucket_name: n.mediaBucket }],
      app,
    );
  }
  assert.equal(n.contentD1, 'commerceworker-content-acme');
  assert.equal(c.studio.kv_namespaces, undefined);
  for (const app of ['pipeline', 'api'] as const)
    assert.deepEqual(c[app].vectorize, [
      { binding: 'VECTORIZE', index_name: 'commerceworker-vectors-acme' },
    ]);
  assert.equal(c.api.vars.OAUTH_ISSUER, 'https://studio.acme.commerceworker.com');
  assert.equal(c.api.vars.MEDIA_BASE_URL, 'https://api.acme.commerceworker.com');
  assert.equal(c.pipeline.vars.MEDIA_PUBLIC_URL, 'https://media.acme.commerceworker.com');
  assert.equal(c.pipeline.vars.QUEUE_SUFFIX, '-acme');
  assert.equal(c.pipeline.vars.AI_GATEWAY_ID, 'commerceworker-acme');
  // The studio fronts the api and delivery by their rendered names.
  assert.deepEqual(c.studio.services, [
    { binding: 'API', service: 'commerceworker-api-acme' },
    { binding: 'DELIVERY', service: 'commerceworker-delivery-acme' },
  ]);
});

test('the pipeline owns the content Durable Objects and Workflows, and the others bind it by name', () => {
  const c = contentConfigs(withContent);
  // Classes, bindings and migrations come from the base alone (scripts/do-migrations.test.ts).
  assert.deepEqual(c.pipeline.migrations, contentTemplate('pipeline').migrations);
  assert.deepEqual(c.pipeline.durable_objects, contentTemplate('pipeline').durable_objects);
  for (const app of ['api', 'delivery'] as const)
    for (const b of c[app].durable_objects.bindings)
      assert.equal(b.script_name, 'commerceworker-pipeline-acme', `${app} ${b.name}`);
  for (const w of c.api.workflows) assert.equal(w.script_name, 'commerceworker-pipeline-acme');
  // Workflow names are account-wide.
  const workflows = [
    ...c.pipeline.workflows,
    ...renderCatalog(base('catalog'), withContent).workflows,
    ...renderEngine(base('engine'), withContent).workflows,
  ].map((w: { name: string }) => w.name);
  assert.equal(new Set(workflows).size, workflows.length);
  for (const w of workflows) assert.ok(w.endsWith('-acme'), w);
});

test("the content queues are the deployment's own, every producer and consumer by name", () => {
  const n = names(withContent);
  const mine = new Set(CONTENT_QUEUES.map(n.contentQueue));
  assert.equal(mine.size, 10);
  const c = contentConfigs(withContent);
  const used = [
    ...c.pipeline.queues.producers,
    ...c.pipeline.queues.consumers,
    ...c.api.queues.producers,
    ...c.media.queues.consumers,
    ...c.delivery.queues.consumers.filter((q: { queue: string }) => !q.queue.includes('catalog')),
  ].flatMap((q: { queue: string; dead_letter_queue?: string }) => [
    q.queue,
    ...(q.dead_letter_queue ? [q.dead_letter_queue] : []),
  ]);
  for (const q of used) assert.ok(mine.has(q), `${q} isn't provisioned for the deployment`);
  // Every provisioned queue is used by some Worker.
  for (const q of mine) assert.ok(used.includes(q), `${q} is provisioned but no Worker binds it`);
  // The catalog's queues keep their own names beside them.
  const all = new Set([...mine, n.catalogPurge, n.catalogPurgeDlq, n.catalogChanges]);
  assert.equal(all.size, mine.size + 3);
  assert.ok(c.delivery.queues.consumers.some((q: { queue: string }) => q.queue === n.catalogPurge));
});

test('delivery with content is the dispatcher at both hosts, with the catalog and content bindings', () => {
  const d = contentConfigs(withContent).delivery;
  assert.equal(d.main, 'src/index.ts');
  assert.deepEqual(d.routes, [
    { pattern: 'catalog.acme.commerceworker.com', custom_domain: true },
    { pattern: 'cdn.acme.commerceworker.com', custom_domain: true },
  ]);
  assert.deepEqual(Object.keys(d.exports).sort(), [
    'CatalogDelivery',
    'CatalogRead',
    'Delivery',
    'default',
  ]);
  assert.deepEqual(d.r2_buckets.map((b: { binding: string }) => b.binding).sort(), [
    'MEDIA_BUCKET',
    'PUBLISHED',
  ]);
  assert.deepEqual(d.kv_namespaces.map((k: { binding: string }) => k.binding).sort(), [
    'CARDS',
    'KV_CACHE',
  ]);
  assert.deepEqual(d.services, [
    { binding: 'CATALOG', service: 'commerceworker-catalog-acme', entrypoint: 'SearchApi' },
  ]);
  assert.deepEqual(
    d.analytics_engine_datasets.map((a: { dataset: string }) => a.dataset),
    ['commerceworker_metrics_acme', 'commerceworker_catalog_delivery_acme'],
  );
  // The catalog's side is what the catalog-only config has.
  const only = renderDelivery(base('delivery'), { ...withContent, content: false });
  assert.deepEqual(d.r2_buckets.at(-1), only.r2_buckets[0]);
  assert.deepEqual(d.kv_namespaces.at(-1), only.kv_namespaces[0]);
  assert.deepEqual(d.queues.consumers.at(-1), only.queues.consumers[0]);
  assert.throws(() => renderDelivery(base('delivery'), withContent), /needs its content template/);
});

test("rate-limit namespaces never repeat across a deployment's Workers, or across deployments", () => {
  const ids = (d: ReturnType<typeof toDeployment>) =>
    [
      renderWeb(base('web'), d),
      renderStorefront(base('storefront'), d),
      ...Object.values(contentConfigs(d)),
    ].flatMap((c) => (c.ratelimits ?? []).map((r: { namespace_id: string }) => r.namespace_id));
  const other = toDeployment({ ...withContent, id: 'beta', slot: 3 });
  const first = ids(withContent);
  assert.equal(new Set(first).size, first.length, first.join());
  const second = ids(other);
  assert.equal(new Set([...first, ...second]).size, first.length + second.length);
  assert.deepEqual(first.slice(0, 2), ['2001', '2002']);
  assert.ok(first.includes('2501') && first.includes('2506'));
});

test('a content deployment gets the content secrets, each Worker only its own', () => {
  const key = 'a'.repeat(64);
  const env = {
    PRINCIPAL_KEY: key,
    PRINCIPAL_KEY_PREVIOUS: 'b'.repeat(64),
    DATA_KEY: 'c'.repeat(64),
    TOKEN_PEPPER: 'd'.repeat(64),
    MEDIA_SIGNING_SECRET: 'e'.repeat(64),
    PASSWORD_PEPPER: 'f'.repeat(64),
    SETUP_TOKEN: 'setup-code',
    ADMIN_TOKEN: 'admin',
    STRIPE_SECRET_KEY: 'sk_test_commerce_only',
  };
  const values = (app: keyof typeof CONTENT_SECRETS, over: Record<string, string> = {}) =>
    contentSecretValues(withContent, { ...env, ...over }, app);
  // The pipeline never holds PRINCIPAL_KEY: its assistant keys are derived from it (and from the
  // previous one), as the security package derives them.
  const pipeline = values('pipeline');
  assert.deepEqual(Object.keys(pipeline).sort(), [
    'ASSISTANT_PRINCIPAL_KEY',
    'ASSISTANT_PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'MEDIA_SIGNING_SECRET',
    'TOKEN_PEPPER',
  ]);
  assert.equal(pipeline.ASSISTANT_PRINCIPAL_KEY, deriveAssistantKey(key));
  assert.equal(pipeline.ASSISTANT_PRINCIPAL_KEY_PREVIOUS, deriveAssistantKey('b'.repeat(64)));
  assert.notEqual(pipeline.ASSISTANT_PRINCIPAL_KEY, key);
  // The rest, each its own.
  assert.deepEqual(Object.keys(values('media')), ['MEDIA_SIGNING_SECRET']);
  assert.deepEqual(Object.keys(values('delivery')).sort(), [
    'DATA_KEY',
    'MEDIA_SIGNING_SECRET',
    'TOKEN_PEPPER',
  ]);
  assert.deepEqual(Object.keys(values('api')).sort(), [
    'ADMIN_TOKEN',
    'DATA_KEY',
    'MEDIA_SIGNING_SECRET',
    'PRINCIPAL_KEY',
    'PRINCIPAL_KEY_PREVIOUS',
    'TOKEN_PEPPER',
  ]);
  assert.deepEqual(Object.keys(values('studio')).sort(), [
    'DATA_KEY',
    'PASSWORD_PEPPER',
    'PRINCIPAL_KEY',
    'PRINCIPAL_KEY_PREVIOUS',
    'SETUP_TOKEN',
  ]);
  // None carries a commerce-only secret, and no Worker gets another's.
  for (const app of Object.keys(CONTENT_SECRETS) as (keyof typeof CONTENT_SECRETS)[])
    assert.ok(!('STRIPE_SECRET_KEY' in values(app)), app);
  // A content deployment can't deploy without the secrets only content uses, or with a short key.
  assert.throws(
    () => values('api', { TOKEN_PEPPER: '' }),
    /TOKEN_PEPPER not set: add it to the deploy-acme/,
  );
  assert.throws(
    () => values('media', { MEDIA_SIGNING_SECRET: '' }),
    /MEDIA_SIGNING_SECRET not set/,
  );
  assert.throws(() => values('studio', { DATA_KEY: '' }), /DATA_KEY not set/);
  assert.throws(() => values('api', { TOKEN_PEPPER: 'short' }), /TOKEN_PEPPER must be at least 32/);
  assert.throws(
    () => contentSecretValues(acme, env, 'api'),
    /content stack off: no api to collect secrets for/,
  );
});

test('the secrets command takes a content Worker and its deployment, and refuses one with content off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'content-secrets-'));
  try {
    const run = (...args: string[]) =>
      execFileSync('node', ['scripts/fleet.ts', 'secrets', ...args], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, PRINCIPAL_KEY: 'a'.repeat(64), DATA_KEY: 'c'.repeat(64) },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    assert.throws(
      () => run('pipeline', join(dir, 'p.json')),
      /secrets pipeline <out> <deployment id>/,
    );
    assert.throws(
      () => run('pipeline', join(dir, 'p.json'), 'commerceworker'),
      /content stack off/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secrets per content app: the pipeline holds derived keys and never PRINCIPAL_KEY', () => {
  assert.deepEqual(Object.keys(CONTENT_SECRETS).sort(), [
    'api',
    'delivery',
    'media',
    'pipeline',
    'studio',
  ]);
  assert.ok(!(CONTENT_SECRETS.pipeline as readonly string[]).includes('PRINCIPAL_KEY'));
  assert.ok(!(CONTENT_SECRETS.delivery as readonly string[]).includes('PRINCIPAL_KEY'));
  assert.deepEqual([...CONTENT_SECRETS.media], ['MEDIA_SIGNING_SECRET']);
  // Only the studio hashes passwords and takes the setup code; only the api holds API tokens' secrets.
  assert.ok((CONTENT_SECRETS.studio as readonly string[]).includes('PASSWORD_PEPPER'));
  assert.ok(!(CONTENT_SECRETS.api as readonly string[]).includes('PASSWORD_PEPPER'));
});

test("provisioning knows the content stack's resource names, and only for a content deployment", () => {
  const v = shellVars(withContent);
  assert.equal(v.CONTENT, 'true');
  assert.equal(v.CONTENT_D1, 'commerceworker-content-acme');
  assert.equal(v.CONTENT_KV, 'commerceworker-content-cache-acme');
  assert.equal(v.CONTENT_MEDIA, 'commerceworker-media-acme');
  assert.equal(v.CONTENT_VECTORS, 'commerceworker-vectors-acme');
  assert.equal(v.ASSET_EVENTS, 'commerceworker-asset-events-acme');
  assert.deepEqual((v.CONTENT_QUEUES as string).split(' '), [
    'commerceworker-events-acme',
    'commerceworker-events-dlq-acme',
    'commerceworker-bulk-acme',
    'commerceworker-agents-acme',
    'commerceworker-purge-acme',
    'commerceworker-purge-dlq-acme',
    'commerceworker-media-purge-acme',
    'commerceworker-media-purge-dlq-acme',
    'commerceworker-asset-events-acme',
    'commerceworker-asset-events-dlq-acme',
  ]);
  assert.equal(v.STUDIO_DOMAIN, 'studio.acme.commerceworker.com');
  assert.equal(v.CDN_DOMAIN, 'cdn.acme.commerceworker.com');
  // The commerce resources are named as before beside them.
  assert.equal(v.D1, 'commerceworker-acme');
  // A demo has no vector index.
  assert.equal(shellVars({ ...withContent, demo: true }).CONTENT_VECTORS, '');
  // Every variable provision.sh reads is one it was given, set by the script, or from the environment.
  const script = readFileSync(join(ROOT, 'scripts', 'provision.sh'), 'utf8');
  const assigned = new Set([
    ...[...script.matchAll(/(?:^|[\s(])([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
    ...[...script.matchAll(/for ([A-Z][A-Z0-9_]*) in/g)].map((m) => m[1]!),
  ]);
  const known = new Set([
    ...Object.keys(v),
    ...assigned,
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'ROTATE_LOGPUSH_KEY',
    'ALERT_WEBHOOK_URL',
    'ALERT_EMAIL',
  ]);
  const used = new Set([...script.matchAll(/\$\{?([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!));
  for (const name of used)
    assert.ok(known.has(name), `provision.sh reads $${name}, which nothing sets`);
});

test('a content deployment needs its content database and cache to be in the matrix', () => {
  assert.doesNotThrow(() => matrix([withContent]));
  for (const missing of ['contentD1Id', 'contentKvId'] as const) {
    const d = { ...withContent, [missing]: undefined };
    assert.throws(() => matrix([d]), /not provisioned/);
    assert.throws(
      () => renderPipeline(contentTemplate('pipeline'), d),
      new RegExp(`no ${missing}: run scripts/provision.sh acme`),
    );
    // Held, it is left out.
    assert.deepEqual(matrix([{ ...d, hold: true }]).canary, []);
  }
  // The studio takes no KV namespace.
  assert.doesNotThrow(() =>
    renderStudio(contentTemplate('studio'), { ...withContent, contentKvId: undefined }),
  );
});

test("a content deployment's Logpush job takes the content Workers too, and nothing else's", () => {
  assert.deepEqual(logpushJob(withContent).scripts, [
    'commerceworker-web-acme',
    'commerceworker-storefront-acme',
    'commerceworker-engine-acme',
    'commerceworker-catalog-acme',
    'commerceworker-delivery-acme',
    'commerceworker-pipeline-acme',
    'commerceworker-media-acme',
    'commerceworker-api-acme',
    'commerceworker-studio-acme',
  ]);
});

test('a content demo mocks its models and has no vector index', () => {
  const demo = toDeployment({ ...withContent, id: 'acme-demo', demo: true });
  const c = contentConfigs(demo);
  for (const app of ['pipeline', 'api'] as const) {
    assert.equal(c[app].vectorize, undefined, app);
    assert.equal(c[app].vars.AI_MODE, 'mock', app);
    assert.equal(c[app].vars.ALLOW_FAKE_ADAPTERS, 'ai,vectors', app);
  }
  assert.equal(c.api.vars.DEMO_STARTERS, 'true');
  assert.equal(c.studio.vars.AI_MODE, undefined);
  // A persistent deployment allows no fakes.
  assert.equal(contentConfigs(withContent).api.vars.ALLOW_FAKE_ADAPTERS, '');
  assert.equal(contentConfigs(withContent).api.vars.AI_MODE, 'live');
});

test("an EU deployment's content Durable Objects, bucket and database are in the EU", () => {
  const eu = toDeployment({ ...withContent, jurisdiction: 'eu' });
  const c = contentConfigs(eu);
  for (const app of ['pipeline', 'api', 'delivery', 'media'] as const) {
    assert.equal(c[app].vars.DATA_JURISDICTION, 'eu', app);
    const bucket = c[app].r2_buckets.find((b: { binding: string }) => b.binding === 'MEDIA_BUCKET');
    assert.equal(bucket.jurisdiction, 'eu', app);
  }
  assert.equal(c.studio.vars.DATA_JURISDICTION, undefined);
  assert.equal(shellVars(eu).JURISDICTION, 'eu');
});

test('the media scope an asset reference resolves in is rendered, defaulting to space-1 and main', () => {
  const dflt = renderMedia(contentTemplate('media'), withContent);
  assert.equal(dflt.vars.ASSET_REF_SPACE, 'space-1');
  assert.equal(dflt.vars.ASSET_REF_ENV, 'main');
  const own = toDeployment({
    id: 'scoped',
    ring: 'canary',
    slot: 3,
    content: true,
    mediaScope: { space: 'shop', environment: 'live' },
    contentD1Id: 'content-d1-scoped',
    contentKvId: 'c'.repeat(32),
  });
  const c = renderMedia(contentTemplate('media'), own);
  assert.equal(c.vars.ASSET_REF_SPACE, 'shop');
  assert.equal(c.vars.ASSET_REF_ENV, 'live');
  // Only the media Worker carries it.
  assert.equal(renderApi(contentTemplate('api'), own).vars.ASSET_REF_SPACE, undefined);
  // Refused without content, or when not a pair of ids.
  const raw = { id: 'bad', ring: 'canary', slot: 4 };
  assert.throws(
    () => toDeployment({ ...raw, mediaScope: { space: 'a', environment: 'b' } }),
    /mediaScope needs "content": true/,
  );
  for (const mediaScope of [{ space: 'a' }, { space: 'a/b', environment: 'main' }, 'main', null])
    assert.throws(
      () => toDeployment({ ...raw, content: true, mediaScope }),
      /mediaScope must be/,
      JSON.stringify(mediaScope),
    );
});

test('the registry refuses two deployments on one host or one queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  try {
    const write = (name: string, v: object) => writeFileSync(join(dir, name), JSON.stringify(v));
    const a = { id: 'aa', ring: 'canary', slot: 1, content: true, payments: 'mock' };
    write('aa.jsonc', a);
    write('bb.jsonc', {
      id: 'bb',
      ring: 'canary',
      slot: 2,
      content: true,
      payments: 'mock',
      mediaDomain: 'media.aa.commerceworker.com',
    });
    assert.throws(() => loadDeployments(dir), /share the host media\.aa\.commerceworker\.com/);
    // Queue names are account-wide: a suffix "-dlq" would name the events dead letters of a
    // deployment with no suffix.
    write('aa.jsonc', { ...a, suffix: '' });
    write('bb.jsonc', { id: 'bb', ring: 'canary', slot: 2, content: true, payments: 'mock' });
    assert.doesNotThrow(() => loadDeployments(dir));
    write('bb.jsonc', {
      id: 'bb',
      ring: 'canary',
      slot: 2,
      content: true,
      payments: 'mock',
      suffix: '-dlq',
    });
    assert.throws(() => loadDeployments(dir), /share the queue/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the catalog knows the assets service's origin only on a content deployment", () => {
  // Commerce-only: no var at all, so the catalog accepts only absolute https media.
  assert.equal('MEDIA_ORIGIN' in renderCatalog(base('catalog'), acme).vars, false);
  assert.equal(renderCatalog(base('catalog'), acme).vars.MEDIA_ORIGIN, undefined);
  // Content: the registry's media host.
  assert.equal(
    renderCatalog(base('catalog'), withContent).vars.MEDIA_ORIGIN,
    'https://media.acme.commerceworker.com',
  );
  const own = toDeployment({
    id: 'own',
    ring: 'canary',
    slot: 3,
    d1Id: 'd1-own',
    catalogKvId: 'c'.repeat(32),
    content: true,
    contentD1Id: 'content-d1-own',
    contentKvId: 'd'.repeat(32),
    mediaDomain: 'assets.shop.example.com',
  });
  assert.equal(
    renderCatalog(base('catalog'), own).vars.MEDIA_ORIGIN,
    'https://assets.shop.example.com',
  );
});

test("a customer's email sets the engine's send_email binding and its sender", () => {
  const mailing = toDeployment({
    ...acme,
    email: { from: 'orders@mail.acme.example', fromName: 'Acme Orders' },
  });
  const c = renderEngine(base('engine'), mailing);
  assert.deepEqual(c.send_email, [{ name: 'EMAIL' }]);
  assert.equal(c.vars.EMAIL_FROM, 'orders@mail.acme.example');
  assert.equal(c.vars.EMAIL_FROM_NAME, 'Acme Orders');
  // Without it no binding is rendered, and the vars are empty, so nothing is sent and one
  // deployment's sender never carries over.
  const plain = renderEngine(base('engine'), acme);
  assert.equal(plain.send_email, undefined);
  assert.equal(plain.vars.EMAIL_FROM, '');
  assert.equal(plain.vars.EMAIL_FROM_NAME, '');
  assert.equal(
    renderEngine(base('engine'), toDeployment({ ...acme, email: { from: 'a@b.example' } })).vars
      .EMAIL_FROM_NAME,
    '',
  );
  for (const bad of ['orders', 'orders@localhost', 'Acme <orders@mail.acme.example>', '', 42])
    assert.throws(() => toDeployment({ ...acme, email: { from: bad } }), /email\.from/);
  for (const bad of ['', 'Acme\nBcc: x@y.example', '<Acme>', 7])
    assert.throws(
      () => toDeployment({ ...acme, email: { from: 'a@b.example', fromName: bad } }),
      /fromName/,
    );
  assert.throws(() => toDeployment({ ...acme, email: 'orders@x.example' }), /email must be/);
});

test('the registry refuses a general-ring deployment without an explicit payments mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  try {
    const only = (v: object) => {
      writeFileSync(join(dir, 'acme.jsonc'), JSON.stringify({ id: 'acme', slot: 2, ...v }));
      return () => loadDeployments(dir);
    };
    // Unset payments would render mock; the error names the field and the choices.
    assert.throws(only({ ring: 'general' }), /set "payments".*"stripe".*"mock"/);
    // Mock is refused outright on general, even when written down.
    assert.throws(only({ ring: 'general', payments: 'mock' }), /refused on the general ring/);
    assert.doesNotThrow(only({ ring: 'general', payments: 'stripe' }));
    // Anything else is refused by the value check, which lists the choices.
    assert.throws(
      only({ ring: 'general', payments: 'none' }),
      /payments must be "mock" or "stripe"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the registry refuses a canary deployment without an explicit payments mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  try {
    const only = (v: object) => {
      writeFileSync(join(dir, 'acme.jsonc'), JSON.stringify({ id: 'acme', slot: 2, ...v }));
      return () => loadDeployments(dir);
    };
    assert.throws(only({ ring: 'canary' }), /set "payments"/);
    assert.doesNotThrow(only({ ring: 'canary', payments: 'mock' }));
    assert.doesNotThrow(only({ ring: 'canary', payments: 'stripe' }));
    // Staging and internal without a storefront keep the mock default.
    assert.doesNotThrow(only({ ring: 'staging' }));
    assert.doesNotThrow(only({ ring: 'internal' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the registry refuses a deployment with a storefrontDomain and no explicit payments mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  try {
    const only = (v: object) => {
      writeFileSync(join(dir, 'acme.jsonc'), JSON.stringify({ id: 'acme', slot: 2, ...v }));
      return () => loadDeployments(dir);
    };
    const shop = { ring: 'internal', storefrontDomain: 'shop.acme.example' };
    assert.throws(only(shop), /set "payments".*storefrontDomain/);
    assert.doesNotThrow(only({ ...shop, payments: 'mock' }));
    // A demo is always mock and needs no choice.
    assert.doesNotThrow(only({ ...shop, demo: true }));
    // The checked-in registry passes.
    assert.doesNotThrow(() => loadDeployments());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the registry refuses two deployments that share a resource id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  try {
    const kv = (c: string) => c.repeat(32);
    const a = {
      id: 'aa',
      ring: 'staging',
      slot: 1,
      content: true,
      d1Id: 'd1-a',
      catalogKvId: kv('a'),
      contentD1Id: 'cd1-a',
      contentKvId: kv('b'),
      plugins: { punchout: { d1Id: 'p-a' } },
      redundancy: true,
      standbyD1Id: 'sb-a',
    };
    const write = (name: string, v: object) => writeFileSync(join(dir, name), JSON.stringify(v));
    const plugin = 'punchout';
    const b = {
      ...a,
      id: 'bb',
      slot: 2,
      d1Id: 'd1-b',
      catalogKvId: kv('c'),
      contentD1Id: 'cd1-b',
      contentKvId: kv('d'),
      plugins: { [plugin]: { d1Id: 'p-b' } },
      standbyD1Id: 'sb-b',
    };
    write('aa.jsonc', a);
    write('bb.jsonc', b);
    assert.doesNotThrow(() => loadDeployments(dir));
    const cases: [string, object][] = [
      ['d1Id', { d1Id: 'd1-a' }],
      ['standbyD1Id', { standbyD1Id: 'sb-a' }],
      ['catalogKvId', { catalogKvId: kv('a') }],
      ['contentD1Id', { contentD1Id: 'cd1-a' }],
      ['contentKvId', { contentKvId: kv('b') }],
      [`plugins.${plugin}.d1Id`, { plugins: { [plugin]: { d1Id: 'p-a' } } }],
    ];
    for (const [field, stale] of cases) {
      write('bb.jsonc', { ...b, ...stale });
      assert.throws(
        () => loadDeployments(dir),
        (e: Error) =>
          e.message.includes(`bb ${field} `) && e.message.includes('already used by aa'),
        field,
      );
    }
    // One entry can't name one id twice either (a D1 id used as a plugin's).
    write('bb.jsonc', { ...b, plugins: { [plugin]: { d1Id: 'd1-b' } } });
    assert.throws(() => loadDeployments(dir), /already used by bb d1Id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Redundancy ---

const STANDBY = '00000000-0000-0000-0000-000000000001';
const protectedAcme = (redundancy: unknown = true, more: Record<string, unknown> = {}) =>
  toDeployment({ ...acme, standbyD1Id: STANDBY, redundancy, ...more });
/** A binding in a rendered wrangler config. */
type Entry = {
  binding: string;
  name?: string;
  class_name?: string;
  schedules?: string[];
  database_name?: string;
  database_id?: string;
  bucket_name?: string;
  jurisdiction?: string;
};
const REDUNDANCY_BINDINGS = (c: Record<string, Entry[]>) => ({
  databases: c.d1_databases!.map((db) => db.binding),
  buckets: c.r2_buckets!.map((b) => b.binding),
  workflows: c.workflows!.map((w) => w.binding),
});

test('redundancy is off unless the registry sets it, and true takes the defaults', () => {
  assert.equal(acme.redundancy, undefined);
  assert.equal(toDeployment({ ...acme, redundancy: false }).redundancy, undefined);
  assert.deepEqual(protectedAcme().redundancy, {
    backupDays: 35,
    backupHourUtc: 1,
    drill: 'weekly',
    except: [],
  });
  const tuned = protectedAcme({
    backupDays: 60,
    backupHourUtc: 4,
    drill: 'monthly',
    except: ['canary', 'canary', 'readReplicas'],
    alerts: { webhook: 'https://hooks.example.com/x', pagerduty: 'rk' },
    offsite: { provider: 'gcs', bucket: 'acme-offsite', region: 'europe-west1' },
  }).redundancy;
  assert.deepEqual(tuned, {
    backupDays: 60,
    backupHourUtc: 4,
    drill: 'monthly',
    except: ['canary', 'readReplicas'],
    alerts: { webhook: 'https://hooks.example.com/x', pagerduty: 'rk' },
    offsite: { provider: 'gcs', bucket: 'acme-offsite', region: 'europe-west1' },
  });
  assert.equal(REDUNDANCY_PARTS.includes('d1Backup'), true);
});

test('bad redundancy entries are refused', () => {
  const refuse = (redundancy: unknown, why: RegExp, more: Record<string, unknown> = {}) =>
    assert.throws(() => toDeployment({ ...acme, redundancy, ...more }), why);
  refuse('yes', /redundancy must be true or/);
  refuse([], /redundancy must be true or/);
  refuse({ backups: 3 }, /redundancy has no backups/);
  refuse({ except: ['d1Backup', 'tape'] }, /names tape/);
  refuse({ except: 'd1Backup' }, /must be a list/);
  // Shorter than Time Travel's 30 days adds nothing; longer than the personal data they hold keeps what was erased.
  refuse({ backupDays: 30 }, /at least 31/);
  refuse({ backupDays: 35.5 }, /backupDays/);
  // `acme` carries the default logRetentionDays (400), which these retentions are shorter than.
  refuse(
    { backupDays: 400 },
    /redundancy.backupDays \(400\) can't be longer than personalDataRetentionDays \(365\)/,
    {
      personalDataRetentionDays: 365,
      logRetentionDays: undefined,
    },
  );
  refuse({}, /personalDataRetentionDays 30 is too short/, {
    personalDataRetentionDays: 30,
    logRetentionDays: undefined,
  });
  refuse({ backupHourUtc: 24 }, /0 to 23/);
  refuse({ drill: 'daily' }, /weekly" or "monthly/);
  refuse({ offsite: { provider: 'ftp', bucket: 'b', region: 'r' } }, /one of s3, gcs, azure/);
  refuse({ offsite: { provider: 's3', bucket: 'b' } }, /offsite.region/);
  refuse({ offsite: { provider: 's3', bucket: 'b', region: 'r', key: 'k' } }, /offsite has no key/);
  refuse({ alerts: { webhook: 'http://insecure.example.com' } }, /https URL/);
  refuse({ alerts: { sms: '1' } }, /alerts has no sms/);
  // A demo holds nothing worth a backup.
  refuse(true, /a demo has no data to keep/, { demo: true });
  assert.throws(
    () => toDeployment({ ...acme, standbyD1Id: STANDBY }),
    /standbyD1Id needs redundancy/,
  );
  assert.throws(() => protectedAcme(true, { standbyD1Id: 'd1-acme' }), /the live database/);
});

test('a personalDataRetentionDays under the default keeps the backups under it', () => {
  const personal = (days: number) =>
    protectedAcme(true, { personalDataRetentionDays: days, logRetentionDays: undefined });
  assert.equal(personal(32).redundancy?.backupDays, 32);
  assert.equal(personal(400).redundancy?.backupDays, 35);
});

test('the engine renders the standby, the backups bucket and the two Workflows with the flag on', () => {
  const c = renderEngine(base('engine'), protectedAcme({ backupHourUtc: 4, drill: 'monthly' }));
  assert.deepEqual(REDUNDANCY_BINDINGS(c), {
    databases: ['DB', 'STANDBY_DB'],
    buckets: ['DOCS', 'BACKUPS', 'DOCS_REPLICA'],
    workflows: [
      'ORDER_WORKFLOW',
      'REPLENISH',
      'D1_BACKUP',
      'D1_RESTORE',
      'OBJECTS_BACKUP',
      'OBJECTS_RESTORE',
      'OBJECTS_DRILL',
      'DOCS_RECONCILE',
    ],
  });
  // DB keeps its own id: the standby is rendered apart, never mapped onto it.
  assert.deepEqual(
    c.d1_databases.map((db: Entry) => [db.binding, db.database_name, db.database_id]),
    [
      ['DB', 'commerceworker-acme', 'd1-acme'],
      ['STANDBY_DB', 'commerceworker-standby-acme', STANDBY],
    ],
  );
  assert.deepEqual(
    c.r2_buckets.map((b: Entry) => [b.binding, b.bucket_name, b.jurisdiction]),
    [
      ['DOCS', 'commerceworker-docs-acme', 'eu'],
      ['BACKUPS', 'commerceworker-backups-acme', 'eu'],
      ['DOCS_REPLICA', 'commerceworker-docs-replica-acme', 'eu'],
    ],
  );
  const flows = Object.fromEntries(c.workflows.map((w: Entry) => [w.binding, w]));
  assert.equal(flows.D1_BACKUP.name, 'commerceworker-d1-backup-acme');
  assert.equal(flows.D1_RESTORE.name, 'commerceworker-d1-restore-acme');
  assert.deepEqual(flows.D1_BACKUP.schedules, ['0 4 * * *']);
  assert.deepEqual(flows.D1_RESTORE.schedules, ['0 10 1 * *']);
  // The object copy two hours after the D1 backup; its drill an hour after the D1 drill's, same days.
  assert.equal(flows.OBJECTS_BACKUP.name, 'commerceworker-objects-backup-acme');
  assert.equal(flows.OBJECTS_BACKUP.class_name, 'ObjectsBackup');
  assert.deepEqual(flows.OBJECTS_BACKUP.schedules, ['0 6 * * *']);
  assert.equal(flows.OBJECTS_DRILL.name, 'commerceworker-objects-drill-acme');
  assert.deepEqual(flows.OBJECTS_DRILL.schedules, ['0 11 1 * *']);
  // The restore is an operator's: no schedule, on the registry or in the base config.
  assert.equal(flows.OBJECTS_RESTORE.name, 'commerceworker-objects-restore-acme');
  assert.equal(flows.OBJECTS_RESTORE.class_name, 'ObjectsRestore');
  assert.equal(flows.OBJECTS_RESTORE.schedules, undefined);
  assert.equal(flows.D1_BACKUP.class_name, 'D1Backup');
  assert.deepEqual(redundancySchedules(protectedAcme().redundancy!), {
    backup: '0 1 * * *',
    restore: '0 7 * * 0',
    objectsBackup: '0 3 * * *',
    objectsDrill: '0 8 * * 0',
  });
  assert.equal(
    redundancySchedules(protectedAcme({ backupHourUtc: 20 }).redundancy!).restore,
    '0 2 * * 0',
  );
  // Only the engine carries any of it.
  for (const [app, render] of [
    ['web', renderWeb],
    ['catalog', renderCatalog],
  ] as const)
    assert.deepEqual(
      REDUNDANCY_BINDINGS({
        ...render(base(app), protectedAcme()),
        workflows: [],
      }).databases.filter((b: string) => b === 'STANDBY_DB'),
      [],
    );
});

test('a deployment without redundancy has the engine bindings stripped, and keeps the rest', () => {
  const off = renderEngine(base('engine'), acme);
  assert.deepEqual(REDUNDANCY_BINDINGS(off), {
    databases: ['DB'],
    buckets: ['DOCS'],
    workflows: ['ORDER_WORKFLOW', 'REPLENISH'],
  });
  const on = renderEngine(base('engine'), protectedAcme());
  // What the flag adds is exactly those bindings, and the replica's queue consumers.
  assert.deepEqual(
    {
      ...on,
      d1_databases: off.d1_databases,
      r2_buckets: off.r2_buckets,
      workflows: off.workflows,
      queues: undefined,
    },
    { ...off, queues: undefined },
  );
  assert.equal(off.queues, undefined);
  // d1Backup, objectBackup and r2Replica as exceptions turn their bindings off, each apart from the others.
  assert.deepEqual(
    REDUNDANCY_BINDINGS(
      renderEngine(
        base('engine'),
        protectedAcme({ except: ['d1Backup', 'objectBackup', 'r2Replica'] }),
      ),
    ),
    REDUNDANCY_BINDINGS(off),
  );
  // Without the D1 backup the bucket stays, for the object copies in it.
  assert.deepEqual(
    REDUNDANCY_BINDINGS(renderEngine(base('engine'), protectedAcme({ except: ['d1Backup'] }))),
    {
      databases: ['DB'],
      buckets: ['DOCS', 'BACKUPS', 'DOCS_REPLICA'],
      workflows: [
        'ORDER_WORKFLOW',
        'REPLENISH',
        'OBJECTS_BACKUP',
        'OBJECTS_RESTORE',
        'OBJECTS_DRILL',
        'DOCS_RECONCILE',
      ],
    },
  );
  // Without the object copies the standby and the D1 Workflows stay, the Durable Object ones go.
  assert.deepEqual(
    REDUNDANCY_BINDINGS(renderEngine(base('engine'), protectedAcme({ except: ['objectBackup'] }))),
    {
      databases: ['DB', 'STANDBY_DB'],
      buckets: ['DOCS', 'BACKUPS', 'DOCS_REPLICA'],
      workflows: ['ORDER_WORKFLOW', 'REPLENISH', 'D1_BACKUP', 'D1_RESTORE', 'DOCS_RECONCILE'],
    },
  );
  assert.equal(backsUpObjects(protectedAcme()), true);
  assert.equal(backsUpObjects(protectedAcme({ except: ['objectBackup'] })), false);
  assert.equal(backsUpObjects(acme), false);
  // And a demo or a held-back standby needs no id.
  assert.doesNotThrow(() =>
    renderEngine(base('engine'), toDeployment({ ...acme, id: 'acme-demo', demo: true })),
  );
});

test('rendering with redundancy needs the standby database provisioned', () => {
  const d = toDeployment({ ...acme, redundancy: true });
  assert.throws(
    () => renderEngine(base('engine'), d),
    /no standbyD1Id: run scripts\/provision.sh acme/,
  );
  assert.throws(() => matrix([d]), /standbyD1Id/);
  assert.doesNotThrow(() => matrix([toDeployment({ ...acme, redundancy: true, hold: true })]));
  assert.doesNotThrow(() => matrix([protectedAcme()]));
  assert.doesNotThrow(() =>
    matrix([toDeployment({ ...acme, redundancy: { except: ['d1Backup'] } })]),
  );
});

test('provision.sh is told the backups bucket, the standby and the retention only with redundancy', () => {
  const on = shellVars(protectedAcme({ backupDays: 60 }));
  assert.deepEqual(
    [on.BACKUPS_R2, on.STANDBY_D1, on.BACKUP_DAYS],
    ['commerceworker-backups-acme', 'commerceworker-standby-acme', '60'],
  );
  const off = shellVars(acme);
  assert.deepEqual([off.BACKUPS_R2, off.STANDBY_D1, off.BACKUP_DAYS], ['', '', '']);
  // Which prefixes of the bucket are kept: d1/ and objects/. The bucket follows either.
  assert.deepEqual([on.BACKUP_D1, on.BACKUP_OBJECTS], ['true', 'true']);
  assert.deepEqual([off.BACKUP_D1, off.BACKUP_OBJECTS], ['', '']);
  const noD1 = shellVars(protectedAcme({ except: ['d1Backup'] }));
  assert.deepEqual(
    [noD1.BACKUPS_R2, noD1.STANDBY_D1, noD1.BACKUP_D1, noD1.BACKUP_OBJECTS],
    ['commerceworker-backups-acme', '', '', 'true'],
  );
  const noObjects = shellVars(protectedAcme({ except: ['objectBackup'] }));
  assert.deepEqual(
    [noObjects.BACKUPS_R2, noObjects.STANDBY_D1, noObjects.BACKUP_D1, noObjects.BACKUP_OBJECTS],
    ['commerceworker-backups-acme', 'commerceworker-standby-acme', 'true', ''],
  );
  const neither = shellVars(protectedAcme({ except: ['d1Backup', 'objectBackup'] }));
  assert.deepEqual([neither.BACKUPS_R2, neither.BACKUP_DAYS], ['', '']);
  assert.equal(names(acme).backups, 'commerceworker-backups-acme');
});

test('commerceworker has redundancy on, and the base engine config carries what it binds', () => {
  const d = loadDeployments().find((x) => x.id === 'commerceworker')!;
  assert.deepEqual(d.redundancy, { backupDays: 35, backupHourUtc: 1, drill: 'weekly', except: [] });
  assert.deepEqual(REDUNDANCY_BINDINGS(base('engine')).workflows.slice(-6), [
    'D1_BACKUP',
    'D1_RESTORE',
    'OBJECTS_BACKUP',
    'OBJECTS_RESTORE',
    'OBJECTS_DRILL',
    'DOCS_RECONCILE',
  ]);
  for (const x of loadDeployments().filter((y) => y.id !== 'commerceworker'))
    assert.equal(x.redundancy, undefined, `${x.id} stays as it was`);
});

test('the engine renders the docs replica: bucket, reconcile Workflow and suffixed queues', () => {
  const c = renderEngine(base('engine'), protectedAcme());
  const replica = c.r2_buckets.find((b: Entry) => b.binding === 'DOCS_REPLICA');
  assert.deepEqual(replica, {
    binding: 'DOCS_REPLICA',
    bucket_name: 'commerceworker-docs-replica-acme',
    jurisdiction: 'eu',
  });
  const reconcile = c.workflows.find((w: Entry) => w.binding === 'DOCS_RECONCILE');
  assert.equal(reconcile.name, 'commerceworker-docs-reconcile-acme');
  assert.equal(reconcile.class_name, 'DocsReplicaReconcile');
  // The queue and its dead-letter queue, and the consumer of each: the DLQ's has none of its own.
  assert.deepEqual(
    c.queues.consumers.map((q: Record<string, string | undefined>) => [
      q.queue,
      q.dead_letter_queue,
    ]),
    [
      ['commerceworker-docs-replica-acme', 'commerceworker-docs-replica-dlq-acme'],
      ['commerceworker-docs-replica-dlq-acme', undefined],
    ],
  );
  // No jurisdiction on the bucket for a deployment without one.
  const plain = renderEngine(
    base('engine'),
    toDeployment({ ...acme, jurisdiction: undefined, redundancy: { except: ['d1Backup'] } }),
  );
  assert.equal(
    plain.r2_buckets.find((b: Entry) => b.binding === 'DOCS_REPLICA').jurisdiction,
    undefined,
  );
});

test('r2Replica as an exception strips the replica and nothing else; the flag off strips it too', () => {
  const noReplica = renderEngine(base('engine'), protectedAcme({ except: ['r2Replica'] }));
  assert.deepEqual(REDUNDANCY_BINDINGS(noReplica), {
    databases: ['DB', 'STANDBY_DB'],
    buckets: ['DOCS', 'BACKUPS'],
    workflows: [
      'ORDER_WORKFLOW',
      'REPLENISH',
      'D1_BACKUP',
      'D1_RESTORE',
      'OBJECTS_BACKUP',
      'OBJECTS_RESTORE',
      'OBJECTS_DRILL',
    ],
  });
  assert.equal(noReplica.queues, undefined);
  assert.equal(renderEngine(base('engine'), acme).queues, undefined);
  // The base config's own consumers are what commerceworker deploys, unsuffixed.
  const own = renderEngine(
    base('engine'),
    loadDeployments().find((x) => x.id === 'commerceworker')!,
  );
  // commerceworker sets no `email`, so it has the replica's queues and none of the mail queue's.
  assert.deepEqual(
    own.queues.consumers,
    base('engine').queues.consumers.filter((c: { queue: string }) =>
      c.queue.startsWith('commerceworker-docs-replica'),
    ),
  );
  assert.equal(own.queues.producers, undefined);
  assert.equal(replicatesDocs(protectedAcme()), true);
  assert.equal(replicatesDocs(protectedAcme({ except: ['r2Replica'] })), false);
  assert.equal(replicatesDocs(acme), false);
});

test('provision.sh is told the replica bucket and its queues only when the replica is on', () => {
  const on = shellVars(protectedAcme());
  assert.deepEqual(
    [on.DOCS_REPLICA_R2, on.DOCS_REPLICA_QUEUE, on.DOCS_REPLICA_DLQ],
    [
      'commerceworker-docs-replica-acme',
      'commerceworker-docs-replica-acme',
      'commerceworker-docs-replica-dlq-acme',
    ],
  );
  for (const d of [acme, protectedAcme({ except: ['r2Replica'] })]) {
    const off = shellVars(d);
    assert.deepEqual(
      [off.DOCS_REPLICA_R2, off.DOCS_REPLICA_QUEUE, off.DOCS_REPLICA_DLQ],
      ['', '', ''],
    );
  }
  // The replica is independent of the D1 backup.
  assert.equal(
    shellVars(protectedAcme({ except: ['d1Backup'] })).DOCS_REPLICA_R2,
    'commerceworker-docs-replica-acme',
  );
  // A bucket and the queue it feeds share a name apart from the dead-letter queue.
  assert.notEqual(names(acme).docsReplicaDlq, names(acme).docsReplicaQueue);
});

// --- Detection: metrics, alert policies and Health Checks ---

test('every app renders its own metrics dataset, with no flag', () => {
  // The base names stay for the unsuffixed deployment; another's carries its suffix.
  for (const [app, render] of [
    ['web', renderWeb],
    ['storefront', renderStorefront],
    ['engine', renderEngine],
  ] as const) {
    assert.deepEqual(
      base(app).analytics_engine_datasets,
      [{ binding: 'METRICS', dataset: 'commerceworker_ops' }],
      `${app}'s base config`,
    );
    assert.deepEqual(render(base(app), acme).analytics_engine_datasets, [
      { binding: 'METRICS', dataset: 'commerceworker_ops_acme' },
    ]);
  }
  assert.equal(names(acme).opsDataset, 'commerceworker_ops_acme');
});

test('alerts are made only with redundancy.alerts set and not excepted', () => {
  assert.equal(alertSpec(acme), null);
  assert.equal(alertSpec(protectedAcme()), null);
  assert.equal(alertsOn(protectedAcme({ alerts: { pagerduty: 'routing-key' } })), true);
  assert.equal(
    alertSpec(
      protectedAcme({ alerts: { webhook: 'https://hooks.example/x' }, except: ['alerts'] }),
    ),
    null,
  );
  assert.equal(shellVars(protectedAcme({ alerts: { pagerduty: 'k' } })).ALERTS, 'true');
  assert.equal(shellVars(acme).ALERTS, 'false');
});

test('the four policies the docs name, and a minute-by-minute check on each deep health', () => {
  const spec = alertSpec(protectedAcme({ alerts: { pagerduty: 'routing-key' } }))!;
  assert.deepEqual(
    spec.policies.map((p) => [p.name, p.alert_type]),
    [
      ['CommerceWorker: Worker issues', 'workers_observability_real_time_issue'],
      ['CommerceWorker: HTTP DDoS', 'dos_attack_l7'],
      ['CommerceWorker: Universal SSL', 'universal_ssl_event_type'],
      ['CommerceWorker: Advanced certificates', 'dedicated_ssl_certificate_event_type'],
    ],
  );
  assert.equal(ALERT_POLICIES.length, 4);
  assert.equal(spec.pagerduty, true);
  assert.equal(spec.webhookName, 'commerceworker-alerts-acme');
  assert.deepEqual(
    spec.healthChecks.map((h) => [
      h.name,
      h.body.address,
      h.body.http_config.path,
      h.body.interval,
    ]),
    [
      ['commerceworker-web-acme', acme.domain, '/health/deep', 60],
      ['commerceworker-storefront-acme', acme.storefrontDomain, '/health/deep', 60],
    ],
  );
  assert.deepEqual(spec.healthChecks[0]!.body, {
    name: 'commerceworker-web-acme',
    description: 'web deep health (D1, R2 and the engine) for acme',
    address: acme.domain,
    type: 'HTTPS',
    interval: 60,
    timeout: 10,
    retries: 2,
    consecutive_fails: 2,
    consecutive_successes: 2,
    check_regions: ['WEU', 'ENAM'],
    http_config: {
      method: 'GET',
      path: '/health/deep',
      port: 443,
      expected_codes: ['200'],
      follow_redirects: false,
      allow_insecure: false,
      header: { Host: [acme.domain] },
    },
  });
  assert.equal(
    protectedAcme({ alerts: { webhook: 'https://hooks.example/x' } }).redundancy?.alerts?.webhook,
    'https://hooks.example/x',
  );
  assert.equal(
    spec.pagerduty &&
      alertSpec(protectedAcme({ alerts: { webhook: 'https://h.example/x' } }))!.pagerduty,
    false,
  );
});

// --- Email: the queue, the fallback sender, the dead letters and their redrive ---

const mailing = (redundancy: unknown = true, email: Record<string, unknown> | null = {}) =>
  protectedAcme(redundancy, {
    ...(email ? { email: { from: 'orders@mail.acme.test', ...email } } : {}),
  });
type QueueEntry = Record<string, string | number | undefined>;
const queueNames = (c: { queues?: { consumers: QueueEntry[] } }) =>
  c.queues?.consumers.map((q) => [q.queue, q.dead_letter_queue]);

test('email.fallbackFrom is a second onboarded domain: another address, never the first’s domain', () => {
  const ok = toDeployment({
    ...acme,
    email: { from: 'orders@mail.acme.test', fallbackFrom: ' orders@backup.example.net ' },
  });
  assert.equal(ok.email?.fallbackFrom, 'orders@backup.example.net');
  assert.deepEqual(emailDomains(ok), ['mail.acme.test', 'backup.example.net']);
  for (const [fallbackFrom, why] of [
    ['nope', /second domain onboarded/],
    ['alerts@MAIL.acme.test', /same domain as email.from/],
    [7, /second domain onboarded/],
  ] as const)
    assert.throws(
      () => toDeployment({ ...acme, email: { from: 'orders@mail.acme.test', fallbackFrom } }),
      why,
    );
  // Ids that would start like a mail queue's own name are refused: the engine dispatches on the name.
  for (const id of ['dlq', 'events', 'events-eu', 'dlq-x'])
    assert.throws(() => toDeployment({ ...acme, id }), /would name a mail queue/);
  assert.doesNotThrow(() => toDeployment({ ...acme, id: 'eventsx' }));
});

test('mail is queued only with redundancy, a sender, and email not an exception', () => {
  assert.equal(queuesEmail(mailing()), true);
  assert.equal(queuesEmail(mailing({ except: ['email'] })), false);
  assert.equal(queuesEmail(mailing(true, null)), false);
  assert.equal(queuesEmail(toDeployment({ ...acme, email: { from: 'a@b.test' } })), false);
  // The other exceptions don't touch it.
  assert.equal(queuesEmail(mailing({ except: ['queues', 'd1Backup', 'r2Replica'] })), true);
});

test('the engine renders the mail queue, its dead letters and the event queue, suffixed, with the producer', () => {
  const c = renderEngine(base('engine'), mailing());
  assert.deepEqual(c.queues.producers, [
    { binding: 'EMAIL_QUEUE', queue: 'commerceworker-email-acme' },
  ]);
  assert.deepEqual(queueNames(c), [
    ['commerceworker-docs-replica-acme', 'commerceworker-docs-replica-dlq-acme'],
    ['commerceworker-docs-replica-dlq-acme', undefined],
    ['commerceworker-email-acme', 'commerceworker-email-dlq-acme'],
    ['commerceworker-email-dlq-acme', undefined],
    ['commerceworker-email-events-acme', 'commerceworker-email-events-dlq-acme'],
    ['commerceworker-email-events-dlq-acme', undefined],
  ]);
  const n = names(mailing());
  assert.deepEqual(
    [n.emailQueue, n.emailDlq, n.emailEvents, n.emailEventsDlq],
    [
      'commerceworker-email-acme',
      'commerceworker-email-dlq-acme',
      'commerceworker-email-events-acme',
      'commerceworker-email-events-dlq-acme',
    ],
  );
  // Retries: the queue retries before its dead-letter queue, the dead-letter consumer keeps trying.
  assert.equal(c.queues.consumers[2]?.max_retries, 6);
});

test('with the flag off, or email an exception, mail is inline: no producer, no mail consumers', () => {
  for (const d of [
    toDeployment({ ...acme, email: { from: 'orders@mail.acme.test' } }),
    mailing({ except: ['email'] }),
  ]) {
    const c = renderEngine(base('engine'), d);
    assert.equal(c.queues?.producers, undefined);
    assert.ok(!JSON.stringify(c.queues ?? {}).includes('commerceworker-email'));
  }
  // The flag off strips everything; email an exception leaves the replica's queues.
  assert.equal(
    renderEngine(base('engine'), toDeployment({ ...acme, email: { from: 'a@b.test' } })).queues,
    undefined,
  );
  assert.deepEqual(queueNames(renderEngine(base('engine'), mailing({ except: ['email'] }))), [
    ['commerceworker-docs-replica-acme', 'commerceworker-docs-replica-dlq-acme'],
    ['commerceworker-docs-replica-dlq-acme', undefined],
  ]);
  // A flagged deployment with no sender has nothing to queue either.
  assert.ok(
    !JSON.stringify(renderEngine(base('engine'), mailing(true, null)).queues).includes('email'),
  );
  // And r2Replica an exception leaves only the mail queue's.
  assert.deepEqual(
    queueNames(renderEngine(base('engine'), mailing({ except: ['r2Replica'] })))!.map((q) => q[0]),
    [
      'commerceworker-email-acme',
      'commerceworker-email-dlq-acme',
      'commerceworker-email-events-acme',
      'commerceworker-email-events-dlq-acme',
    ],
  );
});

test('the fallback sender adds its binding and address, and only where the registry sets it', () => {
  const withFallback = toDeployment({
    ...acme,
    email: { from: 'orders@mail.acme.test', fallbackFrom: 'orders@backup.example.net' },
  });
  const c = renderEngine(base('engine'), withFallback);
  assert.deepEqual(c.send_email, [{ name: 'EMAIL' }, { name: 'EMAIL_FALLBACK' }]);
  assert.equal(c.vars.EMAIL_FALLBACK_FROM, 'orders@backup.example.net');
  const plain = renderEngine(
    base('engine'),
    toDeployment({ ...acme, email: { from: 'a@b.test' } }),
  );
  assert.deepEqual(plain.send_email, [{ name: 'EMAIL' }]);
  assert.equal(plain.vars.EMAIL_FALLBACK_FROM, '');
  assert.equal(renderEngine(base('engine'), acme).send_email, undefined);
});

test('provision.sh is told the mail queues and the domains to subscribe, only when mail is queued', () => {
  const on = shellVars(
    protectedAcme(true, {
      email: { from: 'orders@mail.acme.test', fallbackFrom: 'orders@backup.example.net' },
    }),
  );
  assert.deepEqual(
    [on.EMAIL_QUEUE, on.EMAIL_DLQ, on.EMAIL_EVENTS, on.EMAIL_EVENTS_DLQ, on.EMAIL_DOMAINS],
    [
      'commerceworker-email-acme',
      'commerceworker-email-dlq-acme',
      'commerceworker-email-events-acme',
      'commerceworker-email-events-dlq-acme',
      'mail.acme.test backup.example.net',
    ],
  );
  for (const d of [acme, mailing({ except: ['email'] }), mailing(true, null)])
    assert.deepEqual(
      ['EMAIL_QUEUE', 'EMAIL_DLQ', 'EMAIL_EVENTS', 'EMAIL_EVENTS_DLQ', 'EMAIL_DOMAINS'].map(
        (k) => shellVars(d)[k],
      ),
      ['', '', '', '', ''],
    );
});

/**
 * Every queue a rendered config consumes has a dead-letter queue, and every dead-letter queue a
 * consumer. A dead-letter queue's own consumer (it keeps what it gets) has none: it is the end.
 * Checked across all of a deployment's configs, since a queue is consumed in one Worker and may be
 * produced to (or, the purge queue, dead-lettered) from another.
 */
function coverageOf(configs: { queues?: { consumers: QueueEntry[] } }[]) {
  const consumers = configs.flatMap((c) => c.queues?.consumers ?? []);
  const consumed = new Set(consumers.map((c) => c.queue as string));
  const dlqs = new Set(
    consumers.flatMap((c) => (c.dead_letter_queue ? [c.dead_letter_queue as string] : [])),
  );
  const problems: string[] = [];
  for (const c of consumers)
    if (!c.dead_letter_queue && !dlqs.has(c.queue as string))
      problems.push(`${c.queue} is consumed and has no dead-letter queue`);
  for (const q of dlqs)
    if (!consumed.has(q)) problems.push(`${q} is a dead-letter queue nothing consumes`);
  return { problems, consumers };
}
const coverage = (d: ReturnType<typeof toDeployment>) =>
  coverageOf(renderAll(d).map((r) => r.config));

test('every queue consumer has a dead-letter queue, and every dead-letter queue has a consumer', () => {
  const deployments = [
    // The registry's own (a deployment not yet provisioned can't render).
    ...loadDeployments().filter((d) => d.d1Id && d.catalogKvId),
    acme,
    protectedAcme(),
    mailing(),
    mailing({ except: ['email'] }),
    mailing({ except: ['r2Replica'] }),
    mailing(true, null),
    withContent,
    toDeployment({
      ...withContent,
      standbyD1Id: STANDBY,
      redundancy: true,
      email: { from: 'a@mail.test' },
    }),
  ];
  for (const d of deployments) {
    const { problems, consumers } = coverage(d);
    assert.deepEqual(problems, [], `${d.id}: ${problems.join('; ')}`);
    assert.ok(consumers.length > 0, `${d.id} consumes nothing: the check looks at nothing`);
  }
});

test('the coverage check catches a consumer with no dead-letter queue and one that nothing consumes', () => {
  const engine = renderEngine(base('engine'), mailing());
  const without = (queue: string) => ({
    queues: { consumers: engine.queues.consumers.filter((c: QueueEntry) => c.queue !== queue) },
  });
  assert.deepEqual(coverageOf([engine]).problems, []);
  // Its dead-letter queue has no consumer.
  assert.deepEqual(coverageOf([without('commerceworker-email-dlq-acme')]).problems, [
    'commerceworker-email-dlq-acme is a dead-letter queue nothing consumes',
  ]);
  // A consumer with none (and that is nobody's dead-letter queue).
  const bare = {
    queues: { consumers: [{ queue: 'commerceworker-email-acme' }] },
  };
  assert.deepEqual(coverageOf([bare]).problems, [
    'commerceworker-email-acme is consumed and has no dead-letter queue',
  ]);
});

// The redrive: what to send is a pure plan; running it needs an operator's credentials.
const DLQ = 'commerceworker-email-dlq-acme';
const dead = (date: string, id: string) => `dlq/${DLQ}/${date}/${id}.json`;

test('the redrive plan sends each kept dead letter not yet marked, oldest first, of the day asked for', () => {
  const keys = [dead('2026-11-12', 'b'), dead('2026-11-11', 'a'), dead('2026-11-12', 'a')];
  const markers = [markerKey(DLQ, '2026-11-12', 'a.json')];
  assert.deepEqual(redrivePlan({ dlq: DLQ, keys, markers }), {
    send: [
      { key: dead('2026-11-11', 'a'), marker: markerKey(DLQ, '2026-11-11', 'a.json') },
      { key: dead('2026-11-12', 'b'), marker: markerKey(DLQ, '2026-11-12', 'b.json') },
    ],
    skipped: [{ key: dead('2026-11-12', 'a'), reason: 'already redriven' }],
  });
  assert.deepEqual(
    redrivePlan({ dlq: DLQ, date: '2026-11-11', keys, markers }).send.map((s) => s.key),
    [dead('2026-11-11', 'a')],
  );
  // Another queue's object, or a stray key, is skipped; a bad date is refused.
  const stray = redrivePlan({
    dlq: DLQ,
    keys: ['dlq/other-dlq/2026-11-12/x.json', 'dlq/redriven/x', dead('2026-11-12', 'ok')],
    markers: [],
  });
  assert.equal(stray.send.length, 1);
  assert.equal(stray.skipped.length, 2);
  assert.throws(
    () => redrivePlan({ dlq: DLQ, date: 'yesterday', keys: [], markers: [] }),
    /YYYY-MM-DD/,
  );
});

test('a kept body is sent back as it was; a redacted sign-in code and a non-message are not', () => {
  const job = { kind: 'confirmation', orderId: 'o1', messageId: 'm1' };
  assert.deepEqual(redriveBody(JSON.stringify({ queue: DLQ, id: 'x', body: job })), { body: job });
  assert.deepEqual(
    redriveBody(JSON.stringify({ body: { kind: 'sign_in', redacted: true, expiresAt: 1 } })),
    { skip: 'redacted when kept: its code is gone' },
  );
  assert.deepEqual(redriveBody('not json'), { skip: 'unreadable' });
  assert.deepEqual(redriveBody('{"id":"x"}'), { skip: 'no body' });
});

function memoryIo(objects: Record<string, string>, failSend = false) {
  const store = new Map(Object.entries(objects));
  const sent: unknown[] = [];
  const io: RedriveIo = {
    list: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)).sort(),
    get: async (k) => store.get(k) ?? '',
    put: async (k, b) => void store.set(k, b),
    remove: async (k) => void store.delete(k),
    send: async (b) => {
      if (failSend) throw new Error('Queues push: 503');
      sent.push(b);
    },
  };
  return { io, sent, store };
}

test('a redrive sends each once: the second run finds the markers and sends nothing', async () => {
  const body = { kind: 'confirmation', orderId: 'o1', messageId: 'm1' };
  const { io, sent, store } = memoryIo({ [dead('2026-11-12', 'a')]: JSON.stringify({ body }) });
  const first = await redrive(io, { dlq: DLQ }, undefined);
  assert.deepEqual([first.sent, first.failed], [[dead('2026-11-12', 'a')], []]);
  assert.deepEqual(sent, [body]);
  assert.ok(store.has(markerKey(DLQ, '2026-11-12', 'a.json')));
  const second = await redrive(io, { dlq: DLQ }, undefined);
  assert.deepEqual(second.sent, []);
  assert.equal(second.skipped[0]?.reason, 'already redriven');
  assert.equal(sent.length, 1);
});

test('a send that fails removes its marker so the next run tries again; a dry run changes nothing', async () => {
  const objects = { [dead('2026-11-12', 'a')]: JSON.stringify({ body: { kind: 'confirmation' } }) };
  const failing = memoryIo(objects, true);
  const r = await redrive(failing.io, { dlq: DLQ }, undefined);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0]!.error, /503/);
  assert.ok(!failing.store.has(markerKey(DLQ, '2026-11-12', 'a.json')));
  const dry = memoryIo(objects);
  const d = await redrive(dry.io, { dlq: DLQ }, undefined, true);
  assert.equal(d.sent.length, 1);
  assert.deepEqual(dry.sent, []);
  assert.ok(![...dry.store.keys()].some((k) => k.startsWith('dlq/redriven/')));
});

test('a redacted dead letter is skipped, never sent, and leaves no marker', async () => {
  const { io, sent, store } = memoryIo({
    [dead('2026-11-12', 'c')]: JSON.stringify({ body: { kind: 'sign_in', redacted: true } }),
  });
  const r = await redrive(io, { dlq: DLQ }, undefined);
  assert.deepEqual(sent, []);
  assert.equal(r.skipped[0]?.reason, 'redacted when kept: its code is gone');
  assert.ok(![...store.keys()].some((k) => k.startsWith('dlq/redriven/')));
});

test('which queues can be redriven follows what the deployment runs; the command never runs in CI', () => {
  const t = (d: ReturnType<typeof toDeployment>) => redriveTargets(d).map((x) => x.name);
  assert.deepEqual(t(mailing()), [
    'docs-replica',
    'email',
    'email-events',
    'catalog-feed-parts',
    'catalog-changes',
    'catalog-purge',
  ]);
  assert.deepEqual(t(acme), ['catalog-feed-parts', 'catalog-changes', 'catalog-purge']);
  const email = redriveTargets(mailing()).find((x) => x.name === 'email')!;
  assert.deepEqual(
    [email.bucket, email.dlq, email.queue],
    ['docsReplica', DLQ, 'commerceworker-email-acme'],
  );
  const catalog = redriveTargets(acme).find((x) => x.name === 'catalog-changes')!;
  assert.deepEqual(
    [catalog.bucket, catalog.queue],
    ['catalogR2', 'commerceworker-catalog-changes-acme'],
  );
  for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    const r = spawnSync(
      process.execPath,
      ['scripts/fleet.ts', 'redrive', 'commerceworker', 'catalog-changes'],
      {
        cwd: join(import.meta.dirname, '..'),
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env },
        encoding: 'utf8',
      },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /never in CI/);
  }
});

test('R2 requests are signed with SigV4 and its list answer is read', () => {
  const headers = signR2(
    {
      method: 'GET',
      host: 'acct.r2.cloudflarestorage.com',
      path: '/bucket',
      query: 'list-type=2&prefix=dlq%2F',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      at: new Date('2026-11-12T10:00:00Z'),
    },
    { accessKeyId: 'AKID', secretAccessKey: 'secret' },
  );
  assert.equal(headers['x-amz-date'], '20261112T100000Z');
  assert.match(
    headers.authorization!,
    /^AWS4-HMAC-SHA256 Credential=AKID\/20261112\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
  assert.deepEqual(
    parseList(
      '<R><Key>dlq/a&amp;b.json</Key><Key>dlq/c.json</Key><NextContinuationToken>t</NextContinuationToken></R>',
    ),
    { keys: ['dlq/a&b.json', 'dlq/c.json'], next: 't' },
  );
  // `&amp;` is decoded last, so an escaped entity stays an entity.
  assert.deepEqual(parseList('<R><Key>dlq/x&amp;lt;y.json</Key></R>').keys, ['dlq/x&lt;y.json']);
});
