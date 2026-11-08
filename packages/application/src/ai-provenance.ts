import type { ModelTier } from '@commerceworker/ports';

/** Which path produced an AI-backed value: the model, or the deterministic heuristic. */
export type AiSource = 'model' | 'heuristic';

/**
 * Where a value from {@link generateJson} came from, recorded alongside it
 * (on a workflow node run, an agent review, …) so a reader can tell a model's
 * answer from the heuristic's, and why the heuristic answered.
 */
export interface AiProvenance {
  readonly source: AiSource;
  /** The tier that answered; null when the heuristic did. */
  readonly tier: ModelTier | null;
  /** Stable id of the prompt (e.g. `workflow.router`), for logs and evaluation. */
  readonly prompt: string;
  /**
   * Why the heuristic answered: `mock` (AI_MODE=mock), or the failure —
   * a timeout, a provider error, a budget refusal, an answer off the schema.
   */
  readonly fallback?: string;
}

/** One line per model call, for the fallback rate and latency. */
export interface AiCallRecord extends AiProvenance {
  readonly type: 'ai_call';
  readonly ms: number;
  readonly tokens?: number;
  /** Set when the call failed and the caller (a durable step) will retry it. */
  readonly retrying?: string;
}

/** Heuristic answers that aren't a failure. */
const EXPECTED_FALLBACKS = new Set(['mock']);

/**
 * A heuristic answer the model *should* have given — anything but mock mode.
 * Gating nodes (moderation, routers) treat this as "unchecked" and fail closed
 * to review, rather than letting a guess wave content through.
 */
export function isUncheckedFallback(p: AiProvenance): boolean {
  return p.source === 'heuristic' && !EXPECTED_FALLBACKS.has(String(p.fallback));
}

/** Severity for a call record: unexpected fallbacks are warnings (and alert-worthy). */
export function aiCallLevel(r: AiCallRecord): 'info' | 'warn' {
  return r.retrying || isUncheckedFallback(r) ? 'warn' : 'info';
}
