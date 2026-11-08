/**
 * Expressions over the run context. Conditions are JSON Logic (data, not code: safe to store and
 * to accept from the copilot); text fields interpolate `{{path.to.value}}`.
 *
 * The domain package has no runtime dependencies, so this is a vendored minimal evaluator with
 * `json-logic-js` semantics for the operators workflows use: `var`, `missing`, `== === != !== > >= < <=`
 * (including the 3-argument "between" forms of `<`/`<=`), `and or ! !!`, `+ - * / %`, `min max`,
 * `cat`, `in`, `if`/`?:`, plus the custom `len`, `now` and `days`.
 *
 * `now` reads the run context's `now` instead of `Date.now()`, so an expression
 * evaluates the same way on replay.
 */

/** The entry a run is about, as expressions see it. */
export interface RunEntry {
  id: string;
  contentTypeApiId: string;
  status?: string;
  currentVersion?: number;
  publishedVersion?: number | null;
  /** fieldApiId -> locale -> value. */
  fields?: Record<string, Record<string, unknown>>;
  tags?: string[];
  /** The entry's display title, when the content type has one. */
  title?: string;
  [key: string]: unknown;
}

/** What every expression and template sees while a workflow runs. */
export interface RunContext {
  entry: RunEntry;
  /** Output of each node that has run, by node id (latest iteration). */
  nodes: Record<string, unknown>;
  vars: Record<string, unknown>;
  /** The payload of the trigger. */
  input: Record<string, unknown>;
  /** Epoch ms; deterministic per run step. */
  now: number;
  /** How people know the entry: see {@link entryReference}. */
  ref: string;
}

/** The reference people recognise: the entry's title, else its id. Port of `orderReference`. */
export function entryReference(entry: Pick<RunEntry, 'id' | 'title'>): string {
  return entry.title || entry.id;
}

/** JSON Logic truthiness: an empty array is falsy, otherwise JavaScript's. */
export function logicTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const isLogic = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number.parseFloat(String(v)));

/** JavaScript's loose equality, as JSON Logic's `==` is defined. */
// biome-ignore lint/suspicious/noDoubleEquals: JSON Logic `==` is loose equality by definition.
const looseEq = (a: unknown, b: unknown): boolean => a == b;

type Lt = (a: unknown, b: unknown) => boolean;
const lt: Lt = (a, b) => (a as number) < (b as number);
const le: Lt = (a, b) => (a as number) <= (b as number);

/** Plain operations: arguments are evaluated before the operation runs. */
const OPS: Record<string, (args: unknown[], data: unknown) => unknown> = {
  var: ([path, fallback], data) => {
    const p = path === undefined || path === null ? '' : String(path);
    if (p === '') return data;
    const v = getPath(data, p);
    return v === undefined || v === null ? (fallback ?? null) : v;
  },
  missing: (args, data) => {
    const keys = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    return keys.filter((k) => {
      const v = getPath(data, String(k));
      return v === undefined || v === null || v === '';
    });
  },
  '==': ([a, b]) => looseEq(a, b),
  '===': ([a, b]) => a === b,
  '!=': ([a, b]) => !looseEq(a, b),
  '!==': ([a, b]) => a !== b,
  '>': ([a, b]) => lt(b, a),
  '>=': ([a, b]) => le(b, a),
  '<': ([a, b, c]) => (c === undefined ? lt(a, b) : lt(a, b) && lt(b, c)),
  '<=': ([a, b, c]) => (c === undefined ? le(a, b) : le(a, b) && le(b, c)),
  '!': ([a]) => !logicTruthy(a),
  '!!': ([a]) => logicTruthy(a),
  '+': (args) => args.reduce<number>((s, v) => s + num(v), 0),
  '*': (args) => args.reduce<number>((s, v) => s * num(v), 1),
  '-': ([a, b]) => (b === undefined ? -num(a) : num(a) - num(b)),
  '/': ([a, b]) => num(a) / num(b),
  '%': ([a, b]) => num(a) % num(b),
  min: (args) => Math.min(...args.map(num)),
  max: (args) => Math.max(...args.map(num)),
  cat: (args) => args.map((v) => (v === null || v === undefined ? '' : String(v))).join(''),
  in: ([a, b]) => {
    if (typeof b === 'string') return b.includes(String(a));
    if (Array.isArray(b)) return b.includes(a);
    return false;
  },
  // Custom operations.
  len: ([v]) => (Array.isArray(v) ? v.length : typeof v === 'string' ? v.length : 0),
  now: (_args, data) => {
    const n = (data as { now?: unknown } | null)?.now;
    return typeof n === 'number' ? n : 0;
  },
  days: ([n]) => num(n) * 86_400_000,
};

function apply(expression: unknown, data: unknown): unknown {
  if (Array.isArray(expression)) return expression.map((x) => apply(x, data));
  if (!isLogic(expression)) return expression;
  const op = Object.keys(expression)[0] as string;
  const raw = expression[op];
  const args = Array.isArray(raw) ? raw : [raw];

  // Lazy operations evaluate only what they need.
  switch (op) {
    case 'if':
    case '?:': {
      let i = 0;
      for (; i < args.length - 1; i += 2) {
        if (logicTruthy(apply(args[i], data))) return apply(args[i + 1], data);
      }
      return i === args.length - 1 ? apply(args[i], data) : null;
    }
    case 'and': {
      let v: unknown;
      for (const a of args) {
        v = apply(a, data);
        if (!logicTruthy(v)) return v;
      }
      return v;
    }
    case 'or': {
      let v: unknown;
      for (const a of args) {
        v = apply(a, data);
        if (logicTruthy(v)) return v;
      }
      return v;
    }
  }

  const fn = OPS[op];
  if (!fn) throw new Error(`Unrecognized operation ${op}`);
  return fn(
    args.map((a) => apply(a, data)),
    data,
  );
}

/** Evaluates a JSON Logic expression against the run context. Non-objects are returned as-is. */
export function evaluateLogic(expression: unknown, ctx: RunContext): unknown {
  if (expression === undefined || expression === null) return expression;
  if (typeof expression !== 'object') return expression;
  return apply(expression, ctx);
}

export function logicHolds(expression: unknown, ctx: RunContext): boolean {
  return logicTruthy(evaluateLogic(expression, ctx));
}

/** The operators the vendored evaluator understands (for config validation and the copilot). */
export const LOGIC_OPERATORS: readonly string[] = ['if', '?:', 'and', 'or', ...Object.keys(OPS)];

/**
 * Problems with an expression's shape without running it: unknown operators, found anywhere.
 * Returns messages (empty when the expression is well-formed).
 */
export function logicIssues(expression: unknown): string[] {
  const issues = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }
    if (!isLogic(x)) return;
    const op = Object.keys(x)[0] as string;
    if (!LOGIC_OPERATORS.includes(op)) issues.add(`Unknown operator “${op}”`);
    walk(x[op]);
  };
  walk(expression);
  return [...issues];
}

export function interpolate(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = getPath(ctx, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
