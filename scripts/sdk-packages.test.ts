// The SDK's npm manifest: what `pnpm pack` publishes (scripts/sdk-packages.ts). Runs in CI with
// `node --test scripts/*.test.ts`; the pack-and-load check runs in CI's `sdk` job (.github/workflows/ci.yml).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { sdkManifests } from './sdk-packages.ts';

const root = new URL('..', import.meta.url).pathname;

test('@commerceworker/sdk is the one published package: its dist/, with an export map mirroring the workspace one', () => {
  const sdks = sdkManifests();
  assert.deepEqual(
    sdks.map(({ manifest }) => manifest.name),
    ['@commerceworker/sdk'],
    'one published package',
  );
  for (const { dir, manifest } of sdks) {
    const m = manifest as typeof manifest & {
      exports: Record<string, { default: string }>;
      files?: string[];
      repository?: { directory?: string };
      publishConfig?: {
        access?: string;
        provenance?: boolean;
        exports?: Record<string, { import: string; types: string }>;
      };
    };
    assert.deepEqual(m.files, ['dist', 'README.md'], `${m.name}: files`);
    assert.ok(existsSync(join(dir, 'README.md')), `${m.name}: README`);
    assert.equal(m.publishConfig?.access, 'public', `${m.name}: public`);
    assert.equal(m.publishConfig?.provenance, true, `${m.name}: provenance`);
    assert.equal(m.repository?.directory, relative(root, dir), `${m.name}: repository.directory`);
    assert.deepEqual(
      Object.keys(m.publishConfig?.exports ?? {}),
      Object.keys(m.exports),
      `${m.name}: same subpaths published`,
    );
    for (const [sub, src] of Object.entries(m.exports)) {
      const base = src.default.replace(/^\.\/src\//, '').replace(/\.ts$/, '');
      assert.equal(
        m.publishConfig?.exports?.[sub]?.import,
        `./dist/${base}.js`,
        `${m.name} ${sub}: import`,
      );
      assert.equal(
        m.publishConfig?.exports?.[sub]?.types,
        `./dist/${base}.d.ts`,
        `${m.name} ${sub}: types`,
      );
    }
  }
});

test('the workspace SDKs and the CLI stay private: they ship inside @commerceworker/sdk', () => {
  const base = join(root, 'packages/sdk');
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'sdk')
    .map((d) => join(base, d.name));
  assert.ok(dirs.length >= 8, 'found the workspace SDKs');
  for (const dir of [...dirs, join(root, 'packages/cli')]) {
    const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      private?: boolean;
      publishConfig?: unknown;
    };
    assert.equal(m.private, true, `${m.name} is bundled into @commerceworker/sdk, never published`);
    assert.equal(m.publishConfig, undefined, `${m.name} has no publishConfig`);
  }
});

test('every workspace SDK module and the CLI is reachable from @commerceworker/sdk', () => {
  const sdk = JSON.parse(readFileSync(join(root, 'packages/sdk/sdk/package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
    bin: Record<string, string>;
  };
  const base = join(root, 'packages/sdk');
  for (const d of readdirSync(base).filter((n) => n !== 'sdk')) {
    const m = JSON.parse(readFileSync(join(base, d, 'package.json'), 'utf8')) as { name: string };
    assert.equal(sdk.devDependencies[m.name], 'workspace:*', `${m.name} is bundled`);
  }
  assert.equal(sdk.devDependencies['@commerceworker/cli'], 'workspace:*', 'the CLI is bundled');
  assert.deepEqual(Object.keys(sdk.bin), ['commerceworker'], 'the commerceworker binary');
});
