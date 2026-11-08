/**
 * The workflow graph interpreter: one generic durable workflow that runs a pinned workflow version
 * for one entry, over the `WorkflowSteps` port, so the engine passes its Cloudflare `WorkflowStep`
 * straight in and tests use test-kit's `FakeWorkflowSteps`.
 *
 * Determinism: the planner (`@commerceworker/domain` planner.ts) is pure, every node's effects come
 * back as a memoized step result, and nodes in a batch are applied in graph order, so a replay
 * after hibernation rebuilds exactly the same plan. Snapshot reports carry a sequence number and
 * the run ignores any not newer than what it has, so replays never move it backwards.
 *
 * Steps per node: `${nodeId}#${run}` (run counts make loop iterations distinct). Waiting nodes add
 * `:open` / `:close` steps around `waitForEvent`; `control.wait` adds `:until`; compensation adds
 * `:rollback`. Effects are keyed by `effectKey`, which adds the generation after a continue-as-new.
 *
 * By design:
 * - compensation runs here, in reverse completion order, instead of through Cloudflare's native
 *   step `rollback`, so it is explicit, testable and idempotent (each `:rollback` is a step);
 * - a run that fails ends `rolled_back` (or `failed` when a compensation failed or there was
 *   nothing to undo) without throwing, so the instance never errors after it has reported;
 * - a node's domain failure (`NodeResult.failed`: forbidden, invalid) fails it without retries;
 * - outbound run events go through the outbox when the run's status turns terminal, not a
 *   per-node `:emit` step;
 * - an executor may ask to wait (`ai.enrich` awaiting review): open, wait, close, then resume.
 */

import type { ExecuteWorkflowNodeInput, NodeResult } from '@commerceworker/application';
import {
  approverOf,
  beginNode,
  capReason,
  cloneJson,
  completeLoop,
  completeNode,
  durationMs,
  effectKey,
  entryReference,
  evaluateLogic,
  eventTypeFor,
  eventVar,
  failureReason,
  initPlan,
  interpolate,
  isBackEdge,
  logicHolds,
  nodeSpec,
  type PendingWait,
  type PlanState,
  type RunContext,
  type RunReport,
  readyNodes,
  seedAt,
  type WorkflowNode,
  type WorkflowRunActor,
  type WorkflowRunParams,
  type WorkflowRunStatus,
  withDefaults,
} from '@commerceworker/domain';
import type { WorkflowSteps } from '@commerceworker/ports';
import type { GraphActivities } from './activities';

export type GraphRunOutcome =
  | {
      readonly outcome: Extract<
        WorkflowRunStatus,
        'completed' | 'declined' | 'cancelled' | 'failed' | 'rolled_back'
      >;
      readonly reason: string;
    }
  | { readonly outcome: 'continued'; readonly generation: number };

type EndOutcome = 'completed' | 'declined' | 'cancelled' | 'failed';

type Outcome =
  /** `approver`: an approval approved by a person, who the run acts as downstream of it. */
  | { kind: 'complete'; result: NodeResult; approver?: WorkflowRunActor }
  | { kind: 'loop'; next: boolean; result: NodeResult }
  | { kind: 'end'; outcome: EndOutcome; reason: string }
  | { kind: 'continue' }
  | { kind: 'failed'; reason: string };

interface Compensable {
  readonly node: WorkflowNode;
  readonly key: string;
  readonly fx: string;
  readonly output: unknown;
  /** Who the node ran as; its undo runs as the same identity. */
  readonly actor: WorkflowRunActor;
}

/** Retry policy for a compensation step. */
const ROLLBACK_CONFIG = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'linear' },
  timeout: '2 minutes',
} as const;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** " · as <id>" when a node ran as someone other than the run's starter. */
const asWho = (actor: WorkflowRunActor, p: WorkflowRunParams) =>
  actor.id === p.actor.id ? '' : ` · as ${actor.id}`;

const runOf = (key: string) => Number(key.slice(key.lastIndexOf('#') + 1)) || 1;

function applyResult(ctx: RunContext, nodeId: string, r: NodeResult) {
  ctx.nodes[nodeId] = r.output ?? null;
  if (r.entry) {
    ctx.entry = r.entry;
    ctx.ref = entryReference(r.entry);
  }
  if (r.vars) ctx.vars = { ...ctx.vars, ...r.vars };
}

/** Runs (or replays) one generation of a run. Never throws once the run has loaded. */
export async function runGraph(
  steps: WorkflowSteps,
  act: GraphActivities,
  p: WorkflowRunParams,
): Promise<GraphRunOutcome> {
  const version = await steps.do('load-flow', async () =>
    act.loadVersion(p.scope, p.workflowId, p.version),
  );
  if (!version) {
    const reason = `Workflow ${p.workflowId} v${p.version} not found`;
    await act.report(p.scope, p.runId, { generation: p.generation, status: 'failed', reason });
    return { outcome: 'failed', reason };
  }
  const graph = version.graph;
  const entry = await steps.do('load-entry', async () => act.loadEntry(p.scope, p.entryId));

  const plan = initPlan(graph);
  if (p.startAt && p.generation === 1) seedAt(graph, plan, p.startAt);
  const ctx: RunContext = {
    entry,
    nodes: {},
    vars: { ...p.vars },
    input: { ...p.input },
    now: p.startedAt,
    ref: entryReference(entry),
  };
  let seq = 0;
  const report = async (r: Omit<RunReport, 'seq' | 'generation'>, durable = false) => {
    // Non-durable reports (plan snapshots) are sequenced; durable ones are already exactly-once.
    const msg: RunReport = { ...r, generation: p.generation, ...(durable ? {} : { seq: ++seq }) };
    try {
      await act.report(p.scope, p.runId, msg);
    } catch {
      // Reporting is best-effort: the run's progress lives in its steps, not in the report.
    }
  };
  const snapshot = (status: WorkflowRunStatus, extra: Partial<RunReport> = {}) =>
    report({ status, plan: cloneJson(plan) as PlanState, vars: ctx.vars, ...extra });

  await snapshot('running');

  // "Starter, then approver": a node acts as the person who most recently approved an approval
  // upstream of it, or as the run's starter when none has. Approvals are numbered in the
  // (deterministic) order their results were applied, so a replay resolves the same identities.
  const approvals = new Map<string, { actor: WorkflowRunActor; order: number }>();
  let approvalOrder = 0;
  const ancestorCache = new Map<string, Set<string>>();
  const ancestors = (nodeId: string): Set<string> => {
    const cached = ancestorCache.get(nodeId);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop() as string;
      for (const e of graph.edges) {
        if (e.target === id && !isBackEdge(e) && !seen.has(e.source)) {
          seen.add(e.source);
          stack.push(e.source);
        }
      }
    }
    ancestorCache.set(nodeId, seen);
    return seen;
  };
  const actorFor = (nodeId: string): WorkflowRunActor => {
    const up = ancestors(nodeId);
    let best: { actor: WorkflowRunActor; order: number } | null = null;
    for (const [approvalId, a] of approvals) {
      if (up.has(approvalId) && (!best || a.order > best.order)) best = a;
    }
    return best?.actor ?? p.actor;
  };

  const compensable: Compensable[] = [];
  let end: Extract<Outcome, { kind: 'end' }> | null = null;
  let failure: string | null = null;
  while (!end && failure === null) {
    const { ready } = readyNodes(graph, plan);
    if (!ready.length) break;
    const nodes = ready.map((id) => graph.nodes.find((n) => n.id === id) as WorkflowNode);
    const keys = nodes.map((n) => beginNode(plan, n.id));
    for (const n of nodes) {
      if (nodeSpec(n.type)?.waits || n.type === 'control.wait') {
        (plan.nodes[n.id] as { status: string }).status = 'waiting';
      }
    }
    // The batch's snapshot goes out alongside its nodes rather than before them: it is
    // sequenced, so the run drops it if a newer one lands first, and it never throws.
    const batchSnapshot = snapshot(
      nodes.some((n) => plan.nodes[n.id]?.status === 'waiting') ? 'waiting' : 'running',
    );
    const [, ...outcomes] = await Promise.all([
      batchSnapshot,
      ...nodes.map((n, i) =>
        runNode(steps, act, p, plan, ctx, n, keys[i] as string, report, actorFor(n.id)),
      ),
    ]);

    // Apply in graph order so the plan is identical on replay.
    let continueKey: string | null = null;
    for (const [i, out] of outcomes.entries()) {
      const n = nodes[i] as WorkflowNode;
      const key = keys[i] as string;
      if (out.kind === 'failed') {
        (plan.nodes[n.id] as { status: string }).status = 'failed';
        failure ??= out.reason;
        continue;
      }
      if (out.kind === 'end') {
        completeNode(graph, plan, n.id, []);
        end ??= out;
        continue;
      }
      if (out.kind === 'continue') {
        completeNode(graph, plan, n.id, []);
        continueKey = key;
        continue;
      }
      applyResult(ctx, n.id, out.result);
      if (out.kind === 'complete' && out.approver) {
        approvals.set(n.id, { actor: out.approver, order: ++approvalOrder });
      }
      if (nodeSpec(n.type)?.rollback) {
        compensable.push({
          node: n,
          key,
          fx: effectKey(p.generation, key),
          output: out.result.output ?? null,
          actor: actorFor(n.id),
        });
      }
      if (out.kind === 'loop') completeLoop(graph, plan, n.id, out.next);
      else completeNode(graph, plan, n.id, out.result.branches ?? ['out']);
    }
    if (failure !== null) break;
    // Continue only once the whole batch is applied, so its siblings' outputs carry over.
    if (continueKey && !end) {
      const generation = p.generation + 1;
      await steps.do(continueKey, async () =>
        act.continueAsNew({ ...p, generation, vars: ctx.vars, startedAt: act.now() }),
      );
      await snapshot('running');
      return { outcome: 'continued', generation };
    }
    await snapshot('running');
  }

  if (failure !== null || end?.outcome === 'failed') {
    const reason = failure ?? end?.reason ?? 'Failed';
    // Saga: undo every compensable step, newest first. Each undo is its own step, so a replay
    // (or a retry) never undoes twice, and the compensation itself checks the entry first.
    let undoFailed = false;
    for (const c of [...compensable].reverse()) {
      try {
        const message = await steps.do(`${c.key}:rollback`, ROLLBACK_CONFIG, async () =>
          act.compensateNode({
            scope: p.scope,
            runId: p.runId,
            workflowId: p.workflowId,
            entryId: p.entryId,
            generation: p.generation,
            nodeId: c.node.id,
            run: runOf(c.key),
            nodeType: c.node.type,
            output: c.output,
            effectKey: c.fx,
            ranBy: c.actor.id,
          }),
        );
        (plan.nodes[c.node.id] as { status: string }).status = 'rolled_back';
        await report(
          {
            node: { id: c.node.id, status: 'rolled_back', summary: message },
            log: {
              at: act.now(),
              nodeId: c.node.id,
              kind: 'rollback',
              message: `${c.node.label}: ${message}${asWho(c.actor, p)}`,
              key: `${c.fx}:rollback`,
            },
          },
          true,
        );
      } catch (err) {
        undoFailed = true;
        await report(
          {
            log: {
              at: act.now(),
              nodeId: c.node.id,
              kind: 'rollback',
              message: `${c.node.label}: could not undo (${err instanceof Error ? err.message : String(err)})`,
              key: `${c.fx}:rollback`,
            },
          },
          true,
        );
      }
    }
    const outcome = compensable.length && !undoFailed ? 'rolled_back' : 'failed';
    await snapshot(outcome, { reason });
    return { outcome, reason };
  }

  const outcome = end?.outcome ?? 'completed';
  const reason = end?.reason ?? '';
  await snapshot(outcome, { reason });
  return { outcome, reason };
}

async function runNode(
  steps: WorkflowSteps,
  act: GraphActivities,
  p: WorkflowRunParams,
  plan: PlanState,
  ctx: RunContext,
  node: WorkflowNode,
  key: string,
  reportRaw: (r: Omit<RunReport, 'seq' | 'generation'>, durable?: boolean) => Promise<void>,
  actor: WorkflowRunActor,
): Promise<Outcome> {
  const spec = nodeSpec(node.type);
  const config = withDefaults(node.type, node.config);
  const fx = effectKey(p.generation, key);
  // Every node report names the node's label and type: run lists say where a run waits or
  // stopped, and a node's finished run is recorded with its type.
  const report: typeof reportRaw = (r, durable) =>
    reportRaw(
      r.node
        ? { ...r, node: { label: node.label, type: node.type, ranBy: actor.id, ...r.node } }
        : r,
      durable,
    );
  const nodeInput = (retriesLeft: boolean): ExecuteWorkflowNodeInput => ({
    scope: p.scope,
    runId: p.runId,
    workflowId: p.workflowId,
    entryId: p.entryId,
    actor,
    node,
    run: ctx,
    effectKey: fx,
    retriesLeft,
  });

  /** Opens a wait, waits for its event and closes it; null payload means it timed out. */
  const waitFor = async (
    wait: Omit<PendingWait, 'deadline' | 'since'>,
    timeout: string,
    name: string,
  ): Promise<Record<string, unknown> | null> => {
    const ms = durationMs(timeout);
    // An event delivered before the wait opened comes back from the memoized `:open` step, so
    // the run takes it without waiting, and a replay takes it again.
    const early = await steps.do(`${key}:open`, async () => {
      const now = act.now();
      return act.openWait(p.scope, p.runId, { ...wait, since: now, deadline: now + ms });
    });
    if (early) return early;
    try {
      const ev = await steps.waitForEvent<Record<string, unknown>>(name, {
        type: wait.eventType,
        timeout: ms,
      });
      return (ev.payload ?? {}) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const close = (eventType: string, branch: string, payload: Record<string, unknown>) =>
    steps.do(`${key}:close`, async () => {
      await act.closeWait(p.scope, p.runId, eventType, branch, payload, node.label);
      return true;
    });

  switch (node.type) {
    case 'control.approval':
    case 'control.wait_event': {
      const approval = node.type === 'control.approval';
      const eventType = eventTypeFor(approval ? 'approval' : 'event', fx);
      // The default comes from the node spec (filled by withDefaults), never from here.
      const timeout = str(config.timeout);
      const payload = await waitFor(
        {
          nodeId: node.id,
          eventType,
          kind: approval ? 'approval' : 'event',
          title: approval ? interpolate(str(config.title), ctx) || node.label : node.label,
          ...(approval
            ? {
                assignee: str(config.assignee),
                instructions: interpolate(str(config.instructions), ctx),
                requiredScope: str(config.requiredScope),
                // Unset follows the space's default.
                ...(typeof config.separateDuties === 'boolean'
                  ? { separateDuties: config.separateDuties }
                  : {}),
              }
            : { event: str(config.event) }),
        },
        timeout,
        key,
      );
      const branch = approval
        ? payload === null
          ? 'escalated'
          : payload.decision === 'approved'
            ? 'approved'
            : 'rejected'
        : payload === null
          ? 'timeout'
          : 'received';
      // An approval approved by a person names them; the run acts as them downstream. The
      // principal stays out of the output (it lands in vars-visible node outputs and reports).
      const approver = approval && branch === 'approved' ? approverOf(payload) : null;
      const { actor: _actor, ...shown } = payload ?? {};
      await close(eventType, branch, shown);
      const result: NodeResult = {
        branches: [branch],
        output: { ...shown, outcome: branch },
        summary: approval
          ? branch === 'escalated'
            ? 'Timed out'
            : `${branch}${payload?.by ? ` by ${String(payload.by)}` : ''}`
          : branch === 'received'
            ? 'Received'
            : 'Timed out',
        ...(approval ? {} : { vars: { [eventVar(str(config.event))]: payload } }),
      };
      await report(
        {
          node: {
            id: node.id,
            type: node.type,
            summary: result.summary,
            output: result.output,
            endedAt: act.now(),
          },
        },
        true,
      );
      return { kind: 'complete', result, ...(approver ? { approver } : {}) };
    }

    case 'control.wait': {
      const until =
        config.until !== undefined && config.until !== null && config.until !== ''
          ? await steps.do(`${key}:until`, async () => {
              const v = evaluateLogic(config.until, { ...ctx, now: act.now() });
              const at = typeof v === 'string' ? Date.parse(v) : Number(v);
              return Number.isFinite(at) ? at : 0;
            })
          : 0;
      // The timer's run starts now (a replay keeps the first start): run lists show it waiting.
      await report({ node: { id: node.id, startedAt: act.now() } }, true);
      if (until > 0) await steps.sleepUntil(key, until);
      else await steps.sleep(key, durationMs(str(config.duration)));
      const result: NodeResult = {
        summary: until
          ? `Until ${new Date(until).toISOString()}`
          : `Waited ${str(config.duration)}`,
      };
      await report({ node: { id: node.id, summary: result.summary, endedAt: act.now() } }, true);
      return { kind: 'complete', result };
    }

    case 'control.loop': {
      const runs = plan.nodes[node.id]?.runs ?? 1;
      const max = Number(config.maxIterations ?? 12);
      const next = await steps.do(
        key,
        async () => runs <= max && logicHolds(config.while ?? true, { ...ctx, now: act.now() }),
      );
      const result: NodeResult = {
        output: { iteration: runs, next },
        summary: next ? `Iteration ${runs}` : `Done after ${runs - 1}`,
      };
      await report({ node: { id: node.id, summary: result.summary, output: result.output } }, true);
      return { kind: 'loop', next, result };
    }

    case 'control.end': {
      const outcome = (str(config.outcome) || 'completed') as EndOutcome;
      // Interpolated from the entry's data, which can be any length.
      const reason = capReason(interpolate(str(config.reason), ctx));
      await report({ node: { id: node.id, summary: reason || outcome } }, true);
      return { kind: 'end', outcome, reason };
    }

    case 'control.continue_as_new':
      // Started after the batch is applied.
      return { kind: 'continue' };
  }

  const retries = node.retries ?? spec?.retries ?? 3;
  const failed = async (message: string): Promise<Outcome> => {
    await report(
      {
        node: {
          id: node.id,
          type: node.type,
          status: 'failed',
          error: message,
          endedAt: act.now(),
        },
        log: {
          at: act.now(),
          nodeId: node.id,
          kind: 'node',
          message: `${node.label} failed: ${capReason(message, 500)}`,
          key: `${fx}:failed`,
        },
      },
      true,
    );
    // The run's reason is a short summary; the full message stays on the node's run.
    return { kind: 'failed', reason: failureReason(node.label, message) };
  };
  const finished = (r: NodeResult) =>
    report(
      {
        node: {
          id: node.id,
          type: node.type,
          summary: r.summary,
          output: r.output,
          endedAt: act.now(),
        },
        log: {
          at: act.now(),
          nodeId: node.id,
          kind: node.type.startsWith('ai.') ? 'ai' : 'node',
          // "Publish: Published version 2 · as editor@example.com" when not the starter.
          message: `${node.label}: ${r.summary ?? 'done'}${asWho(actor, p)}`,
          key: fx,
        },
      },
      true,
    );

  let result: NodeResult;
  try {
    result = await steps.do(
      key,
      {
        retries: { limit: retries, delay: '5 seconds', backoff: 'exponential' },
        timeout: node.timeout ?? '5 minutes',
      },
      async (sctx) => {
        await report(
          {
            node: { id: node.id, startedAt: act.now() },
            ...(sctx.attempt > 1
              ? {
                  log: {
                    at: act.now(),
                    nodeId: node.id,
                    kind: 'node' as const,
                    message: `${node.label}: attempt ${sctx.attempt}`,
                    key: `${fx}:a${sctx.attempt}`,
                  },
                }
              : {}),
          },
          true,
        );
        // `limit` retries after the first try: attempt `retries + 1` is the last, where a model
        // node answers with its fallback instead of throwing.
        const r = await act.executeNode(nodeInput(sctx.attempt <= retries));
        if (!r.failed && !r.wait) await finished(r);
        return r;
      },
    );
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  if (result.failed) return failed(result.failed);

  if (result.wait) {
    const w = result.wait;
    const payload = await waitFor(
      {
        nodeId: node.id,
        eventType: w.eventType,
        kind: w.kind,
        title: w.title,
        ...(w.requiredScope ? { requiredScope: w.requiredScope } : {}),
        ...(w.instructions ? { instructions: w.instructions } : {}),
        ...(w.assignee ? { assignee: w.assignee } : {}),
        ...(w.reviewId ? { reviewId: w.reviewId } : {}),
      },
      w.timeout,
      `${key}:wait`,
    );
    let resumed: NodeResult;
    try {
      resumed = await steps.do(`${key}:resume`, async (sctx) =>
        act.resumeNode({ ...nodeInput(sctx.attempt <= retries), before: result, payload }),
      );
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
    await close(w.eventType, resumed.branches?.[0] ?? (payload ? 'received' : 'timeout'), {
      ...(payload ?? {}),
    });
    if (resumed.failed) return failed(resumed.failed);
    await finished(resumed);
    return { kind: 'complete', result: resumed };
  }
  return { kind: 'complete', result };
}
