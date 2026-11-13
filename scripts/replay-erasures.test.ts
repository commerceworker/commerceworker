import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  parseSince,
  REPLAY_PATH,
  type ReplayAnswer,
  refuseInCi,
  replayErasures,
  replayRequest,
  summarize,
} from './replay-erasures.ts';

// The operator's step at the end of every restore runbook: erase again who a restore brought back
// (docs/operations.md, "Replaying erasures after a restore"). It calls the deployment's REST
// operation with an admin's token and never runs in CI.

const NOW = Date.parse('2026-11-12T12:00:00Z');
const TOKEN = 'cmw_live_secret';
const answer = (over: Partial<ReplayAnswer> = {}): ReplayAnswer => ({
  dryRun: false,
  events: { total: 2, database: 1, archive: 1 },
  scanned: 40,
  erased: [{ target: 'subject:aa', orders: 3, done: true }],
  blocked: [],
  clean: ['subject:bb'],
  ...over,
});
const fetcher = (body: unknown, status = 200, seen: { url: string; init: RequestInit }[] = []) =>
  (async (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

test('the restore point is an ISO time (UTC unless it names a zone), a date, or epoch ms', () => {
  assert.equal(parseSince('2026-11-12T09:30:00Z', NOW), Date.parse('2026-11-12T09:30:00Z'));
  assert.equal(parseSince('2026-11-12T09:30:00', NOW), Date.parse('2026-11-12T09:30:00Z'));
  assert.equal(parseSince('2026-11-12T09:30:00+02:00', NOW), Date.parse('2026-11-12T07:30:00Z'));
  assert.equal(parseSince('2026-11-10', NOW), Date.parse('2026-11-10T00:00:00Z'));
  assert.equal(parseSince('1794481800000', NOW), 1794481800000);
});

test('a restore point that is missing, not a time or not yet come is refused', () => {
  assert.throws(() => parseSince(undefined, NOW), /needs <since>/);
  assert.throws(() => parseSince('', NOW), /needs <since>/);
  assert.throws(() => parseSince('yesterday', NOW), /not a time/);
  assert.throws(() => parseSince('2026-13-40', NOW), /not a time/);
  assert.throws(() => parseSince('2026-11-13T00:00:00Z', NOW), /has not come yet/);
});

test('the plan is one POST to the deployment, with the token as a bearer and the time in the body', () => {
  const { url, init } = replayRequest('acme.example.com', 1_000, { token: TOKEN });
  assert.equal(url, `https://acme.example.com${REPLAY_PATH}`);
  assert.equal(REPLAY_PATH, '/api/v1/erasures/replay');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(init.body)), { since: 1_000 });
  // --dry-run asks the engine to report and erase nobody.
  assert.deepEqual(
    JSON.parse(
      String(replayRequest('acme.example.com', 1_000, { token: TOKEN, dryRun: true }).init.body),
    ),
    { since: 1_000, dryRun: true },
  );
});

test('it refuses a workflow before it reads a token or sends anything', async () => {
  for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    assert.throws(() => refuseInCi(env), /never in CI/);
    const seen: { url: string; init: RequestInit }[] = [];
    await assert.rejects(
      replayErasures('acme.example.com', 1, {
        env: { ...env, COMMERCEWORKER_API_TOKEN: TOKEN },
        fetcher: fetcher(answer(), 200, seen),
      }),
      /never in CI/,
    );
    assert.deepEqual(seen, []);
  }
  refuseInCi({});
});

test('it needs an admin token in the environment', async () => {
  await assert.rejects(
    replayErasures('acme.example.com', 1, { env: {}, fetcher: fetcher(answer()) }),
    /COMMERCEWORKER_API_TOKEN not set/,
  );
});

test('it sends the call and reports whether anyone needs another look', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const ok = await replayErasures('acme.example.com', 5_000, {
    env: { COMMERCEWORKER_API_TOKEN: TOKEN },
    fetcher: fetcher(answer(), 200, seen),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'https://acme.example.com/api/v1/erasures/replay');
  assert.equal(ok.needsLook, false);
  // Someone with running orders, or an erasure that did not finish, is not "done".
  const blocked = answer({
    blocked: [{ target: 'subject:cc', reason: 'active_orders', orders: ['ord_1'] }],
  });
  assert.equal(
    (
      await replayErasures('a.example', 1, {
        env: { COMMERCEWORKER_API_TOKEN: TOKEN },
        fetcher: fetcher(blocked),
      })
    ).needsLook,
    true,
  );
  const unfinished = answer({ erased: [{ target: 'subject:aa', orders: 2000, done: false }] });
  assert.equal(
    (
      await replayErasures('a.example', 1, {
        env: { COMMERCEWORKER_API_TOKEN: TOKEN },
        fetcher: fetcher(unfinished),
      })
    ).needsLook,
    true,
  );
});

test('a refusal from the deployment is an error with what it said', async () => {
  await assert.rejects(
    replayErasures('a.example', 1, {
      env: { COMMERCEWORKER_API_TOKEN: TOKEN },
      fetcher: fetcher({ error: 'This needs the Admin role.' }, 403),
    }),
    /a\.example answered 403: .*Admin role/,
  );
});

test('the summary names counts only, never a person', () => {
  const line = summarize(answer({ dryRun: true }));
  assert.match(line, /2 erased since \(1 in the database's log, 1 only in its R2 copies\)/);
  assert.match(line, /1 would be erased again \(3 orders\)/);
  assert.match(line, /1 not held; 0 left alone/);
});

/** `fleet.ts replay-erasures …` as an operator's shell (or a workflow's) runs it. */
const fleet = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, ['scripts/fleet.ts', 'replay-erasures', ...args], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });

test('fleet.ts refuses in CI, without a token, for an unknown deployment and a bad time, sending nothing', () => {
  for (const ci of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }] as Record<string, string>[]) {
    const r = fleet(['bench', '2026-01-01'], { ...ci, COMMERCEWORKER_API_TOKEN: TOKEN });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /replay-erasures is run by an operator, never in CI/);
    assert.equal(r.stdout, '');
  }
  const noToken = fleet(['bench', '2026-01-01', '--dry-run'], {});
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /COMMERCEWORKER_API_TOKEN not set/);
  assert.match(fleet(['nope', '2026-01-01'], {}).stderr, /no deployment "nope"/);
  assert.match(fleet(['bench', 'last week'], {}).stderr, /not a time/);
  assert.match(fleet(['bench'], {}).stderr, /needs <since>/);
});
