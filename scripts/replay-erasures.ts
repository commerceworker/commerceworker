/**
 * `node scripts/fleet.ts replay-erasures <id> <since> [--dry-run]`: after a restore, erases again
 * the people erased since its point (docs/operations.md, "Replaying erasures after a restore").
 *
 * It calls the deployment's REST operation, `POST /api/v1/erasures/replay` (the `replay_erasures`
 * tool, the same one MCP offers), with an admin's `COMMERCEWORKER_API_TOKEN`, as `plugin-check.ts`
 * calls the plugin usage route. It does not print a `curl` line for the operator to run: the
 * restore runbooks end with this step, so the step should be the command, its answer says who
 * was left alone (and exits non-zero), and the token never lands in a shell history or a
 * pasted command. The engine does the work, in the deployment's own Worker: an operator's
 * machine reads and erases nothing. `--dry-run` sends `dryRun: true`, so the engine reports who
 * would be erased and erases nobody. It never runs in CI: a restore is an operator's decision and
 * so is what follows it.
 */

/** The REST operation (`REST_OPERATIONS`, apps/web/app/lib/rest-operations.ts). */
export const REPLAY_PATH = '/api/v1/erasures/replay';

/** Refuses a workflow: the token is an operator's, and a restore is not scheduled. */
export function refuseInCi(env: Record<string, string | undefined>) {
  if (env.CI || env.GITHUB_ACTIONS)
    throw new Error('replay-erasures is run by an operator, never in CI');
}

/**
 * A restore point as an operator has it: an ISO date or date-time (read as UTC when it names no
 * zone), or epoch milliseconds. Refuses a time that has not come, since it would erase nobody.
 */
export function parseSince(raw: string | undefined, now = Date.now()): number {
  if (!raw)
    throw new Error('replay-erasures needs <since>: the restore point, an ISO time or epoch ms');
  const ms = /^\d{10,}$/.test(raw)
    ? Number(raw)
    : Date.parse(
        /^\d{4}-\d{2}-\d{2}$/.test(raw) || /[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`,
      );
  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error(`${JSON.stringify(raw)} is not a time: use 2026-11-12T09:30:00Z or epoch ms`);
  if (ms > now) throw new Error(`${raw} has not come yet`);
  return ms;
}

export type ReplayRequest = {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
};

/** The call that replays erasures on `domain`: nothing is sent here. */
export function replayRequest(
  domain: string,
  since: number,
  opts: { dryRun?: boolean; token: string },
): ReplayRequest {
  return {
    url: `https://${domain}${REPLAY_PATH}`,
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ since, ...(opts.dryRun ? { dryRun: true } : {}) }),
    },
  };
}

/** What the REST operation answers (`erasureReplaySchema`, packages/core/src/erasure-schemas.ts). */
export type ReplayAnswer = {
  dryRun: boolean;
  events: { total: number; database: number; archive: number };
  scanned: number;
  erased: { target: string; orders: number; done: boolean }[];
  blocked: { target: string; reason: string; orders: string[] }[];
  clean: string[];
};

/** The answer in a line an operator reads at the end of a runbook. */
export function summarize(a: ReplayAnswer): string {
  const orders = a.erased.reduce((n, e) => n + e.orders, 0);
  return [
    `${a.events.total} erased since (${a.events.database} in the database's log, ${a.events.archive} only in its R2 copies)`,
    `${a.erased.length} ${a.dryRun ? 'would be erased again' : 'erased again'} (${orders} orders)`,
    `${a.clean.length} not held`,
    `${a.blocked.length} left alone`,
  ].join('; ');
}

/**
 * Runs it: refuses CI and a missing token before any request, sends the call, and returns the
 * answer with whether it needs another look (someone left alone, or an erasure not finished).
 * `fetcher` is injected for tests.
 */
export async function replayErasures(
  domain: string,
  since: number,
  opts: {
    dryRun?: boolean;
    env: Record<string, string | undefined>;
    fetcher?: typeof fetch;
  },
): Promise<{ answer: ReplayAnswer; needsLook: boolean }> {
  refuseInCi(opts.env);
  const token = opts.env.COMMERCEWORKER_API_TOKEN;
  if (!token) throw new Error("COMMERCEWORKER_API_TOKEN not set: use an admin's API token");
  const { url, init } = replayRequest(domain, since, { token, dryRun: opts.dryRun });
  // A long replay (many people, many orders) takes minutes: the operation is idempotent, so a
  // timeout is safe to run again.
  const res = await (opts.fetcher ?? fetch)(url, { ...init, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${domain} answered ${res.status}: ${await res.text()}`);
  const answer = (await res.json()) as ReplayAnswer;
  return {
    answer,
    needsLook: answer.blocked.length > 0 || answer.erased.some((e) => !e.done),
  };
}
