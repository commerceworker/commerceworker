import {
  type EditorialHostDeps,
  EditorialWorkflowBase,
} from '@commerceworker/platform/editorial-host';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { wireEdge } from '@commerceworker/platform/wire';

/**
 * Editorial workflow runs on Cloudflare Workflows (binding `EDITORIAL_WF`). Each invocation wires
 * exactly as a request does (`wireEdge`): the D1 store, AI provider and AI context
 * (with the fake-adapter guard), the CostGuard, plugin hooks, Email Sending and the webhook
 * sender. Without a database it falls back to the isolate's in-memory demo store, which is only
 * shared with the API when the instance runs in the same isolate.
 *
 * This class is a composition-root export, deployed by the engine Worker (apps/pipeline).
 */
export class EditorialWorkflow extends EditorialWorkflowBase<EdgeEnv> {
  protected override open(): EditorialHostDeps {
    const wired = wireEdge(this.env);
    if (!wired.workflowEngine) {
      void wired.close();
      throw new Error('EditorialWorkflow runs need the EDITORIAL_WF binding in this environment');
    }
    return {
      ctx: wired.ctx,
      engine: wired.workflowEngine,
      nodes: wired.workflowNodes,
      close: () => wired.close(),
    };
  }
}
