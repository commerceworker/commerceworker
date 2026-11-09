/**
 * Writes the content API's OpenAPI document to src/generated/content-openapi.json, for the explorer
 * at /content/api/ and the endpoint index on /content/reference/rest-api/.
 *
 * The document is the one every deployment serves at GET /openapi.json: the API app is built on
 * its in-memory wiring (no database, cache or AI provider) with every module mounted, and the spec
 * is generated from the routes it actually registers. So the reference matches the code at this
 * commit and cannot drift from it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The in-memory wiring is chosen by the absence of a D1 binding, which a Node script never has;
// clear the provider switches a developer's shell might carry so the spec is the plain default.
for (const key of [
  'AI_PROVIDER',
  'EMBEDDINGS_PROVIDER',
  'AGENT_RUNTIME',
  'OAUTH_ISSUER',
  'OIDC_ISSUER',
]) {
  delete process.env[key];
}

const { createApp } = await import('@commerceworker/http/api/app');
// The in-memory wiring the API's own tests use; the Workers' composition root needs bindings.
const { wire } = await import('@commerceworker/http/api/in-memory');
const { loadConfig } = await import('@commerceworker/platform/config');

const config = loadConfig({
  ROLE: 'all',
  CMA_KEY: 'docs-cma',
  CDA_KEY: 'docs-cda',
  CPA_KEY: 'docs-cpa',
  ADMIN_TOKEN: 'docs-admin',
  SEED_SPACE_ID: 'docs',
} as NodeJS.ProcessEnv);

const wired = wire(config);
const { ctx, rag, blob, ai, bus } = wired;
const app = createApp(ctx, config, rag, blob, ai, wired, bus);
const res = await app.request('/openapi.json');
if (!res.ok) throw new Error(`GET /openapi.json answered ${res.status}`);
const spec = (await res.json()) as { paths?: Record<string, unknown> };
const count = Object.keys(spec.paths ?? {}).length;
if (count < 50)
  throw new Error(`The OpenAPI document has only ${count} paths; expected the full API`);

const out = fileURLToPath(new URL('../src/generated/content-openapi.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../src/generated/', import.meta.url)), { recursive: true });
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`openapi: ${count} paths → src/generated/content-openapi.json`);
// The in-memory wiring may hold timers (rate limiters, schedulers); the document is written.
process.exit(0);
