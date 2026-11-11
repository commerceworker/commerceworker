import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parse as parseJsonc } from 'jsonc-parser';

// One toolchain, held in line. Node, TypeScript, the Biome schema, vitest and the generated
// worker types each have a version that several files state; these tests fail the day one is
// bumped without the others, with the file to change in the message.
//
// The floor is the root package.json's `engines.node`. `.nvmrc` is what we run and may be newer;
// `@types/node` follows the floor, so code can't call an API the oldest supported Node lacks.

const root = join(import.meta.dirname, '..');

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 1 << 26,
})
  .split('\n')
  .filter(Boolean);

const read = (path: string) => readFileSync(join(root, path), 'utf8');
type Config = {
  $schema?: string;
  private?: boolean;
  engines?: { node?: string };
  extends?: string | string[];
  compilerOptions?: Record<string, unknown>;
};
const json = (path: string) => parseJsonc(read(path)) as Config;
const named = (name: string) => files.filter((f) => f.split('/').pop() === name);

const workspace = read('pnpm-workspace.yaml');

/** An entry of the default catalog in pnpm-workspace.yaml, as written (`^2.5.15`, `5.0.5`). */
function catalogVersion(name: string): string {
  const quoted = name.replace(/[/@]/g, (c) => `\\${c}`);
  const hit = new RegExp(`^ {2}'?${quoted}'?:\\s*(\\S+)\\s*$`, 'm').exec(workspace);
  assert.ok(hit?.[1], `${name} is not in the catalog of pnpm-workspace.yaml`);
  return hit[1];
}

const major = (range: string) => Number(/(\d+)/.exec(range)?.[1]);

const floorRange: string | undefined = json('package.json').engines?.node;
assert.ok(
  floorRange,
  'package.json needs "engines": { "node": ">=NN" }: it is the toolchain floor',
);
const floor = major(floorRange);

test('every engines.node equals the root floor, and every published package has one', () => {
  for (const path of named('package.json')) {
    const pkg = json(path);
    if (pkg.engines?.node !== undefined) {
      assert.equal(
        pkg.engines.node,
        floorRange,
        `${path}: engines.node is ${pkg.engines.node}; set it to ${floorRange}, the root package.json's`,
      );
    } else if (pkg.private !== true) {
      assert.fail(
        `${path} is published (no "private": true) and needs "engines": { "node": "${floorRange}" }`,
      );
    }
  }
});

test('.nvmrc is at or above the engines floor', () => {
  const nvm = major(read('.nvmrc'));
  assert.ok(
    nvm >= floor,
    `.nvmrc says ${nvm} but engines.node is ${floorRange}: raise .nvmrc or lower the floor`,
  );
});

test('the @types/node catalog major equals the floor major', () => {
  const types = catalogVersion('@types/node');
  assert.equal(
    major(types),
    floor,
    `@types/node is ${types} in pnpm-workspace.yaml but engines.node is ${floorRange}: set it to ^${floor}`,
  );
});

// apps/docs and apps/marketing are Astro projects: they extend Astro's own config.
const ASTRO = new Set(['apps/docs/tsconfig.json', 'apps/marketing/tsconfig.json']);
// The root scripts have no package of their own to depend on the shared config, so they reach the
// same base by its path.
const ROOT_SCRIPTS = {
  path: 'scripts/tsconfig.json',
  base: '../packages/typescript-config/base.json',
};

test('every tsconfig extends the shared configs and sets no target, module or moduleResolution', () => {
  const tsconfigs = files.filter(
    (f) => /(^|\/)tsconfig[^/]*\.json$/.test(f) && !f.startsWith('packages/typescript-config/'),
  );
  assert.ok(tsconfigs.length > 20, 'found too few tsconfigs: is git ls-files failing?');
  for (const path of tsconfigs) {
    const config = json(path);
    const extended = [config.extends].flat().filter(Boolean) as string[];
    const ok = ASTRO.has(path)
      ? extended.length === 1 && extended[0] === 'astro/tsconfigs/strict'
      : path === ROOT_SCRIPTS.path
        ? extended.length === 1 && extended[0] === ROOT_SCRIPTS.base
        : extended.length > 0 &&
          extended.every(
            // A sibling tsconfig (tsconfig.test.json) inherits the shared base through ./tsconfig.json.
            (e) => e.startsWith('@commerceworker/typescript-config/') || e === './tsconfig.json',
          );
    assert.ok(
      ok,
      `${path} must extend @commerceworker/typescript-config/* (base, worker or react-app)${
        ASTRO.has(path) ? ' or, as an Astro project, astro/tsconfigs/strict' : ''
      }; found ${JSON.stringify(config.extends)}`,
    );
    for (const key of ['target', 'module', 'moduleResolution']) {
      assert.equal(
        config.compilerOptions?.[key],
        undefined,
        `${path} sets compilerOptions.${key}: remove it and change packages/typescript-config if every package needs it`,
      );
    }
  }
});

test('no bundler targets a Node below the floor', () => {
  const configs = files.filter(
    (f) =>
      /(^|\/)(tsup|esbuild)\.config\.[cm]?[jt]s$/.test(f) ||
      f === 'packages/plugin-sdk/src/testing.ts', // its esbuild call bundles a plugin for the tests
  );
  assert.ok(
    configs.includes('packages/sdk/sdk/tsup.config.ts'),
    'the sdk tsup config was not found',
  );
  for (const path of configs) {
    for (const [, target] of read(path).matchAll(/target:\s*['"]node(\d+)['"]/g)) {
      assert.ok(
        Number(target) >= floor,
        `${path} targets node${target}, below engines.node ${floorRange}: change it to node${floor}`,
      );
    }
  }
});

test("biome.json's $schema version equals the catalog's Biome version", () => {
  const schema: string | undefined = json('biome.json').$schema;
  assert.ok(schema, 'biome.json needs a $schema');
  const version = /schemas\/([^/]+)\/schema\.json$/.exec(schema)?.[1];
  const catalog = catalogVersion('@biomejs/biome').replace(/^[\^~]/, '');
  assert.equal(
    version,
    catalog,
    `bump biome.json $schema to .../schemas/${catalog}/schema.json with the catalog`,
  );
});

test('vitest is an exact pin in the catalog', () => {
  const version = catalogVersion('vitest');
  assert.match(
    version,
    /^\d+\.\d+\.\d+$/,
    `vitest is ${version} in pnpm-workspace.yaml: pin an exact version (no ^ or ~), see the testing skill`,
  );
});

test('every vitest config that uses the Workers pool plugin turns the module cache off', () => {
  const configs = files.filter((f) => /(^|\/)vitest\.config\.[cm]?[jt]s$/.test(f));
  const workerd = configs.filter((f) => read(f).includes('@cloudflare/vitest-plugin'));
  assert.ok(
    workerd.length >= 8,
    'found too few workerd vitest configs: is the import check broken?',
  );
  for (const path of workerd) {
    assert.match(
      read(path),
      /fsModuleCache:\s*false/,
      `${path} imports @cloudflare/vitest-plugin and must set fsModuleCache: false (parallel workerd suites share one module cache)`,
    );
  }
});

// The content Workers type their runtime from @cloudflare/workers-types, with no generated file.
const WORKERS_TYPES = ['apps/api', 'apps/delivery', 'apps/media', 'apps/pipeline'];

test("every worker-configuration.d.ts names the lockfile's workerd version", () => {
  const lock = read('pnpm-lock.yaml');
  const versions = new Set([...lock.matchAll(/^ {2}workerd@(\S+?):$/gm)].map((m) => m[1]));
  assert.equal(
    versions.size,
    1,
    `pnpm-lock.yaml holds workerd ${[...versions].join(', ')}: expected one version`,
  );
  const [workerd] = versions;

  const generated = named('worker-configuration.d.ts');
  assert.ok(generated.length >= 8, 'found too few worker-configuration.d.ts files');
  for (const path of generated) {
    const app = dirname(path);
    assert.ok(
      !WORKERS_TYPES.includes(app),
      `${app} types its runtime from @cloudflare/workers-types: delete ${path} or drop it from WORKERS_TYPES`,
    );
    const header = /Runtime types generated with workerd@(\S+)/.exec(read(path))?.[1];
    assert.equal(
      header,
      workerd,
      `${path} was generated with workerd ${header} but the lockfile has ${workerd}: run \`pnpm --filter <that package> types\``,
    );
  }
});
