import type { CostGuardDO } from '@commerceworker/platform/do/cost-guard';
import type { LiveHubDO } from '@commerceworker/platform/do/live-hub';
import type { RateLimiterDO } from '@commerceworker/platform/do/rate-limiter';
import type { SearchShardDO } from '@commerceworker/platform/do/search-shard';
import type { AssistantAgent } from '../src/assistant';

// Bindings provided by vitest.config.ts (miniflare section), typed as
// required — unlike EdgeEnv, where every binding is optional.
//
// Augments `Cloudflare.Env` rather than the pool's old `ProvidedEnv`: the newer
// pool types `env` as the same global namespace wrangler generates, so test and
// production bindings are described in one place instead of two that can drift.
declare global {
  namespace Cloudflare {
    interface Env {
      readonly LIVE_HUB: DurableObjectNamespace<LiveHubDO>;
      readonly AUTH_LIMITER: DurableObjectNamespace<RateLimiterDO>;
      readonly AI_BUDGET: DurableObjectNamespace<CostGuardDO>;
      readonly SEARCH: DurableObjectNamespace<SearchShardDO>;
      readonly EDITORIAL_WF: Workflow;
      readonly ASSET_INGEST_WF: Workflow;
      readonly ASSET_ZIP_WF: Workflow;
      readonly MEDIA_BUCKET: R2Bucket;
      readonly ASSISTANT_AGENT: DurableObjectNamespace<AssistantAgent>;
      readonly DB: D1Database;
      readonly KV_CACHE: KVNamespace;
      readonly PRINCIPAL_KEY: string;
      readonly PRINCIPAL_KEY_PREVIOUS: string;
      readonly ASSISTANT_PRINCIPAL_KEY: string;
      readonly ASSISTANT_PRINCIPAL_KEY_PREVIOUS: string;
    }
  }
}
