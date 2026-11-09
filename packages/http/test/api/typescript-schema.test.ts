import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

// TypeScript 7 ships no compiler JS API, so this runs its own `tsc` on the source in a temp dir and
// returns the diagnostics it prints ('' when it compiles clean).
const tscBin = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
);
async function tsc(source: string, compilerOptions: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cw-tsc-'));
  await writeFile(join(dir, 'generated.ts'), source);
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { noEmit: true, ...compilerOptions },
      files: ['generated.ts'],
    }),
  );
  try {
    execFileSync(process.execPath, [tscBin, '-p', dir, '--pretty', 'false'], { encoding: 'utf8' });
    return '';
  } catch (error) {
    return String((error as { stdout?: string }).stdout || error);
  }
}
const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
  await app.request(`${M}/content-types`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: true,
          required: true,
          position: 0,
        },
        {
          apiId: 'views',
          name: 'Views',
          type: 'Integer',
          localized: false,
          required: false,
          position: 1,
        },
        {
          apiId: 'hero',
          name: 'Hero',
          type: 'Component',
          localized: false,
          required: false,
          position: 2,
          fields: [
            {
              apiId: 'heading',
              name: 'Heading',
              type: 'Symbol',
              localized: false,
              required: true,
              position: 0,
            },
          ],
        },
      ],
    }),
  });
});

const fetchTypes = async (headers: Record<string, string> = cma) =>
  app.request(`${M}/content-types?format=typescript`, { headers });

describe('serving the content model as TypeScript', () => {
  it('returns source, not JSON', async () => {
    const res = await fetchTypes();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('export type ArticleFields');
  });

  it('still returns JSON without the format', async () => {
    const res = await app.request(`${M}/content-types`, { headers: cma });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()) as { items: unknown[] }).toHaveProperty('items');
  });

  it('describes the live model, including shapes the CLI would have to be re-run for', async () => {
    const source = await (await fetchTypes()).text();
    expect(source).toContain('title: string;');
    expect(source).toContain('views?: number;');
    // A component, which is where a stale checked-in file drifts first.
    expect(source).toContain('hero?: { heading: string };');
  });

  it('parses as TypeScript', async () => {
    const source = await (await fetchTypes()).text();
    // Only syntax: `noCheck` skips type-checking, and pretending
    // otherwise would be the vacuous version of this test. That the generated
    // shapes type-check and satisfy the SDK generics is covered where it
    // belongs, in the codegen package's own suite. What is worth checking here
    // is that the endpoint serves that output intact rather than, say, a
    // JSON-escaped string of it.
    expect(await tsc(source, { noCheck: true, target: 'es2022', types: [] })).toBe('');
  });

  it('says which space and environment it came from', async () => {
    const source = await (await fetchTypes()).text();
    // A file on disk with no provenance is one nobody can tell is stale.
    expect(source).toContain('s1/main');
  });

  it('needs only the scope that lists content types', async () => {
    // A delivery key reads published content, not the model.
    expect((await fetchTypes(cda as Record<string, string>)).status).toBe(403);
  });
});
