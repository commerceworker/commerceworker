/**
 * A model turn against the space's AI budget (`CostGuard`, the CostGuardDO on the edge), the way
 * any other AI call is metered: every model step is one request (`consume`), and the turn's
 * tokens are settled once, however it ends (finished, aborted, failed). A step the budget refuses
 * aborts the turn. Steps the mock model answers cost nothing and aren't counted.
 */

import type { Scope } from '@commerceworker/domain';
import type { CostGuard } from '@commerceworker/ports';

export const BUDGET_SPENT = 'This space’s AI budget is spent for now. Try again in a minute.';

export interface TurnMeter {
  /** Aborts the turn when a step is over budget; combine with the caller's own signal. */
  readonly signal: AbortSignal;
  /** Before the turn: its first step's request; false when the budget is spent already. */
  begin(): Promise<boolean>;
  /** Before each later step: one request against the budget. */
  prepareStep(options: { stepNumber: number }): Promise<undefined>;
  /** After a step: its tokens, to settle with the turn. */
  onStepFinish(step: { usage: { totalTokens?: number | undefined } }): void;
  /** However the turn ends: settles once, then releases what the turn held. */
  settle(): Promise<void>;
}

export function meterTurn(
  guard: CostGuard | undefined,
  scope: Scope,
  /** Whether a real model is answering now (the mock isn't metered). */
  metered: () => boolean,
  /** Called once the turn has ended and been settled (closes the turn's wiring). */
  done: () => void,
): TurnMeter {
  const controller = new AbortController();
  let tokens = 0;
  let consumed = false;
  let settled = false;
  return {
    signal: controller.signal,
    async begin() {
      if (!guard || !metered()) return true;
      consumed = true;
      return (await guard.consume(scope)).allowed;
    },
    async prepareStep({ stepNumber }) {
      // The first step was counted by `begin`.
      if (stepNumber === 0 || !guard || !metered() || controller.signal.aborted) return undefined;
      consumed = true;
      if (!(await guard.consume(scope)).allowed) controller.abort(new Error(BUDGET_SPENT));
      return undefined;
    },
    onStepFinish(step) {
      tokens += step.usage.totalTokens ?? 0;
    },
    async settle() {
      if (settled) return;
      settled = true;
      try {
        if (guard && consumed) await guard.settle(scope, tokens);
      } catch (err) {
        console.error('assistant: settling the AI budget failed', err);
      } finally {
        done();
      }
    },
  };
}
