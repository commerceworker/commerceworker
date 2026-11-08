import type { DomainEvent } from '@commerceworker/domain';
import type { EventBus } from '@commerceworker/ports';
import {
  type AgentRunner,
  type PublishAgentRunSummary,
  type PublishAgentsConfig,
  runPublishAgents,
} from '../agent-actions';
import type { AppContext } from '../context';
import { liveEventOf } from '../delivery';
import { type DispatchDeps, dispatchEvent } from './dispatch';

export interface ConsumeDeps extends DispatchDeps {
  /** Optional — live-content fan-out (SSE). Publish failures never block dispatch. */
  readonly bus?: EventBus;
  /** Invoked when the best-effort live publish fails (for caller-side logging). */
  readonly onLiveError?: (err: unknown) => void;
  /** Optional — on-publish agents (enrich/moderate); both must be set to run them. */
  readonly agents?: AgentRunner;
  readonly agentConfig?: PublishAgentsConfig;
}

/**
 * Consumes one relayed domain event end-to-end: dispatch (webhooks, cache
 * invalidation, RAG, functions), best-effort live fan-out, then the configured
 * on-publish agents. This is the single consumer body shared by every queue
 * host (the Worker's Cloudflare queue handler; tests call it directly). A throw propagates to the
 * queue for retry/dead-letter. Delivery is at-least-once — relayOutbox claims
 * rows (a lease claim) so duplicates are rare, but consumers must tolerate
 * redelivery: webhook receivers dedupe on the event id, and agent runs are
 * recorded proposals, never direct state changes.
 */
export async function consumeEvent(
  ctx: AppContext,
  deps: ConsumeDeps,
  event: DomainEvent,
): Promise<PublishAgentRunSummary[]> {
  await dispatchEvent(ctx, deps, event);
  // An invitation belongs to no space, so no live subscriber could be told about it. A test event
  // is for one webhook alone (and only ever arrives inside a WebhookSendRequest).
  if (event.type === 'invite.email_due' || event.type === 'webhook.test') return [];
  if (deps.bus) {
    const bus = deps.bus;
    // Undelivered locales never reach a Delivery subscriber (`liveEventOf`).
    await liveEventOf(ctx, event)
      .then((live) => bus.publish(live))
      .catch((err) => deps.onLiveError?.(err));
  }
  if (deps.agents && deps.agentConfig && event.type === 'entry.published') {
    return runPublishAgents(ctx, deps.agents, event.scope, event.entryId, deps.agentConfig);
  }
  return [];
}
