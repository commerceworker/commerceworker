/**
 * Assessments for the `ai.assess` node: typed questions answered with a probability for every
 * allowed option. Pure: the application calls the model; this module validates questions, repairs
 * answers and picks the branch the node takes.
 *
 * Questions are validated by the hand-written {@link assessQuestionsIssues}. Images are deferred (the AI port has
 * no multimodal input yet).
 */

export type AssessQuestion =
  /** Yes/no: answered with the probability of yes. */
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  /** Pick one option: criteria maps option id to its description (or null). */
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  /** Rate on an ordered rubric, lowest level first; levels are indexed from 0. */
  | { type: 'score'; instructions: unknown; criteria: unknown[] };

export type AssessQuestions = Record<string, AssessQuestion>;

export type AssessAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: 'score';
      score: number;
      legend: Record<string, unknown>;
      probabilities: Record<string, number>;
      confidence: number;
    };
export type AssessAnswers = Record<string, AssessAnswer>;

export const ASSESS_ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/** The branch taken when an answer is below the node's confidence floor. */
export const UNSURE = 'unsure';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function instructionsOk(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return isRecord(v);
}

/** Why `v` isn't a valid questions object (empty when it is). */
export function assessQuestionsIssues(v: unknown): string[] {
  if (!isRecord(v)) return ['Expected an object of questions'];
  const entries = Object.entries(v);
  if (entries.length < 1 || entries.length > 64) return ['Ask 1 to 64 questions'];
  const issues: string[] = [];
  for (const [id, q] of entries) {
    if (!ASSESS_ID_RE.test(id)) {
      issues.push('Question ids use letters, digits, _ . - (max 100)');
      continue;
    }
    if (!isRecord(q)) {
      issues.push(`${id}: expected a question object`);
      continue;
    }
    if (!instructionsOk(q.instructions)) issues.push(`${id}: instructions are required`);
    if (q.type === 'noul') {
      if (q.criteria !== undefined && !isRecord(q.criteria)) {
        issues.push(`${id}: criteria must be { true?, false? }`);
      }
    } else if (q.type === 'choice') {
      const n = isRecord(q.criteria) ? Object.keys(q.criteria).length : 0;
      if (n < 2 || n > 255) issues.push(`${id}: A choice needs 2 to 255 options`);
    } else if (q.type === 'score') {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if (n < 2 || n > 10) issues.push(`${id}: A score needs 2 to 10 levels`);
    } else {
      issues.push(`${id}: type must be noul, choice or score`);
    }
  }
  return issues;
}

const parsedQuestions = (v: unknown): AssessQuestions | undefined =>
  assessQuestionsIssues(v).length ? undefined : (v as AssessQuestions);

/** The question a node branches on, if it names one that can branch (noul or choice). */
function branchQuestion(questions: unknown, branchOn: unknown) {
  if (typeof branchOn !== 'string' || !branchOn.trim()) return undefined;
  const q = parsedQuestions(questions)?.[branchOn.trim()];
  return q && q.type !== 'score' ? q : undefined;
}

/** Output handles: the options of the branch question (yes/no for noul), plus `unsure` with a floor. */
export function assessOutputs(
  questions: unknown,
  branchOn: unknown,
  minConfidence: unknown,
): string[] {
  const q = branchQuestion(questions, branchOn);
  if (!q) return ['out'];
  const outs = q.type === 'choice' ? Object.keys(q.criteria) : ['yes', 'no'];
  if (Number(minConfidence) > 0 && !outs.includes(UNSURE)) outs.push(UNSURE);
  return outs;
}

/** How certain an answer is, 0 to 1. Reported for choice and score; for noul it is |2p − 1|. */
export function answerConfidence(a: AssessAnswer): number {
  return a.type === 'noul' ? Math.abs(2 * a.noul - 1) : a.confidence;
}

/** The branch an answer selects. Score questions don't branch. */
export function assessBranch(a: AssessAnswer | undefined, minConfidence = 0): string {
  if (!a || a.type === 'score') return 'out';
  if (minConfidence > 0 && answerConfidence(a) < minConfidence) return UNSURE;
  return a.type === 'choice' ? a.choice : a.noul >= 0.5 ? 'yes' : 'no';
}

/** Config errors the field checks can't see: `branchOn` must name a question. */
export function assessConfigErrors(config: Record<string, unknown>): string[] {
  const branchOn = typeof config.branchOn === 'string' ? config.branchOn.trim() : '';
  const questions = parsedQuestions(config.questions);
  if (!branchOn || !questions) return [];
  const q = questions[branchOn];
  if (!q) return [`Branch on: no question “${branchOn}”`];
  if (q.type === 'score') {
    return [`Branch on: “${branchOn}” is a score; branch on a yes/no or choice`];
  }
  return [];
}

const unit = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(1, Math.max(0, n));
};

/** Probabilities over exactly `keys`, summing to 1 (uniform when the model gave none). */
function normalise(keys: string[], raw: unknown): Record<string, number> {
  const src = isRecord(raw) ? raw : {};
  const ps = keys.map((k) => unit(src[k]));
  const sum = ps.reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    keys.map((k, i) => [k, sum > 0 ? (ps[i] ?? 0) / sum : 1 / keys.length]),
  );
}

const argmax = (p: Record<string, number>) =>
  Object.entries(p).reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];

/**
 * Answers held to the questions asked: unknown ids dropped, only allowed options kept and
 * renormalised, everything in [0, 1], and a uniform answer for any question the model skipped.
 * The chosen option and the score are recomputed from the probabilities so they always agree.
 */
export function clampAnswers(questions: AssessQuestions, raw: unknown): AssessAnswers {
  const src = isRecord(raw) ? raw : {};
  const out: AssessAnswers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a: Record<string, unknown> = isRecord(src[id])
      ? (src[id] as Record<string, unknown>)
      : {};
    const conf = (p: Record<string, number>) =>
      typeof a.confidence === 'number' ? unit(a.confidence) : Math.max(...Object.values(p));
    if (q.type === 'noul') {
      out[id] = { type: 'noul', noul: typeof a.noul === 'number' ? unit(a.noul) : 0.5 };
    } else if (q.type === 'choice') {
      const probabilities = normalise(Object.keys(q.criteria), a.probabilities);
      out[id] = {
        type: 'choice',
        choice: argmax(probabilities),
        probabilities,
        confidence: conf(probabilities),
      };
    } else {
      const levels = q.criteria.map((_, i) => String(i));
      const probabilities = normalise(levels, a.probabilities);
      out[id] = {
        type: 'score',
        score: levels.reduce((s, l) => s + Number(l) * (probabilities[l] ?? 0), 0),
        legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
        probabilities,
        confidence: conf(probabilities),
      };
    }
  }
  return out;
}

/** One line per answer for logs and the timeline: `stale → yes (82%)`, `urgent 0.91`. */
export function describeAnswers(answers: AssessAnswers): string {
  return Object.entries(answers)
    .map(([id, a]) =>
      a.type === 'noul'
        ? `${id} ${a.noul.toFixed(2)}`
        : a.type === 'choice'
          ? `${id} → ${a.choice} (${Math.round((a.probabilities[a.choice] ?? 0) * 100)}%)`
          : `${id} ${a.score.toFixed(1)}/${Object.keys(a.probabilities).length - 1}`,
    )
    .join(' · ');
}
