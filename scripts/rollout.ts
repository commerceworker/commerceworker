/**
 * Gradual Worker rollouts for one deployment (.github/workflows/deploy.yml, docs/deploy.md).
 *
 * A deployment whose registry has `redundancy` on (and `canary` not an exception) ships each Worker
 * as a new version that takes traffic in steps, instead of `wrangler deploy` putting it live at
 * once. This file decides, per Worker, how it ships; deploy.yml and scripts/rollout.sh run what it
 * decides. Nothing here deploys: the decisions are pure (and tested), and the only network calls
 * are reads (the Workers API for what is deployed, the GraphQL Analytics API for error rates).
 *
 *   node scripts/rollout.ts plan <id> <out>   decide each Worker's mode (DEPLOYMENT, the registry
 *                                             entry as JSON, in the environment); writes <out> and
 *                                             prints a Markdown table for the job summary
 *   node scripts/rollout.ts get <key> <field>   one Worker's mode, name, filter, old or new version
 *   node scripts/rollout.ts keys <mode>...      the Workers shipping in these modes, in deploy order
 *   node scripts/rollout.ts record <key> <id>   note the version just uploaded for <key>
 *   node scripts/rollout.ts specs <key> <percent>  the `wrangler versions deploy` arguments for that share
 *   node scripts/rollout.ts rollback-specs <key>   the arguments that put it back on its earlier version
 *   node scripts/rollout.ts overrides          the Cloudflare-Workers-Version-Overrides header value
 *   node scripts/rollout.ts smoke-urls [mode...] the URLs the override smoke test requests (of these modes)
 *   node scripts/rollout.ts watch <since>       hold, and fail if a new version's error rate rises
 *   node scripts/rollout.ts watch-promoted <since>  after every Worker is at 100%: watch the gradual
 *                                             and staged versions for ROLLOUT_POST_PROMOTE_SECONDS
 *
 * Modes: `full` is `wrangler deploy`; `gradual` is upload, 0% (smoke test by override), 10%, hold and
 * watch, 100%; `staged` (a Worker that serves hashed static assets or runs Workflows) stays at 0%
 * through the hold, is smoke tested again, and goes to 100% after every gradual Worker has, so a
 * new caller never goes live before the callees it was built against. If any Worker is `full`, all are.
 * Every other reads ROLLOUT_PLAN, the file `plan` wrote.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export type Mode = 'full' | 'gradual' | 'staged';

/** The share of traffic a new version takes first. */
export const CANARY_PERCENT = 10;
/** How long the new version holds that share, watched, before it takes the rest. */
export const HOLD_SECONDS = 600;
/**
 * How long every rolled-out version (the staged Workers too) is watched at full traffic before its
 * triggers are applied. The step running it has a 30 minute timeout, so the window is capped.
 */
export const POST_PROMOTE_SECONDS = 600;
export const POST_PROMOTE_MAX_SECONDS = 1200;
/** The share of a new version's invocations that may fail while it holds, as a fraction. */
export const MAX_ERROR_RATE = 0.02;
/** Fewer failures than this are noise, whatever the rate. */
export const MIN_ERRORS = 3;
/** Fewer invocations than this can't show a rate: the hold passes with a notice. */
export const MIN_REQUESTS = 20;

/** What a Worker is: how it is reached decides what a smoke test and a split can do. */
type Traits = {
  /** The app (or plugin) directory, relative to the repository. */
  dir: string;
  /** Needs the registry's `content`. */
  content?: true;
  /**
   * Why a percentage split is unsafe for it, so it goes 0% (smoke test) then 100% with no split: it
   * serves content-hashed static assets (a split sends a page's asset requests to the other
   * version), or it runs Workflows and Durable Objects (an instance's steps could run on both
   * versions, and their invocations aren't in the Workers analytics the hold reads).
   */
  staged?: string;
  /** The host (registry field) and paths a request reaches it at. Without one it is reached only by service binding RPC. */
  smoke?: {
    hosts: (
      | 'domain'
      | 'catalogDomain'
      | 'storefrontDomain'
      | 'studioDomain'
      | 'apiDomain'
      | 'mediaDomain'
      | 'cdnDomain'
    )[];
    paths: string[];
  };
};

const ASSETS =
  "serves hashed static assets (a split would send a page's asset requests to the other version; it needs version affinity)";
const WORKFLOWS =
  "runs Workflows and Durable Objects (a split could run one instance's steps on both versions, and the hold can't see those invocations)";

/** In deploy order: each Worker is bound by the ones after it. */
const APPS: Record<string, Traits> = {
  catalog: { dir: 'apps/catalog', staged: WORKFLOWS },
  pipeline: { dir: 'apps/pipeline', content: true, staged: WORKFLOWS },
  media: {
    dir: 'apps/media',
    content: true,
    smoke: { hosts: ['mediaDomain'], paths: ['/health'] },
  },
  api: { dir: 'apps/api', content: true, smoke: { hosts: ['apiDomain'], paths: ['/health'] } },
  // The catalog's read-only edge (and, with content, the content API at cdnDomain).
  delivery: {
    dir: 'apps/delivery',
    smoke: { hosts: ['catalogDomain', 'cdnDomain'], paths: ['/health'] },
  },
  engine: { dir: 'apps/engine', staged: WORKFLOWS },
  storefront: {
    dir: 'apps/storefront',
    staged: ASSETS,
    smoke: { hosts: ['storefrontDomain'], paths: ['/health', '/health/deep'] },
  },
  web: {
    dir: 'apps/web',
    staged: ASSETS,
    smoke: { hosts: ['domain'], paths: ['/health', '/health/deep'] },
  },
  studio: {
    dir: 'apps/studio',
    content: true,
    staged: ASSETS,
    smoke: { hosts: ['studioDomain'], paths: ['/health', '/health/deep'] },
  },
};

/** The registry entry's fields the plan reads (a `Deployment` from scripts/fleet.ts, as JSON). */
export type DeploymentInput = {
  id: string;
  content?: boolean;
  domain: string;
  catalogDomain: string;
  storefrontDomain: string;
  studioDomain?: string;
  apiDomain?: string;
  mediaDomain?: string;
  cdnDomain?: string;
  plugins?: Record<string, { runtime?: string }>;
  redundancy?: { except: string[] } | null;
};

/** What Cloudflare says about a Worker, null when it couldn't be read. */
export type Deployed = {
  exists: boolean;
  /** The Durable Object migration tag it last applied. */
  migrationTag: string | null;
  /** The version serving all traffic, null when traffic is split (a rollout in progress) or nothing is deployed. */
  stableVersion: string | null;
  /** More than one version in the latest deployment. */
  split: boolean;
} | null;

export type WorkerInput = {
  key: string;
  name: string;
  filter: string;
  /** The last Durable Object migration tag in the rendered config, null with none. */
  configTag: string | null;
  deployed: Deployed;
};

export type PlannedWorker = {
  key: string;
  name: string;
  filter: string;
  mode: Mode;
  /** Why: shown in the job summary, and the reason a Worker falls back to `full`. */
  reason: string;
  /** What a request carrying the version override reaches; none for a Worker only reached over RPC. */
  smoke: string[];
  /** The version serving traffic before this deploy: what a rollback returns to. */
  oldVersion: string | null;
  /** The version uploaded by this deploy, once it is. */
  newVersion?: string;
};

export type Plan = {
  id: string;
  canaryPercent: number;
  workers: PlannedWorker[];
};

/** Whether this deployment ships gradually: `redundancy` on and `canary` not an exception. */
export function rolloutOn(d: Pick<DeploymentInput, 'redundancy'>): { on: boolean; reason: string } {
  if (!d.redundancy) return { on: false, reason: 'redundancy is off' };
  if (d.redundancy.except.includes('canary'))
    return { on: false, reason: 'redundancy.except has canary' };
  return { on: true, reason: '' };
}

/** The Workers a deployment deploys, in deploy order, as `{ key, dir }`. */
export function workerKeys(d: DeploymentInput): { key: string; dir: string; traits?: Traits }[] {
  const plugins = Object.entries(d.plugins ?? {})
    .filter(([, p]) => (p.runtime ?? 'worker') === 'worker')
    .map(([id]) => id)
    .sort();
  const out: { key: string; dir: string; traits?: Traits }[] = [];
  const add = (name: string) => {
    const t = APPS[name] as Traits;
    if (!t.content || d.content) out.push({ key: name, dir: t.dir, traits: t });
  };
  // catalog .. delivery, then the plugins (the engine and web bind them), then engine, storefront, web, studio.
  for (const name of ['catalog', 'pipeline', 'media', 'api', 'delivery']) add(name);
  for (const p of plugins) out.push({ key: `plugin:${p}`, dir: `plugins/${p}` });
  for (const name of ['engine', 'storefront', 'web', 'studio']) add(name);
  return out;
}

/** The URLs a request with the version override can reach this Worker at: none for an RPC-only Worker. */
export function smokeUrls(d: DeploymentInput, traits?: Traits): string[] {
  if (!traits?.smoke) return [];
  const urls: string[] = [];
  for (const field of traits.smoke.hosts) {
    const host = d[field];
    if (!host) continue;
    for (const path of traits.smoke.paths) urls.push(`https://${host}${path}`);
  }
  return urls;
}

/** One Worker's mode and why. Anything this can't be sure of is `full`: `wrangler deploy`, as before. */
export function planWorker(
  w: WorkerInput,
  traits: Traits | undefined,
  d: DeploymentInput,
): PlannedWorker {
  const base = { key: w.key, name: w.name, filter: w.filter, smoke: [] as string[] };
  const full = (reason: string): PlannedWorker => ({
    ...base,
    mode: 'full',
    reason,
    oldVersion: w.deployed?.stableVersion ?? null,
  });
  const on = rolloutOn(d);
  if (!on.on) return full(on.reason);
  const s = w.deployed;
  if (!s) return full("Cloudflare's record of it couldn't be read");
  if (!s.exists) return full('first deploy: there is no earlier version');
  // Cloudflare refuses a version that changes a Durable Object class, and a rollback can't go back
  // past one: a migration ships on its own, with `wrangler deploy`.
  if (w.configTag !== null && w.configTag !== s.migrationTag)
    return full(
      `a Durable Object migration (${w.configTag}) is pending${s.migrationTag ? ` after ${s.migrationTag}` : ''}`,
    );
  if (s.split) return full('a rollout of it is already in progress (traffic is split)');
  if (!s.stableVersion) return full('no deployment to return to');
  const smoke = smokeUrls(d, traits);
  if (traits?.staged)
    return {
      ...base,
      smoke,
      mode: 'staged',
      reason: `${traits.staged}: held at 0% through the hold, smoke tested, then 100%`,
      oldVersion: s.stableVersion,
    };
  return {
    ...base,
    smoke,
    mode: 'gradual',
    reason: smoke.length
      ? 'percentages, smoke test by version override'
      : 'percentages (reached over RPC only: no override smoke test)',
    oldVersion: s.stableVersion,
  };
}

/**
 * Each Worker of the deployment, planned. All or nothing: a Worker that ships in full goes live at
 * once, unwatched, while the others would sit at 0% or 10% for the whole hold, and a rollback
 * would leave the splits in place. So when any Worker is `full`, every Worker is.
 */
export function planRollout(d: DeploymentInput, workers: WorkerInput[]): Plan {
  const traitsOf = new Map(workerKeys(d).map((w) => [w.key, w.traits]));
  let planned = workers.map((w) => planWorker(w, traitsOf.get(w.key), d));
  const first = planned.find((w) => w.mode === 'full');
  if (first)
    planned = planned.map((w) =>
      w.mode === 'full'
        ? w
        : { ...w, mode: 'full', smoke: [], reason: `${first.name} ships in full` },
    );
  return { id: d.id, canaryPercent: CANARY_PERCENT, workers: planned };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `wrangler versions deploy` arguments for a traffic split: the new version first at every step,
 * so Durable Objects already assigned to it stay on it as its share grows. At 100% the old
 * version leaves the deployment.
 */
export function versionSpecs(newVersion: string, oldVersion: string, percent: number): string[] {
  for (const v of [newVersion, oldVersion])
    if (!UUID.test(v)) throw new Error(`not a Worker version id: ${v}`);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100)
    throw new Error(`a traffic share is a whole number from 0 to 100, not ${percent}`);
  if (percent === 100) return [`${newVersion}@100%`];
  return [`${newVersion}@${percent}%`, `${oldVersion}@${100 - percent}%`];
}

/** The arguments that put a Worker back on its earlier version alone. */
export const rollbackSpecs = (oldVersion: string) => versionSpecs(oldVersion, oldVersion, 100);

/**
 * The `Cloudflare-Workers-Version-Overrides` header value: a structured-field dictionary of
 * Worker name to version id. A request carrying it is served by that version where it is in the
 * Worker's current deployment (also at 0%), and by the percentages where it isn't.
 */
export function overridesHeader(versions: { name: string; version: string }[]): string {
  return versions
    .map(({ name, version }) => {
      if (!WORKER_NAME.test(name)) throw new Error(`not a Worker name: ${name}`);
      if (!UUID.test(version)) throw new Error(`not a Worker version id: ${version}`);
      return `${name}="${version}"`;
    })
    .join(', ');
}

/** Invocation statuses that aren't the new code's fault: a success, or a caller that went away, or the platform. */
const NOT_ERRORS = new Set([
  'success',
  'clientDisconnected',
  'responseStreamDisconnected',
  'internalError',
]);

export type Row = { status: string; requests: number };

/** The invocations of a version, and how many ended in an unhandled exception or a resource limit. */
export function tally(rows: Row[]): { requests: number; errors: number } {
  let requests = 0;
  let errors = 0;
  for (const r of rows) {
    requests += r.requests;
    if (!NOT_ERRORS.has(r.status)) errors += r.requests;
  }
  return { requests, errors };
}

export type Verdict = {
  verdict: 'ok' | 'fail' | 'quiet';
  requests: number;
  errors: number;
  rate: number;
};

/**
 * `fail` when enough invocations failed and over the threshold; `quiet` when too few ran to say
 * (the hold passes: the smoke tests are what covered it); `ok` otherwise.
 */
export function judge(
  rows: Row[],
  limits: { maxRate: number; minErrors: number; minRequests: number } = {
    maxRate: MAX_ERROR_RATE,
    minErrors: MIN_ERRORS,
    minRequests: MIN_REQUESTS,
  },
): Verdict {
  const { requests, errors } = tally(rows);
  const rate = requests ? errors / requests : 0;
  const verdict =
    errors >= limits.minErrors && rate > limits.maxRate
      ? 'fail'
      : requests < limits.minRequests
        ? 'quiet'
        : 'ok';
  return { verdict, requests, errors, rate };
}

export type WatchOptions = {
  workers: { name: string; version: string }[];
  /** The rows for one version since the rollout began. */
  rows: (worker: { name: string; version: string }) => Promise<Row[]>;
  holdMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  limits?: Parameters<typeof judge>[1];
};

/**
 * Holds for `holdMs`, looking at every new version's error rate each `intervalMs` and once more at
 * the end. Returns the first failure at once; an unreadable analytics response throws.
 */
export async function watch(o: WatchOptions): Promise<{ ok: boolean; failures: string[] }> {
  const log = o.log ?? (() => {});
  let waited = 0;
  for (;;) {
    const last = waited >= o.holdMs;
    const failures: string[] = [];
    for (const w of o.workers) {
      const v = judge(await o.rows(w), o.limits);
      log(
        `${w.name} ${w.version}: ${v.errors} of ${v.requests} invocations failed (${(v.rate * 100).toFixed(2)}%)${v.verdict === 'quiet' ? ', too few to judge' : ''}`,
      );
      if (v.verdict === 'fail')
        failures.push(
          `${w.name} ${w.version}: ${v.errors} of ${v.requests} invocations failed (${(v.rate * 100).toFixed(1)}%), over ${((o.limits?.maxRate ?? MAX_ERROR_RATE) * 100).toFixed(1)}%`,
        );
    }
    if (failures.length) return { ok: false, failures };
    if (last) return { ok: true, failures: [] };
    const step = Math.min(o.intervalMs, o.holdMs - waited);
    await o.sleep(step);
    waited += step;
  }
}

// --- Cloudflare reads -------------------------------------------------------------------------

type Fetch = typeof fetch;
const API = 'https://api.cloudflare.com/client/v4';

/** The parts of Cloudflare's answers read here. */
type ApiBody = {
  success?: boolean;
  errors?: { message?: string; extensions?: { code?: string } }[];
  result?: {
    default_environment?: { script?: { migration_tag?: string | null } };
    deployments?: { versions?: { version_id: string; percentage: number }[] }[];
  };
  data?: {
    viewer?: {
      accounts?: {
        workersInvocationsAdaptive?: {
          sum: { requests: number };
          dimensions: { status: string };
        }[];
      }[];
    };
  };
};

async function cf(fetchFn: Fetch, token: string, path: string, init?: RequestInit) {
  // A network failure is an answer of 0: the state is unknown, not an error that stops the deploy.
  const res = await fetchFn(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  }).catch(() => null);
  if (!res) return { status: 0, body: null as ApiBody | null };
  return { status: res.status, body: (await res.json().catch(() => null)) as ApiBody | null };
}

/** A Worker's deployed state: whether it exists, its migration tag, and the version serving all traffic. */
export async function deployedState(
  fetchFn: Fetch,
  token: string,
  account: string,
  name: string,
): Promise<Deployed> {
  const service = await cf(fetchFn, token, `/accounts/${account}/workers/services/${name}`);
  if (service.status === 404)
    return { exists: false, migrationTag: null, stableVersion: null, split: false };
  if (service.status !== 200 || !service.body?.success) return null;
  const tag = service.body.result?.default_environment?.script?.migration_tag;
  const deployments = await cf(
    fetchFn,
    token,
    `/accounts/${account}/workers/scripts/${name}/deployments`,
  );
  if (deployments.status !== 200 || !deployments.body?.success) return null;
  const versions = deployments.body.result?.deployments?.[0]?.versions ?? [];
  const only = versions.length === 1 && versions[0]?.percentage === 100 ? versions[0] : undefined;
  return {
    exists: true,
    migrationTag: typeof tag === 'string' && tag ? tag : null,
    stableVersion: only?.version_id ?? null,
    split: versions.length > 1,
  };
}

const QUERY = `query RolloutErrors($accountTag: string, $script: string, $version: string, $since: Time, $until: Time) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 100, filter: { scriptName: $script, scriptVersion: $version, datetime_geq: $since, datetime_leq: $until }) {
        sum { requests }
        dimensions { status }
      }
    }
  }
}`;

/** Why analytics couldn't be read: the token isn't allowed to, Cloudflare didn't answer, or the query is wrong. */
export class AnalyticsError extends Error {
  kind: 'denied' | 'unavailable' | 'query';
  constructor(message: string, kind: 'denied' | 'unavailable' | 'query') {
    super(message);
    this.kind = kind;
  }
}

/**
 * Whether the hold will be able to read error rates, asked before anything deploys. `denied` (the
 * token lacks the permission) is the one answer that turns the rollout off, so a missing permission
 * can't block a release; an unavailable API is retried, and a query that Cloudflare rejects throws,
 * so a broken query can't leave the rollout silently never running.
 */
export async function probeAnalytics(
  fetchFn: Fetch,
  token: string,
  account: string,
  w: { name: string; version: string },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<'ok' | 'denied'> {
  for (let attempt = 1; ; attempt++) {
    try {
      await versionRows(fetchFn, token, account, w, new Date(Date.now() - 3600_000).toISOString());
      return 'ok';
    } catch (err) {
      if (err instanceof AnalyticsError && err.kind === 'denied') return 'denied';
      if (err instanceof AnalyticsError && err.kind === 'unavailable' && attempt < 3) {
        await sleep(attempt * 5000);
        continue;
      }
      throw err;
    }
  }
}

/** One version's invocations by status since `since`, from the GraphQL Analytics API. Throws when it can't be read. */
export async function versionRows(
  fetchFn: Fetch,
  token: string,
  account: string,
  w: { name: string; version: string },
  since: string,
  until = new Date().toISOString(),
): Promise<Row[]> {
  const res = await cf(fetchFn, token, '/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: QUERY,
      variables: { accountTag: account, script: w.name, version: w.version, since, until },
    }),
  });
  if (res.status !== 200 || res.body?.errors?.length) {
    const denied =
      res.status === 401 ||
      res.status === 403 ||
      !!res.body?.errors?.some(
        (e) => e.extensions?.code === 'authz' || /not authorized|permission/i.test(e.message ?? ''),
      );
    throw new AnalyticsError(
      `Workers analytics for ${w.name}: ${res.status} ${JSON.stringify(res.body?.errors ?? res.body)}`,
      denied ? 'denied' : res.status === 0 || res.status >= 500 ? 'unavailable' : 'query',
    );
  }
  const groups = res.body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return groups.map((g) => ({ status: g.dimensions.status, requests: g.sum.requests }));
}

// --- Command line -----------------------------------------------------------------------------

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

/** The Workers of a deployment as `plan` needs them, from the configs `fleet.ts render` wrote. */
function readWorkers(d: DeploymentInput): Omit<WorkerInput, 'deployed'>[] {
  return workerKeys(d).map(({ key, dir }) => {
    const config = readJson(join(ROOT, dir, `wrangler.${d.id}.json`));
    const migrations: { tag: string }[] = config.migrations ?? [];
    return {
      key,
      name: config.name as string,
      filter: key.startsWith('plugin:') ? `./${dir}` : `@commerceworker/${key}`,
      configTag: migrations.at(-1)?.tag ?? null,
    };
  });
}

function table(plan: Plan) {
  const lines = [
    `Rollout for ${plan.id}`,
    '',
    '| Worker | Mode | Why |',
    '| --- | --- | --- |',
    ...plan.workers.map((w) => `| ${w.name} | ${w.mode} | ${w.reason} |`),
  ];
  return lines.join('\n');
}

function loadPlan(): { file: string; plan: Plan } {
  const file = process.env.ROLLOUT_PLAN;
  if (!file) throw new Error('ROLLOUT_PLAN is not set: run `rollout.ts plan` first');
  return { file, plan: readJson(file) as Plan };
}

function number(name: string, fallback: number, ok: (n: number) => boolean) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !ok(n)) throw new Error(`${name} is not usable: ${raw}`);
  return n;
}

async function main(cmd: string | undefined, args: string[]) {
  if (cmd === 'plan') {
    const [id, out] = args;
    const d = JSON.parse(process.env.DEPLOYMENT ?? 'null') as DeploymentInput | null;
    if (!d || d.id !== id || !out)
      throw new Error(
        'usage: rollout.ts plan <id> <out> (DEPLOYMENT is the registry entry as JSON)',
      );
    const configs = readWorkers(d);
    const on = rolloutOn(d);
    let workers: WorkerInput[];
    if (!on.on) {
      // Nothing to read: every Worker ships with `wrangler deploy`, as it always did.
      workers = configs.map((c) => ({ ...c, deployed: null }));
    } else {
      const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
      const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
      workers = [];
      for (const c of configs)
        workers.push({ ...c, deployed: await deployedState(fetch, token, account, c.name) });
    }
    let plan = planRollout(d, workers);
    if (on.on && plan.workers.some((w) => w.mode !== 'full')) {
      // The hold judges the new version by its error rate: with no way to read it, nothing is staged.
      const probe = plan.workers.find((w) => w.mode !== 'full') as PlannedWorker;
      const answer = await probeAnalytics(
        fetch,
        process.env.CLOUDFLARE_API_TOKEN ?? '',
        process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
        { name: probe.name, version: probe.oldVersion as string },
      );
      if (answer === 'denied') {
        console.error(
          '::warning title=Gradual rollout off::CLOUDFLARE_API_TOKEN may not read Workers analytics. Every Worker ships with a full deploy; give it Account Analytics Read to roll out gradually.',
        );
        plan = {
          ...plan,
          workers: plan.workers.map((w) => ({
            ...w,
            mode: 'full',
            smoke: [],
            reason: 'Workers analytics could not be read (see the warning)',
          })),
        };
      }
    }
    writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(table(plan));
    return;
  }
  const { file, plan } = loadPlan();
  const find = (key: string | undefined) => {
    const w = plan.workers.find((x) => x.key === key);
    if (!w) throw new Error(`${key} is not in the rollout plan`);
    return w;
  };
  if (cmd === 'get') {
    const [key, field] = args;
    const w = find(key);
    if (field === 'canary') return void console.log(String(plan.canaryPercent));
    const v = (w as Record<string, unknown>)[field as string];
    console.log(v === undefined || v === null ? '' : String(v));
  } else if (cmd === 'keys') {
    const modes = new Set(args);
    for (const w of plan.workers) if (modes.has(w.mode)) console.log(w.key);
  } else if (cmd === 'record') {
    const [key, version] = args;
    if (!UUID.test(version ?? '')) throw new Error(`not a Worker version id: ${version}`);
    find(key).newVersion = version;
    writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  } else if (cmd === 'specs') {
    // The `wrangler versions deploy` arguments putting <key>'s new version at <percent>.
    const [key, percent] = args;
    const w = find(key);
    if (!w.newVersion || !w.oldVersion)
      throw new Error(`${key} has no new and earlier version to split`);
    console.log(versionSpecs(w.newVersion, w.oldVersion, Number(percent)).join(' '));
  } else if (cmd === 'rollback-specs') {
    const w = find(args[0]);
    if (!w.oldVersion) throw new Error(`${args[0]} has no earlier version`);
    console.log(rollbackSpecs(w.oldVersion).join(' '));
  } else if (cmd === 'overrides') {
    console.log(
      overridesHeader(
        plan.workers
          .filter((w) => w.mode !== 'full' && w.newVersion)
          .map((w) => ({ name: w.name, version: w.newVersion as string })),
      ),
    );
  } else if (cmd === 'smoke-urls') {
    const modes = new Set(args.length ? args : ['gradual', 'staged']);
    for (const w of plan.workers)
      if (modes.has(w.mode) && w.newVersion) for (const u of w.smoke) console.log(u);
  } else if (cmd === 'watch' || cmd === 'watch-promoted') {
    const since = args[0];
    if (!since || Number.isNaN(Date.parse(since)))
      throw new Error(`usage: rollout.ts ${cmd} <ISO time the rollout step began>`);
    const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
    const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
    const promoted = cmd === 'watch-promoted';
    const holdMs = promoted
      ? number(
          'ROLLOUT_POST_PROMOTE_SECONDS',
          POST_PROMOTE_SECONDS,
          (n) => n >= 0 && n <= POST_PROMOTE_MAX_SECONDS,
        ) * 1000
      : number('ROLLOUT_HOLD_SECONDS', HOLD_SECONDS, (n) => n >= 0) * 1000;
    const maxRate = number('ROLLOUT_MAX_ERROR_RATE', MAX_ERROR_RATE, (n) => n > 0 && n < 1);
    // The hold watches the Workers taking a share (staged ones are at 0% through it: nothing to
    // watch). After promotion every rolled-out Worker serves all traffic, staged ones included.
    const watched = plan.workers.filter(
      (w) => (w.mode === 'gradual' || (promoted && w.mode === 'staged')) && w.newVersion,
    );
    if (!watched.length)
      return console.log(
        promoted
          ? 'No Worker was rolled out: nothing to watch'
          : 'No Worker is taking a share: nothing to hold',
      );
    const retrying = async (w: { name: string; version: string }) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await versionRows(fetch, token, account, w, since);
        } catch (err) {
          if (attempt === 3) throw err;
          await new Promise((r) => setTimeout(r, attempt * 5000));
        }
      }
    };
    const result = await watch({
      workers: watched.map((w) => ({ name: w.name, version: w.newVersion as string })),
      rows: retrying,
      holdMs,
      intervalMs: 60_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (line) => console.log(line),
      limits: { maxRate, minErrors: MIN_ERRORS, minRequests: MIN_REQUESTS },
    });
    if (!result.ok) {
      for (const f of result.failures) console.error(`::error title=Rollout error rate::${f}`);
      process.exit(1);
    }
  } else {
    throw new Error(
      'usage: rollout.ts plan|get|keys|record|overrides|smoke-urls|watch|watch-promoted (see the header)',
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2], process.argv.slice(3)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
