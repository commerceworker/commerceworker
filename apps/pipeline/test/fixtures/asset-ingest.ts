import type { AppContext, AssetIngestDeps } from '@commerceworker/application';
import {
  type AssetIngestHostDeps,
  AssetIngestWorkflowBase,
} from '@commerceworker/platform/asset-ingest';

/**
 * What the test's ingest instances run against. The production `AssetIngestWorkflow` wires D1, R2,
 * the Images binding and Workers AI through `wireEdge`; this fixture hands the run the test's
 * in-memory store and fakes for the bytes, the image probe, extraction, the model and search
 * (instances run in the test worker's isolate), so a test seeds an asset and watches the real
 * Workflows engine ingest it.
 */
export const assetIngestTestState: { ctx?: AppContext; deps?: AssetIngestDeps } = {};

export class AssetIngestTestWorkflow extends AssetIngestWorkflowBase<Cloudflare.Env> {
  protected override open(): AssetIngestHostDeps {
    const { ctx, deps } = assetIngestTestState;
    if (!ctx || !deps) throw new Error('assetIngestTestState is not set');
    return { ctx, deps, close: async () => {} };
  }
}
