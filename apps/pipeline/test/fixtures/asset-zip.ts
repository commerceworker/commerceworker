import type { AppContext } from '@commerceworker/application';
import { type AssetZipHostDeps, AssetZipWorkflowBase } from '@commerceworker/platform/asset-zip';
import type { BlobStore } from '@commerceworker/ports';

/**
 * What the test's zip instances run against: the test's in-memory store, and the blob store the
 * test builds over the real (Miniflare) R2 binding, so the archive is a real R2 multipart upload.
 */
export const assetZipTestState: { ctx?: AppContext; blob?: BlobStore } = {};

export class AssetZipTestWorkflow extends AssetZipWorkflowBase<Cloudflare.Env> {
  protected override open(): AssetZipHostDeps {
    const { ctx, blob } = assetZipTestState;
    if (!ctx || !blob) throw new Error('assetZipTestState is not set');
    return { ctx, blob, close: async () => {} };
  }
}
