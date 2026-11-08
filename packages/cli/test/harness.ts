import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.js';
import { run } from '../src/run.js';

export const URL_ = 'https://api.cms.test';
export const ISSUER = 'https://cms.test';

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

type Handler = (call: Call) => unknown;

/** A JSON response, or a Response as-is. */
const respond = (value: unknown): Response =>
  value instanceof Response
    ? value
    : new Response(JSON.stringify(value ?? null), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

export const status = (code: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A scripted deployment: `routes` maps `METHOD /path` (or a full URL for the issuer's origin) to a
 * handler; anything unrouted is a 404 so a stray request fails its test loudly. Every call is
 * recorded, and `sleep` advances the clock instead of waiting.
 */
export async function harness(
  routes: Record<string, Handler>,
  opts: { env?: Record<string, string>; interactive?: boolean; answers?: string[] } = {},
) {
  const configDir = join(await mkdtemp(join(tmpdir(), 'cw-cli-')), 'config');
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sleeps: number[] = [];
  let clock = Date.parse('2026-11-01T12:00:00Z');
  const answers = [...(opts.answers ?? [])];

  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init.method ?? 'GET',
      url: url.href,
      path: url.pathname,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const handler =
      routes[`${call.method} ${url.origin}${url.pathname}`] ??
      (url.origin === URL_ ? routes[`${call.method} ${url.pathname}`] : undefined);
    if (!handler) return status(404, { code: 'not_found' });
    return respond(await handler(call));
  }) as typeof fetch;

  const io: Io = {
    env: { COMMERCEWORKER_CONFIG_DIR: configDir, ...opts.env },
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
    interactive: opts.interactive ?? false,
    fetch: fetchImpl,
    configDir,
    cwd: process.cwd(),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ask: async () => answers.shift() ?? '',
    platform: process.platform,
  };

  return {
    io,
    calls,
    sleeps,
    configDir,
    stdout,
    stderr,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    run: async (...argv: string[]) => {
      stdout.length = 0;
      stderr.length = 0;
      const code = await run(argv, io);
      return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    },
    /** The `--json` result on stdout. */
    json: () => JSON.parse(stdout.join('\n')) as Record<string, unknown>,
    form: (call: Call) => Object.fromEntries(new URLSearchParams(call.body ?? '')),
  };
}

/** The OAuth metadata the api serves: endpoints on the admin's origin. */
export const metadata = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  device_authorization_endpoint: `${ISSUER}/oauth/device_authorization`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
};

export const me = (
  spaceId = 's1',
  scopes = ['content:write', 'content:publish', 'preview:read'],
) => ({
  spaceId,
  kind: 'cma',
  scopes,
  subject: 'ada@example.com',
  restricted: false,
});
