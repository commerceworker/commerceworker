import type {
  DecisionAnswer,
  DecisionModel,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  ModelTier,
} from '@commerceworker/ports';
import {
  asWorkersAIError,
  DEFAULT_TIMEOUT_MS,
  gatewayRunOptions,
  WorkersAIError,
  type WorkersAiRun,
  withTimeout,
} from './transport';

/**
 * Tier → Clef decision model. Clef for anything that wants precision, Clef-flash (about 13x faster
 * and far cheaper) for the hot path.
 */
export const WORKERS_AI_DECISION_MODEL_BY_TIER: Readonly<
  Record<ModelTier, { readonly id: string; readonly selector: string }>
> = {
  flagship: { id: '@cf/cloudflare/clef', selector: 'clef' },
  balanced: { id: '@cf/cloudflare/clef', selector: 'clef' },
  fast: { id: '@cf/cloudflare/clef-flash', selector: 'clef-flash' },
};

/** Questions per request: the System One API's ceiling. */
export const MAX_DECISION_QUESTIONS = 64;

export interface WorkersAIDecisionOptions {
  run: WorkersAiRun;
  /** AI Gateway id (AI_GATEWAY_ID); empty calls Workers AI directly. */
  gatewayId?: string;
  /** As the generation adapter's `collectLogs`; payloads are never logged. */
  collectLogs?: boolean;
  timeoutMs?: number;
}

/** A question as the System One API takes it. */
function toWire(q: DecisionQuestion): Record<string, unknown> {
  if (q.type === 'noul') {
    return {
      type: 'noul',
      instructions: q.instructions,
      ...(q.criteria ? { criteria: q.criteria } : {}),
    };
  }
  if (q.type === 'choice')
    return { type: 'choice', instructions: q.instructions, criteria: q.options };
  return { type: 'score', instructions: q.instructions, criteria: [...q.levels] };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * One answer, checked against its question: a probability outside [0, 1], a choice that isn't one
 * of the options, or a missing field is a bad response, never a guess.
 */
function fromWire(id: string, q: DecisionQuestion, raw: unknown): DecisionAnswer {
  const a = (raw ?? {}) as Record<string, unknown>;
  const bad = (why: string) => new WorkersAIError('bad_response', `Decision "${id}": ${why}`);
  if (q.type === 'noul') {
    const p = isNum(a.noul) ? a.noul : isNum(a.probability) ? a.probability : undefined;
    if (p === undefined) throw bad('no probability');
    return { type: 'noul', probability: clamp01(p) };
  }
  if (q.type === 'choice') {
    const choice = a.choice;
    if (typeof choice !== 'string' || !Object.hasOwn(q.options, choice)) {
      throw bad('not one of the options');
    }
    const probs = (a.probabilities ?? {}) as Record<string, unknown>;
    const probabilities: Record<string, number> = {};
    for (const option of Object.keys(q.options)) {
      probabilities[option] = clamp01(isNum(probs[option]) ? probs[option] : 0);
    }
    // Probabilities missing (or keyed some other way): the model's choice carries its confidence,
    // so nothing downstream can re-derive a different option from an empty spread.
    const sum = Object.values(probabilities).reduce((n, p) => n + p, 0);
    const stated = isNum(a.confidence) ? clamp01(a.confidence) : undefined;
    if (sum === 0) probabilities[choice] = stated ?? 1;
    const top = Math.max(...Object.values(probabilities));
    if ((probabilities[choice] ?? 0) < top) throw bad('the choice is not the most probable option');
    const confidence = stated ?? probabilities[choice] ?? 0;
    return { type: 'choice', choice, confidence, probabilities };
  }
  const score = a.score;
  if (!isNum(score)) throw bad('no score');
  // Per-level probabilities as an array (by level) or an object (by index or label).
  const raws = a.probabilities;
  const probabilities = q.levels.map((label, i) => {
    if (Array.isArray(raws)) return clamp01(isNum(raws[i]) ? raws[i] : 0);
    const byKey = (raws ?? {}) as Record<string, unknown>;
    const v = byKey[String(i)] ?? byKey[label];
    return clamp01(isNum(v) ? v : 0);
  });
  const clamped = Math.min(q.levels.length - 1, Math.max(0, score));
  // No per-level probabilities: all of it at the level the score is nearest.
  if (!probabilities.some((p) => p > 0)) probabilities[Math.round(clamped)] = 1;
  return { type: 'score', score: clamped, probabilities };
}

/**
 * Cloudflare Workers AI implementation of the DecisionModel port, over Clef. Transport-agnostic
 * like the generation adapter: everything goes through the injected `run`, routed through AI
 * Gateway when configured. Every failure is a {@link WorkersAIError}.
 */
export function createWorkersAIDecisionModel(opts: WorkersAIDecisionOptions): DecisionModel {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runOpts = gatewayRunOptions(opts.gatewayId, opts.collectLogs);
  return {
    async decide(req: DecisionRequest): Promise<DecisionResult> {
      const ids = Object.keys(req.questions);
      if (ids.length === 0 || ids.length > MAX_DECISION_QUESTIONS) {
        throw new WorkersAIError(
          'config',
          `A decision takes 1 to ${MAX_DECISION_QUESTIONS} questions, not ${ids.length}`,
        );
      }
      const model = WORKERS_AI_DECISION_MODEL_BY_TIER[req.tier ?? 'fast'];
      const questions: Record<string, unknown> = {};
      for (const id of ids) questions[id] = toWire(req.questions[id] as DecisionQuestion);
      let res: {
        answers?: Record<string, unknown>;
        usage?: { input_tokens?: number; prompt_tokens?: number };
      };
      try {
        res = ((await withTimeout(
          opts.run(model.id, { model: model.selector, state: req.state, questions }, runOpts),
          timeoutMs,
        )) ?? {}) as typeof res;
      } catch (err) {
        throw asWorkersAIError(err);
      }
      const answers: Record<string, DecisionAnswer> = {};
      for (const id of ids) {
        answers[id] = fromWire(id, req.questions[id] as DecisionQuestion, res.answers?.[id]);
      }
      // System One reports input_tokens; Workers AI's own models prompt_tokens.
      const inputTokens = res.usage?.input_tokens ?? res.usage?.prompt_tokens ?? 0;
      return { answers, model: model.id, usage: { inputTokens } };
    },
  };
}
