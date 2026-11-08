import type { AppContext } from '@commerceworker/application';
import {
  type EditorialHostDeps,
  EditorialWorkflowBase,
} from '@commerceworker/platform/editorial-host';
import { CloudflareWorkflowEngine } from '@commerceworker/platform/workflows';

/**
 * The context the test's Workflow instances run against. The production `EditorialWorkflow`
 * wires the D1 store through `wireEdge`; this fixture shares the test's in-memory store instead
 * (instances run in the test worker's isolate), so a test seeds a run and then watches the real
 * Workflows engine execute it.
 */
export const editorialTestState: { ctx?: AppContext } = {};

export class EditorialTestWorkflow extends EditorialWorkflowBase<Cloudflare.Env> {
  protected override open(): EditorialHostDeps {
    const ctx = editorialTestState.ctx;
    if (!ctx) throw new Error('editorialTestState.ctx is not set');
    return {
      ctx,
      engine: new CloudflareWorkflowEngine(this.env.EDITORIAL_WF),
      nodes: {},
      close: async () => {},
    };
  }
}
