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
  assert.deepEqual(r.lock, {
    rules: [
      {
        id: 'd1-backups',
        enabled: true,
        prefix: 'd1/',
        condition: { type: 'Age', maxAgeSeconds: 35 * 86400 },
      },
    ],
  });
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
  const r = runRedundancy({ vars: { BACKUPS_R2: '', STANDBY_D1: '', BACKUP_DAYS: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
});
