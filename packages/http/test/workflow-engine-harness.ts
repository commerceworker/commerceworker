import { makeGraphActivities, runGraph } from '@commerceworker/agent-runtime';
import type { AppContext, WorkflowNodeDeps } from '@commerceworker/application';
import type { WorkflowRunParams } from '@commerceworker/domain';
import { FakeWorkflowSteps, RecordingWorkflowEngine } from '@commerceworker/test-kit';

/**
 * A Cloudflare-Workflows stand-in for the API and MCP suites: every started instance gets its own
 * `FakeWorkflowSteps`, `sendEvent` lands in that instance's inbox, and `drive` runs one pass of the
 * real interpreter over it against the suite's store. Run `drive` again after a decision or an
 * event and finished steps replay, as on Workflows.
 */
export function makeTestWorkflowEngine(ctx: AppContext, nodes: WorkflowNodeDeps = {}) {
  const instances = new Map<string, { steps: FakeWorkflowSteps; params: WorkflowRunParams }>();
  const engine = new RecordingWorkflowEngine({
    onStart: async (id, params) => {
      instances.set(id, { steps: new FakeWorkflowSteps(ctx.clock), params });
    },
    onEvent: async (id, type, payload) => {
      instances.get(id)?.steps.sendEvent(type, payload);
    },
  });
  const act = makeGraphActivities({ ctx, engine, nodes });
  const drive = async (instanceId: string) => {
    const inst = instances.get(instanceId);
    if (!inst) throw new Error(`No instance ${instanceId}`);
    return inst.steps.run(() => runGraph(inst.steps, act, inst.params));
  };
  return { engine, instances, drive };
}
