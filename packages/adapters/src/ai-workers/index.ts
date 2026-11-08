import type {
  AIProvider,
  ChatMessage,
  EmbeddingsProvider,
  GenerateRequest,
  GenerateResult,
  ModelTier,
  ToolCall,
} from '@commerceworker/ports';
import { extractJson } from './json';
import {
  asWorkersAIError,
  DEFAULT_TIMEOUT_MS,
  gatewayRunOptions,
  WorkersAIError,
  type WorkersAiRun,
  withTimeout,
} from './transport';

export {
  createWorkersAIDecisionModel,
  MAX_DECISION_QUESTIONS,
  WORKERS_AI_DECISION_MODEL_BY_TIER,
  type WorkersAIDecisionOptions,
} from './decisions';
export {
  createWorkersAITextExtractor,
  WORKERS_AI_TRANSCRIBE_MODEL,
  type WorkersAITextExtractorOptions,
  type WorkersAiToMarkdown,
} from './extract';
export { extractJson } from './json';
export {
  DEFAULT_TIMEOUT_MS,
  NO_LOG_PAYLOAD,
  WorkersAIError,
  type WorkersAIErrorReason,
  type WorkersAiRun,
  type WorkersAiRunOptions,
} from './transport';

/**
 * Provider-neutral tier → Workers AI text model: Kimi K2.6 for the hardest
 * work, Llama 3.3 70B fp8-fast (reliable in JSON mode) as the workhorse, GLM
 * 4.7 Flash where latency matters most. All accept `response_format`.
 */
export const WORKERS_AI_MODEL_BY_TIER: Readonly<Record<ModelTier, string>> = {
  flagship: '@cf/moonshotai/kimi-k2.6',
  balanced: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  fast: '@cf/zai-org/glm-4.7-flash',
};

/**
 * Per-tier overrides from WORKERS_AI_MODEL_FLAGSHIP / _BALANCED / _FAST. Empty
 * strings (how wrangler vars ship "unset") are ignored.
 */
export function workersAiModelsFromEnv(
  env: Record<string, string | undefined>,
): Partial<Record<ModelTier, string>> {
  const models: Partial<Record<ModelTier, string>> = {};
  for (const tier of ['flagship', 'balanced', 'fast'] as const) {
    const value = env[`WORKERS_AI_MODEL_${tier.toUpperCase()}`];
    if (value) models[tier] = value;
  }
  return models;
}

/** Lower temperature for structured output: the answer should be data, not prose. */
const JSON_TEMPERATURE = 0.2;

export interface WorkersAIProviderOptions {
  /** The Workers AI call: `env.AI.run.bind(env.AI)` on the edge, a REST runner on Node. */
  run: WorkersAiRun;
  /** Model per tier; unset tiers use {@link WORKERS_AI_MODEL_BY_TIER}. */
  models?: Partial<Record<ModelTier, string>>;
  /** AI Gateway id (AI_GATEWAY_ID); empty calls Workers AI directly. */
  gatewayId?: string;
  /**
   * Whether the gateway keeps a request log entry (model, tokens, cost) for each call
   * (AI_GATEWAY_LOGS); prompts and answers are never logged either way. Unset follows the
   * gateway's own setting.
   */
  collectLogs?: boolean;
  /** Hard ceiling per call in ms (default 120 000). */
  timeoutMs?: number;
}

/** OpenAI-style message as Workers AI's chat models take it. */
type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

function toWire(m: ChatMessage): WireMessage {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/** Workers AI's own models answer in `response`; chat-completions models in `choices`. */
interface ModelAnswer {
  response?: unknown;
  tool_calls?: { id?: string; name?: string; arguments?: unknown }[];
  choices?: {
    message?: {
      content?: unknown;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function toolCallsOf(res: ModelAnswer): ToolCall[] {
  const chat = res.choices?.[0]?.message?.tool_calls;
  if (chat?.length) {
    return chat.map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.function?.name ?? '',
      input: parseArgs(c.function?.arguments),
    }));
  }
  return (res.tool_calls ?? []).map((c, i) => ({
    id: c.id || `call_${i}`,
    name: c.name ?? '',
    input: parseArgs(c.arguments),
  }));
}

/**
 * Cloudflare Workers AI implementation of the AIProvider port. Callers pick a
 * tier, never a model. Transport-agnostic: everything goes through the
 * injected `run`, so the same code serves the edge binding and the REST API.
 *
 * - `outputSchema` → JSON mode (`response_format: json_schema`); the parsed
 *   value comes back as `object` (schema conformance is `generateJson`'s job).
 * - An answer cut off at `max_tokens` (`finish_reason: 'length'`) is an error,
 *   never half an answer.
 * - `messages`/`tools` → OpenAI-style multi-turn + function calling; the
 *   model's calls come back as `toolCalls`.
 * - Every failure is a {@link WorkersAIError} (`timeout`, `upstream`,
 *   `bad_response`), which `generateJson` turns into a retry or its fallback.
 */
export function createWorkersAIProvider(opts: WorkersAIProviderOptions): AIProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runOpts = gatewayRunOptions(opts.gatewayId, opts.collectLogs);

  return {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const model =
        opts.models?.[req.tier ?? 'balanced'] || WORKERS_AI_MODEL_BY_TIER[req.tier ?? 'balanced'];
      const messages: WireMessage[] = [];
      if (req.system) messages.push({ role: 'system', content: req.system });
      for (const m of req.messages ?? []) messages.push(toWire(m));
      if (req.prompt || !req.messages?.length) messages.push({ role: 'user', content: req.prompt });

      const input: Record<string, unknown> = { messages, max_tokens: req.maxTokens };
      if (req.outputSchema) {
        input.response_format = { type: 'json_schema', json_schema: req.outputSchema };
        input.temperature = JSON_TEMPERATURE;
      }
      if (req.tools?.length) {
        input.tools = req.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            parameters: t.inputSchema,
          },
        }));
      }

      let res: ModelAnswer;
      try {
        res = ((await withTimeout(opts.run(model, input, runOpts), timeoutMs)) ??
          {}) as ModelAnswer;
      } catch (err) {
        throw asWorkersAIError(err);
      }
      if (res.choices?.[0]?.finish_reason === 'length') {
        throw new WorkersAIError(
          'bad_response',
          `Workers AI ${model}: the answer ran past max_tokens`,
        );
      }

      const raw = res.response ?? res.choices?.[0]?.message?.content;
      const text =
        typeof raw === 'string'
          ? raw
          : raw === undefined || raw === null
            ? ''
            : JSON.stringify(raw);
      const result: GenerateResult = {
        text,
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        },
      };
      if (req.outputSchema && raw !== undefined && raw !== null) {
        const value = typeof raw === 'string' ? extractJson(raw) : raw;
        if (value !== undefined) result.object = value;
      }
      if (req.tools?.length) {
        const calls = toolCallsOf(res);
        if (calls.length) result.toolCalls = calls;
      }
      return result;
    },
  };
}

/**
 * Output width of the Workers AI embedding models. Known widths let the
 * adapter fail at boot when EMBEDDINGS_DIM (the Vectorize
 * index width) disagrees with the model, rather than on the first upsert.
 */
export const WORKERS_AI_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  '@cf/baai/bge-small-en-v1.5': 384,
  '@cf/baai/bge-base-en-v1.5': 768,
  '@cf/baai/bge-large-en-v1.5': 1024,
  '@cf/baai/bge-m3': 1024,
  '@cf/google/embeddinggemma-300m': 768,
};

/** Default embedding model: 768 dimensions. */
export const DEFAULT_WORKERS_AI_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

/** Texts per embedding call — the bge models' batch limit. */
const EMBED_BATCH = 100;

export interface WorkersAIEmbeddingsOptions {
  run: WorkersAiRun;
  /** Embedding model (EMBEDDINGS_MODEL); default {@link DEFAULT_WORKERS_AI_EMBEDDING_MODEL}. */
  model?: string;
  /** The width the platform is sized for (EMBEDDINGS_DIM); must equal the model's. */
  dimensions?: number;
  gatewayId?: string;
  /** As {@link WorkersAIProviderOptions.collectLogs}. */
  collectLogs?: boolean;
  timeoutMs?: number;
}

/**
 * Workers AI implementation of the EmbeddingsProvider port (bge-* by default),
 * over the same injected `run`. Vectors are validated against `dimensions` so a
 * mis-sized model fails loudly instead of corrupting the vector index.
 */
export function createWorkersAIEmbeddings(opts: WorkersAIEmbeddingsOptions): EmbeddingsProvider {
  const model = opts.model || DEFAULT_WORKERS_AI_EMBEDDING_MODEL;
  const known = WORKERS_AI_EMBEDDING_DIMENSIONS[model];
  const dimensions = opts.dimensions ?? known;
  if (dimensions === undefined) {
    throw new WorkersAIError(
      'config',
      `unknown output width for Workers AI embedding model "${model}"; set EMBEDDINGS_DIM`,
    );
  }
  if (known !== undefined && known !== dimensions) {
    throw new WorkersAIError(
      'config',
      `Workers AI model "${model}" produces ${known}-dim vectors but EMBEDDINGS_DIM is ${dimensions}; set EMBEDDINGS_DIM=${known} (and size the Vectorize index to match)`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runOpts = gatewayRunOptions(opts.gatewayId, opts.collectLogs);

  return {
    modelId: model,
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        let res: { data?: unknown } | undefined;
        try {
          res = (await withTimeout(opts.run(model, { text: batch }, runOpts), timeoutMs)) as
            | { data?: unknown }
            | undefined;
        } catch (err) {
          throw asWorkersAIError(err);
        }
        const data = res?.data;
        if (!Array.isArray(data) || data.length !== batch.length) {
          throw new WorkersAIError(
            'bad_response',
            `embeddings response shape mismatch: expected ${batch.length} vectors, got ${Array.isArray(data) ? data.length : 'none'}`,
          );
        }
        for (const vector of data) {
          if (!Array.isArray(vector) || vector.length !== dimensions) {
            throw new WorkersAIError(
              'bad_response',
              `model "${model}" returned ${Array.isArray(vector) ? vector.length : 'non-array'}-dim vectors but the platform is configured for ${dimensions} (EMBEDDINGS_DIM)`,
            );
          }
          out.push(vector as number[]);
        }
      }
      return out;
    },
  };
}
