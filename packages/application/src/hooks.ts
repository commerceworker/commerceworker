import { HookRejectedError, type Scope, ValidationError } from '@commerceworker/domain';
import type { HookName, HookVeto } from '@commerceworker/ports';
import type { AppContext } from './context';

/**
 * The use-case side of the hook seam.
 *
 * Call sites get one line and no branching, and the rules that matter live here
 * rather than being restated (and eventually diverging) at five different
 * points on the write path:
 *
 * - No dispatcher configured means no cost at all — not an empty dispatch.
 * - A veto raises, so a caller can never accidentally continue past a refusal
 *   by forgetting to check a return value.
 * - A veto carrying field issues becomes a ValidationError, so a hook's
 *   complaint about a field reaches the editor exactly like a built-in one.
 *   Everything else becomes a HookRejectedError naming the hook, so an editor
 *   can tell "the CMS rejected this" from "your integration rejected this".
 */
export async function runHook<T>(
  ctx: AppContext,
  hook: HookName,
  scope: Scope,
  payload: T,
): Promise<T> {
  if (!ctx.hooks) return payload;

  const result = await ctx.hooks.dispatch(hook, payload, scope);
  if ('veto' in result) throwVeto(result.veto);
  return result.payload;
}

/**
 * `runHook` for a dry run: only the handlers that can have no effect run (`pureOnly`), and the
 * ones left out are named, so the caller can say that a real save might still be rewritten or
 * refused by them. A veto raises exactly as it would on the real path.
 */
export async function runPureHook<T>(
  ctx: AppContext,
  hook: HookName,
  scope: Scope,
  payload: T,
): Promise<{ readonly payload: T; readonly skipped: readonly string[] }> {
  if (!ctx.hooks) return { payload, skipped: [] };

  const result = await ctx.hooks.dispatch(hook, payload, scope, { pureOnly: true });
  if ('veto' in result) throwVeto(result.veto);
  return { payload: result.payload, skipped: result.skipped ?? [] };
}

function throwVeto(veto: HookVeto): never {
  if (veto.issues?.length) {
    throw new ValidationError(veto.issues);
  }
  throw new HookRejectedError(veto.hook, veto.reason);
}
