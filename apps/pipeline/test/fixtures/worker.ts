// Test-only worker entry: exports the Durable Object classes under test with a
// minimal fetch handler, so the vitest-pool-workers runtime can bind them
// without pulling src/index.ts's full adapter graph into the test bundle. Its
// fetch handler is the api's forward to the assistant, so the socket tests go
// through the same gate a deployment does.
import { isAssistantPath, routeAssistant } from '@commerceworker/http/assistant/gate';
import type { EdgeEnv } from '@commerceworker/platform/env';

export { CostGuardDO } from '@commerceworker/platform/do/cost-guard';
export { LiveHubDO } from '@commerceworker/platform/do/live-hub';
export { RateLimiterDO } from '@commerceworker/platform/do/rate-limiter';
export { SearchShardDO } from '@commerceworker/platform/do/search-shard';
export { AssistantAgent } from '../../src/assistant';
export { AssetIngestTestWorkflow } from './asset-ingest';
export { AssetZipTestWorkflow } from './asset-zip';
export { EditorialTestWorkflow } from './editorial';

export default {
  fetch(request: Request, env: EdgeEnv): Promise<Response> | Response {
    if (isAssistantPath(new URL(request.url).pathname)) return routeAssistant(request, env);
    return new Response('test fixture');
  },
};
