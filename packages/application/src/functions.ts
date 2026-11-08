import { type DomainEvent, type Scope, ValidationError } from '@commerceworker/domain';
import type {
  FunctionDefinition,
  FunctionInvokeResult,
  FunctionInvoker,
} from '@commerceworker/ports';
import type { AppContext } from './context';
import { assertSafeExternalUrl } from './url-safety';

/** True if `type` matches `pattern` ('*' = all, trailing '*' = prefix, else exact). */
export function eventMatches(pattern: string, type: string): boolean {
  if (!pattern || pattern === '*') return true;
  if (pattern.endsWith('*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

export interface CreateFunctionInput {
  readonly name: string;
  readonly eventPattern: string;
  readonly url: string;
  readonly active?: boolean;
}

/** Registers a function: a URL invoked on events matching `eventPattern`. */
export async function createFunction(
  ctx: AppContext,
  scope: Scope,
  input: CreateFunctionInput,
): Promise<FunctionDefinition> {
  if (!input.name.trim()) {
    throw new ValidationError([{ field: 'name', message: 'Name is required' }]);
  }
  assertSafeExternalUrl(input.url);
  const fn: FunctionDefinition = {
    id: ctx.ids.newId(),
    name: input.name.trim(),
    eventPattern: input.eventPattern || '*',
    url: input.url,
    active: input.active ?? true,
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.functions.create(scope, fn);
  return fn;
}

export async function listFunctions(ctx: AppContext, scope: Scope): Promise<FunctionDefinition[]> {
  return ctx.store.functions.list(scope);
}

export async function deleteFunction(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await ctx.store.functions.delete(scope, id);
}

export interface FunctionRunResult {
  readonly functionId: string;
  readonly name: string;
  readonly result: FunctionInvokeResult;
}

/**
 * Invokes every active function whose pattern matches the event. Each invocation
 * is independent — one failure never blocks the others. Used by the dispatch
 * worker; returns the per-function outcomes for logging.
 */
export async function invokeFunctionsForEvent(
  ctx: AppContext,
  invoker: FunctionInvoker,
  event: DomainEvent,
): Promise<FunctionRunResult[]> {
  const fns = await ctx.store.functions.list(event.scope);
  const matched = fns.filter((f) => f.active && eventMatches(f.eventPattern, event.type));
  const out: FunctionRunResult[] = [];
  for (const fn of matched) {
    let result: FunctionInvokeResult;
    try {
      result = await invoker.invoke(fn.url, event);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    out.push({ functionId: fn.id, name: fn.name, result });
  }
  return out;
}
