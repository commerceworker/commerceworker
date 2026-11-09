/**
 * The assistant's Workers AI model, bound at the composition root: the flagship tier through AI
 * Gateway (when AI_GATEWAY_ID is set) with the fast tier as its fallback. The mock fallback and
 * the turn-level timeout belong to the assistant (`@commerceworker/http/assistant/model`); this
 * only says which real model there is, and whether there is one at all.
 */
import {
  NO_LOG_PAYLOAD,
  WORKERS_AI_MODEL_BY_TIER,
  workersAiModelsFromEnv,
} from '@commerceworker/adapters/ai-workers';
import { createAI, type WorkersAIModelId } from 'agents/models/ai-sdk';
import type { LanguageModel } from 'ai';
import type { EdgeEnv } from './env';

export type AssistantLlm = Extract<LanguageModel, { specificationVersion: 'v4' }>;

/** A slow model must not hold the person hostage: the mock answers after this. */
export const ASSISTANT_AI_TIMEOUT_MS = 20_000;

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * Builds the assistant's model for one person, or nothing under AI_MODE=mock or without an AI
 * binding (local development, the tests, a demo), where the assistant answers with its mock.
 */
export function makeAssistantModel(
  env: EdgeEnv,
): ((personId: string) => Promise<AssistantLlm>) | undefined {
  const binding = env.AI;
  if (env.AI_MODE === 'mock' || !binding) return undefined;
  const models = workersAiModelsFromEnv(env as unknown as Record<string, string | undefined>);
  const flagship = (models.flagship ?? WORKERS_AI_MODEL_BY_TIER.flagship) as WorkersAIModelId;
  const fast = (models.fast ?? WORKERS_AI_MODEL_BY_TIER.fast) as WorkersAIModelId;
  const gatewayId = env.AI_GATEWAY_ID ?? '';
  const ai = createAI({
    // EdgeEnv types only the `run` the adapters use; createAI takes the whole binding.
    binding: binding as unknown as Ai,
    // An empty id calls Workers AI directly; undefined would pick the account's "default" gateway.
    gateway: gatewayId
      ? {
          id: gatewayId,
          ...(env.AI_GATEWAY_LOGS ? { collectLog: env.AI_GATEWAY_LOGS === 'true' } : {}),
          metadata: { prompt: 'assistant' },
          retries: { maxAttempts: 2, retryDelayMs: 500, backoff: 'exponential' },
          requestTimeoutMs: ASSISTANT_AI_TIMEOUT_MS,
        }
      : { id: '' },
  });
  return async (personId) =>
    ai(flagship, {
      fallback: fast === flagship ? [] : [fast],
      // Workers AI's prefix cache: the system prompt and tools repeat within a conversation.
      sessionAffinity: await sha256(`assistant:${personId}`),
      // Tool results carry people's content: the gateway keeps no prompt or answer.
      headers: { ...NO_LOG_PAYLOAD },
    });
}
