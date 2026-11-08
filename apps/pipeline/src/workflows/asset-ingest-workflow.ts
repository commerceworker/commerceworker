import {
  type AssetIngestHostDeps,
  AssetIngestWorkflowBase,
} from '@commerceworker/platform/asset-ingest';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { makeAssetIngestDeps, wireEdge } from '@commerceworker/platform/wire';

/**
 * Asset ingest on Cloudflare Workflows (binding `ASSET_INGEST_WF`): one instance per file version,
 * started by the engine's asset-events consumer. Each invocation wires as a request does
 * (`wireEdge`), so the store, the AI budget and the fake-adapter guard are the ones every other
 * caller gets; `makeAssetIngestDeps` adds what ingest reads (R2, the Images binding, Workers AI's
 * conversion and transcription, the asset search indexes).
 *
 * This class is a composition-root export, deployed by the engine Worker (apps/pipeline).
 */
export class AssetIngestWorkflow extends AssetIngestWorkflowBase<EdgeEnv> {
  protected override open(): AssetIngestHostDeps {
    const wired = wireEdge(this.env);
    return {
      ctx: wired.ctx,
      deps: makeAssetIngestDeps(this.env, wired),
      close: () => wired.close(),
    };
  }
}
