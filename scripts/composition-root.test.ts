import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

// The engine reaches its D1 database only through the ports, bound in one composition root:
// apps/engine/src/wire.ts (AGENTS.md, "Converging on a hexagonal layout"). Every other engine
// file asks wire.ts for a port; none imports the D1 adapters (`@commerceworker/db` or a subpath)
// or uses the `DB` binding itself. A new storage need is a port method, its D1 and in-memory
// stores, and their contract, not a query in a node, an agent or a route.
const ROOT = 'apps/engine/src';
const COMPOSITION_ROOT = join(ROOT, 'wire.ts');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const D1_ADAPTERS = /from '@commerceworker\/db(?:\/[\w-]+)?'/;
const D1_BINDING = /\benv\.DB\b/;

test('only the composition root reaches D1 in the engine', () => {
  const reaching = files(ROOT)
    .filter((f) => f !== COMPOSITION_ROOT)
    .flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      const why = [
        ...(D1_ADAPTERS.test(src) ? ['imports @commerceworker/db'] : []),
        ...(D1_BINDING.test(src) ? ['uses env.DB'] : []),
      ];
      return why.length ? [`${relative('.', f)}: ${why.join(', ')}`] : [];
    });
  assert.deepEqual(
    reaching,
    [],
    `Reach D1 through a port bound in ${COMPOSITION_ROOT}:\n${reaching.join('\n')}`,
  );
});

test('the composition root does bind the D1 adapters', () => {
  assert.match(readFileSync(COMPOSITION_ROOT, 'utf8'), D1_ADAPTERS);
});

// The web app is moving onto the same ports, slice by slice (ROADMAP, P1): its composition root is
// apps/web/app/lib/wire.server.ts. Files still reaching D1 themselves (through `@commerceworker/db`,
// `db()` from env.server.ts, or the `DB` binding) are listed here until they move. The list only
// shrinks: a new file can't reach D1, and a moved file must come off it.
const WEB = 'apps/web/app';
const WEB_ROOTS = new Set([join(WEB, 'lib/wire.server.ts'), join(WEB, 'lib/env.server.ts')]);
const WEB_PENDING = new Set([
  'apps/web/app/lib/api.server.ts',
]);
const WEB_D1 = (src: string) =>
  D1_ADAPTERS.test(src) || /\bdb\(\)/.test(src) || D1_BINDING.test(src);

test('the web app reaches D1 only through its composition root, apart from files still moving', () => {
  const reaching = files(WEB)
    .filter((f) => !WEB_ROOTS.has(f))
    .filter((f) => WEB_D1(readFileSync(f, 'utf8')));
  const unlisted = reaching.filter((f) => !WEB_PENDING.has(f));
  assert.deepEqual(
    unlisted,
    [],
    `Reach D1 through a port bound in apps/web/app/lib/wire.server.ts:\n${unlisted.join('\n')}`,
  );
  const moved = [...WEB_PENDING].filter((f) => !reaching.includes(f));
  assert.deepEqual(
    moved,
    [],
    `These no longer reach D1: take them off WEB_PENDING:\n${moved.join('\n')}`,
  );
});
