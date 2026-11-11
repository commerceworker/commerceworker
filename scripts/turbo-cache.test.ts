/**
 * The turbo cache is only safe if a task's hash moves whenever something its result depends on
 * changes: CI restores the cache between runs and a hit skips the task, so a stale hit is a green
 * check for code that was never checked. This changes one file at a time in a scratch copy of the
 * repository (never the working tree) and compares `turbo run ... --dry=json` hashes before and
 * after. Each case names a file the tasks read from outside their own package, or a file every
 * package reads, and the tasks that must notice it. See the notes at the top of turbo.json.
 *
 * Needs the repository's own turbo (`pnpm install`); reads no cache and runs no task.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const root = join(import.meta.dirname, '..');
const turbo = join(root, 'node_modules/.bin/turbo');
const TASKS = ['lint', 'check-types', 'build', 'test'];

let copy = '';

const turboEnv = { ...process.env, TURBO_TELEMETRY_DISABLED: '1', TURBO_NO_UPDATE_NOTIFIER: '1' };

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: copy, encoding: 'utf8', maxBuffer: 1 << 28 });
}

function dry(env: Record<string, string> = {}): {
  hashes: Map<string, string>;
  envMode: string;
  declaredEnv: string[];
} {
  const out = execFileSync(turbo, ['run', ...TASKS, '--dry=json', '--no-daemon'], {
    cwd: copy,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...turboEnv, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const json = JSON.parse(out.slice(out.indexOf('{'))) as {
    tasks: {
      taskId: string;
      hash: string;
      envMode: string;
      environmentVariables?: { specified?: { env?: string[] } };
    }[];
  };
  return {
    hashes: new Map(json.tasks.map((t) => [t.taskId, t.hash])),
    envMode: json.tasks[0]?.envMode ?? '',
    declaredEnv: json.tasks.flatMap((t) => t.environmentVariables?.specified?.env ?? []),
  };
}

/** Append to a file in the copy, hash, then undo. */
function changed(file: string, text = '\n'): Set<string> {
  const before = dry().hashes;
  const path = join(copy, file);
  assert.ok(existsSync(path), `${file} exists`);
  appendFileSync(path, text);
  try {
    const after = dry().hashes;
    return new Set([...after].filter(([task, hash]) => before.get(task) !== hash).map(([t]) => t));
  } finally {
    git('checkout', '--', file);
  }
}

function assertMoves(file: string, tasks: string[], text?: string) {
  const moved = changed(file, text);
  for (const task of tasks) {
    assert.ok(moved.has(`@commerceworker/${task}`), `${file} must change the hash of ${task}`);
  }
}

describe('turbo cache inputs', () => {
  before(() => {
    assert.ok(existsSync(turbo), 'run `pnpm install` first: this test uses the repository turbo');
    copy = mkdtempSync(join(tmpdir(), 'cw-turbo-'));
    const files = [
      ...execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'),
      ...execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8',
      }).split('\0'),
    ].filter((file) => file && existsSync(join(root, file)));
    for (const file of files) {
      mkdirSync(join(copy, file, '..'), { recursive: true });
      cpSync(join(root, file), join(copy, file));
    }
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'copy');
  });
  after(() => rmSync(copy, { recursive: true, force: true }));

  it('a docs/content page re-runs the docs embed and what consumes it', () => {
    assertMoves('docs/content/admin-ui.md', [
      'docs-index#generate',
      'docs-index#test',
      'http#check-types',
      'http#test',
      'api#build',
      'studio#build',
      'docs#build',
    ]);
  });

  it('a maintainer doc outside docs/content does not', () => {
    const moved = changed('docs/deploy.md');
    assert.ok(!moved.has('@commerceworker/docs-index#generate'));
  });

  it('a skill re-runs the MCP embed, the API suite and the CLI suite', () => {
    assertMoves('packages/http/skills/author-and-publish/SKILL.md', [
      'http#generate',
      'http#test',
      'api#build',
      'studio#build',
    ]);
    assertMoves('skills/modeling-content-with-commerceworker/SKILL.md', ['cli#test', 'http#test']);
  });

  it('a design token re-runs the themes and the docs site', () => {
    assertMoves('packages/design/src/tokens.ts', ['design#generate', 'design#test', 'docs#build']);
  });

  it('files a test reads from another package move that test', () => {
    for (const css of [
      'apps/web/app/app.css',
      'apps/studio/app/app.css',
      'apps/storefront/app/app.css',
    ]) {
      assertMoves(css, ['design#test']);
    }
    assertMoves('packages/ui/src/button.tsx', ['design#test', 'web#test']);
    assertMoves('apps/docs/src/content/index.mdx', ['design#test', 'cli#test']);
    assertMoves('packages/sdk/vue/src/index.ts', ['cli#test']);
    assertMoves('apps/delivery/src/catalog/routes.ts', ['sdk-catalog#test']);
    assertMoves('apps/docs/src/data/runs/b2b-order.json', ['engine#test']);
  });

  it('a plugin the engine suite loads moves the engine suite', () => {
    assertMoves('plugins/example/src/index.ts', ['engine#test']);
    assertMoves('plugins/fixture-carrier/src/index.ts', ['engine#test']);
    assertMoves('plugins/punchout/src/index.ts', ['engine#test']);
  });

  it('a Worker a Vite config bundles or reads moves that build', () => {
    // The studio's build bundles the api, pipeline, media and delivery Workers.
    for (const file of [
      'apps/api/src/index.ts',
      'apps/pipeline/src/index.ts',
      'apps/media/src/index.ts',
    ]) {
      assertMoves(file, ['studio#build']);
    }
    assertMoves('apps/engine/wrangler.jsonc', ['web#build', 'storefront#build']);
    assertMoves('apps/catalog/wrangler.jsonc', ['web#build', 'storefront#build']);
    assertMoves('packages/plugin-sdk/src/testing.ts', ['web#build', 'web#check-types']);
  });

  it('the web OpenAPI document moves the docs site that renders it', () => {
    assertMoves('apps/web/app/lib/openapi.ts', ['docs#build', 'docs#check-types']);
  });

  it('a change reaches the tests of every package that depends on it, not only the direct ones', () => {
    // web and the engine reach domain and redaction only through other packages.
    assertMoves('packages/domain/src/index.ts', ['web#test', 'engine#test', 'studio#test']);
    assertMoves('packages/redaction/src/index.ts', ['web#test', 'engine#test']);
  });

  it('a migration moves every suite that applies it', () => {
    assertMoves('packages/db/migrations/0074_quotes.sql', [
      'db#test',
      'engine#test',
      'catalog#test',
    ]);
  });

  it('files every package reads move every package', () => {
    for (const file of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      '.nvmrc',
      'biome.json',
      'packages/typescript-config/base.json',
    ]) {
      const moved = changed(file, file.endsWith('.json') ? ' ' : '\n# x\n');
      for (const task of ['ports#check-types', 'web#build', 'domain#test', 'core#lint']) {
        assert.ok(moved.has(`@commerceworker/${task}`), `${file} must change the hash of ${task}`);
      }
    }
  });

  it("a package's own files still move its tasks beside the inputs it declares", () => {
    assertMoves('packages/cli/src/bin.ts', ['cli#test', 'cli#build']);
    assertMoves('packages/design/src/tokens.ts', ['design#test']);
    assertMoves('packages/http/src/api/access-policy.ts', ['http#test']);
    assertMoves('apps/engine/src/index.ts', ['engine#test']);
    assertMoves('apps/web/app/root.tsx', ['web#build', 'web#check-types']);
    assertMoves('apps/catalog/src/index.ts', ['catalog#test']);
    assertMoves('apps/studio/app/root.tsx', ['studio#build']);
    assertMoves('packages/sdk/catalog/src/index.ts', ['sdk-catalog#test']);
  });

  it('a change in a package leaves unrelated packages cached', () => {
    const moved = changed('packages/sdk/vue/src/index.ts');
    assert.ok(!moved.has('@commerceworker/domain#test'));
    assert.ok(!moved.has('@commerceworker/engine#test'));
    assert.ok(!moved.has('@commerceworker/web#test'));
  });

  it('env vars from the shell never reach a task, so none can change a result', () => {
    const base = dry();
    assert.equal(base.envMode, 'strict');
    assert.deepEqual(base.declaredEnv, [], 'a task declares an env var: add a case for it here');
    const other = dry({ AI_MODE: 'live', CLOUDFLARE_API_TOKEN: 'x', NODE_ENV: 'production' });
    assert.deepEqual([...other.hashes], [...base.hashes]);
  });
});
