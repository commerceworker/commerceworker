import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_VERSION } from '../src/commands.js';
import { writeCredentials } from '../src/credentials.js';
import { EXIT } from '../src/output.js';
import { type Call, harness, me, status, URL_ } from './harness.js';

const M = '/spaces/s1/environments/main';
const ENV = { COMMERCEWORKER_TOKEN: 'tok', COMMERCEWORKER_URL: URL_, COMMERCEWORKER_SPACE: 's1' };
const entry = (version = 2) => ({
  entry: {
    id: 'e1',
    contentTypeApiId: 'article',
    status: 'draft',
    currentVersion: version,
    publishedVersion: null,
  },
  fields: { title: { 'en-US': 'Hello', 'de-DE': 'Hallo' }, slug: { 'en-US': 'hello' } },
});

describe('entries', () => {
  it('lists through Preview, with a table for people and { items, total } for agents', async () => {
    const h = await harness(
      {
        'GET /preview/s1/main/entries': () => ({
          items: [{ id: 'e1', contentType: 'article', status: 'draft', version: 2, fields: {} }],
          total: 1,
        }),
      },
      { env: ENV },
    );
    const human = await h.run('entries', 'list', '--content-type', 'article', '--limit', '5');
    expect(human.code).toBe(EXIT.ok);
    expect(human.stdout).toBe('ID  CONTENTTYPE  STATUS  VERSION\ne1  article      draft   2');
    expect(new URL(h.calls[0]?.url ?? '').search).toBe('?content_type=article&limit=5');

    await h.run('entries', 'list', '--json');
    expect(h.json()).toEqual({
      items: [{ id: 'e1', contentType: 'article', status: 'draft', version: 2, fields: {} }],
      total: 1,
    });

    expect((await h.run('entries', 'list', '--limit', 'ten')).code).toBe(EXIT.usage);
  });

  it('update merges into the current draft by field and locale unless --replace', async () => {
    const puts: unknown[] = [];
    const h = await harness(
      {
        [`GET ${M}/entries/e1`]: () => entry(),
        [`PUT ${M}/entries/e1`]: (call) => {
          puts.push(JSON.parse(call.body ?? '{}'));
          return entry(3);
        },
      },
      { env: ENV },
    );
    const patch = JSON.stringify({ title: { 'en-US': 'Hello again' } });
    expect((await h.run('entries', 'update', 'e1', '--fields', patch)).code).toBe(EXIT.ok);
    expect(puts[0]).toEqual({
      fields: {
        title: { 'en-US': 'Hello again', 'de-DE': 'Hallo' },
        slug: { 'en-US': 'hello' },
      },
    });

    const dir = await mkdtemp(join(tmpdir(), 'cw-fields-'));
    await writeFile(join(dir, 'fields.json'), patch);
    const out = await h.run(
      'entries',
      'update',
      'e1',
      '--fields',
      `@${join(dir, 'fields.json')}`,
      '--replace',
      '--json',
    );
    expect(out.code).toBe(EXIT.ok);
    expect(puts[1]).toEqual({ fields: { title: { 'en-US': 'Hello again' } } });
    expect(h.json()).toEqual(entry(3));

    expect((await h.run('entries', 'update', 'e1', '--fields', '{nope')).code).toBe(EXIT.usage);
  });

  it('creates and publishes, holding the publish to the version read', async () => {
    const calls: Call[] = [];
    const h = await harness(
      {
        [`POST ${M}/entries`]: (call) => {
          calls.push(call);
          return status(201, entry(1));
        },
        [`POST ${M}/entries/e1/published`]: (call) => {
          calls.push(call);
          return { ...entry(1).entry, status: 'published', publishedVersion: 1 };
        },
      },
      { env: ENV },
    );
    const fields = JSON.stringify({ title: { 'en-US': 'Hi' } });
    await h.run('entries', 'create', '--content-type', 'article', '--fields', fields, '--json');
    expect(h.json()).toEqual(entry(1));
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hi' } },
    });
    const out = await h.run('entries', 'publish', 'e1', '--expected-version', '1');
    expect(out.stdout).toBe('Published e1 (version 1).');
    expect(calls[1]?.url).toBe(`${URL_}${M}/entries/e1/published?expectedVersion=1`);

    expect((await h.run('entries', 'create')).code).toBe(EXIT.usage);
  });

  it('reports a refused write as JSON on stderr with the API’s code and status', async () => {
    const h = await harness(
      {
        [`POST ${M}/entries/e1/published`]: () =>
          status(409, { code: 'version_conflict', message: 'The draft moved on' }),
        [`GET ${M}/entries/e2`]: () => status(403, { code: 'forbidden', message: 'Missing scope' }),
      },
      { env: ENV },
    );
    const out = await h.run('entries', 'publish', 'e1', '--expected-version', '1', '--json');
    expect(out.code).toBe(EXIT.failure);
    expect(out.stdout).toBe('');
    expect(JSON.parse(out.stderr)).toEqual({
      error: {
        code: 'version_conflict',
        message: 'The draft moved on',
        status: 409,
        details: { code: 'version_conflict', message: 'The draft moved on' },
      },
    });
    const forbidden = await h.run('entries', 'get', 'e2');
    expect(forbidden.stderr).toBe(
      'commerceworker: Forbidden (403): the token lacks the scope this needs. Missing scope',
    );
  });
});

describe('entries publish, several at once', () => {
  it('publishes in one bulk request and exits 1 when any entry failed', async () => {
    const h = await harness(
      {
        [`POST ${M}/bulk/entries/publish`]: (call) => {
          const { ids } = JSON.parse(call.body ?? '{}') as { ids: string[] };
          return {
            action: 'publish',
            total: ids.length,
            succeeded: ids.length - 1,
            failed: 1,
            results: ids.map((id, i) => ({
              id,
              ok: i > 0,
              ...(i ? {} : { error: 'publish_gated' }),
            })),
          };
        },
      },
      { env: ENV },
    );
    const out = await h.run('entries', 'publish', 'e1', 'e2', 'e3');
    expect(out.code).toBe(EXIT.failure);
    expect(out.stdout).toBe('Published 2 of 3.\ne1: publish_gated');
    expect(JSON.parse(h.calls[0]?.body ?? '{}')).toEqual({ ids: ['e1', 'e2', 'e3'] });
    expect((await h.run('entries', 'publish', 'e1', 'e2', '--expected-version', '2')).code).toBe(
      EXIT.usage,
    );
  });
});

describe('assets upload', () => {
  it('uploads the bytes with a type from the extension, then publishes on request', async () => {
    let stored: Uint8Array | undefined;
    const asset = { id: 'a1', status: 'draft' };
    const h = await harness(
      {
        [`POST ${M}/assets`]: (call) => {
          expect(JSON.parse(call.body ?? '{}')).toEqual({
            fileName: 'cup.png',
            contentType: 'image/png',
            title: { 'de-DE': 'Tasse' },
          });
          return status(201, {
            asset,
            upload: { url: 'https://media.cms.test/put/a1?sig=x', headers: {} },
          });
        },
        'PUT https://media.cms.test/put/a1': () => new Response(null, { status: 200 }),
        [`POST ${M}/assets/a1/published`]: () => ({ ...asset, status: 'published' }),
      },
      { env: ENV },
    );
    const dir = await mkdtemp(join(tmpdir(), 'cw-asset-'));
    const file = join(dir, 'cup.png');
    await writeFile(file, new Uint8Array([137, 80, 78, 71]));
    const wrapped = h.io.fetch;
    (h.io as { fetch: typeof fetch }).fetch = (async (input, init) => {
      if (init?.method === 'PUT') stored = init.body as Uint8Array;
      return wrapped(input, init);
    }) as typeof fetch;

    const out = await h.run(
      'assets',
      'upload',
      file,
      '--title',
      'Tasse',
      '--locale',
      'de-DE',
      '--publish',
      '--json',
    );
    expect(out.code).toBe(EXIT.ok);
    expect(h.json()).toEqual({ id: 'a1', status: 'published' });
    expect([...(stored ?? [])]).toEqual([137, 80, 78, 71]);
  });
});

describe('import', () => {
  async function setup(analysis: Record<string, unknown>) {
    const posted: Call[] = [];
    const h = await harness(
      {
        [`POST ${M}/imports/analyze`]: (call) => {
          posted.push(call);
          return analysis;
        },
        [`POST ${M}/imports`]: (call) => {
          posted.push(call);
          return status(201, { analysis, created: 2, updated: 0, skipped: 0, failed: [] });
        },
        [`POST ${M}/imports/job`]: (call) => {
          posted.push(call);
          return status(202, { analysis, job: { id: 'job-1', status: 'queued' } });
        },
      },
      { env: ENV },
    );
    const dir = await mkdtemp(join(tmpdir(), 'cw-import-'));
    await writeFile(join(dir, 'posts.xml'), '<rss/>');
    await writeFile(join(dir, 'rows.csv'), 'Title,Body\nA,x\nB,y\n');
    return { h, posted, dir };
  }

  const ready = {
    contentTypeApiId: 'article',
    locale: 'en-US',
    records: 2,
    willCreate: 2,
    willUpdate: 0,
    willSkip: 0,
    invalid: 0,
    unmappedSourceFields: [],
    missingRequiredFields: [],
    unknownTargetFields: [],
    warnings: [],
    issues: [],
    executable: true,
  };

  it('infers the source from the extension and sends the mapping; --dry-run only analyzes', async () => {
    const { h, posted, dir } = await setup(ready);
    const out = await h.run(
      'import',
      join(dir, 'posts.xml'),
      '--content-type',
      'article',
      '--map',
      'title=title',
      '--map',
      'body=content',
      '--identity',
      'legacyId',
      '--option',
      'postType=page',
      '--dry-run',
      '--json',
    );
    expect(out.code).toBe(EXIT.ok);
    expect(JSON.parse(posted[0]?.body ?? '{}')).toEqual({
      source: 'wxr',
      payload: '<rss/>',
      mapping: {
        contentTypeApiId: 'article',
        fields: { title: 'title', body: 'content' },
        identityField: 'legacyId',
      },
      sourceOptions: { postType: 'page' },
    });
    expect(h.json()).toEqual({ analysis: ready, imported: false });
    expect(posted).toHaveLength(1);
  });

  it('runs after --yes, or as a durable job with --job', async () => {
    const { h, posted, dir } = await setup(ready);
    const file = join(dir, 'rows.csv');
    const args = ['import', file, '--content-type', 'article', '--map', 'title=Title'];
    expect((await h.run(...args)).code).toBe(EXIT.usage); // not a terminal, no --yes
    expect((await h.run(...args, '--yes')).stdout).toContain('Created 2');
    expect(posted.map((c) => c.path)).toEqual([
      `${M}/imports/analyze`,
      `${M}/imports/analyze`,
      `${M}/imports`,
    ]);
    await h.run(...args, '--yes', '--job', '--json');
    expect(h.json()).toMatchObject({ imported: true, job: { id: 'job-1' } });
  });

  it('stops when the mapping blocks the import', async () => {
    const { h, posted, dir } = await setup({
      ...ready,
      executable: false,
      missingRequiredFields: ['title'],
    });
    const out = await h.run('import', join(dir, 'rows.csv'), '--content-type', 'article', '--yes');
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toMatch(/missingRequiredFields: +title/);
    expect(posted).toHaveLength(1);

    expect((await h.run('import', join(dir, 'rows.txt'), '--content-type', 'a')).code).toBe(
      EXIT.usage,
    );
  });
});

describe('types', () => {
  it('generates the codegen module from the live model', async () => {
    const h = await harness(
      {
        [`GET ${M}/content-types`]: () => ({
          items: [
            {
              apiId: 'article',
              name: 'Article',
              displayField: 'title',
              version: 1,
              status: 'published',
              fields: [
                {
                  apiId: 'title',
                  name: 'Title',
                  type: 'Symbol',
                  localized: false,
                  required: true,
                  position: 0,
                },
              ],
            },
          ],
        }),
      },
      { env: ENV },
    );
    const dir = await mkdtemp(join(tmpdir(), 'cw-types-'));
    const out = await h.run('types', '--out', join(dir, 'types.ts'), '--json');
    expect(out.code).toBe(EXIT.ok);
    expect(h.json()).toEqual({ path: join(dir, 'types.ts'), contentTypes: 1 });
    const source = await readFile(join(dir, 'types.ts'), 'utf8');
    expect(source).toContain('export type ArticleFields = {');
    expect(source).toContain('from s1/main');
  });
});

describe('doctor', () => {
  const healthy = {
    'GET /health': () => ({ status: 'ok', scheduler: 'ok' }),
    'GET /openapi.json': () => ({ info: { version: API_VERSION } }),
    'GET /auth/me': () => me(),
    [`GET ${M}/content-types`]: () => ({ items: [] }),
  };

  it('passes every check against a healthy deployment', async () => {
    const h = await harness(healthy, { env: ENV });
    const out = await h.run('doctor', '--json');
    expect(out.code).toBe(EXIT.ok);
    const result = h.json() as { ok: boolean; checks: { name: string; status: string }[] };
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ['auth', 'ok'],
      ['reachable', 'ok'],
      ['api version', 'ok'],
      ['token', 'ok'],
      ['space', 'ok'],
    ]);
  });

  it('fails (exit 1) on an incompatible API, an unreadable space, or a wide credentials file', async () => {
    const h = await harness({
      ...healthy,
      'GET /openapi.json': () => ({ info: { version: '0.2.0' } }),
      [`GET ${M}/content-types`]: () => status(403, { code: 'forbidden' }),
    });
    await writeCredentials(h.io, {
      current: 'default',
      profiles: { default: { url: URL_, space: 's1', environment: 'main', accessToken: 't' } },
    });
    if (process.platform !== 'win32') {
      const { chmod } = await import('node:fs/promises');
      await chmod(join(h.configDir, 'credentials.json'), 0o644);
    }
    const out = await h.run('doctor', '--json');
    expect(out.code).toBe(EXIT.failure);
    const checks = Object.fromEntries(
      (h.json().checks as { name: string; status: string }[]).map((c) => [c.name, c.status]),
    );
    expect(checks['api version']).toBe('fail');
    expect(checks.space).toBe('fail');
    if (process.platform !== 'win32') expect(checks.credentials).toBe('fail');
  });

  it('reports a missing sign-in and an unreachable deployment instead of throwing', async () => {
    const h = await harness({});
    (h.io as { fetch: typeof fetch }).fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const out = await h.run('doctor', '--url', URL_, '--json');
    expect(out.code).toBe(EXIT.failure);
    expect(
      (h.json().checks as { name: string; status: string }[]).map((c) => [c.name, c.status]),
    ).toEqual([
      ['auth', 'fail'],
      ['reachable', 'fail'],
      ['api version', 'warn'],
    ]);
  });
});

describe('the command line', () => {
  it('lists spaces, and rejects unknown commands and flags with exit 2', async () => {
    const h = await harness(
      { 'GET /spaces': () => ({ items: [{ id: 's1', name: 'One' }] }) },
      { env: ENV },
    );
    await h.run('spaces', '--json');
    expect(h.json()).toEqual({ items: [{ id: 's1', name: 'One' }] });
    expect((await h.run('spaces')).stdout).toBe('ID  NAME\ns1  One');
    expect((await h.run('nope')).code).toBe(EXIT.usage);
    expect((await h.run('entries', 'nope')).code).toBe(EXIT.usage);
    expect((await h.run('spaces', '--bogus')).code).toBe(EXIT.usage);
    const help = await h.run('entries', 'list', '--help');
    expect(help.code).toBe(EXIT.ok);
    expect(help.stdout).toContain('--content-type');
  });
});
