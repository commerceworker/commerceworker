/**
 * The `commerceworker` CLI against the real api, in process: its fetch is `app.request`, so every
 * command goes through the same routes, auth and validation a deployed api runs. Proves the device
 * flow (approved by a signed-in person while the CLI polls), the model round trip, entries,
 * imports and types, and that a device-flow token is refused what OAuth never grants.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMember, createRole, createSpace } from '@commerceworker/application';
import { EXIT, type Io, run } from '@commerceworker/cli';
import { SCOPES } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { principalTarget, signPrincipal } from '@commerceworker/security/principal';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const PRINCIPAL_KEY = 'p'.repeat(40);
const ORIGIN = 'https://cms.example.com';

const config: ApiConfig = testConfig({
  sessionSecret: 's'.repeat(40),
  principalKeys: [PRINCIPAL_KEY],
  oauthIssuer: ORIGIN,
  oauthAccessTokenTtlSeconds: 3600,
  oauthRefreshTokenTtlSeconds: 2592000,
});

const PERSON = { sub: 'usr_ada', email: 'ada@example.com', name: 'Ada', role: 'member' as const };

async function boot() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
  await createSpace(wired.ctx, { spaceId: 's1', name: 'One', defaultLocale: 'en-US' }).catch(
    () => {},
  );
  const role = await createRole(wired.ctx, 's1', {
    name: 'Editor',
    scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.previewRead, SCOPES.deliveryRead],
  });
  await addMember(wired.ctx, 's1', { email: PERSON.email, name: PERSON.name, role: role.id });

  /** What the admin's gateway adds for a signed-in person: a principal signed for this path. */
  const asPerson = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set(
      'x-cw-principal',
      await signPrincipal(
        PRINCIPAL_KEY,
        PERSON,
        principalTarget(init.method ?? 'GET', new URL(path, ORIGIN).pathname),
      ),
    );
    return app.request(`${ORIGIN}${path}`, { ...init, headers });
  };
  return { app, asPerson };
}

async function cli(
  app: ReturnType<typeof createApp>,
  env: Record<string, string> = {},
  onSleep?: () => Promise<void>,
) {
  const configDir = await mkdtemp(join(tmpdir(), 'cw-cli-http-'));
  const out: string[] = [];
  const err: string[] = [];
  let clock = Date.now();
  const io: Io = {
    env: { COMMERCEWORKER_CONFIG_DIR: configDir, ...env },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    interactive: false,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      app.request(String(input), init)) as typeof fetch,
    configDir,
    cwd: configDir,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await onSleep?.();
    },
    ask: async () => '',
    platform: process.platform,
    openUrl: async () => {},
    readStdin: async () => '',
  };
  return {
    io,
    configDir,
    err,
    run: async (...argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await run(argv, io);
      return {
        code,
        json: out.length && argv.includes('--json') ? JSON.parse(out.join('\n')) : undefined,
        stderr: err.join('\n'),
      };
    },
  };
}

/** Approves the device code the CLI printed, the way a person does on the admin. */
async function approve(asPerson: Awaited<ReturnType<typeof boot>>['asPerson'], stderr: string) {
  const { userCode } = JSON.parse(stderr.split('\n')[0] as string) as { userCode: string };
  const page = await asPerson(`/oauth/device?user_code=${encodeURIComponent(userCode)}`);
  const fields: Record<string, string> = {};
  for (const m of (await page.text()).matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
  )) {
    fields[m[1] as string] = (m[2] as string).replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  }
  const res = await asPerson('/oauth/device', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, decision: 'approve' }).toString(),
  });
  expect(res.status).toBe(200);
}

describe('commerceworker CLI against the api', () => {
  it('signs in with the device flow, then reads and writes as that person', async () => {
    const { app, asPerson } = await boot();
    let approved = false;
    const c = await cli(app, {}, async () => {
      // The person approves while the CLI waits between polls.
      if (!approved && c.err.length) {
        approved = true;
        await approve(asPerson, c.err.join('\n'));
      }
    });

    const login = await c.run('login', '--url', ORIGIN, '--json');
    expect(login.code).toBe(EXIT.ok);
    expect(login.json).toMatchObject({ space: 's1', method: 'device', subject: PERSON.sub });

    const whoami = await c.run('whoami', '--json');
    expect(whoami.json).toMatchObject({ space: 's1', source: 'default' });
    expect(whoami.json.scopes).toEqual(
      expect.arrayContaining([SCOPES.contentWrite, SCOPES.previewRead]),
    );

    // OAuth never grants content:manage, so the model can't be changed with this token.
    const dir = await mkdtemp(join(tmpdir(), 'cw-cli-model-'));
    await writeFile(
      join(dir, 'model.json'),
      JSON.stringify([
        {
          apiId: 'note',
          name: 'Note',
          displayField: 'title',
          fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
        },
      ]),
    );
    const refused = await c.run('model', 'apply', join(dir, 'model.json'), '--yes', '--json');
    expect(refused.code).toBe(EXIT.failure);
    expect(JSON.parse(refused.stderr).error.status).toBe(403);

    const logout = await c.run('logout', '--json');
    expect(logout.json).toEqual({ profile: 'default', removed: true, revoked: true });
  });

  it('keeps the model in a file, authors entries, imports a CSV and generates types', async () => {
    const { app } = await boot();
    const c = await cli(app, {
      COMMERCEWORKER_TOKEN: 'cma',
      COMMERCEWORKER_URL: ORIGIN,
      COMMERCEWORKER_SPACE: 's1',
    });
    const model = join(c.configDir, 'model.ts');
    const article = {
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        { apiId: 'title', name: 'Title', type: 'Symbol', required: true },
        { apiId: 'sku', name: 'SKU', type: 'Symbol' },
        { apiId: 'body', name: 'Body', type: 'Text' },
      ],
    };
    await writeFile(model, `export default ${JSON.stringify([article])};\n`);

    const plan = await c.run('model', 'apply', model, '--dry-run', '--json');
    expect(plan.json).toMatchObject({ changes: 1, destructive: 0, applied: false });
    const applied = await c.run('model', 'apply', model, '--yes', '--json');
    expect(applied.code).toBe(EXIT.ok);
    expect(applied.json.results).toEqual([
      { apiId: 'article', action: 'create', version: 1, published: true },
    ]);
    // Applied again, the space already matches.
    expect((await c.run('model', 'apply', model, '--dry-run', '--json')).json.changes).toBe(0);

    // Export round-trips to a file that plans clean.
    const exported = join(c.configDir, 'exported.json');
    expect((await c.run('model', 'export', '--out', exported)).code).toBe(EXIT.ok);
    expect((await c.run('model', 'apply', exported, '--dry-run', '--json')).json.changes).toBe(0);

    // Dropping a field is destructive: refused without the flag. (A new file: Vite, unlike Node,
    // can't transform the `.ts?v=` URL the CLI reloads an edited module under.)
    const smaller = join(c.configDir, 'smaller.ts');
    await writeFile(
      smaller,
      `export default ${JSON.stringify([{ ...article, fields: article.fields.slice(0, 2) }])};\n`,
    );
    const destructive = await c.run('model', 'apply', smaller, '--yes', '--json');
    expect(destructive.code).toBe(EXIT.refused);

    const created = await c.run(
      'entries',
      'create',
      '--content-type',
      'article',
      '--fields',
      JSON.stringify({ title: { 'en-US': 'Hello' }, body: { 'en-US': 'Draft' } }),
      '--json',
    );
    const id = created.json.entry.id as string;
    const updated = await c.run(
      'entries',
      'update',
      id,
      '--fields',
      JSON.stringify({ title: { 'en-US': 'Hello again' } }),
      '--json',
    );
    expect(updated.json.fields).toEqual({
      title: { 'en-US': 'Hello again' },
      body: { 'en-US': 'Draft' },
    });
    const published = await c.run(
      'entries',
      'publish',
      id,
      '--expected-version',
      String(updated.json.entry.currentVersion),
      '--json',
    );
    expect(published.json.status).toBe('published');
    // A publish held to a version that has moved on changes nothing.
    const stale = await c.run('entries', 'publish', id, '--expected-version', '1', '--json');
    expect(stale.code).toBe(EXIT.failure);
    expect(JSON.parse(stale.stderr).error.status).toBe(409);

    await writeFile(join(c.configDir, 'rows.csv'), 'sku,name\nA-1,Widget\nA-2,Gadget\n');
    const importArgs = [
      'import',
      join(c.configDir, 'rows.csv'),
      '--content-type',
      'article',
      '--map',
      'title=name',
      '--map',
      'sku=sku',
      '--identity',
      'sku',
      '--json',
    ];
    const dry = await c.run(...importArgs, '--dry-run');
    expect(dry.json.analysis).toMatchObject({ willCreate: 2, executable: true });
    const imported = await c.run(...importArgs, '--yes');
    expect(imported.json.result).toMatchObject({ created: 2, failed: [] });
    // Re-run: the identity field recognises what the first run created.
    const again = await c.run(...importArgs, '--dry-run');
    expect(again.json.analysis).toMatchObject({ willCreate: 0, willSkip: 2 });

    const listed = await c.run('entries', 'list', '--content-type', 'article', '--json');
    expect(listed.json.total).toBe(3);

    const types = await c.run('types', '--json');
    expect(types.json.source).toContain('export type ArticleFields = {');

    const doctor = await c.run('doctor', '--json');
    expect(doctor.json.checks.find((x: { name: string }) => x.name === 'api version').status).toBe(
      'ok',
    );
  });
  it('applies the example model the modeling skill documents, as written', async () => {
    const { app } = await boot();
    const c = await cli(app, {
      COMMERCEWORKER_TOKEN: 'cma',
      COMMERCEWORKER_URL: ORIGIN,
      COMMERCEWORKER_SPACE: 's1',
    });
    const reference = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../skills/modeling-content-with-commerceworker/references/field-reference.md',
    );
    const example = /```ts\n([\s\S]*?)```/.exec(await readFile(reference, 'utf8'))?.[1];
    expect(example).toContain('export default');
    const file = join(c.configDir, 'landing-page.ts');
    await writeFile(file, example as string);

    const applied = await c.run('model', 'apply', file, '--yes', '--json');
    expect(applied.code, applied.stderr).toBe(EXIT.ok);
    expect(applied.json.results).toEqual([
      { apiId: 'landingPage', action: 'create', version: 1, published: true },
    ]);
    expect((await c.run('model', 'apply', file, '--dry-run', '--json')).json.changes).toBe(0);
  });
});
