import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Every external dependency version lives in one place: the `catalog:` in pnpm-workspace.yaml
// (https://pnpm.io/catalogs). A package.json names its dependencies `catalog:` (external) or
// `workspace:` (our own packages), never a version of its own, so a bump is one line and two
// packages can never drift onto different versions of the same library. peerDependencies are
// the exception: they state the range a consumer may bring, deliberately broader than ours.
//
// To add a dependency: add `name: version` to the catalog (in the group it belongs to), then
// `"name": "catalog:"` in the package.json. `catalogMode: strict` makes `pnpm add` hold to it.

const root = join(import.meta.dirname, '..');
const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');

/** The default catalog's entries, read from pnpm-workspace.yaml's top-level `catalog:` map. */
function catalogEntries(): Map<string, string> {
  const entries = new Map<string, string>();
  let inside = false;
  for (const line of workspace.split('\n')) {
    if (/^catalog:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\S/.test(line)) break; // the next top-level key
    const m = line.match(/^\s+(["']?)([^"'#:\s][^"']*?)\1:\s*(\S+)\s*(#.*)?$/);
    if (m?.[2] && m[3]) entries.set(m[2], m[3]);
  }
  return entries;
}

/** Every workspace package.json, found from pnpm-workspace.yaml's globs (`dir/*` only). */
function manifests(): string[] {
  const globs = [...workspace.matchAll(/^\s+-\s+["']?([^"'\n]+)\/\*["']?\s*$/gm)].map(
    (m) => m[1] ?? '',
  );
  const files = [join(root, 'package.json')];
  for (const dir of globs) {
    for (const name of readdirSync(join(root, dir))) {
      const file = join(root, dir, name, 'package.json');
      try {
        if (statSync(file).isFile()) files.push(file);
      } catch {}
    }
  }
  return files;
}

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const catalog = catalogEntries();

test('pnpm-workspace.yaml has a non-empty catalog in strict mode', () => {
  assert.ok(catalog.size > 0, 'no catalog: entries found in pnpm-workspace.yaml');
  assert.match(workspace, /^catalogMode:\s*strict\s*$/m);
});

test('every dependency comes from the catalog or the workspace', () => {
  const stray: string[] = [];
  const missing: string[] = [];
  for (const file of manifests()) {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    const rel = file.slice(root.length + 1);
    for (const section of SECTIONS) {
      for (const [name, spec] of Object.entries<string>(pkg[section] ?? {})) {
        if (spec.startsWith('workspace:')) continue;
        if (spec !== 'catalog:') stray.push(`${rel} ${section}.${name} = "${spec}"`);
        else if (!catalog.has(name)) missing.push(`${rel} ${section}.${name}`);
      }
    }
  }
  assert.deepEqual(
    stray,
    [],
    'Move these versions into the catalog in pnpm-workspace.yaml and use "catalog:"',
  );
  assert.deepEqual(missing, [], 'These say "catalog:" but the catalog has no entry for them');
});

test('every catalog entry is used by some package', () => {
  const used = new Set<string>();
  for (const file of manifests()) {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const section of SECTIONS) {
      for (const [name, spec] of Object.entries<string>(pkg[section] ?? {})) {
        if (spec === 'catalog:') used.add(name);
      }
    }
  }
  const unused = [...catalog.keys()].filter((name) => !used.has(name));
  assert.deepEqual(unused, [], 'Remove these unused entries from the catalog');
});
