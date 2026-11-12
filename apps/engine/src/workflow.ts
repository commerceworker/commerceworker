/**
 * CommerceWorker: one generic Workflow that interprets a pinned flow version for one order.
 *
 * Determinism: the planner (`@commerceworker/core` graph.ts) is pure, every node's effects come back as
 * a memoized step result, and nodes in a batch are applied in graph order, so a replay after
 * hibernation rebuilds exactly the same plan. Reports to the OrderAgent carry a sequence number;
 * the agent ignores anything not newer than what it has, so replays never move the UI backwards.
 *
 * Steps per node: `${nodeId}#${run}` (run counts make loop iterations distinct). Waiting nodes
 * add `:open` / `:close` steps around `step.waitForEvent`.
 *
 * Effects (connector writes, webhook deliveries, wait event types, timeline entries) are keyed by
 * `effectKey`, which adds the generation after a continue-as-new: run counts restart in every
 * generation, so step names repeat across generations while their effects must not.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  planApproval,
  releaseCredit,
  reverseBudgetSpend,
} from '@commerceworker/application/commerce';
import {
  type AccountContext,
  beginNode,
  calendarWait,
  completeLoop,
  completeNode,
  durationField,
  evaluate,
  type FlowNode,
  type FlowVersion,
  inDateRange,
  initPlan,
  interpolate,
  NODE_EVENTS,
  type NodeRegistry,
  type Order,
  type OrderEvent,
  type OrderStatus,
  orderReference,
  type PendingWait,
  type PlanState,
  type PluginManifest,
  pluginOf,
  type RunContext,
  readApprovalSpec,
  readyNodes,
  type SubscriptionInterval,
  staticRegistry,
  truthy,
  withPlugins,
} from '@commerceworker/core';
import { loadAccount } from './accounts';
import type { Report } from './agent';
import { recordAudit } from './audit';
import { loadFlowVersion } from './flows';
import { orderAgent } from './namespaces';
import { EXECUTORS, type NodeResult, ROLLBACKS, scaled } from './nodes';
import { confirmsByEmail, orderConfirmation } from './order-confirmation';
import { instanceExists } from './orders';
import { emit, orderSummary } from './outbox';
import { voidAuthorizations } from './payments';
import { execPluginNode, flowManifests, pluginRollback, usesPlugins } from './plugins';
import { approvalPorts, balanceStore, budgetStore } from './wire';
import { capReason, failureReason, orderReason, plural } from './words';

export type OrderWorkflowParams = {
  orderId: string;
  flowId: string;
  version: number;
  generation: number;
  order: Order;
  vars: Record<string, unknown>;
  /** The idempotency key the order started under, when it had one. */
  key?: string;
};

type Outcome =
  | { kind: 'complete'; result: NodeResult }
  | { kind: 'loop'; next: boolean; result: NodeResult }
  | {
      kind: 'end';
      outcome: 'completed' | 'declined' | 'cancelled' | 'failed';
      reason: string;
      /** The End node and its step key, for what runs once the batch has finished. */
      nodeId: string;
      key: string;
    }
  | { kind: 'continue' };

/** Workflow event types allow only [a-zA-Z0-9_-]. */
const eventTypeFor = (prefix: string, stepKey: string) =>
  `${prefix}-${stepKey}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100);

/** The key a node's effects are idempotent on: its step name, plus the generation after the first. */
export const effectKey = (generation: number, stepKey: string) =>
  generation > 1 ? `${stepKey}@g${generation}` : stepKey;

/** "goods.received" → "goods_received": where an event's payload lands in vars. */
export const eventVar = (event: string) => event.replace(/[^a-zA-Z0-9]+/g, '_');

/**
 * What `run` knows about a throw by the time it reaches it. A node's own step and an End node
 * that fails the order have already announced it (`announced`: the node `failed` and
 * `order.failed`); anything else that throws (loading the flow, a wait's `:open` or `:close` step)
 * is only tagged with what it was doing. Either way `run` then reports the order failed, durably.
 */
type RunFailure = {
  /** Nodes whose own step threw and whose `failed` report and timeline line went out. */
  reportedNodes: Set<string>;
  /** An End node that fails the order sent `order.failed` itself. */
  endAnnounced: boolean;
  /** The next generation's instance id, once a continue-as-new step is under way. */
  continuing?: string;
  ctx?: RunContext;
  where: WeakMap<object, { label: string; node?: FlowNode }>;
};

/** Notes what a throw was doing, for the reason the order fails with. The first note wins. */
function blame(failure: RunFailure, err: unknown, label: string, node?: FlowNode) {
  if (typeof err === 'object' && err !== null && !failure.where.has(err))
    failure.where.set(err, { label, node });
}

export class OrderWorkflow extends WorkflowEntrypoint<Env, OrderWorkflowParams> {
  /**
   * Whatever throws out of the run fails the order: a throw reaches the OrderAgent only as a
   * report, and the agent starts watching the instance (to record its rollback) only once a report
   * says the order failed. Workflows runs the registered rollbacks as the error leaves.
   */
  override async run(event: Readonly<WorkflowEvent<OrderWorkflowParams>>, step: WorkflowStep) {
    const failure: RunFailure = {
      reportedNodes: new Set(),
      endAnnounced: false,
      where: new WeakMap(),
    };
    try {
      return await this.runOrder(event, step, failure);
    } catch (err) {
      // The next generation is running: this one ends cleanly, so Workflows compensates nothing
      // under it.
      if ((await this.failOrder(step, event.payload, failure, err)) === 'continued')
        return { continuedAs: event.payload.generation + 1 };
      throw err;
    }
  }

  /**
   * Reports the order failed as one step (`run:failed`, which exists only on this path, so no
   * published flow's step names change), then announces it unless a node's step or an End node
   * already did. A step, not a bare report: the snapshots those two send are dropped if the agent
   * is unreachable for the moment, and a step retries.
   * Replay-safe: a replay returns both steps' memoized results, and the agent folds a repeated
   * `failed` into no change.
   */
  private async failOrder(
    step: WorkflowStep,
    p: OrderWorkflowParams,
    failure: RunFailure,
    err: unknown,
  ): Promise<'continued' | undefined> {
    try {
      // A throw from the continue step once the next generation exists (a retry that finds it, then
      // fails on something after) is not the order's failure: that generation carries on. Only a
      // definite not-found counts as absent; any other error from the check retries the step.
      if (failure.continuing) {
        const next = failure.continuing;
        const exists = await step.do('run:failed:continued', async () => {
          try {
            await this.env.ORDER_WORKFLOW.get(next);
            return true;
          } catch (e) {
            if (/not[_ ]found/i.test(e instanceof Error ? e.message : String(e))) return false;
            throw e;
          }
        });
        if (exists) return 'continued';
      }
      // A step's error comes back with its class name in front, which the order's reason leaves out.
      const message = (err instanceof Error ? err.message : String(err)).replace(
        /^NonRetryableError: /,
        '',
      );
      const where = typeof err === 'object' && err !== null ? failure.where.get(err) : undefined;
      // The blamed node's own step may not be the one that threw first; report it unless it did.
      const nodeSent = where?.node ? failure.reportedNodes.has(where.node.id) : false;
      const reason = where
        ? failureReason(where.label, message)
        : orderReason(message.split('\n')[0] ?? '');
      const fx = effectKey(p.generation, 'run:failed');
      const env = this.env;
      await step.do(
        'run:failed',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' },
        async () => {
          await orderAgent(env, p.orderId).report({
            generation: p.generation,
            status: 'failed',
            reason,
            ...(!nodeSent && where?.node
              ? {
                  node: {
                    id: where.node.id,
                    status: 'failed' as const,
                    error: message,
                    endedAt: Date.now(),
                  },
                }
              : {}),
            ...(nodeSent || failure.endAnnounced
              ? {}
              : {
                  log: {
                    at: Date.now(),
                    nodeId: where?.node?.id,
                    kind: 'node' as const,
                    message: where
                      ? `${where.label} failed: ${message}`
                      : `Order failed: ${message}`,
                    key: fx,
                  },
                }),
          });
          return reason;
        },
      );
      if (!failure.endAnnounced)
        await emitStep(step, env, 'run:failed', fx, p.orderId, 'order.failed', {
          order: orderSummary(failure.ctx?.order ?? p.order),
          outcome: 'failed',
          reason,
          ...(where?.node
            ? { node: { id: where.node.id, type: where.node.type, error: message } }
            : {}),
        });
    } catch (reportErr) {
      // Never mask the error that failed the run: Workflows still needs it to run the rollbacks.
      console.warn('failure report gave up', reportErr);
    }
  }

  private async runOrder(
    event: Readonly<WorkflowEvent<OrderWorkflowParams>>,
    step: WorkflowStep,
    failure: RunFailure,
  ) {
    const p = event.payload;
    const agent = orderAgent(this.env, p.orderId);
    const flow = JSON.parse(
      await step.do('load-flow', async () => {
        const f = await loadFlowVersion(this.env, p.flowId, p.version);
        if (!f) throw new NonRetryableError(`Flow ${p.flowId} v${p.version} not found`);
        return JSON.stringify(f);
      }),
    ) as FlowVersion;
    // A flow with plugin nodes reads the installed plugins' specs once, durably, so a replay sees
    // the same specs even if a plugin is redeployed meanwhile. Other flows add no step.
    const registry: NodeRegistry = usesPlugins(flow)
      ? withPlugins(
          JSON.parse(
            await step.do('load-plugins', async () =>
              JSON.stringify(await flowManifests(this.env, flow)),
            ),
          ) as PluginManifest[],
        )
      : staticRegistry;

    // The order's company and buyer, for `company.*` and `buyer.*` in the flow's expressions. Read
    // once, in a step, so a replay sees what the first run did. An order with no customer adds no
    // step.
    const account = p.order.customerId
      ? (JSON.parse(
          await step.do('load-account', async () =>
            JSON.stringify(await loadAccount(this.env, p.order)),
          ),
        ) as AccountContext)
      : undefined;
    const plan = initPlan(flow);
    const ctx: RunContext = {
      order: p.order,
      nodes: {},
      vars: { ...p.vars },
      input: p.order.meta ?? {},
      now: event.timestamp.getTime(),
      ref: orderReference(p.order),
      ...account,
    };
    failure.ctx = ctx;
    let seq = 0;
    const report = async (r: Omit<Report, 'seq' | 'generation'>, durable = false) => {
      // Non-durable reports (plan snapshots) are sequenced; durable ones are already exactly-once.
      const msg: Report = { ...r, generation: p.generation, ...(durable ? {} : { seq: ++seq }) };
      try {
        await agent.report(msg);
      } catch (err) {
        console.warn('report failed', err);
      }
    };
    const snapshot = (status: OrderStatus, extra: Partial<Report> = {}) =>
      report({ status, plan: clonePlan(plan), order: ctx.order, vars: ctx.vars, ...extra });

    await snapshot('running');

    let end: Extract<Outcome, { kind: 'end' }> | null = null;
    let confirmed = false;
    while (!end) {
      const { ready } = readyNodes(flow, plan);
      if (!ready.length) break;
      const nodes = ready.map((id) => flow.nodes.find((n) => n.id === id)!);
      const keys = nodes.map((n) => beginNode(plan, n.id));
      for (const n of nodes)
        if (registry.spec(n.type)?.waits || n.type === 'control.wait')
          plan.nodes[n.id]!.status = 'waiting';
      // The batch's snapshot goes out alongside its nodes rather than before them: it is
      // sequenced, so the agent drops it if a newer one lands first, and it never throws.
      const batchSnapshot = snapshot(
        nodes.some((n) => plan.nodes[n.id]!.status === 'waiting') ? 'waiting' : 'running',
      );

      const [, ...outcomes] = await Promise.all([
        batchSnapshot,
        ...nodes.map((n, i) =>
          this.runNode(step, plan, ctx, n, keys[i]!, p, report, registry, failure).catch((err) => {
            blame(failure, err, n.label, n);
            throw err;
          }),
        ),
      ]);

      // Apply in graph order so the plan is identical on replay.
      let continueKey: string | null = null;
      for (const [i, out] of outcomes.entries()) {
        const n = nodes[i]!;
        if (out.kind === 'end') {
          completeNode(flow, plan, n.id, []);
          end = out;
          continue;
        }
        if (out.kind === 'continue') {
          completeNode(flow, plan, n.id, []);
          continueKey = keys[i]!;
          continue;
        }
        applyResult(ctx, n.id, out.result);
        if (out.kind === 'loop') completeLoop(flow, plan, n.id, out.next);
        else completeNode(flow, plan, n.id, out.result.branches ?? ['out']);
      }
      // Continue only once the whole batch is applied, so its siblings' outputs carry over.
      if (continueKey && !end) {
        failure.continuing = `${p.orderId}-g${p.generation + 1}`;
        await this.continueAsNew(step, p, ctx, continueKey);
        await snapshot('running');
        return { continuedAs: p.generation + 1 };
      }
      await snapshot('running');
      // A hosted checkout's buyer is mailed once the card is authorized: the order is confirmed
      // then, priced and paid for, not when its flow ends (a return window can keep it open for
      // weeks). After the snapshot, so the mail shows the order as priced.
      if (
        !confirmed &&
        !end &&
        confirmsByEmail(ctx.order, p.key) &&
        flow.nodes.some(
          (n) =>
            n.type === 'commerce.authorize_payment' &&
            plan.nodes[n.id]?.status === 'succeeded' &&
            plan.nodes[n.id]?.branches?.includes('ok'),
        )
      ) {
        confirmed = true;
        await this.confirmByEmail(step, p, 'authorize');
      }
    }

    const outcome = end?.outcome ?? 'completed';
    const reason = end?.reason ?? '';
    // Ending declined or cancelled isn't a failure, so no rollback runs: void any card hold the
    // order still has, rather than leave it open until the card network releases it. After the
    // whole batch, so a hold a sibling placed alongside the End node is voided too.
    // A release that fails for good (after its step's retries) does not fail the order: its End node
    // has already announced the outcome, and an error out of `run` would make Workflows roll back
    // an order the buyer was told is done (refund a capture, release its stock). It is recorded
    // instead, below, and the order keeps its outcome.
    const problems: string[] = [];
    const release = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        problems.push(
          failureReason(`${what} failed`, err instanceof Error ? err.message : String(err)),
        );
      }
    };
    if (end && (outcome === 'declined' || outcome === 'cancelled')) {
      await release('voiding its card holds', () =>
        this.voidOpenHolds(step, p, end!.nodeId, end!.key),
      );
      // The same for the budgets: an order that never completes spent none of what it recorded.
      if (flow.nodes.some((n) => n.type === 'commerce.budget_check' && n.config?.commit === true))
        await release('giving back its budget spend', () =>
          this.giveBackBudgetSpend(step, p, end!.nodeId, end!.key),
        );
    }
    // Whatever the outcome but failed (a failed run's rollbacks give the credit back), an order
    // that ends holds no credit: an invoice already converted its hold, and any left over (a card
    // order, a decline after the check) goes back to the customer's limit.
    if (outcome !== 'failed')
      await release('releasing its credit holds', () =>
        this.releaseCreditHolds(step, p, end?.nodeId ?? 'end'),
      );
    if (problems.length) await this.recordReleaseProblems(step, p, outcome, end?.nodeId, problems);
    // An End node that fails the order announced it itself, in its own step.
    if (outcome === 'failed') failure.endAnnounced = true;
    await snapshot(outcome, { reason });
    // A flow with no card authorization confirms when it completes. After the outcome is recorded,
    // so a mail problem can't change it.
    if (outcome === 'completed' && !confirmed && confirmsByEmail(ctx.order, p.key))
      await this.confirmByEmail(step, p, end?.nodeId ?? 'end');
    if (outcome === 'failed') {
      // Fails the instance; Workflows then runs every registered rollback in reverse order.
      throw new NonRetryableError(reason || 'Order failed');
    }
    return { outcome, total: ctx.order.total };
  }

  /**
   * Records that releasing what an ended order held failed for good, as one step (`release:failed`,
   * which exists only then). The order keeps its outcome, so the timeline line and the audit event
   * are what staff see; the held credit or card hold is still there to release by hand. Replay-safe:
   * the timeline line is keyed, and a replay returns the memoized step.
   */
  private async recordReleaseProblems(
    step: WorkflowStep,
    p: OrderWorkflowParams,
    outcome: string,
    nodeId: string | undefined,
    problems: string[],
  ) {
    const env = this.env;
    const message = capReason(
      `${outcome[0]!.toUpperCase()}${outcome.slice(1)}, but ${problems.join('; ')}`,
      400,
    );
    try {
      await step.do(
        'release:failed',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' },
        async () => {
          await orderAgent(env, p.orderId).report({
            generation: p.generation,
            log: {
              at: Date.now(),
              nodeId,
              kind: 'rollback',
              message,
              key: `${effectKey(p.generation, 'release')}:failed`,
            },
          });
          await recordAudit(env, 'order.release_failed', {
            actor: { kind: 'system', id: 'system:workflow', name: 'Order Flow' },
            target: p.orderId,
            detail: { outcome, problems },
          });
          return true;
        },
      );
    } catch (err) {
      console.warn('release failure report gave up', err);
    }
  }

  /**
   * Voids the order's open authorizations as one step (`<end key>:void`). Retry-safe: each void is
   * keyed by its payment row, and a hold already voided is skipped.
   */
  private async voidOpenHolds(
    step: WorkflowStep,
    p: OrderWorkflowParams,
    nodeId: string,
    key: string,
  ) {
    const env = this.env;
    const fx = effectKey(p.generation, key);
    await step.do(
      `${key}:void`,
      { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' },
      async () => {
        const voided = await voidAuthorizations(env, p.orderId);
        if (voided) {
          // Sent from inside the step, so it is reported once; a failed report doesn't redo the void.
          try {
            await orderAgent(env, p.orderId).report({
              generation: p.generation,
              log: {
                at: Date.now(),
                nodeId,
                kind: 'rollback',
                message: `Voided ${plural(voided, 'authorization')}: the order ended without payment`,
                key: `${fx}:void`,
              },
            });
          } catch (err) {
            console.warn('void report failed', err);
          }
        }
        return voided;
      },
    );
  }

  /**
   * Mails the buyer the order's confirmation (once its card is authorized, or when the order ends
   * for a flow with none), as one step (`order:confirmation`). The send is keyed
   * by the order (`messages`, once per order and kind), so a retry or a replay mails nothing more.
   * Only a refusal by Email Sending retries; a deployment without email, or an order with no
   * address, says so on the timeline and moves on. Nothing here fails the order: it has completed.
   */
  private async confirmByEmail(step: WorkflowStep, p: OrderWorkflowParams, nodeId: string) {
    const env = this.env;
    const fx = effectKey(p.generation, 'confirmation');
    let note: string | null = null;
    try {
      const outcome = await step.do(
        'order:confirmation',
        { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '1 minute' },
        async () => {
          const r = await orderConfirmation.send(env, p.orderId);
          if (r.status === 'failed') throw new Error(r.error);
          return r.status;
        },
      );
      if (outcome === 'not_configured')
        note = 'its confirmation email was not sent: email sending is not configured';
      if (outcome === 'no_recipient')
        note = 'its confirmation email was not sent: the order has no email address';
    } catch (err) {
      note = `its confirmation email was not sent: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!note) return;
    try {
      await orderAgent(env, p.orderId).report({
        generation: p.generation,
        log: {
          at: Date.now(),
          nodeId,
          kind: 'order',
          message: capReason(`Completed, but ${note}`, 400),
          key: `${fx}:unsent`,
        },
      });
    } catch (err) {
      console.warn('confirmation report failed', err);
    }
  }

  /**
   * Gives back the credit the order still holds, as one step (`credit:release`). Retry-safe: a
   * hold is released once, so a retry finds none left and reports nothing.
   */
  private async releaseCreditHolds(step: WorkflowStep, p: OrderWorkflowParams, nodeId: string) {
    const env = this.env;
    const fx = effectKey(p.generation, 'credit');
    await step.do(
      'credit:release',
      { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' },
      async () => {
        const released = await releaseCredit({ balances: balanceStore(env) }, p.orderId);
        if (released) {
          // Sent from inside the step, so it is reported once; a failed report doesn't redo the release.
          try {
            await orderAgent(env, p.orderId).report({
              generation: p.generation,
              log: {
                at: Date.now(),
                nodeId,
                kind: 'rollback',
                message: `Released ${plural(released, 'credit hold')}: the order ended without charging it`,
                key: `${fx}:release`,
              },
            });
          } catch (err) {
            console.warn('credit release report failed', err);
          }
        }
        return released;
      },
    );
  }

  /**
   * Gives back the budget spend the order recorded, as one step (`<end key>:budgets`). Retry-safe:
   * each commit is reversed once, so a retry finds none left and reports nothing.
   */
  private async giveBackBudgetSpend(
    step: WorkflowStep,
    p: OrderWorkflowParams,
    nodeId: string,
    key: string,
  ) {
    const env = this.env;
    const fx = effectKey(p.generation, key);
    await step.do(
      `${key}:budgets`,
      { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' },
      async () => {
        const reversed = await reverseBudgetSpend(
          { budgets: budgetStore(env) },
          p.orderId,
          Date.now(),
        );
        if (reversed) {
          // Sent from inside the step, so it is reported once; a failed report doesn't redo the reversal.
          try {
            await orderAgent(env, p.orderId).report({
              generation: p.generation,
              log: {
                at: Date.now(),
                nodeId,
                kind: 'rollback',
                message: `Gave back ${plural(reversed, 'budget spend')}: the order ended without completing`,
                key: `${fx}:budgets`,
              },
            });
          } catch (err) {
            console.warn('budget reversal report failed', err);
          }
        }
        return reversed;
      },
    );
  }

  /** Starts the next generation. Retry-safe: a retry after `create` succeeded finds the instance. */
  private async continueAsNew(
    step: WorkflowStep,
    p: OrderWorkflowParams,
    ctx: RunContext,
    key: string,
  ) {
    const env = this.env;
    await step.do(key, async () => {
      const generation = p.generation + 1;
      const id = `${p.orderId}-g${generation}`;
      // An order started before documents moved to R2 may still carry the text; drop it once stored.
      const { documentText: _text, ...stored } = ctx.order;
      const order = stored.documentKey ? stored : ctx.order;
      const params: OrderWorkflowParams = { ...p, generation, order, vars: ctx.vars };
      try {
        await env.ORDER_WORKFLOW.create({ id, params });
      } catch (err) {
        if (!(await instanceExists(env, id))) throw err;
      }
      // The next generation is running now, so this step is done: a failing note to the agent must
      // not fail the step (and with it the order). Generation g+1's first snapshot advances it.
      try {
        await orderAgent(env, p.orderId).continuedAs(id, generation);
      } catch (err) {
        console.warn('continuedAs failed', err);
      }
      return id;
    });
  }

  private async runNode(
    step: WorkflowStep,
    plan: PlanState,
    ctx: RunContext,
    node: FlowNode,
    key: string,
    p: OrderWorkflowParams,
    report: (r: Omit<Report, 'seq' | 'generation'>, durable?: boolean) => Promise<void>,
    registry: NodeRegistry,
    failure: RunFailure,
  ): Promise<Outcome> {
    const env = this.env;
    const agent = orderAgent(env, p.orderId);
    const spec = registry.spec(node.type);
    const config = registry.withDefaults(node.type, node.config);
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const fx = effectKey(p.generation, key);

    switch (node.type) {
      case 'control.approval':
      case 'control.wait_event': {
        const approval = node.type === 'control.approval';
        const eventType = eventTypeFor(approval ? 'approval' : 'event', fx);
        // Blank or missing, the catalog's default: 2 days for an approval, 30 for an event.
        const timeout = durationField(spec, config, 'timeout');
        const wait: PendingWait = {
          nodeId: node.id,
          eventType,
          kind: approval ? 'approval' : 'event',
          title: approval
            ? interpolate(str(config.title), ctx)
            : `Waiting for ${str(config.event)}`,
          event: approval ? undefined : str(config.event),
          assignee: approval ? str(config.assignee) : undefined,
          amount: ctx.order.total,
          deadline: ctx.now + scaled(env, timeout),
          since: Date.now(),
        };
        await step.do(`${key}:open`, async () => {
          // Who may vote, resolved here so a replay keeps what the wait opened with. The wait is
          // still one event: the agent sends it once the votes decide the step.
          let votePlan: Awaited<ReturnType<typeof planApproval>> | undefined;
          if (approval) {
            // The spec is the flow's own, so a spec that doesn't read never will; a failed read of
            // who the approvers are is a database or network error, and retries.
            const spec = readApprovalSpec(config);
            if ('error' in spec) throw new NonRetryableError(spec.error);
            votePlan = await planApproval(approvalPorts(env), config, ctx.order);
          }
          await agent.openWait({
            ...wait,
            ...(votePlan ? { approval: votePlan } : {}),
            since: Date.now(),
            deadline: Date.now() + scaled(env, timeout),
          });
          return true;
        });
        let branch: string;
        let payload: Record<string, unknown> = {};
        try {
          const ev = await step.waitForEvent<Record<string, string | number | boolean | null>>(
            key,
            {
              type: eventType,
              timeout: scaled(env, timeout),
            },
          );
          payload = (ev.payload ?? {}) as Record<string, unknown>;
          branch = approval
            ? payload.decision === 'approved'
              ? 'approved'
              : 'rejected'
            : 'received';
        } catch {
          branch = approval ? 'escalated' : 'timeout';
        }
        await step.do(`${key}:close`, async () => {
          await agent.closeWait(eventType, branch, payload);
          return true;
        });
        const result: NodeResult = {
          branches: [branch],
          output: { ...payload, outcome: branch },
          summary: approval
            ? branch === 'escalated'
              ? 'Timed out'
              : `${branch}${payload.by ? ` by ${String(payload.by)}` : ''}`
            : branch === 'received'
              ? 'Received'
              : 'Timed out',
          vars: approval ? undefined : { [eventVar(str(config.event))]: payload },
        };
        await report(
          {
            node: {
              id: node.id,
              summary: result.summary,
              output: result.output,
              endedAt: Date.now(),
            },
          },
          true,
        );
        return { kind: 'complete', result };
      }

      case 'control.wait': {
        const until = config.until
          ? await step.do(`${key}:until`, async () => Number(evaluate(config.until, ctx)) || 0)
          : 0;
        // A calendar wait reads the clock, so its deadline is decided once in a step of its own
        // (only flows that set `every` have one) and a replay sleeps to the same instant.
        const period =
          !until && config.every
            ? await step.do(`${key}:period`, async () => {
                const now = Date.now();
                const raw = config.from ? evaluate(config.from, ctx) : now;
                // Only a finite epoch-ms or a parseable date string is an anchor; null (a missing
                // var), booleans and arrays would otherwise coerce to 0 or 1 and renew from 1970.
                const anchor =
                  typeof raw === 'number'
                    ? raw
                    : typeof raw === 'string'
                      ? Date.parse(raw)
                      : Number.NaN;
                if (!inDateRange(anchor))
                  return { refused: 'the anchor (from) is not a date or epoch-ms' };
                try {
                  // TIME_SCALE compresses the wait for demos; the reported date stays a real one.
                  return calendarWait(
                    anchor,
                    str(config.every) as SubscriptionInterval,
                    Number(config.count ?? 1),
                    now,
                    Number(env.TIME_SCALE) || 1,
                  );
                } catch (err) {
                  return { refused: err instanceof Error ? err.message : String(err) };
                }
              })
            : null;
        // A deadline that can't be computed fails the order for good; it is returned, not thrown, so
        // the run ends through the same path as a failed End node and says why on the timeline.
        if (period && 'refused' in period) {
          const reason = capReason(`${node.label}: ${period.refused}`);
          await report(
            {
              node: { id: node.id, status: 'failed', error: reason, endedAt: Date.now() },
              log: {
                at: Date.now(),
                nodeId: node.id,
                kind: 'node',
                message: `${node.label} failed: ${period.refused}`,
                key: `${fx}:failed`,
              },
            },
            true,
          );
          await emitStep(step, env, key, fx, p.orderId, 'order.failed', {
            order: orderSummary(ctx.order),
            outcome: 'failed',
            reason,
            node: { id: node.id, type: node.type, error: period.refused },
          });
          return { kind: 'end', outcome: 'failed', reason, nodeId: node.id, key };
        }
        if (until > 0) await step.sleepUntil(key, until);
        else if (period) await step.sleepUntil(key, period.wake);
        else await step.sleep(key, scaled(env, durationField(spec, config, 'duration')));
        const at = until || (period && 'at' in period ? period.at : 0);
        const result: NodeResult = {
          summary: at ? `Until ${new Date(at).toISOString()}` : `Waited ${str(config.duration)}`,
        };
        await report({ node: { id: node.id, summary: result.summary, endedAt: Date.now() } }, true);
        return { kind: 'complete', result };
      }

      case 'control.loop': {
        const runs = plan.nodes[node.id]!.runs;
        const max = Number(config.maxIterations ?? 12);
        const next = await step.do(
          key,
          async () => runs <= max && truthy(config.while ?? true, ctx),
        );
        const result: NodeResult = {
          output: { iteration: runs, next },
          summary: next ? `Iteration ${runs}` : `Done after ${runs - 1}`,
        };
        await report(
          { node: { id: node.id, summary: result.summary, output: result.output } },
          true,
        );
        return { kind: 'loop', next, result };
      }

      case 'control.end': {
        const outcome = (str(config.outcome) || 'completed') as
          | 'completed'
          | 'declined'
          | 'cancelled'
          | 'failed';
        // Interpolated from the order's data, which can be any length.
        const reason = capReason(interpolate(str(config.reason), ctx));
        await report(
          { node: { id: node.id, summary: reason || outcome, endedAt: Date.now() } },
          true,
        );
        await emitStep(step, env, key, fx, p.orderId, `order.${outcome}`, {
          order: orderSummary(ctx.order),
          outcome,
          reason,
        });
        return { kind: 'end', outcome, reason, nodeId: node.id, key };
      }

      case 'control.continue_as_new':
        // Started by `continueAsNew` after the batch is applied.
        return { kind: 'continue' };
    }

    const fromPlugin = pluginOf(node.type) !== null;
    const exec = EXECUTORS[node.type] ?? (fromPlugin ? execPluginNode : undefined);
    if (!exec) throw new NonRetryableError(`No executor for ${node.type}`);
    const rollback = !spec?.rollback
      ? undefined
      : fromPlugin
        ? pluginRollback(node.type, node.id, fx)
        : ROLLBACKS[node.type];
    const retries = node.retries ?? spec?.retries ?? 3;
    try {
      const result = (await step.do(
        key,
        {
          retries: { limit: retries, delay: '5 seconds', backoff: 'exponential' },
          timeout: (node.timeout as `${number} seconds`) ?? '5 minutes',
        },
        async (sctx) => {
          await report(
            {
              node: { id: node.id, startedAt: Date.now() },
              log:
                sctx.attempt > 1
                  ? {
                      at: Date.now(),
                      nodeId: node.id,
                      kind: 'node',
                      message: `${node.label}: attempt ${sctx.attempt}`,
                      key: `${fx}:a${sctx.attempt}`,
                    }
                  : undefined,
            },
            true,
          );
          // `limit` retries after the first try: attempt `retries + 1` is the last, where a model
          // node answers with its fallback instead of throwing (`AiCall`).
          const retriesLeft = sctx.attempt <= retries;
          const r = await exec({ env, node, config, ctx, stepKey: fx, registry, retriesLeft });
          await report(
            {
              node: {
                id: node.id,
                summary: r.summary,
                output: r.output,
                endedAt: Date.now(),
                error: undefined,
              },
              log: {
                at: Date.now(),
                nodeId: node.id,
                kind: node.type.startsWith('ai.') ? 'ai' : 'node',
                message: `${node.label}: ${r.summary ?? 'done'}`,
                key: fx,
              },
            },
            true,
          );
          return JSON.parse(JSON.stringify(r)) as NodeResult & Rpc.Serializable<NodeResult>;
        },
        rollback
          ? {
              rollback: async ({ output, error }) => {
                const message = await rollback(
                  env,
                  p.orderId,
                  (output as NodeResult | undefined)?.output,
                  fx,
                );
                // The compensation already ran: a failed report must not make Workflows retry it.
                try {
                  await agent.report({
                    generation: p.generation,
                    node: { id: node.id, status: 'rolled_back', summary: message },
                    log: {
                      at: Date.now(),
                      nodeId: node.id,
                      kind: 'rollback',
                      message: `${node.label}: ${message} (${error.message})`,
                      key: `${fx}:rollback`,
                    },
                  });
                } catch (err) {
                  console.warn('rollback report failed', err);
                }
              },
              rollbackConfig: {
                retries: { limit: 3, delay: '10 seconds', backoff: 'linear' },
                timeout: '2 minutes',
              },
            }
          : undefined,
      )) as NodeResult;
      const emits = NODE_EVENTS[node.type];
      if (emits && (!emits.branch || (result.branches ?? ['out']).includes(emits.branch))) {
        await emitStep(step, env, key, fx, p.orderId, emits.event, {
          order: orderSummary({ ...ctx.order, ...result.order }),
          node: { id: node.id, type: node.type, output: result.output ?? null },
        });
      }
      return { kind: 'complete', result };
    } catch (err) {
      // The node's own report; `run` then fails the order once, whichever node threw first.
      failure.reportedNodes.add(node.id);
      const message = err instanceof Error ? err.message : String(err);
      await report(
        {
          node: { id: node.id, status: 'failed', error: message, endedAt: Date.now() },
          log: {
            at: Date.now(),
            nodeId: node.id,
            kind: 'node',
            message: `${node.label} failed: ${message}`,
            key: `${fx}:failed`,
          },
        },
        true,
      );
      throw err;
    }
  }
}

/**
 * Delivers an outbound webhook in its own step (`${key}:emit`), keyed by the node's effect key
 * `fx`. The step throws while deliveries
 * are pending so Workflows retries it with backoff; once retries run out the error is swallowed,
 * because a subscriber being down must never fail the order. Undelivered rows stay `failed`.
 */
async function emitStep(
  step: WorkflowStep,
  env: Env,
  key: string,
  fx: string,
  orderId: string,
  event: OrderEvent,
  data: Record<string, unknown>,
) {
  try {
    await step.do(
      `${key}:emit`,
      { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' },
      async () => {
        const r = await emit(env, fx, orderId, event, data);
        if (r.pending) throw new Error(`${r.pending} ${event} deliveries pending`);
        return r;
      },
    );
  } catch (err) {
    console.warn('webhook delivery gave up', event, err);
  }
}

function applyResult(ctx: RunContext, nodeId: string, r: NodeResult) {
  ctx.nodes[nodeId] = r.output ?? null;
  if (r.order) ctx.order = { ...ctx.order, ...r.order };
  if (r.vars) ctx.vars = { ...ctx.vars, ...r.vars };
  if (r.pluginVars) {
    const plugins = (ctx.vars.plugins ?? {}) as Record<string, Record<string, unknown>>;
    const { id, vars } = r.pluginVars;
    ctx.vars = { ...ctx.vars, plugins: { ...plugins, [id]: { ...plugins[id], ...vars } } };
  }
}

function clonePlan(plan: PlanState): PlanState {
  return { nodes: structuredClone(plan.nodes), edges: { ...plan.edges } };
}
