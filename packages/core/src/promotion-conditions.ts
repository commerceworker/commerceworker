/**
 * A promotion's `condition`: a JSON Logic expression, the same engine and the same variable names
 * as a flow's expressions (`order.channel`, `order.lines`, `now`), run against a smaller context
 * built here from the order being priced. It sits beside the typed fields (`minSubtotal`, `skus`,
 * `customerId`, dates), which stay the fast, structured form; a promotion applies only when both
 * hold.
 *
 * What a condition may say is checked once when it is written (`promotionConditionProblem`) and
 * again before every evaluation, so a stored row that skipped the check never qualifies an order.
 * Only the variables below and a short list of operators are allowed: no `method` calls (which
 * reach into objects), no clock (`now` is a variable, so a step's replay sees the same time), and
 * caps on size, depth and nested iteration.
 */

import { checkAddress } from './address';
import { money, toBase, truthy } from './logic';
import type { OrderLine } from './types';

/** The most a stored condition may take, as JSON. */
export const MAX_CONDITION_LENGTH = 4000;
const MAX_NODES = 200;
const MAX_DEPTH = 12;
/** `map`/`filter`/`some`… inside one another: two deep covers "a line of X with qty over Y". */
const MAX_ITERATION_DEPTH = 2;
export const MAX_CONDITION_MESSAGE = 200;

/** Every variable a condition may read, with what it holds. Documented in the promotions guide. */
export const PROMOTION_CONDITION_VARIABLES = {
  now: 'When the order is priced, epoch ms',
  'order.channel': 'Where the order came in: web, pos, api, …',
  'order.currency': "The order's currency",
  'order.subtotal': "The lines' total in the order's currency, before shipping and tax",
  'order.baseSubtotal': 'The same subtotal in the base currency',
  'order.customerId': "The buyer's customer id, or null for a guest",
  'order.lines': 'The lines: each has sku, name, qty and unitPrice',
  'order.meta.shipTo.country': 'Two-letter ship-to country (US, GB, …), or null',
  'order.meta.shipTo.region': 'Ship-to state or province code (IL, ON, …), or null',
  'customer.id': "The buyer's customer id, or null for a guest",
  'customer.kind': 'business, consumer or internal, or null for a guest',
  'customer.tier': "The customer's pricing tier, or null for a guest",
} as const;

/** What each line carries, in a condition and inside `map`, `filter`, `some`… over the lines. */
export const PROMOTION_CONDITION_LINE_FIELDS = ['sku', 'name', 'qty', 'unitPrice'] as const;

/** The JSON Logic operations a condition may use; the rest are refused. */
export const PROMOTION_CONDITION_OPERATORS = [
  'var',
  'if',
  '?:',
  '==',
  '===',
  '!=',
  '!==',
  '!',
  '!!',
  'or',
  'and',
  '>',
  '>=',
  '<',
  '<=',
  'max',
  'min',
  '+',
  '-',
  '*',
  '/',
  '%',
  'map',
  'filter',
  'reduce',
  'all',
  'none',
  'some',
  'merge',
  'in',
  'cat',
  'substr',
  'days',
  'len',
] as const;

const OPERATORS: ReadonlySet<string> = new Set(PROMOTION_CONDITION_OPERATORS);
const ITERATORS: ReadonlySet<string> = new Set(['map', 'filter', 'reduce', 'all', 'none', 'some']);
const LINE_FIELDS: ReadonlySet<string> = new Set(PROMOTION_CONDITION_LINE_FIELDS);
const VARIABLES: ReadonlySet<string> = new Set(Object.keys(PROMOTION_CONDITION_VARIABLES));

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a path at the top level of the condition is one of the documented variables. */
function knownVariable(path: string): boolean {
  if (VARIABLES.has(path)) return true;
  // `order.lines.0.sku`: one line, by position.
  const m = /^order\.lines\.\d+(?:\.(\w+))?$/.exec(path);
  return !!m && (m[1] === undefined || LINE_FIELDS.has(m[1]));
}

/** Inside `map`, `filter`, `some`… the data is the one element: a line, or what `reduce` carries. */
function knownItemVariable(path: string): boolean {
  const [root = ''] = path.split('.');
  return path === '' || root === 'current' || root === 'accumulator' || LINE_FIELDS.has(root);
}

type Walk = { nodes: number };

function check(
  rule: unknown,
  inItem: boolean,
  depth: number,
  iter: number,
  w: Walk,
): string | null {
  if (++w.nodes > MAX_NODES) return 'is too large';
  if (depth > MAX_DEPTH) return 'is nested too deeply';
  if (Array.isArray(rule)) {
    for (const r of rule) {
      const e = check(r, inItem, depth + 1, iter, w);
      if (e) return e;
    }
    return null;
  }
  if (!isObject(rule)) return null;
  const keys = Object.keys(rule);
  // Any other object evaluates to itself, and an object is truthy: `{}` would always hold.
  if (keys.length !== 1) return 'needs exactly one operator in each part';
  const op = keys[0]!;
  const args = rule[op];
  if (op === 'now') return 'can’t call now: read the variable now';
  if (!OPERATORS.has(op))
    return `can’t use “${op}” (allowed: ${PROMOTION_CONDITION_OPERATORS.join(' ')})`;
  const list = Array.isArray(args) ? args : [args];
  if (op === 'var') {
    const [path, ...rest] = list;
    if (typeof path !== 'string' && typeof path !== 'number')
      return 'must name each variable outright, not compute it';
    const name = String(path);
    if (inItem ? !knownItemVariable(name) : !knownVariable(name))
      return inItem
        ? `reads “${name}”, which isn’t a field of the line (${PROMOTION_CONDITION_LINE_FIELDS.join(', ')}): inside a list operation only the item itself is available`
        : `reads “${name}”, which isn’t a promotion variable`;
    // A default may itself be an expression.
    return check(rest, inItem, depth + 1, iter, w);
  }
  if (ITERATORS.has(op)) {
    if (list.length !== (op === 'reduce' ? 3 : 2)) return `“${op}” has the wrong number of parts`;
    if (iter + 1 > MAX_ITERATION_DEPTH) return 'nests list operations too deeply';
    const [items, body, ...init] = list;
    return (
      check(items, inItem, depth + 1, iter, w) ??
      check(body, true, depth + 1, iter + 1, w) ??
      check(init, inItem, depth + 1, iter, w)
    );
  }
  return check(list, inItem, depth + 1, iter, w);
}

/**
 * Why `condition` can't be a promotion's condition, in words a merchant can act on, or null when
 * it can. One JSON Logic expression (an object with one operator), of the documented variables
 * and operators, small enough to store.
 */
export function promotionConditionProblem(condition: unknown): string | null {
  if (!isObject(condition))
    return 'A condition is a JSON Logic expression: an object like {"==": [...]}.';
  let json: string;
  try {
    json = JSON.stringify(condition);
  } catch {
    return 'The condition isn’t JSON.';
  }
  if (json.length > MAX_CONDITION_LENGTH)
    return `A condition is at most ${MAX_CONDITION_LENGTH} characters.`;
  const why = check(condition, false, 0, 0, { nodes: 0 });
  return why ? `The condition ${why}.` : null;
}

/** A condition typed or pasted as text: its parsed form, or why it isn't one. */
export function parsePromotionCondition(text: string): { condition: object } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'The condition isn’t valid JSON.' };
  }
  const error = promotionConditionProblem(parsed);
  return error ? { error } : { condition: parsed as object };
}

/** What the order being priced offers a condition. */
export type ConditionInput = {
  now: number;
  currency: string;
  fxRate: number | undefined;
  channel: string;
  lines: OrderLine[];
  customerId: string | undefined;
  /** The customer's record, when the order has one. */
  customer: { kind: string; tier: string } | undefined;
  /** The order's `meta`, which holds the ship-to. */
  meta: Record<string, unknown> | undefined;
};

/** The data a condition reads: a fresh copy, so nothing a condition does reaches the order. */
export function promotionConditionContext(c: ConditionInput) {
  const subtotal = money(c.lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));
  // The address as the validate step would write it, so `US` matches however it was typed.
  const ship = c.meta?.shipTo ? checkAddress(c.meta.shipTo).address : null;
  return {
    now: c.now,
    order: {
      channel: c.channel,
      currency: c.currency,
      subtotal,
      baseSubtotal: toBase(subtotal, c.fxRate),
      customerId: c.customerId ?? null,
      lines: c.lines.map((l) => ({
        sku: l.sku,
        name: l.name ?? null,
        qty: l.qty,
        unitPrice: l.unitPrice ?? null,
      })),
      meta: { shipTo: { country: ship?.country ?? null, region: ship?.region ?? null } },
    },
    customer: {
      id: c.customerId ?? null,
      kind: c.customer?.kind ?? null,
      tier: c.customer?.tier ?? null,
    },
  };
}

/**
 * Whether the order meets `condition`. Fails closed: a condition that isn't allowed, or throws,
 * or isn't truthy by JSON Logic's rules, doesn't qualify the order.
 */
export function promotionConditionHolds(condition: unknown, c: ConditionInput): boolean {
  if (promotionConditionProblem(condition)) return false;
  try {
    // JSON Logic's truthiness, as in a flow's condition: an empty array is false.
    return truthy(condition, promotionConditionContext(c));
  } catch {
    return false;
  }
}
