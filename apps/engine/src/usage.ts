/**
 * The assistant's daily token budget per person (`ASSISTANT_DAILY_TOKENS`, a million unless the
 * deployment sets another; `0` is no limit). A conversation turn is refused once the person has
 * used the day's tokens; what a turn uses is added when it finishes. Turns the heuristic answers
 * cost nothing. Covers the in-app assistant and A2A chat; MCP clients bring their own model.
 */

import { assistantDailyTokens, type Principal, promptId, usageDay } from '@commerceworker/core';
import { assistantModelId, logAiCall } from './ai';
import type { ModelSource } from './assistant/model';
import { usageStore } from './wire';

/** True when this person has no tokens left today. */
export async function assistantBudgetSpent(env: Env, p: Principal, now = Date.now()) {
  const limit = assistantDailyTokens(env.ASSISTANT_DAILY_TOKENS);
  if (!Number.isFinite(limit)) return false;
  return (await usageStore(env).tokens(p.id, usageDay(now))) >= limit;
}

/** Adds a finished turn's tokens to the person's day. */
export async function recordAssistantUsage(
  env: Env,
  p: Principal,
  tokens: number | undefined,
  now = Date.now(),
) {
  const used = Math.max(0, Math.round(tokens ?? 0));
  await usageStore(env).add(p.id, usageDay(now), used);
}

/** Drops days older than 90 (the retention sweep). */
export async function pruneUsage(env: Env, now = Date.now()) {
  return usageStore(env).prune(usageDay(now - 90 * 86_400_000));
}

/** Counts a finished turn against the person's budget and logs it as an `ai_call`. */
export async function finishTurn(
  env: Env,
  p: Principal,
  used: ModelSource,
  tokens: number | undefined,
  started: number,
) {
  const model = used.source === 'model';
  logAiCall(
    {
      source: used.source,
      model: model ? (used.model ?? assistantModelId(env)) : null,
      prompt: promptId('assistant'),
      ...(model ? {} : { fallback: String(env.AI_MODE) === 'mock' ? 'mock' : 'model unavailable' }),
    },
    Date.now() - started,
    { tokens: model ? (tokens ?? 0) : 0 },
  );
  if (model) await recordAssistantUsage(env, p, tokens);
}
