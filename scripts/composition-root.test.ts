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

// The web app follows the same rule: its composition root is apps/web/app/lib/wire.server.ts, the
// one web file that imports the D1 adapters (`@commerceworker/db` or a subpath), calls `createDb` or
// touches the `DB` binding. Everything else asks the root for a port.
const WEB = 'apps/web/app';
const WEB_ROOT = join(WEB, 'lib/wire.server.ts');
const WEB_D1 = (src: string) =>
  D1_ADAPTERS.test(src) || /\bcreateDb\(|\bdb\(\)/.test(src) || D1_BINDING.test(src);

test('the web app reaches D1 only through its composition root', () => {
  const reaching = files(WEB)
    .filter((f) => f !== WEB_ROOT)
    .filter((f) => WEB_D1(readFileSync(f, 'utf8')));
  assert.deepEqual(
    reaching,
    [],
    `Reach D1 through a port bound in apps/web/app/lib/wire.server.ts:\n${reaching.join('\n')}`,
  );
});

test('the web composition root does bind the D1 adapters', () => {
  assert.match(readFileSync(WEB_ROOT, 'utf8'), D1_ADAPTERS);
});
