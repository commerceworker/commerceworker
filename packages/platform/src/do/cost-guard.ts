import { DurableObject } from 'cloudflare:workers';
import {
  type AiBudgetLimits,
  agentBudgetLimits,
  aiBudgetLimits,
} from '@commerceworker/application';
import type { Scope } from '@commerceworker/domain';
import type { AiBudgetDecision, CostGuard } from '@commerceworker/ports';
import type { EdgeEnv } from '../env';

const STATE_KEY = 'window';

/** DO-name prefix for the background (agent) counter windows. */
export const AGENT_WINDOW_PREFIX = 'agent:';

const DEFAULT_LIMITS: AiBudgetLimits = { maxRequests: 60, maxTokens: 200_000, windowSeconds: 60 };

const envRecord = (env: EdgeEnv) => env as unknown as Record<string, string | undefined>;

/**
 * Which ceilings a counter window enforces. Passed explicitly on every call
 * because a Durable Object cannot see its own idFromName name
 * (`this.ctx.id.name` is only populated on the caller's stub id).
 */
export type BudgetWindowKind = 'interactive' | 'agent';

interface WindowState {
  start: number;
  requests: number;
  tokens: number;
}

/**
 * AI budget governor as a Durable Object — one object per space, so
 * the request/token window is global across isolates and colos (an in-process
 * guard can't share state across isolates). An alarm GCs idle
 * windows.
 */
export class CostGuardDO extends DurableObject<EdgeEnv> {
  // Background (`agent`) windows prefer the AI_AGENT_* ceilings — the same
  // override semantics as the application's agentBudgetLimits — and fall back
  // to the interactive ones.
  private limitsFor(kind: BudgetWindowKind): AiBudgetLimits {
    const rec = envRecord(this.env);
    return (
      (kind === 'agent' ? agentBudgetLimits(rec) : undefined) ??
      aiBudgetLimits(rec) ??
      DEFAULT_LIMITS
    );
  }

  private async current(windowMs: number): Promise<WindowState> {
    const s = await this.ctx.storage.get<WindowState>(STATE_KEY);
    const now = Date.now();
    if (!s || now - s.start >= windowMs) return { start: now, requests: 0, tokens: 0 };
    return s;
  }

  async consume(kind: BudgetWindowKind = 'interactive'): Promise<AiBudgetDecision> {
    const limits = this.limitsFor(kind);
    const windowMs = limits.windowSeconds * 1000;
    const s = await this.current(windowMs);
    s.requests += 1;
    await this.ctx.storage.put(STATE_KEY, s);
    await this.ctx.storage.setAlarm(s.start + windowMs * 2);
    const retryAfterSeconds = Math.ceil((s.start + windowMs - Date.now()) / 1000);
    if (s.tokens >= limits.maxTokens) {
      return { allowed: false, reason: 'tokens', retryAfterSeconds };
    }
    if (s.requests > limits.maxRequests) {
      return { allowed: false, reason: 'requests', retryAfterSeconds };
    }
    return { allowed: true };
  }

  async settle(tokens: number, kind: BudgetWindowKind = 'interactive'): Promise<void> {
    if (tokens <= 0) return;
    const s = await this.current(this.limitsFor(kind).windowSeconds * 1000);
    s.tokens += tokens;
    await this.ctx.storage.put(STATE_KEY, s);
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** CostGuard over the per-space CostGuardDO namespace. */
export function createDoCostGuard(
  ns: DurableObjectNamespace<CostGuardDO>,
  namePrefix = '',
): CostGuard {
  // A prefix gives an independent counter window per space (e.g. `agent:` for
  // background agent spend) while reusing the same DO class. The prefix also
  // selects which ceilings that window enforces.
  const kind: BudgetWindowKind = namePrefix === AGENT_WINDOW_PREFIX ? 'agent' : 'interactive';
  const stub = (scope: Scope) => ns.get(ns.idFromName(`${namePrefix}${scope.spaceId}`));
  return {
    consume: (scope) => stub(scope).consume(kind),
    settle: async (scope, tokens) => {
      await stub(scope).settle(tokens, kind);
    },
  };
}

/**
 * Interactive AI budget guard from the environment: `undefined` when the
 * AI_BUDGET namespace is unbound or either ceiling is 0 — metering disabled,
 * the same semantics as the application's aiBudgetLimits.
 */
export function doCostGuardFromEnv(env: EdgeEnv): CostGuard | undefined {
  if (!env.AI_BUDGET || !aiBudgetLimits(envRecord(env))) return undefined;
  return createDoCostGuard(env.AI_BUDGET);
}

/**
 * Background (agent) budget guard: an independent `agent:` counter window per
 * space so batch spend can't exhaust the interactive budget. The window
 * enforces the AI_AGENT_* ceilings when set (see CostGuardDO), else the
 * interactive ones. `undefined` when unbound or every ceiling disables
 * metering.
 */
export function doAgentCostGuardFromEnv(env: EdgeEnv): CostGuard | undefined {
  if (!env.AI_BUDGET) return undefined;
  const rec = envRecord(env);
  if (!agentBudgetLimits(rec) && !aiBudgetLimits(rec)) return undefined;
  return createDoCostGuard(env.AI_BUDGET, AGENT_WINDOW_PREFIX);
}
