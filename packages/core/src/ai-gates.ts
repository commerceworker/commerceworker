/**
 * What an AI gate decides when its answer can't be trusted to the model: the heuristic answered
 * because the model was unavailable (outside simulated AI). Both fail closed, towards a person.
 */

/**
 * Risk score's branch and the `risk` it records. A checked score is `high` at or above the
 * threshold. An unchecked one is always `high`, recorded at least at the threshold, so a condition
 * on `vars.risk` downstream agrees with the branch.
 */
export function riskBranch(
  score: number,
  threshold: number,
  unchecked: boolean,
): { branch: 'high' | 'low'; risk: number } {
  if (unchecked) return { branch: 'high', risk: Math.max(score, threshold) };
  return { branch: score >= threshold ? 'high' : 'low', risk: score };
}

/**
 * The router's route when the model was unavailable: `needs_approval` when the router has it, so a
 * person looks; otherwise the heuristic's route, which the router's guards still check.
 */
export function uncheckedRoute(routes: readonly string[], heuristic: string): string {
  return routes.includes('needs_approval') ? 'needs_approval' : heuristic;
}
