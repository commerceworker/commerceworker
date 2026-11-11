#!/usr/bin/env node
/**
 * The type declarations for @commerceworker/sdk. TypeScript 7 has no compiler API, so no .d.ts
 * bundler can run; instead each workspace SDK emits its own declarations with `tsc` (their
 * `build`, which turbo runs first), and this copies them into dist/types/<package>/, rewrites any
 * `@commerceworker/sdk-*` import inside them to a relative path, and writes one dist/<entry>.d.ts
 * per subpath. Users only ever see @commerceworker/sdk.
 */
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

const pkg = new URL('..', import.meta.url).pathname;
const sdkDir = join(pkg, '..');
const dist = join(pkg, 'dist');
const types = join(dist, 'types');

/** Workspace package → its folder under packages/sdk. */
const PACKAGES: Record<string, string> = {
  '@commerceworker/sdk-core': 'core',
  '@commerceworker/sdk-rich-text': 'rich-text',
  '@commerceworker/sdk-edge': 'edge',
  '@commerceworker/sdk-management': 'management',
  '@commerceworker/sdk-commerce': 'commerce',
  '@commerceworker/sdk-catalog': 'catalog',
  '@commerceworker/sdk-web': 'web',
  '@commerceworker/sdk-vue': 'vue',
  '@commerceworker/sdk-react-native': 'react-native',
  '@commerceworker/sdk-codegen': 'codegen',
};

/** Each published subpath and the workspace module it re-exports. */
const ENTRIES: Record<string, string> = {
  index: '@commerceworker/sdk-core',
  'inline-edit': '@commerceworker/sdk-core/inline-edit',
  redirects: '@commerceworker/sdk-core/redirects',
  webhooks: '@commerceworker/sdk-core/webhooks',
  'rich-text': '@commerceworker/sdk-rich-text',
  edge: '@commerceworker/sdk-edge',
  management: '@commerceworker/sdk-management',
  catalog: '@commerceworker/sdk-catalog',
  commerce: '@commerceworker/sdk-commerce',
  'commerce-webhooks': '@commerceworker/sdk-commerce/webhooks',
  react: '@commerceworker/sdk-web',
  vue: '@commerceworker/sdk-vue',
  'react-native': '@commerceworker/sdk-react-native',
  codegen: '@commerceworker/sdk-codegen',
};

/** `@commerceworker/sdk-core/webhooks` → dist/types/core/webhooks.d.ts (as a `.js` specifier). */
function target(spec: string): string {
  const name = Object.keys(PACKAGES).find((n) => spec === n || spec.startsWith(`${n}/`));
  if (!name) throw new Error(`no workspace package for ${spec}`);
  const sub = spec.slice(name.length).replace(/^\//, '') || 'index';
  return join(types, PACKAGES[name] ?? '', `${sub}.js`);
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith('.d.ts')) yield path;
  }
}

const specifier = (from: string, to: string) => {
  const rel = relative(dirname(from), to);
  return rel.startsWith('.') ? rel : `./${rel}`;
};

rmSync(types, { recursive: true, force: true });
for (const [name, dir] of Object.entries(PACKAGES)) {
  const src = join(sdkDir, dir, 'dist');
  if (!existsSync(join(src, 'index.d.ts')))
    throw new Error(`${name} has no dist/index.d.ts: build it first`);
  cpSync(src, join(types, dir), {
    recursive: true,
    filter: (p) => statSync(p).isDirectory() || p.endsWith('.d.ts'),
  });
}

// Inside the copied declarations, imports of other workspace SDKs become relative paths.
let rewrites = 0;
for (const file of walk(types)) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(
    /(['"])(@commerceworker\/sdk-[a-z-]+(?:\/[a-z-]+)?)\1/g,
    (_m, q: string, spec: string) => {
      rewrites += 1;
      return `${q}${specifier(file, target(spec))}${q}`;
    },
  );
  if (after !== before) writeFileSync(file, after);
}

for (const [entry, spec] of Object.entries(ENTRIES)) {
  const file = join(dist, `${entry}.d.ts`);
  writeFileSync(file, `export * from '${specifier(file, target(spec))}';\n`);
}

const leftover = [...walk(dist)].filter((f) =>
  /['"]@commerceworker\/sdk-/.test(readFileSync(f, 'utf8')),
);
if (leftover.length) throw new Error(`unresolved workspace imports in: ${leftover.join(', ')}`);
console.log(
  `types: ${Object.keys(ENTRIES).length} entries, ${Object.keys(PACKAGES).length} packages, ${rewrites} imports rewritten`,
);
