import type {
  Activities,
  AgentRunResult,
  AgentRuntime,
  WorkflowInput,
  WorkflowName,
} from './types';
import { curateWorkflow, enrichWorkflow, moderateWorkflow, repurposeWorkflow } from './workflows';

/**
 * Runs workflows directly in the calling process — the executor for dev, tests,
 * demo mode, and synchronous on-demand agent actions. It is NOT durable (no
 * replay across crashes); for durability the same workflows run on Cloudflare
 * Workflows (apps/pipeline/src/workflows/agent-workflow.ts), whose runtime implements this identical
 * `AgentRuntime` interface and wraps each `Activities` method in a `step.do`.
 */
export class InProcessAgentRuntime implements AgentRuntime {
  constructor(private readonly activities: Activities) {}

  async run(workflow: WorkflowName, input: WorkflowInput): Promise<AgentRunResult> {
    switch (workflow) {
      case 'enrich':
        return enrichWorkflow(this.activities, input);
      case 'moderate':
        return moderateWorkflow(this.activities, input);
      case 'curate':
        return curateWorkflow(this.activities, input);
      case 'repurpose':
        return repurposeWorkflow(this.activities, input);
      case 'review':
        // The watcher is only started via watchReview on durable runtimes;
        // in-process decisions apply through the direct path instead.
        throw new Error('the review watcher runs only on durable runtimes');
    }
  }
}
