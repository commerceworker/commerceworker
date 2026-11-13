import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type Deployed,
  type DeploymentInput,
  deployedState,
  judge,
  overridesHeader,
  type Plan,
  planRollout,
  planWorker,
  probeAnalytics,
  rollbackSpecs,
  rolloutOn,
  versionRows,
  versionSpecs,
  type WorkerInput,
  watch,
  workerKeys,
} from './rollout.ts';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';

const deployment = (over: Partial<DeploymentInput> = {}): DeploymentInput => ({
  id: 'acme',
  domain: 'app.acme.test',
  catalogDomain: 'catalog.app.acme.test',
  storefrontDomain: 'shop.app.acme.test',
  redundancy: { except: [] },
  ...over,
});
const content = (over: Partial<DeploymentInput> = {}) =>
  deployment({
    content: true,
    studioDomain: 'studio.app.acme.test',
    apiDomain: 'api.app.acme.test',
    cdnDomain: 'cdn.app.acme.test',
    mediaDomain: 'media.app.acme.test',
    ...over,
  });

const live: Deployed = { exists: true, migrationTag: 'v6', stableVersion: OLD, split: false };
const worker = (key: string, over: Partial<WorkerInput> = {}): WorkerInput => ({
  key,
  name: `commerceworker-${key.replace(':', '-')}-acme`,
  filter: `@commerceworker/${key}`,
  configTag: null,
  deployed: live,
  ...over,
});
const plan = (d: DeploymentInput, key: string, over: Partial<WorkerInput> = {}) =>
  planRollout(d, [worker(key, over)]).workers[0]!;

test('a Worker with no migration to apply ships gradually, and returns to the version serving traffic', () => {
  const w = plan(deployment(), 'delivery', { configTag: 'v6' });
  assert.equal(w.mode, 'gradual');
  assert.equal(w.oldVersion, OLD);
});

test('a Durable Object migration the Worker has not applied forces a full deploy', () => {
  const w = plan(deployment(), 'engine', { configTag: 'v7' });
  assert.equal(w.mode, 'full');
  assert.match(w.reason, /Durable Object migration \(v7\) is pending after v6/);
  // The same config once the tag is applied is staged again.
  assert.equal(plan(deployment(), 'engine', { configTag: 'v6' }).mode, 'staged');
});

test('a Worker with migrations that never applied one is full', () => {
  const w = plan(deployment(), 'engine', {
    configTag: 'v1',
    deployed: { ...live, migrationTag: null },
  });
  assert.equal(w.mode, 'full');
  assert.match(w.reason, /\(v1\) is pending/);
});

test('a first deploy is full', () => {
  const w = plan(deployment(), 'catalog', {
    deployed: { exists: false, migrationTag: null, stableVersion: null, split: false },
  });
  assert.equal(w.mode, 'full');
  assert.match(w.reason, /first deploy/);
});

test('a Worker whose state could not be read is full, never staged blind', () => {
  assert.equal(plan(deployment(), 'engine', { deployed: null }).mode, 'full');
});

const modes = (d: DeploymentInput, over: Record<string, Partial<WorkerInput>>) =>
  planRollout(
    d,
    workerKeys(d).map((k) => worker(k.key, over[k.key])),
  ).workers;

test('one Worker that must ship in full makes every Worker ship in full', () => {
  const d = content({ plugins: { punchout: {} } });
  const everyone = workerKeys(d).map((w) => w.key);
  const cases: [string, Partial<WorkerInput>, RegExp][] = [
    ['engine', { configTag: 'v7' }, /migration \(v7\) is pending/],
    ['plugin:punchout', { deployed: null }, /couldn't be read/],
    [
      'media',
      { deployed: { exists: false, migrationTag: null, stableVersion: null, split: false } },
      /first deploy/,
    ],
  ];
  for (const [key, over, why] of cases) {
    const planned = modes(d, { [key]: over });
    assert.deepEqual(
      planned.map((w) => w.key),
      everyone,
    );
    for (const w of planned) {
      assert.equal(w.mode, 'full', `${key}: ${w.key}`);
      assert.deepEqual(w.smoke, []);
      if (w.key === key) assert.match(w.reason, why);
      else
        assert.match(
          w.reason,
          new RegExp(`${planned.find((x) => x.key === key)!.name} ships in full`),
        );
    }
  }
  // Nothing to force: nothing is full.
  assert.ok(modes(d, {}).every((w) => w.mode !== 'full'));
});

test('a Worker already split between versions is deployed in full', () => {
  const w = plan(deployment(), 'engine', {
    deployed: { ...live, stableVersion: null, split: true },
  });
  assert.equal(w.mode, 'full');
  assert.match(w.reason, /already in progress/);
});

test('flag off is full, and so is canary an exception', () => {
  const off = plan(deployment({ redundancy: null }), 'engine');
  assert.equal(off.mode, 'full');
  assert.match(off.reason, /redundancy is off/);
  assert.equal(plan(deployment({ redundancy: undefined }), 'engine').mode, 'full');
  const except = plan(deployment({ redundancy: { except: ['alerts', 'canary'] } }), 'engine');
  assert.equal(except.mode, 'full');
  assert.match(except.reason, /except has canary/);
  // Another exception leaves the rollout on.
  assert.equal(plan(deployment({ redundancy: { except: ['alerts'] } }), 'engine').mode, 'staged');
  assert.deepEqual(rolloutOn(deployment({ redundancy: null })), {
    on: false,
    reason: 'redundancy is off',
  });
});

test('a Worker reached only over RPC gets no override smoke test', () => {
  const d = content({ plugins: { punchout: {} } });
  const keys = ['catalog', 'pipeline', 'engine', 'plugin:punchout'];
  const planned = planRollout(
    d,
    keys.map((k) => worker(k)),
  );
  for (const w of planned.workers) {
    assert.notEqual(w.mode, 'full', w.key);
    assert.deepEqual(w.smoke, [], w.key);
  }
  assert.equal(planned.workers.find((w) => w.key === 'plugin:punchout')?.mode, 'gradual');
});

test('a Worker with a public host is smoke tested through it', () => {
  const d = content();
  const by = Object.fromEntries(
    planRollout(
      d,
      ['media', 'api', 'delivery'].map((k) => worker(k)),
    ).workers.map((w) => [w.key, w]),
  );
  assert.deepEqual(by.media!.smoke, ['https://media.app.acme.test/health']);
  assert.deepEqual(by.api!.smoke, ['https://api.app.acme.test/health']);
  // Delivery serves the catalog's edge and, with content, the content API.
  assert.deepEqual(by.delivery!.smoke, [
    'https://catalog.app.acme.test/health',
    'https://cdn.app.acme.test/health',
  ]);
  assert.deepEqual(plan(deployment(), 'delivery').smoke, ['https://catalog.app.acme.test/health']);
});

test('a Worker serving hashed assets or running Workflows is staged, not split', () => {
  for (const key of ['web', 'storefront', 'studio', 'engine', 'pipeline', 'catalog']) {
    const w = plan(content(), key);
    assert.equal(w.mode, 'staged', key);
    assert.match(w.reason, /held at 0% through the hold/, key);
  }
  assert.ok(plan(content(), 'web').smoke.length);
  assert.deepEqual(plan(deployment(), 'web').smoke, [
    'https://app.acme.test/health',
    'https://app.acme.test/health/deep',
  ]);
});

test('the Workers are in the order deploy.yml deploys them, plugins before the engine', () => {
  const keys = (d: DeploymentInput) => workerKeys(d).map((w) => w.key);
  assert.deepEqual(keys(deployment()), ['catalog', 'delivery', 'engine', 'storefront', 'web']);
  assert.deepEqual(keys(content({ plugins: { b: {}, a: {}, s: { runtime: 'sandboxed' } } })), [
    'catalog',
    'pipeline',
    'media',
    'api',
    'delivery',
    'plugin:a',
    'plugin:b',
    'engine',
    'storefront',
    'web',
    'studio',
  ]);
});

test('every Worker deploy.yml ships is one the plan covers', () => {
  const yaml = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  const shipped = [...yaml.matchAll(/rollout\.sh ship "?([\w:$]+)"?/g)].map((m) =>
    m[1]!.replace('$p', 'p'),
  );
  const planned = workerKeys(content({ plugins: { p: {} } })).map((w) => w.key);
  assert.deepEqual([...shipped].sort(), [...planned].sort());
});

test('versions go out new first, and 100% leaves the old one out', () => {
  assert.deepEqual(versionSpecs(NEW, OLD, 0), [`${NEW}@0%`, `${OLD}@100%`]);
  assert.deepEqual(versionSpecs(NEW, OLD, 10), [`${NEW}@10%`, `${OLD}@90%`]);
  assert.deepEqual(versionSpecs(NEW, OLD, 100), [`${NEW}@100%`]);
  assert.deepEqual(rollbackSpecs(OLD), [`${OLD}@100%`]);
  assert.throws(() => versionSpecs(NEW, OLD, 101), /0 to 100/);
  assert.throws(() => versionSpecs(NEW, OLD, 2.5), /whole number/);
  assert.throws(() => versionSpecs('x --yes', OLD, 10), /not a Worker version id/);
});

test('the override header is a dictionary of well-formed names and versions', () => {
  assert.equal(
    overridesHeader([
      { name: 'commerceworker-web-acme', version: NEW },
      { name: 'commerceworker-api', version: OLD },
    ]),
    `commerceworker-web-acme="${NEW}", commerceworker-api="${OLD}"`,
  );
  assert.throws(() => overridesHeader([{ name: 'a", b="c', version: NEW }]), /not a Worker name/);
  assert.throws(() => overridesHeader([{ name: 'a', version: 'v"1' }]), /not a Worker version id/);
});

test('a version whose invocations fail over the limit fails, a quiet one passes with a notice', () => {
  const rows = (ok: number, bad: number, status = 'scriptThrewException') => [
    { status: 'success', requests: ok },
    { status, requests: bad },
  ];
  assert.equal(judge(rows(95, 5)).verdict, 'fail');
  assert.equal(judge(rows(990, 10)).verdict, 'ok'); // 1%: under the 2% limit
  assert.equal(judge(rows(97, 3)).verdict, 'fail'); // 3%
  assert.equal(judge(rows(8, 2)).verdict, 'quiet'); // too few errors to be more than noise
  assert.equal(judge(rows(5, 3)).verdict, 'fail'); // 3 of 8 is a rate, even on little traffic
  assert.equal(judge([]).verdict, 'quiet');
  // A caller who left, a cancelled stream and the platform's own errors are not the new code's.
  assert.equal(
    judge([
      { status: 'success', requests: 50 },
      { status: 'clientDisconnected', requests: 40 },
      { status: 'internalError', requests: 10 },
    ]).verdict,
    'ok',
  );
  assert.equal(judge(rows(95, 5, 'exceededResources')).verdict, 'fail');
});

test('the hold watches each interval and stops at the first failure', async () => {
  const slept: number[] = [];
  const asked: string[] = [];
  const ok = await watch({
    workers: [{ name: 'a', version: NEW }],
    rows: async (w) => {
      asked.push(w.name);
      return [{ status: 'success', requests: 100 }];
    },
    holdMs: 150_000,
    intervalMs: 60_000,
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(slept, [60_000, 60_000, 30_000]);
  assert.equal(asked.length, 4); // each interval and once at the end

  let calls = 0;
  const bad = await watch({
    workers: [{ name: 'a', version: NEW }],
    rows: async () =>
      ++calls < 2
        ? [{ status: 'success', requests: 100 }]
        : [
            { status: 'success', requests: 90 },
            { status: 'scriptThrewException', requests: 10 },
          ],
    holdMs: 600_000,
    intervalMs: 60_000,
    sleep: async () => {},
  });
  assert.equal(bad.ok, false);
  assert.equal(calls, 2); // it did not wait out the rest of the hold
  assert.match(bad.failures[0]!, /10 of 100 invocations failed/);
});

test('an unreadable analytics response stops the rollout instead of passing it', async () => {
  await assert.rejects(
    watch({
      workers: [{ name: 'a', version: NEW }],
      rows: async () => {
        throw new Error('analytics down');
      },
      holdMs: 0,
      intervalMs: 1,
      sleep: async () => {},
    }),
    /analytics down/,
  );
});

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the deployed state comes from the Workers API: migration tag and the version at 100%', async () => {
  const seen: string[] = [];
  const state = await deployedState(
    async (url) => {
      seen.push(String(url));
      return String(url).endsWith('/deployments')
        ? reply(200, {
            success: true,
            result: { deployments: [{ versions: [{ version_id: OLD, percentage: 100 }] }] },
          })
        : reply(200, {
            success: true,
            result: { default_environment: { script: { migration_tag: 'v5' } } },
          });
    },
    'token',
    'acct',
    'commerceworker-engine',
  );
  assert.deepEqual(state, { exists: true, migrationTag: 'v5', stableVersion: OLD, split: false });
  assert.deepEqual(seen, [
    'https://api.cloudflare.com/client/v4/accounts/acct/workers/services/commerceworker-engine',
    'https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/commerceworker-engine/deployments',
  ]);
});

test('a missing Worker is a first deploy, a split deployment is split, an error is unknown', async () => {
  assert.deepEqual(await deployedState(async () => reply(404, { success: false }), 't', 'a', 'w'), {
    exists: false,
    migrationTag: null,
    stableVersion: null,
    split: false,
  });
  const split = await deployedState(
    async (url) =>
      String(url).endsWith('/deployments')
        ? reply(200, {
            success: true,
            result: {
              deployments: [
                {
                  versions: [
                    { version_id: NEW, percentage: 10 },
                    { version_id: OLD, percentage: 90 },
                  ],
                },
              ],
            },
          })
        : reply(200, { success: true, result: { default_environment: { script: {} } } }),
    't',
    'a',
    'w',
  );
  assert.deepEqual(split, { exists: true, migrationTag: null, stableVersion: null, split: true });
  assert.equal(
    await deployedState(async () => reply(403, { success: false }), 't', 'a', 'w'),
    null,
  );
});

test('version analytics are one GraphQL query per version, and an error in it throws', async () => {
  let sent: { query: string; variables: Record<string, string> } | undefined;
  const rows = await versionRows(
    async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return reply(200, {
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  { sum: { requests: 40 }, dimensions: { status: 'success' } },
                  { sum: { requests: 2 }, dimensions: { status: 'scriptThrewException' } },
                ],
              },
            ],
          },
        },
      });
    },
    'token',
    'acct',
    { name: 'commerceworker-web', version: NEW },
    '2026-11-13T00:00:00Z',
    '2026-11-13T00:10:00Z',
  );
  assert.deepEqual(rows, [
    { status: 'success', requests: 40 },
    { status: 'scriptThrewException', requests: 2 },
  ]);
  assert.deepEqual(sent?.variables, {
    accountTag: 'acct',
    script: 'commerceworker-web',
    version: NEW,
    since: '2026-11-13T00:00:00Z',
    until: '2026-11-13T00:10:00Z',
  });
  assert.match(sent?.query ?? '', /workersInvocationsAdaptive/);
  await assert.rejects(
    versionRows(
      async () => reply(200, { errors: [{ message: 'unknown field' }] }),
      't',
      'a',
      { name: 'w', version: NEW },
      's',
    ),
    /unknown field/,
  );
});

// scripts/rollout.sh run for real, against a `pnpm` that records its arguments and an `retry`
// that just runs its command. Nothing reaches Cloudflare.
const dir = mkdtempSync(join(tmpdir(), 'rollout-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'pnpm'),
  `#!/usr/bin/env bash
echo "$*" >> "$LOG"
if [[ "$*" == *"versions upload"* ]]; then
  echo '{"type":"version-upload","version_id":"${NEW}"}' >> "$WRANGLER_OUTPUT_FILE_PATH"
fi
`,
);
writeFileSync(join(bin, 'retry'), '#!/usr/bin/env bash\n"$@"\n');
chmodSync(join(bin, 'pnpm'), 0o755);
chmodSync(join(bin, 'retry'), 0o755);

function ship(workers: Plan['workers'], steps: string[][]) {
  const run = mkdtempSync(join(dir, 'run-'));
  const file = join(run, 'plan.json');
  writeFileSync(file, JSON.stringify({ id: 'acme', canaryPercent: 10, workers }));
  const log = join(run, 'log');
  writeFileSync(log, '');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: run,
    ROLLOUT_PLAN: file,
    LOG: log,
    CONFIG: 'wrangler.acme.json',
    GITHUB_SHA: 'abcdef0123456789',
  };
  const results = steps.map((args) =>
    spawnSync('bash', [join(ROOT, 'scripts/rollout.sh'), ...args], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    }),
  );
  for (const r of results) assert.equal(r.status, 0, r.stderr + r.stdout);
  return {
    log: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    plan: JSON.parse(readFileSync(file, 'utf8')) as Plan,
  };
}

const planned = (over: Partial<Plan['workers'][number]>): Plan['workers'][number] => ({
  key: 'engine',
  name: 'commerceworker-engine-acme',
  filter: '@commerceworker/engine',
  mode: 'full',
  reason: '',
  smoke: [],
  oldVersion: OLD,
  ...over,
});

test('rollout.sh ships a full Worker with the same wrangler deploy as before', () => {
  const { log } = ship([planned({})], [['ship', 'engine', '@commerceworker/engine', 'config']]);
  assert.deepEqual(log, [
    '--filter @commerceworker/engine exec wrangler deploy --config wrangler.acme.json',
  ]);
  // A built app has no --config, and a secrets file of `{}` is not passed.
  const secrets = join(dir, 'secrets.json');
  writeFileSync(secrets, '{}');
  const built = ship(
    [planned({ key: 'web', filter: '@commerceworker/web' })],
    [['ship', 'web', '@commerceworker/web', 'redirect', secrets]],
  );
  assert.deepEqual(built.log, ['--filter @commerceworker/web exec wrangler deploy']);
  writeFileSync(secrets, '{"A":"b"}');
  const withSecrets = ship(
    [planned({})],
    [['ship', 'engine', '@commerceworker/engine', 'config', secrets]],
  );
  assert.deepEqual(withSecrets.log, [
    `--filter @commerceworker/engine exec wrangler deploy --config wrangler.acme.json --secrets-file ${secrets}`,
  ]);
});

test('rollout.sh uploads a version, holds it at 0%, steps it to 10% and then 100%', () => {
  const { log, plan: after } = ship(
    [planned({ mode: 'gradual' })],
    [
      ['ship', 'engine', '@commerceworker/engine', 'config'],
      ['stage'],
      ['promote'],
      ['promote-staged'],
    ],
  );
  const e = '--filter @commerceworker/engine exec wrangler';
  assert.deepEqual(log, [
    `${e} versions upload --config wrangler.acme.json --message Deploy abcdef0`,
    `${e} versions deploy ${NEW}@0% ${OLD}@100% -y --message Deploy abcdef0 at 0% --config wrangler.acme.json`,
    `${e} versions deploy ${NEW}@10% ${OLD}@90% -y --message Deploy abcdef0 at 10% --config wrangler.acme.json`,
    `${e} versions deploy ${NEW}@100% -y --message Deploy abcdef0 at 100% --config wrangler.acme.json`,
    `${e} triggers deploy --config wrangler.acme.json`,
  ]);
  assert.equal(after.workers[0]!.newVersion, NEW);
});

test('a staged Worker reaches 100% only after every gradual Worker has, and is never split', () => {
  const { log } = ship(
    [
      planned({ key: 'web', name: 'w', filter: '@commerceworker/web', mode: 'staged' }),
      planned({ key: 'media', name: 'm', filter: '@commerceworker/media', mode: 'gradual' }),
      planned({ key: 'api', name: 'a', filter: '@commerceworker/api', mode: 'gradual' }),
    ],
    [
      ['ship', 'web', '@commerceworker/web', 'redirect'],
      ['ship', 'media', '@commerceworker/media', 'config'],
      ['ship', 'api', '@commerceworker/api', 'config'],
      ['stage'],
      ['promote'],
      ['promote-staged'],
    ],
  );
  const deploys = log.filter((l) => l.includes('versions deploy'));
  const at = (filter: string, pct: string) =>
    deploys.findIndex((l) => l.includes(`/${filter} `) && l.includes(`${NEW}@${pct}% `));
  const lastGradual = Math.max(at('media', '100'), at('api', '100'));
  assert.ok(
    lastGradual >= 0 && at('web', '100') > lastGradual,
    'web goes live after media and api',
  );
  assert.ok(at('media', '10') >= 0 && at('api', '10') >= 0);
  assert.equal(at('web', '10'), -1, 'a staged Worker never takes a share');
  // Triggers come after every version is in place.
  assert.ok(
    log.findIndex((l) => l.includes('triggers deploy')) >
      log.findLastIndex((l) => l.includes('versions deploy')),
  );
  assert.equal(deploys.filter((l) => l.includes('/web ')).length, 2); // 0% and 100%
});

test('rollout.sh rolls a Worker back to its earlier version', () => {
  const { log } = ship(
    [planned({ key: 'web', filter: '@commerceworker/web', mode: 'staged' })],
    [
      ['ship', 'web', '@commerceworker/web', 'redirect'],
      ['stage'],
      ['rollback', 'web', 'Deploy failed for abcdef0'],
    ],
  );
  const w = '--filter @commerceworker/web exec wrangler';
  assert.deepEqual(log, [
    `${w} versions upload --message Deploy abcdef0`,
    `${w} versions deploy ${NEW}@0% ${OLD}@100% -y --message Deploy abcdef0 at 0%`,
    `${w} versions deploy ${OLD}@100% -y --message Deploy failed for abcdef0`,
  ]);
});

const denied = async () => reply(403, { success: false });

test('the probe turns the rollout off only for a token that is not allowed to read analytics', async () => {
  const w = { name: 'w', version: NEW };
  assert.equal(await probeAnalytics(denied, 't', 'a', w), 'denied');
  assert.equal(
    await probeAnalytics(
      async () => reply(200, { errors: [{ message: 'no', extensions: { code: 'authz' } }] }),
      't',
      'a',
      w,
    ),
    'denied',
  );
  assert.equal(await probeAnalytics(async () => reply(200, { data: {} }), 't', 'a', w), 'ok');
});

test('the probe fails loudly on a query Cloudflare rejects, and after retrying an outage', async () => {
  const w = { name: 'w', version: NEW };
  await assert.rejects(
    probeAnalytics(
      async () => reply(200, { errors: [{ message: 'unknown field "scriptVersion"' }] }),
      't',
      'a',
      w,
    ),
    /unknown field/,
  );
  let calls = 0;
  await assert.rejects(
    probeAnalytics(
      async () => {
        calls++;
        return reply(503, {});
      },
      't',
      'a',
      w,
      async () => {},
    ),
    /503/,
  );
  assert.equal(calls, 3);
  let n = 0;
  assert.equal(
    await probeAnalytics(
      async () => (++n < 2 ? reply(502, {}) : reply(200, { data: {} })),
      't',
      'a',
      w,
      async () => {},
    ),
    'ok',
  );
});

test('planWorker is the plan of one Worker', () => {
  assert.deepEqual(
    planWorker(worker('plugin:p'), undefined, deployment()),
    plan(deployment(), 'plugin:p'),
  );
});
