import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { deriveAssistantPrincipalKey } from '@commerceworker/security/assistant-key';
import agents from 'agents/vite';
import { defineConfig } from 'vitest/config';

// The principal key the assistant tests sign the web Worker's header with.
export const TEST_PRINCIPAL_KEY = 'engine-test-principal-key-0123456789abcdef';
// …and the one it replaced, mid-rotation: the engine holds both keys derived from them.
export const TEST_PRINCIPAL_KEY_PREVIOUS = 'engine-test-previous-principal-key-0123456789';

// Runs inside workerd so the Durable Objects and the editorial Workflow execute for real
// (storage, alarms, RPC, Miniflare's Workflows engine). The fixture worker exports only the
// classes under test. The assistant needs the content store and the web app's people, so a D1
// with every migration applied (test/setup.ts) is bound too.
export default defineConfig(async () => ({
  test: {
    name: 'workers',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // The Workers pool answers a file's whole warm-module snapshot as ONE WebSocket message, with
    // every cached transform inlined (twice: a module is keyed by url and by id). This suite's
    // graph (the assistant pulls in `ai`, the MCP SDK, `agents`, the embedded docs) is already
    // ~33.4 MB of that, and the runtime closes the socket at 32 MiB (33,554,432 bytes): the first
    // file of a run passes on a cold cache, every later one dies with "Worker exited unexpectedly".
    // Without the filesystem cache there is no snapshot; modules are fetched one at a time.
    fsModuleCache: false,
  },
  plugins: [
    // TC39 decorators (`@callable()` on the assistant), which Vite's Oxc transform doesn't lower.
    ...agents(),
    cloudflareTest({
      main: './test/fixtures/worker.ts',
      miniflare: {
        // Production's date (apps/pipeline/wrangler.jsonc).
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
        // No `workerLoaders` binding, though the compatibility date now allows
        // one. The pool proxies bindings into the test isolate, and an
        // entrypoint to a dynamically-loaded worker cannot cross a Worker
        // boundary — "the system does not know how to reload this Worker from
        // scratch". Loading from the fixture worker's own handler does not help,
        // because that handler is reached through the same proxy. So the plugin
        // sandbox's isolation properties stay verified against a real
        // `wrangler dev` worker by hand, and the adapter's unit tests pin the
        // configuration it asks for. Revisit when the pool exposes an
        // in-isolate binding.
        durableObjects: {
          LIVE_HUB: 'LiveHubDO',
          AUTH_LIMITER: 'RateLimiterDO',
          AI_BUDGET: 'CostGuardDO',
          SEARCH: { className: 'SearchShardDO', useSQLite: true },
          ASSISTANT_AGENT: { className: 'AssistantAgent', useSQLite: true },
        },
        d1Databases: { DB: 'commerceworker-pipeline-test' },
        // The media gate the events consumer writes (test/asset-delivery.test.ts).
        kvNamespaces: ['KV_CACHE'],
        // The zip Workflow's files and archive (a real multipart upload).
        r2Buckets: ['MEDIA_BUCKET'],
        // The editorial workflow host, run by miniflare's real Workflows engine over the
        // fixture's in-memory context (test/fixtures/editorial.ts).
        workflows: {
          EDITORIAL_WF: {
            name: 'commerceworker-editorial-test',
            className: 'EditorialTestWorkflow',
          },
          // Asset ingest over fakes for the bytes, Images, extraction and the model
          // (test/fixtures/asset-ingest.ts).
          ASSET_INGEST_WF: {
            name: 'commerceworker-asset-ingest-test',
            className: 'AssetIngestTestWorkflow',
          },
          // Zip downloads over the test's store and the real R2 binding (test/fixtures/asset-zip.ts).
          ASSET_ZIP_WF: {
            name: 'commerceworker-asset-zip-test',
            className: 'AssetZipTestWorkflow',
          },
        },
        bindings: {
          AUTH_RATE_LIMIT_MAX: '3',
          AUTH_RATE_LIMIT_WINDOW_MS: '3000',
          AI_MAX_REQUESTS_PER_WINDOW: '2',
          AI_MAX_TOKENS_PER_WINDOW: '100',
          // Wide enough that a test's sequential RPCs can't straddle a
          // window roll on a slow runner; only the lapse test sleeps it out.
          AI_BUDGET_WINDOW_SECONDS: '2',
          // Background (`agent:`) windows enforce the stricter agent ceiling.
          AI_AGENT_MAX_REQUESTS_PER_WINDOW: '1',
          TEST_MIGRATIONS: await readD1Migrations('../../packages/store/migrations'),
          // The assistant: the web Worker's key, the mock model, and the dev fallbacks a
          // persistent (D1-backed) wiring otherwise refuses.
          PRINCIPAL_KEY: TEST_PRINCIPAL_KEY,
          PRINCIPAL_KEY_PREVIOUS: TEST_PRINCIPAL_KEY_PREVIOUS,
          ASSISTANT_PRINCIPAL_KEY: await deriveAssistantPrincipalKey(TEST_PRINCIPAL_KEY),
          ASSISTANT_PRINCIPAL_KEY_PREVIOUS: await deriveAssistantPrincipalKey(
            TEST_PRINCIPAL_KEY_PREVIOUS,
          ),
          AI_MODE: 'mock',
          REQUIRE_SECURE_SECRETS: 'false',
          ALLOW_FAKE_ADAPTERS: 'all',
          EMBEDDINGS_PROVIDER: 'local',
        },
      },
    }),
  ],
}));
