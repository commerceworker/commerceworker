import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { type AppContext, runAssetZip } from '@commerceworker/application';
import type {
  AssetZipParams,
  AssetZipStarter,
  BlobStore,
  WorkflowSteps,
} from '@commerceworker/ports';
import { WORKFLOW_INSTANCE_EXISTS } from './asset-ingest';

/** The slice of the Workflows binding the starter uses. */
export type AssetZipWorkflowBinding = Pick<Workflow<AssetZipParams>, 'createBatch'>;

/**
 * The AssetZipStarter port over the `ASSET_ZIP_WF` binding: one instance per zip job, under the
 * job's id, so a redelivered `asset_zip.requested` finds the run that exists (`false`) rather
 * than starting a second. Any other error throws, and the event is retried.
 */
export class CloudflareAssetZipStarter implements AssetZipStarter {
  constructor(private readonly wf: AssetZipWorkflowBinding) {}

  async start(params: AssetZipParams): Promise<boolean> {
    const { created, errors } = await this.wf.createBatch({
      instances: [{ id: `zip-${params.jobId}`, params }],
    });
    if (created.length > 0) return true;
    const [error] = errors;
    if (error?.code === WORKFLOW_INSTANCE_EXISTS) return false;
    throw new Error(
      `Workflows did not start zip ${params.jobId}: ${error ? `${error.code} ${error.message}` : 'no result'}`,
    );
  }
}

/** What one zip invocation needs, opened per invocation and closed after it. */
export interface AssetZipHostDeps {
  readonly ctx: AppContext;
  readonly blob: BlobStore;
  close(): Promise<void>;
}

/**
 * The durable host for zip downloads: one Workflows instance per job. It hands Cloudflare's
 * `WorkflowStep` to `runAssetZip`, which owns every step; this class only binds the ports, so the
 * engine's class (D1, R2) and the workerd test fixture (fakes) share this body.
 */
export abstract class AssetZipWorkflowBase<Env = unknown> extends WorkflowEntrypoint<
  Env,
  AssetZipParams
> {
  protected abstract open(): AssetZipHostDeps | Promise<AssetZipHostDeps>;

  override async run(event: Readonly<WorkflowEvent<AssetZipParams>>, step: WorkflowStep) {
    const host = await this.open();
    try {
      return await runAssetZip(
        step as unknown as WorkflowSteps,
        host.ctx,
        host.blob,
        event.payload,
      );
    } finally {
      await host.close();
    }
  }
}
