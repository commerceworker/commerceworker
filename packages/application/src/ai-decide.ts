import { RateLimitedError, type Scope } from '@commerceworker/domain';
import type {
  DecisionAnswer,
  DecisionModel,
  DecisionRequest,
  ModelTier,
} from '@commerceworker/ports';
import { decideWithBudget } from './ai-budget';
import type { AiCallRecord, AiProvenance } from './ai-provenance';
import type { AppContext } from './context';

/**
 * Decisions with the same guarantees as {@link generateJson}: the caller always gets answers to
 * every question, with provenance saying whether the model or the caller's heuristic gave them.
 *
 * A decision model can only answer the questions asked, from the options they define, so there is
 * no schema to check and no free text to parse; what remains is the path when the model can't
 * answer at all. AI_MODE=mock and a budget refusal answer with the heuristic; a failure throws
 * while the caller (a durable step) can retry, then answers with the heuristic; every call is
 * logged as an `ai_call` record, so the fallback rate covers decisions too.
 */

/** A decision call's cap, as a generation's (`AI_TIMEOUT_MS`, default 20 s). */
const DEFAULT_DECISION_TIMEOUT_MS = 20_000;

export interface DecideOptions {
  /** Stable id of the decision (e.g. `workflow.classify`), for logs and evaluation. */
  readonly prompt: string;
  /** The answers when the model gives none: mock mode, a budget refusal, a final failure. */
  readonly fallback: () => Record<string, DecisionAnswer>;
  /** The caller retries a failed call itself (a durable step with attempts left). */
  readonly retry?: boolean;
  readonly timeoutMs?: number;
}

export interface DecideResult extends AiProvenance {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** The model that answered (absent when the heuristic did). */
  readonly model?: string;
}

export async function decide(
  ctx: AppContext,
  model: DecisionModel,
  scope: Scope,
  req: DecisionRequest,
  opts: DecideOptions,
): Promise<DecideResult> {
  const tier: ModelTier = req.tier ?? 'fast';
  const started = ctx.clock.now().getTime();
  const log = (record: Omit<AiCallRecord, 'type' | 'ms'>) =>
    ctx.ai?.log?.({ type: 'ai_call', ms: ctx.clock.now().getTime() - started, ...record });
  const heuristic = (reason: string): DecideResult => {
    const p: AiProvenance = {
      source: 'heuristic',
      tier: null,
      prompt: opts.prompt,
      fallback: reason,
    };
    log(p);
    return { ...p, answers: opts.fallback() };
  };

  if (ctx.ai?.mode === 'mock') return heuristic('mock');
  try {
    const result = await withTimeout(
      decideWithBudget(ctx, model, scope, { ...req, tier }),
      opts.timeoutMs ?? ctx.ai?.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
    );
    const p: AiProvenance = { source: 'model', tier, prompt: opts.prompt };
    log({ ...p, tokens: result.usage.inputTokens });
    return { ...p, answers: result.answers, model: result.model };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof RateLimitedError) return heuristic(`budget: ${reason}`);
    if (opts.retry) {
      log({ source: 'heuristic', tier, prompt: opts.prompt, retrying: reason });
      throw new Error(`The decision call failed (${reason}); trying again`);
    }
    return heuristic(reason);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
