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

// The catalog's read edge is bound there too: UCP reads published documents through the
// `CATALOG_EDGE` service binding, wrapped by the `catalog-edge` adapter in wire.ts. Nothing else in
// the engine fetches the edge itself or imports the adapter, so every read is the adapter's
// canonical, encoded URL, and the capability and channel checks sit in front of it.
const EDGE_ADAPTER = /from '@commerceworker\/adapters\/catalog-edge'/;
const EDGE_BINDING = /\benv\.CATALOG_EDGE\b/;

test('only the composition root binds the catalog edge in the engine', () => {
  const reaching = files(ROOT)
    .filter((f) => f !== COMPOSITION_ROOT)
    .filter((f) => {
      const src = readFileSync(f, 'utf8');
      return EDGE_BINDING.test(src) || EDGE_ADAPTER.test(src);
    })
    .map((f) => relative('.', f));
  assert.deepEqual(reaching, [], `Read the edge through catalogReader() in ${COMPOSITION_ROOT}`);
});

// What the engine binds is `CatalogRead` (apps/delivery/src/catalog/read.ts): fetch only, public
// routes only. The engine must not depend on more than that, and the binding must not be widened.
test('the engine binds the catalog edge through the fetch-only entrypoint and never its index blobs or purge', () => {
  const wrangler = readFileSync('apps/engine/wrangler.jsonc', 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(
    wrangler,
    /"binding": "CATALOG_EDGE",\s*"service": "[^"]+",\s*"entrypoint": "CatalogRead"/,
  );
  const reaching = files(ROOT).filter((f) =>
    /\/_idx\/|CATALOG_EDGE[^;]{0,80}\.purge/.test(readFileSync(f, 'utf8')),
  );
  assert.deepEqual(
    reaching.map((f) => relative('.', f)),
    [],
  );
});

test('the composition root does bind the catalog edge', () => {
  const src = readFileSync(COMPOSITION_ROOT, 'utf8');
  assert.match(src, EDGE_ADAPTER);
  assert.match(src, EDGE_BINDING);
});

// Cloudflare adapters (Email Sending today) are bound there too: every other engine file takes the
// port (`emailSender` in wire.ts), so a send can be swapped for a fake and one place reads `EMAIL`.
const CF_ADAPTERS = /from '@commerceworker\/adapters(?:\/[\w-]+)?'/;

test('only the composition root binds a Cloudflare adapter in the engine', () => {
  const binding = files(ROOT)
    .filter((f) => f !== COMPOSITION_ROOT)
    .filter((f) => CF_ADAPTERS.test(readFileSync(f, 'utf8')))
    .map((f) => relative('.', f));
  assert.deepEqual(binding, [], `Take the port from ${COMPOSITION_ROOT}:\n${binding.join('\n')}`);
  assert.match(readFileSync(COMPOSITION_ROOT, 'utf8'), CF_ADAPTERS);
});

test('the engine reads the EMAIL binding only in the composition root', () => {
  const reading = files(ROOT)
    .filter((f) => f !== COMPOSITION_ROOT)
    .filter((f) => /\benv\.EMAIL\b/.test(readFileSync(f, 'utf8')))
    .map((f) => relative('.', f));
  assert.deepEqual(reading, []);
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

// The storefront has no composition root: it is public, so it binds no database and no bucket, and
// imports no store, adapter or use-case. What it needs from D1 or R2 (a platform's key, a customer's
// name, a cart's files) it asks the engine for, through `StorefrontRpc` (`StorefrontApi` in
// apps/engine/src/storefront-api.ts, which is bound in the engine's own composition root).
const STOREFRONT = 'apps/storefront';
const STOREFRONT_SOURCES = ['app', 'workers', 'tests', 'e2e'].flatMap((d) =>
  files(join(STOREFRONT, d)),
);
const STOREFRONT_DATA =
  /@commerceworker\/(?:db|ports|application|store|adapters|platform|test-kit)\b|\bcreateDb\(|\benv\.(?:DB|DOCS)\b|\bwire\.server\b/;

test('the storefront imports no @commerceworker/db and reaches no database or bucket', () => {
  const reaching = STOREFRONT_SOURCES.filter((f) =>
    STOREFRONT_DATA.test(readFileSync(f, 'utf8')),
  ).map((f) => relative('.', f));
  assert.deepEqual(
    reaching,
    [],
    `Ask the engine through StorefrontRpc (packages/core/src/api.ts) instead:\n${reaching.join('\n')}`,
  );
});

test('the storefront declares no data dependency and binds no database or bucket', () => {
  const pkg = JSON.parse(readFileSync(join(STOREFRONT, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(
    deps.filter((d) => /^@commerceworker\/(db|ports|application|store|adapters|platform)$/.test(d)),
    [],
  );
  const wrangler = readFileSync(join(STOREFRONT, 'wrangler.jsonc'), 'utf8').replace(
    /\/\/.*$/gm,
    '',
  );
  assert.doesNotMatch(wrangler, /d1_databases|r2_buckets|kv_namespaces|"queues"|durable_objects/);
  assert.match(wrangler, /"entrypoint": "StorefrontApi"/);
  assert.doesNotMatch(wrangler, /"entrypoint": "EngineApi"/);
});

// The HTTP surface (packages/http) is a library: it takes its adapters as deps and binds none.
// `wireEdge` and `platform/in-memory` build the import sources, the space export reader, the
// remote fetcher and the assistant's model, and `platform/media` the media routes' R2 transfers,
// Images transforms and Stream webhook check; the Workers' entries pass them in.
const HTTP = 'packages/http/src';
const ADAPTERS = /from '@commerceworker\/adapters(?:\/[\w-]+)?'/;

test('packages/http binds no adapters', () => {
  const binding = files(HTTP).filter((f) => ADAPTERS.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    binding,
    [],
    `Take the adapter as a dep, bound in packages/platform/src/wire.ts:\n${binding.join('\n')}`,
  );
});

// Nor does it read a binding or the process environment: the composition roots (`wireEdge`, the
// app entries, the Durable Object classes) read `env` and hand over what was read. `NODE_ENV` is
// not a binding but a build constant the bundler inlines, so reading it is allowed. The one
// exception is listed with its reason; keep this list empty if you can.
const ENV_READS = /\benv\.(?!NODE_ENV\b)[A-Z][A-Z0-9_]+\b|\bprocess\.env\b(?!\.NODE_ENV\b)/;
const ENV_EXCEPTIONS: Record<string, string> = {
  // The MCP tools default a call's space and environment to the seed's ids (SEED_SPACE_ID,
  // SEED_ENV_ID), as module constants that ~20 call sites share; threading them through
  // `McpDeps` is its own change.
  'packages/http/src/mcp/tools/shared.ts': 'SEED_SPACE_ID and SEED_ENV_ID defaults',
};

test('packages/http reads no binding and no process.env', () => {
  const reading = files(HTTP)
    .filter((f) => !(f in ENV_EXCEPTIONS))
    .filter((f) => ENV_READS.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    reading,
    [],
    `Take the value as an argument, read at the composition root (wireEdge or the app entry):\n${reading.join('\n')}`,
  );
});

test('every listed http env-read exception still reads one', () => {
  const stale = Object.keys(ENV_EXCEPTIONS).filter((f) => !ENV_READS.test(readFileSync(f, 'utf8')));
  assert.deepEqual(stale, [], `Remove from ENV_EXCEPTIONS:\n${stale.join('\n')}`);
});

// The pipeline Worker's files reach D1 and the in-memory fakes only through `wireEdge`: no D1
// store factory (`@commerceworker/store`, its `/auth` tables included) and no test-kit in
// production code. Its entry (src/index.ts) may bind the outbound-effects adapter it hands the
// consumers.
const PIPELINE = 'apps/pipeline/src';
const PIPELINE_BINDS = /from '@commerceworker\/(?:store(?:\/[\w-]+)?|test-kit)'|\.DB\b/;

test('the pipeline reaches stores only through wireEdge', () => {
  const reaching = files(PIPELINE).filter((f) => PIPELINE_BINDS.test(readFileSync(f, 'utf8')));
  assert.deepEqual(
    reaching,
    [],
    `Take the store or port from wireEdge (packages/platform/src/wire.ts):\n${reaching.join('\n')}`,
  );
});
