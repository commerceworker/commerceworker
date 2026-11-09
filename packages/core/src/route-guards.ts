/**
 * Deterministic guards on an AI router's routes. A model reads order text the customer controls (a
 * title, a note, a PO), so a crafted message can steer it towards a route like `auto_approve`. A
 * flow can give a route a JSON Logic condition that is checked in code: the model's choice of that
 * route is taken only when its condition holds, otherwise the order takes the fallback route (a
 * person's review). The model can still only pick a configured route; this narrows which of them
 * it can send an order down on its own say-so.
 *
 * A guard fails closed. It holds only when it evaluates truthy by JSON Logic's own rules (so `[]`
 * doesn't hold), every field it reads is present (a misspelt path, or a total read before pricing,
 * compares `null` and would otherwise pass `<`), unless the guard gives that field a default with
 * `{"var": [path, default]}`, and nothing in it throws. A stored guard that isn't a usable rule
 * (refused at publishing) fails the same way.
 */
import jsonLogic from 'json-logic-js';
import { getPath, type RunContext, truthy } from './logic';

/** `{ route: condition }`: a route whose condition must hold before the model's choice is taken. */
export type RouteGuards = Record<string, unknown>;

export type GuardedRoute = {
  route: string;
  /** Set when a guard turned the model's choice down: the route it chose. */
  overridden?: string;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The fallback for a guarded choice: the configured `fallback`, else `needs_approval` when the
 * router has it. Undefined when neither is a route, which `routeGuardErrors` refuses whenever a
 * guard is set.
 */
export function guardFallback(
  config: Record<string, unknown>,
  routes: string[],
): string | undefined {
  const named = typeof config.fallback === 'string' ? config.fallback.trim() : '';
  if (named) return routes.includes(named) ? named : undefined;
  return routes.includes('needs_approval') ? 'needs_approval' : undefined;
}

const knownOperator = (op: string) => {
  try {
    jsonLogic.apply({ [op]: [] } as jsonLogic.RulesLogic, {});
    return true;
  } catch (err) {
    return !String(err).includes('Unrecognized operation');
  }
};

/**
 * Why a condition isn't a usable guard, or null. Every object in it must be one JSON Logic
 * operation (exactly one key, an operator JSON Logic has): anything else evaluates to itself, and
 * an object is truthy, so `{}` or a two-key rule would always hold.
 */
function ruleError(rule: unknown): string | null {
  if (Array.isArray(rule)) {
    for (const r of rule) {
      const e = ruleError(r);
      if (e) return e;
    }
    return null;
  }
  if (!isObject(rule)) return null;
  const keys = Object.keys(rule);
  if (keys.length !== 1) return 'each part needs exactly one operator';
  const op = keys[0]!;
  if (!knownOperator(op)) return `“${op}” is not a JSON Logic operator`;
  // A `var`'s default is a value, not a rule.
  if (op === 'var') return null;
  return ruleError(rule[op]);
}

/** The fields a rule reads with no default given: `{"var": "a.b"}` or `{"var": ["a.b"]}`. */
function requiredFields(rule: unknown, out: string[] = []): string[] {
  if (Array.isArray(rule)) {
    for (const r of rule) requiredFields(r, out);
    return out;
  }
  if (!isObject(rule)) return out;
  for (const [op, args] of Object.entries(rule)) {
    if (op === 'var') {
      const [path, ...fallback] = Array.isArray(args) ? args : [args];
      if (!fallback.length && path !== '' && path !== null && path !== undefined)
        out.push(String(path));
    } else requiredFields(args, out);
  }
  return out;
}

function holds(rule: unknown, ctx: RunContext): boolean {
  if (!isObject(rule) || ruleError(rule)) return false;
  for (const path of requiredFields(rule)) {
    const v = getPath(ctx, path);
    if (v === undefined || v === null) return false;
  }
  try {
    return truthy(rule, ctx);
  } catch {
    return false;
  }
}

/**
 * The route to take: the chosen one when it has no guard or its guard holds, else the fallback.
 * Guards that aren't an object of route → rule (a stored flow that skipped validation) guard every
 * route, so nothing is taken on the model's say-so.
 */
export function guardRoute(
  chosen: string,
  config: Record<string, unknown>,
  routes: string[],
  ctx: RunContext,
): GuardedRoute {
  const guards = config.guards;
  if (guards === undefined || guards === null) return { route: chosen };
  const guarded = !isObject(guards) || Object.hasOwn(guards, chosen);
  if (!guarded || holds(isObject(guards) ? guards[chosen] : undefined, ctx))
    return { route: chosen };
  const fallback = guardFallback(config, routes);
  // Validation refuses a guard without a fallback; a stored flow that slipped past it stops here
  // rather than taking the route its own guard refused.
  if (!fallback || fallback === chosen) throw new Error(`No fallback for guarded route ${chosen}`);
  return { route: fallback, overridden: chosen };
}

/** Config errors: guards only on configured routes, each a usable rule, and a valid unguarded fallback. */
export function routeGuardErrors(config: Record<string, unknown>, routes: string[]): string[] {
  if (config.guards === undefined || config.guards === null) return [];
  if (!isObject(config.guards)) return ['Guards: an object of route → condition'];
  const errors: string[] = [];
  const keys = Object.keys(config.guards);
  for (const k of keys) {
    if (!routes.includes(k)) errors.push(`Guards: “${k}” is not one of the routes`);
    const c = config.guards[k];
    const why = isObject(c) ? ruleError(c) : 'needs a JSON Logic condition';
    if (why) errors.push(`Guards: “${k}” ${why}`);
  }
  if (!keys.length) return errors;
  const named = typeof config.fallback === 'string' ? config.fallback.trim() : '';
  const fallback = guardFallback(config, routes);
  if (!fallback)
    errors.push(
      named
        ? `Fallback: “${named}” is not one of the routes`
        : 'Fallback: name the route a guarded choice falls back to (or add needs_approval)',
    );
  else if (Object.hasOwn(config.guards, fallback))
    errors.push(`Fallback: “${fallback}” can't have a guard`);
  return errors;
}
