import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The GitHub environment section of scripts/provision.sh, run against a fake `gh` on PATH that
// records every call and answers from fixture files. Nothing reaches GitHub. The section sits
// between the `github-environment` markers in the script.
const script = readFileSync(new URL('./provision.sh', import.meta.url), 'utf8');
const section = /# github-environment:begin\n([\s\S]*?)# github-environment:end/.exec(script)?.[1];

const FAKE_GH = `#!/usr/bin/env bash
# Records "METHOD path" and the stdin of a --input call; answers GETs from $FIX.
method=GET; path=""; input=""
args=("$@"); i=0
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    api) ;;
    --method) i=$((i+1)); method="\${args[$i]}" ;;
    --input) input=$(cat) ;;
    -f) i=$((i+1)) ;;
    -*) ;;
    *) [ -z "$path" ] && path="$a" ;;
  esac
  i=$((i+1))
done
echo "$method $path" >> "$FIX/calls"
[ -n "$input" ] && echo "$input" > "$FIX/body-$method-$(basename "$path")"
if [ "$method" != GET ]; then exit 0; fi
case "$path" in
  */deployment-branch-policies) cat "$FIX/policies.json" ;;
  *) if [ -f "$FIX/environment.json" ]; then cat "$FIX/environment.json"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;
esac
`;

function run(opts: { environment?: unknown; policies?: unknown[]; getFails?: string }) {
  assert.ok(section, 'provision.sh has no github-environment section');
  const dir = mkdtempSync(join(tmpdir(), 'provision-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  if (opts.environment)
    writeFileSync(join(dir, 'environment.json'), JSON.stringify(opts.environment));
  writeFileSync(
    join(dir, 'policies.json'),
    JSON.stringify({
      total_count: opts.policies?.length ?? 0,
      branch_policies: opts.policies ?? [],
    }),
  );
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${section}`], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FIX: dir,
      ENVIRONMENT: 'production',
    },
    encoding: 'utf8',
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return {
    status: result.status,
    stderr: result.stderr,
    calls: read('calls').split('\n').filter(Boolean),
    putBody: read('body-PUT-production') ? JSON.parse(read('body-PUT-production')) : undefined,
  };
}

const ENV = 'repos/{owner}/{repo}/environments/production';

test('a new environment gets the custom branch policy and a main policy', () => {
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.putBody.deployment_branch_policy, {
    protected_branches: false,
    custom_branch_policies: true,
  });
  assert.deepEqual(r.putBody.reviewers, []);
  assert.ok(r.calls.includes(`PUT ${ENV}`));
  assert.ok(r.calls.includes(`POST ${ENV}/deployment-branch-policies`));
});

test('an existing main policy is not added again', () => {
  const r = run({
    environment: {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    policies: [{ id: 1, name: 'main', type: 'branch' }],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.calls.filter((c) => !c.startsWith('GET')),
    [],
    r.calls.join('\n'),
  );
});

test('an environment already on custom policies is not PUT again; a missing main is added', () => {
  const r = run({
    environment: {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    policies: [{ id: 2, name: 'release/*', type: 'branch' }],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.startsWith('PUT')));
  assert.ok(r.calls.includes(`POST ${ENV}/deployment-branch-policies`));
});

test('required reviewers, the wait timer and self-review are carried into the PUT', () => {
  const r = run({
    environment: {
      deployment_branch_policy: null,
      protection_rules: [
        { id: 1, type: 'wait_timer', wait_timer: 15 },
        {
          id: 2,
          type: 'required_reviewers',
          prevent_self_review: true,
          reviewers: [
            { type: 'User', reviewer: { id: 11, login: 'owner' } },
            { type: 'Team', reviewer: { id: 22, slug: 'release' } },
          ],
        },
        { id: 3, type: 'branch_policy' },
      ],
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.putBody.wait_timer, 15);
  assert.equal(r.putBody.prevent_self_review, true);
  assert.deepEqual(r.putBody.reviewers, [
    { type: 'User', id: 11 },
    { type: 'Team', id: 22 },
  ]);
  assert.deepEqual(r.putBody.deployment_branch_policy, {
    protected_branches: false,
    custom_branch_policies: true,
  });
});

test('a read that fails for any reason but 404 stops before any write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provision-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash\necho "$*" >> "${dir}/calls"\necho "gh: Forbidden (HTTP 403)" >&2\nexit 1\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  assert.ok(section);
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${section}`], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ENVIRONMENT: 'production' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not read the GitHub environment/);
  assert.ok(!readFileSync(join(dir, 'calls'), 'utf8').includes('PUT'));
});

// The redundancy section: the backups bucket and the standby database, against a fake `wrangler`
// and `node` that record every call and answer from what "exists" in the fixture. Nothing reaches
// Cloudflare. The section sits between the `redundancy` markers in the script.
const redundancy = /# redundancy:begin\n([\s\S]*?)# redundancy:end/.exec(script)?.[1];

function runRedundancy(opts: {
  buckets?: string[];
  databases?: { name: string; uuid: string }[];
  vars?: Record<string, string>;
  jurisdiction?: string;
}) {
  assert.ok(redundancy, 'provision.sh has no redundancy section');
  const dir = mkdtempSync(join(tmpdir(), 'provision-'));
  writeFileSync(join(dir, 'buckets'), (opts.buckets ?? []).join('\n'));
  writeFileSync(join(dir, 'databases.json'), JSON.stringify(opts.databases ?? []));
  const prelude = `
calls="${dir}/calls"
wrangler() {
  echo "wrangler $*" >> "$calls"
  case "$1 $2 $3" in
    "r2 bucket info") grep -qx "$4" "${dir}/buckets" ;;
    "r2 bucket lock") [ "$4" = set ] && cp "$7" "${dir}/lock.json" ;;
    "d1 list "*) cat "${dir}/databases.json" ;;
    "d1 create "*)
      jq --arg n "$3" '. + [{name: $n, uuid: "11111111-2222-3333-4444-555555555555"}]' "${dir}/databases.json" > "${dir}/databases.next" &&
        mv "${dir}/databases.next" "${dir}/databases.json" ;;
  esac
}
node() { echo "node $*" >> "$calls"; }
j=(${opts.jurisdiction ? `--jurisdiction ${opts.jurisdiction}` : ''})
id=acme
uuid=aaaaaaaa-0000-0000-0000-000000000000
`;
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${prelude}\n${redundancy}`], {
    env: {
      ...process.env,
      BACKUPS_R2: 'commerceworker-backups-acme',
      STANDBY_D1: 'commerceworker-standby-acme',
      BACKUP_DAYS: '35',
      BACKUP_D1: 'true',
      BACKUP_OBJECTS: 'true',
      ...opts.vars,
    },
    encoding: 'utf8',
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return {
    status: result.status,
    stderr: result.stderr,
    calls: read('calls').split('\n').filter(Boolean),
    lock: read('lock.json') ? JSON.parse(read('lock.json')) : undefined,
  };
}

test('the backups bucket and the standby database are created when they do not exist', () => {
  const r = runRedundancy({});
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    r.calls.includes('wrangler r2 bucket create commerceworker-backups-acme'),
    r.calls.join('\n'),
  );
  assert.ok(r.calls.includes('wrangler d1 create commerceworker-standby-acme'));
  // The standby is found by name in the account's list, never by `d1 info`.
  assert.ok(!r.calls.some((c) => c.startsWith('wrangler d1 info')));
  assert.ok(
    r.calls.includes(
      'node scripts/fleet.ts set-standby-d1 acme 11111111-2222-3333-4444-555555555555',
    ),
  );
  // d1/ expires and is locked for the same number of days, as the catalog's backups are.
  assert.ok(
    r.calls.some((c) =>
      c.startsWith(
        'wrangler r2 bucket lifecycle add commerceworker-backups-acme d1-backups d1/ --expire-days 35',
      ),
    ),
  );
  // The Durable Object copies and restore reports under objects/ follow the same retention.
  assert.ok(
    r.calls.some((c) =>
      c.startsWith(
        'wrangler r2 bucket lifecycle add commerceworker-backups-acme object-backups objects/ --expire-days 35',
      ),
    ),
  );
  const rule = (id: string, prefix: string, days: number) => ({
    id,
    enabled: true,
    prefix,
    condition: { type: 'Age', maxAgeSeconds: days * 86400 },
  });
  assert.deepEqual(r.lock, {
    rules: [rule('d1-backups', 'd1/', 35), rule('object-backups', 'objects/', 35)],
  });
});

test('with the D1 backup an exception the bucket keeps only objects/, and no standby is made', () => {
  const r = runRedundancy({ vars: { BACKUP_D1: '', STANDBY_D1: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.includes('wrangler r2 bucket create commerceworker-backups-acme'));
  assert.ok(!r.calls.some((c) => c.includes(' d1-backups ')), r.calls.join('\n'));
  assert.ok(!r.calls.some((c) => c.startsWith('wrangler d1 ') || c.startsWith('node ')));
  assert.deepEqual(
    r.lock.rules.map((x: { id: string; prefix: string }) => [x.id, x.prefix]),
    [['object-backups', 'objects/']],
  );
});

test('with the object backup an exception the bucket keeps only d1/, and the standby stays', () => {
  const r = runRedundancy({ vars: { BACKUP_OBJECTS: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.includes('object-backups')), r.calls.join('\n'));
  assert.ok(r.calls.includes('wrangler d1 create commerceworker-standby-acme'));
  assert.deepEqual(
    r.lock.rules.map((x: { prefix: string }) => x.prefix),
    ['d1/'],
  );
});

test('an existing bucket and standby database are kept, and only the retention is set again', () => {
  const r = runRedundancy({
    buckets: ['commerceworker-backups-acme'],
    databases: [
      { name: 'commerceworker-standby-acme', uuid: 'bbbbbbbb-0000-0000-0000-000000000000' },
    ],
    vars: { BACKUP_DAYS: '90' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.startsWith('wrangler r2 bucket create')), r.calls.join('\n'));
  assert.ok(!r.calls.some((c) => c.startsWith('wrangler d1 create')));
  assert.ok(
    r.calls.includes(
      'node scripts/fleet.ts set-standby-d1 acme bbbbbbbb-0000-0000-0000-000000000000',
    ),
  );
  assert.equal(r.lock.rules[0].condition.maxAgeSeconds, 90 * 86400);
});

test('an EU deployment creates both in its jurisdiction', () => {
  const r = runRedundancy({ jurisdiction: 'eu' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    r.calls.includes('wrangler r2 bucket create commerceworker-backups-acme --jurisdiction eu'),
  );
  assert.ok(r.calls.includes('wrangler d1 create commerceworker-standby-acme --jurisdiction eu'));
  assert.ok(
    r.calls.some(
      (c) =>
        c.startsWith('wrangler r2 bucket lock set commerceworker-backups-acme') &&
        c.includes('--jurisdiction eu'),
    ),
  );
});

test('a standby that is the live database stops before it is recorded', () => {
  const r = runRedundancy({
    buckets: ['commerceworker-backups-acme'],
    databases: [
      { name: 'commerceworker-standby-acme', uuid: 'aaaaaaaa-0000-0000-0000-000000000000' },
    ],
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /would wipe it/);
  assert.ok(!r.calls.some((c) => c.startsWith('node scripts/fleet.ts')));
});

test('a deployment without redundancy creates nothing', () => {
  const r = runRedundancy({
    vars: {
      BACKUPS_R2: '',
      STANDBY_D1: '',
      BACKUP_DAYS: '',
      BACKUP_D1: '',
      BACKUP_OBJECTS: '',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
});

// The docs replica section, against the same kind of fake `wrangler`: what exists (buckets, queues,
// notification rules) is a fixture, every call is recorded, and nothing reaches Cloudflare.
const docsReplica = /# docs-replica:begin\n([\s\S]*?)# docs-replica:end/.exec(script)?.[1];

function runDocsReplica(opts: {
  buckets?: string[];
  queues?: string[];
  rules?: string;
  jurisdiction?: string;
  vars?: Record<string, string>;
}) {
  assert.ok(docsReplica, 'provision.sh has no docs-replica section');
  const dir = mkdtempSync(join(tmpdir(), 'provision-'));
  writeFileSync(join(dir, 'buckets'), (opts.buckets ?? []).join('\n'));
  writeFileSync(join(dir, 'queues'), (opts.queues ?? []).join('\n'));
  writeFileSync(join(dir, 'rules'), opts.rules ?? '');
  const prelude = `
calls="${dir}/calls"
wrangler() {
  echo "wrangler $*" >> "$calls"
  case "$1 $2 $3" in
    "r2 bucket info") grep -qx "$4" "${dir}/buckets" ;;
    "r2 bucket lock") [ "$4" = set ] && cp "$7" "${dir}/lock.json" ;;
    "r2 bucket notification") if [ "$4" = list ]; then cat "${dir}/rules"; fi ;;
    "queues info "*) grep -qx "$3" "${dir}/queues" ;;
  esac
}
j=(${opts.jurisdiction ? `--jurisdiction ${opts.jurisdiction}` : ''})
`;
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${prelude}\n${docsReplica}`], {
    env: {
      ...process.env,
      R2: 'commerceworker-docs-acme',
      DOCS_REPLICA_R2: 'commerceworker-docs-replica-acme',
      DOCS_REPLICA_QUEUE: 'commerceworker-docs-replica-acme',
      DOCS_REPLICA_DLQ: 'commerceworker-docs-replica-dlq-acme',
      AUDIT_ARCHIVE_DAYS: '400',
      ...opts.vars,
    },
    encoding: 'utf8',
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return {
    status: result.status,
    stderr: result.stderr,
    calls: read('calls').split('\n').filter(Boolean),
    lock: read('lock.json') ? JSON.parse(read('lock.json')) : undefined,
  };
}

test('the replica bucket, its queues and the notification rule are created when missing', () => {
  const r = runDocsReplica({});
  assert.equal(r.status, 0, r.stderr);
  const has = (c: string) => assert.ok(r.calls.includes(c), `${c}\n${r.calls.join('\n')}`);
  has('wrangler r2 bucket create commerceworker-docs-replica-acme');
  has('wrangler queues create commerceworker-docs-replica-acme');
  has('wrangler queues create commerceworker-docs-replica-dlq-acme');
  has(
    'wrangler r2 bucket notification create commerceworker-docs-acme --event-type object-create --event-type object-delete --queue commerceworker-docs-replica-acme --description commerceworker docs replica',
  );
  // The moved copies and the dead letters expire after 30 days; the audit archive as the primary's does.
  has(
    'wrangler r2 bucket lifecycle add commerceworker-docs-replica-acme deleted-copies deleted/ --expire-days 30 --force',
  );
  has(
    'wrangler r2 bucket lifecycle add commerceworker-docs-replica-acme dlq dlq/ --expire-days 30 --force',
  );
  has(
    'wrangler r2 bucket lifecycle add commerceworker-docs-replica-acme audit-archive audit/ --expire-days 400 --force',
  );
  // The same lock rules as the primary's (the primary's section sets them from auditArchiveDays).
  assert.deepEqual(r.lock, {
    rules: [
      {
        id: 'audit-archive',
        enabled: true,
        prefix: 'audit/',
        condition: { type: 'Age', maxAgeSeconds: 400 * 86400 },
      },
      {
        id: 'plugin-bundles',
        enabled: true,
        prefix: 'plugins/',
        condition: { type: 'Indefinite' },
      },
    ],
  });
  // The rule is read before it is created.
  const list = r.calls.indexOf('wrangler r2 bucket notification list commerceworker-docs-acme');
  const create = r.calls.findIndex((c) => c.startsWith('wrangler r2 bucket notification create'));
  assert.ok(list >= 0 && list < create);
});

test('without auditArchiveDays the replica locks audit/ indefinitely and sets no expiry', () => {
  const r = runDocsReplica({ vars: { AUDIT_ARCHIVE_DAYS: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.lock.rules[0].condition, { type: 'Indefinite' });
  assert.ok(!r.calls.some((c) => c.includes('lifecycle add') && c.includes('audit-archive')));
});

test('an existing bucket, queues and rule are kept: nothing is created twice', () => {
  const r = runDocsReplica({
    buckets: ['commerceworker-docs-replica-acme'],
    queues: ['commerceworker-docs-replica-acme', 'commerceworker-docs-replica-dlq-acme'],
    rules: 'rule-1  commerceworker-docs-replica-acme  object-create,object-delete',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.calls.filter((c) => /bucket create|queues create|notification create/.test(c)),
    [],
  );
  // The retention and the locks are set again, so a changed number takes effect.
  assert.ok(
    r.calls.some((c) => c.startsWith('wrangler queues update commerceworker-docs-replica-acme')),
  );
  assert.ok(r.lock);
});

test('an EU deployment creates the bucket and its rule in its jurisdiction', () => {
  const r = runDocsReplica({ jurisdiction: 'eu' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    r.calls.includes(
      'wrangler r2 bucket create commerceworker-docs-replica-acme --jurisdiction eu',
    ),
  );
  assert.ok(
    r.calls.some(
      (c) =>
        c.startsWith('wrangler r2 bucket notification create') && c.includes('--jurisdiction eu'),
    ),
  );
  assert.ok(
    r.calls.some(
      (c) =>
        c.startsWith('wrangler r2 bucket lock set commerceworker-docs-replica-acme') &&
        c.includes('--jurisdiction eu'),
    ),
  );
  // Queues are account-level here, as every other queue is: no jurisdiction flag.
  assert.ok(r.calls.includes('wrangler queues create commerceworker-docs-replica-dlq-acme'));
});

test('a deployment without the replica creates nothing', () => {
  const r = runDocsReplica({
    vars: { DOCS_REPLICA_R2: '', DOCS_REPLICA_QUEUE: '', DOCS_REPLICA_DLQ: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
});

// The detection section (`alerts:begin` to `alerts:end`), run against a fake `curl` that records
// "METHOD url" and each body, and answers a GET from fixture files by its path. Nothing reaches
// Cloudflare. `alert_spec` is what `fleet.ts alerts <id>` prints.
const alerts = /# alerts:begin\n([\s\S]*?)# alerts:end/.exec(script)?.[1];

const FAKE_CURL = `#!/usr/bin/env bash
method=GET; url=""
args=("$@"); i=0
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    -X) i=$((i+1)); method="\${args[$i]}" ;;
    --data-binary) i=$((i+1)); body=$(cat) ;;
    -H|-sS) [ "$a" = -H ] && i=$((i+1)) ;;
    -*) ;;
    *) url="$a" ;;
  esac
  i=$((i+1))
done
path="\${url#https://api.cloudflare.com/client/v4}"
echo "$method $path" >> "$FIX/calls"
[ -n "\${body:-}" ] && jq -c . <<<"$body" >> "$FIX/bodies"
if [ "$method" != GET ]; then
  # Every write answers with the id "new-id" (a created object's id).
  echo '{"success":true,"result":{"id":"new-id"}}'; exit 0
fi
f="$FIX/get$(echo "\${path%%\\?*}" | tr '/' '_')"
if [ -f "$f" ]; then cat "$f"; else echo '{"success":true,"result":[]}'; fi
`;

const SPEC = {
  policies: [
    {
      name: 'CommerceWorker: Worker issues',
      alert_type: 'workers_observability_real_time_issue',
      description: 'issues',
    },
    { name: 'CommerceWorker: HTTP DDoS', alert_type: 'dos_attack_l7', description: 'ddos' },
  ],
  webhookName: 'commerceworker-alerts',
  pagerduty: false,
  healthChecks: [
    {
      name: 'commerceworker-web',
      policy: 'CommerceWorker: commerceworker-web health',
      host: 'app.example.com',
      body: { name: 'commerceworker-web', address: 'app.example.com' },
    },
  ],
};

const ACCOUNT = 'acct1';
const GET = (p: string) => `get${p.replaceAll('/', '_')}`;

function runAlerts(opts: {
  fixtures?: Record<string, unknown>;
  spec?: unknown;
  env?: Record<string, string>;
}) {
  assert.ok(alerts, 'provision.sh has no alerts section');
  const dir = mkdtempSync(join(tmpdir(), 'provision-alerts-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  chmodSync(join(bin, 'curl'), 0o755);
  for (const [path, body] of Object.entries(opts.fixtures ?? {}))
    writeFileSync(join(dir, GET(path)), JSON.stringify({ success: true, result: body }));
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${alerts}`], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FIX: dir,
      ALERTS: 'true',
      ALERT_WEBHOOK_FALLBACK: '',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      alert_spec: JSON.stringify(opts.spec ?? SPEC),
      ...opts.env,
    },
    encoding: 'utf8',
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    writes: read('calls')
      .split('\n')
      .filter((c) => c && !c.startsWith('GET')),
    bodies: read('bodies')
      .split('\n')
      .filter(Boolean)
      .map((b) => JSON.parse(b)),
  };
}

const N = `/accounts/${ACCOUNT}/alerting/v3`;
const ZONES = { '/zones': [{ id: 'zone1' }] };
const HOOK = 'https://hooks.example/secret-path';

test('with alerts off, nothing is called', () => {
  const r = runAlerts({ env: { ALERTS: 'false' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, []);
});

test('a new account gets the webhook, the policies, the Health Check and its policy', () => {
  const r = runAlerts({ fixtures: ZONES, env: { ALERT_WEBHOOK_URL: HOOK } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, [
    `POST ${N}/destinations/webhooks`,
    `POST ${N}/policies`,
    `POST ${N}/policies`,
    'POST /zones/zone1/healthchecks',
    `POST ${N}/policies`,
  ]);
  // The secret URL reaches the API in a body only, and is never printed.
  assert.deepEqual(r.bodies[0], { name: 'commerceworker-alerts', url: HOOK });
  assert.equal(`${r.stdout}${r.stderr}`.split(HOOK).length, 1, 'the webhook URL was printed');
  assert.deepEqual(r.bodies[1].mechanisms, { webhooks: [{ id: 'new-id' }] });
  assert.equal(r.bodies[1].alert_type, 'workers_observability_real_time_issue');
  assert.deepEqual(r.bodies.at(-1).filters, { health_check_id: ['new-id'] });
  assert.equal(r.bodies.at(-1).alert_type, 'health_check_status_notification');
});

test('a second run finds everything by name and writes only the webhook it keeps current', () => {
  const mechanisms = { webhooks: [{ id: 'hook1' }] };
  const r = runAlerts({
    env: { ALERT_WEBHOOK_URL: HOOK },
    fixtures: {
      ...ZONES,
      [`${N}/destinations/webhooks`]: [{ id: 'hook1', name: 'commerceworker-alerts' }],
      [`${N}/policies`]: [
        { id: 'p1', name: 'CommerceWorker: Worker issues', mechanisms },
        { id: 'p2', name: 'CommerceWorker: HTTP DDoS', mechanisms },
        { id: 'p3', name: 'CommerceWorker: commerceworker-web health', mechanisms },
      ],
      '/zones/zone1/healthchecks': [{ id: 'hc1', name: 'commerceworker-web' }],
    },
  });
  assert.equal(r.status, 0, r.stderr);
  // No second webhook, policy or check: the webhook and the check are updated in place, and no
  // policy already sending to the destination is written.
  assert.deepEqual(r.writes, [
    `PUT ${N}/destinations/webhooks/hook1`,
    'PUT /zones/zone1/healthchecks/hc1',
  ]);
});

test('a policy that exists gains the destination and keeps the ones it had', () => {
  const r = runAlerts({
    env: { ALERT_WEBHOOK_URL: HOOK, ALERT_EMAIL: 'ops@example.com' },
    fixtures: {
      ...ZONES,
      [`${N}/destinations/webhooks`]: [{ id: 'hook1', name: 'commerceworker-alerts' }],
      [`${N}/policies`]: [
        {
          id: 'p1',
          name: 'CommerceWorker: Worker issues',
          alert_type: 'workers_observability_real_time_issue',
          enabled: true,
          description: 'issues',
          mechanisms: { email: [{ id: 'old@example.com' }] },
        },
      ],
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.writes.includes(`PUT ${N}/policies/p1`), r.writes.join('\n'));
  const put = r.bodies.find(
    (b) => b.name === 'CommerceWorker: Worker issues' && b.mechanisms.email,
  );
  assert.deepEqual(put.mechanisms.email.map((e: { id: string }) => e.id).sort(), [
    'old@example.com',
    'ops@example.com',
  ]);
  assert.deepEqual(put.mechanisms.webhooks, [{ id: 'hook1' }]);
});

test('PagerDuty that is not connected is said so, and with no other destination it stops', () => {
  const r = runAlerts({ spec: { ...SPEC, pagerduty: true }, fixtures: ZONES });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PagerDuty isn't connected/);
  assert.match(r.stderr, /nowhere to go/);
  assert.deepEqual(r.writes, []);
});

test('a connected PagerDuty service is a destination of every policy', () => {
  const r = runAlerts({
    spec: { ...SPEC, pagerduty: true },
    fixtures: { ...ZONES, [`${N}/destinations/pagerduty`]: [{ id: 'pd1' }] },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.bodies[0].mechanisms, { pagerduty: [{ id: 'pd1' }] });
});

test('a host in no zone of the account stops provisioning, naming it', () => {
  const r = runAlerts({ env: { ALERT_WEBHOOK_URL: HOOK } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No zone in this account holds app\.example\.com/);
});

test('without an API token the alerts are skipped, not half made', () => {
  const r = runAlerts({ env: { CLOUDFLARE_API_TOKEN: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Skipped the alerts/);
  assert.deepEqual(r.writes, []);
});

// The mail queue section, against a fake `wrangler` (queues and event subscriptions are fixtures) and
// a fake `curl` that answers the zone lookup. Every call is recorded; nothing reaches Cloudflare.
const emailQueue = /# email-queue:begin\n([\s\S]*?)# email-queue:end/.exec(script)?.[1];

function runEmailQueue(opts: {
  queues?: string[];
  subscriptions?: string;
  zones?: Record<string, string>;
  vars?: Record<string, string>;
}) {
  assert.ok(emailQueue, 'provision.sh has no email-queue section');
  const dir = mkdtempSync(join(tmpdir(), 'provision-email-'));
  writeFileSync(join(dir, 'queues'), (opts.queues ?? []).join('\n'));
  writeFileSync(join(dir, 'subscriptions'), opts.subscriptions ?? '');
  writeFileSync(join(dir, 'zones.json'), JSON.stringify(opts.zones ?? {}));
  const prelude = `
calls="${dir}/calls"
wrangler() {
  echo "wrangler $*" >> "$calls"
  case "$1 $2 $3" in
    "queues info "*) grep -qx "$3" "${dir}/queues" ;;
    "queues subscription list") cat "${dir}/subscriptions" ;;
  esac
}
curl() {
  echo "curl $*" >> "$calls"
  local url="" a
  for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
  local name="\${url#*name=}"; name="\${name%%&*}"
  jq -n --arg id "$(jq -r --arg n "$name" '.[$n] // empty' "${dir}/zones.json")" \\
    'if $id == "" then {result: []} else {result: [{id: $id}]} end'
}
`;
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${prelude}\n${emailQueue}`], {
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      EMAIL_QUEUE: 'commerceworker-email-acme',
      EMAIL_DLQ: 'commerceworker-email-dlq-acme',
      EMAIL_EVENTS: 'commerceworker-email-events-acme',
      EMAIL_EVENTS_DLQ: 'commerceworker-email-events-dlq-acme',
      EMAIL_DOMAINS: 'mail.acme.test backup.example.net',
      ...opts.vars,
    },
    encoding: 'utf8',
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean);
  } catch {}
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, calls };
}

const MAIL_ZONES = { 'acme.test': 'zone-acme', 'example.net': 'zone-example' };

test('the mail queues are created, and each sending domain subscribes to the events queue by its zone', () => {
  const r = runEmailQueue({ zones: MAIL_ZONES });
  assert.equal(r.status, 0, r.stderr);
  for (const q of [
    'commerceworker-email-acme',
    'commerceworker-email-dlq-acme',
    'commerceworker-email-events-acme',
    'commerceworker-email-events-dlq-acme',
  ]) {
    assert.ok(r.calls.includes(`wrangler queues create ${q}`), `${q}\n${r.calls.join('\n')}`);
    assert.ok(r.calls.some((c) => c.startsWith(`wrangler queues update ${q} --message-retention`)));
  }
  const subs = r.calls.filter((c) => c.startsWith('wrangler queues subscription create'));
  assert.equal(subs.length, 2);
  // The zone is the parent's: mail.acme.test is in the acme.test zone, backup.example.net in example.net.
  assert.match(
    subs[0]!,
    /commerceworker-email-events-acme --source email.sending --zone-id zone-acme --domain mail.acme.test --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained/,
  );
  assert.match(subs[1]!, /--zone-id zone-example --domain backup.example.net/);
  // Read before created.
  const list = r.calls.indexOf(
    'wrangler queues subscription list commerceworker-email-events-acme',
  );
  assert.ok(list >= 0 && list < r.calls.findIndex((c) => c.includes('subscription create')));
});

test('existing queues and subscriptions are kept: nothing is created twice', () => {
  const r = runEmailQueue({
    zones: MAIL_ZONES,
    queues: [
      'commerceworker-email-acme',
      'commerceworker-email-dlq-acme',
      'commerceworker-email-events-acme',
      'commerceworker-email-events-dlq-acme',
    ],
    subscriptions:
      'sub1  mail.acme.test  message.delivered\nsub2  backup.example.net  message.bounced',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.calls.filter((c) => /queues create|subscription create/.test(c)),
    [],
  );
  assert.ok(r.calls.some((c) => c.startsWith('wrangler queues update')));
  assert.ok(!r.calls.some((c) => c.startsWith('curl')));
});

test('only the missing subscription is made, and a domain with no zone in the account is reported, not fatal', () => {
  const some = runEmailQueue({
    zones: MAIL_ZONES,
    subscriptions: 'sub1  mail.acme.test  message.delivered',
  });
  assert.equal(some.status, 0, some.stderr);
  assert.equal(some.calls.filter((c) => c.includes('subscription create')).length, 1);
  // The subscription names the zone's own sending domain as a whole argument.
  assert.match(
    some.calls.find((c) => c.includes('subscription create'))!,
    /(?:^|\s)backup\.example\.net(?:\s|$)/,
  );
  const none = runEmailQueue({ zones: {} });
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(
    none.calls.filter((c) => c.includes('subscription create')),
    [],
  );
  assert.match(none.stderr, /No zone in this account holds mail.acme.test/);
  // The queues are made regardless: the engine's consumers need them.
  assert.ok(none.calls.includes('wrangler queues create commerceworker-email-acme'));
});

test('without mail queues (no redundancy, no sender, email an exception), nothing is called', () => {
  const r = runEmailQueue({ vars: { EMAIL_QUEUE: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
});
