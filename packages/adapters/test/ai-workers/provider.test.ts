import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkersAIEmbeddings,
  createWorkersAIProvider,
  NO_LOG_PAYLOAD,
  WORKERS_AI_MODEL_BY_TIER,
  WorkersAIError,
  type WorkersAiRun,
  workersAiModelsFromEnv,
} from '../../src/ai-workers/index';

const schema = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
} as const;

/** A fake `run` that records calls and answers with `answer` (an Error rejects). */
function fakeRun(answer: unknown) {
  const calls: { model: string; input: Record<string, unknown>; opts?: unknown }[] = [];
  const run: WorkersAiRun = async (model, input, opts) => {
    calls.push({ model, input, opts });
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? (answer as (i: unknown) => unknown)(input) : answer;
  };
  return { run, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('workers-ai provider — tier mapping', () => {
  it('maps each tier to its default model, defaulting to balanced', async () => {
    const { run, calls } = fakeRun({ response: 'ok' });
    const ai = createWorkersAIProvider({ run });
    await ai.generate({ prompt: 'p', maxTokens: 16 });
    await ai.generate({ prompt: 'p', maxTokens: 16, tier: 'flagship' });
    await ai.generate({ prompt: 'p', maxTokens: 16, tier: 'fast' });
    expect(calls.map((c) => c.model)).toEqual([
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/moonshotai/kimi-k2.6',
      '@cf/zai-org/glm-4.7-flash',
    ]);
  });

  it('honours per-tier overrides read from WORKERS_AI_MODEL_<TIER>', async () => {
    const models = workersAiModelsFromEnv({
      WORKERS_AI_MODEL_FAST: '@cf/meta/llama-3.1-8b-instruct',
      WORKERS_AI_MODEL_FLAGSHIP: '',
    });
    expect(models).toEqual({ fast: '@cf/meta/llama-3.1-8b-instruct' });
    const { run, calls } = fakeRun({ response: 'ok' });
    const ai = createWorkersAIProvider({ run, models });
    await ai.generate({ prompt: 'p', maxTokens: 16, tier: 'fast' });
    await ai.generate({ prompt: 'p', maxTokens: 16, tier: 'flagship' });
    expect(calls.map((c) => c.model)).toEqual([
      '@cf/meta/llama-3.1-8b-instruct',
      WORKERS_AI_MODEL_BY_TIER.flagship,
    ]);
  });
});

describe('workers-ai provider — request shape', () => {
  it('sends messages and max_tokens, no response_format for free text, and maps usage', async () => {
    const { run, calls } = fakeRun({
      response: 'Hello',
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const res = await createWorkersAIProvider({ run }).generate({
      system: 'sys',
      prompt: 'hi',
      maxTokens: 64,
    });
    expect(calls[0]!.input).toEqual({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 64,
    });
    expect(calls[0]!.opts).toBeUndefined();
    expect(res).toEqual({ text: 'Hello', usage: { inputTokens: 7, outputTokens: 3 } });
  });

  it('requests JSON mode with the schema and returns the parsed object', async () => {
    const { run, calls } = fakeRun({ response: { title: 'T' } });
    const res = await createWorkersAIProvider({ run }).generate({
      prompt: 'p',
      maxTokens: 64,
      outputSchema: schema,
    });
    expect(calls[0]!.input.response_format).toEqual({ type: 'json_schema', json_schema: schema });
    expect(res.object).toEqual({ title: 'T' });
    expect(JSON.parse(res.text)).toEqual({ title: 'T' });
  });

  it('reads chat-completions answers from choices[0].message.content (fenced JSON too)', async () => {
    const { run } = fakeRun({
      choices: [{ message: { content: '```json\n{"title":"F"}\n```' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    const res = await createWorkersAIProvider({ run }).generate({
      prompt: 'p',
      maxTokens: 64,
      tier: 'flagship',
      outputSchema: schema,
    });
    expect(res.object).toEqual({ title: 'F' });
    expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it('routes through AI Gateway with payload logging off when a gateway id is set', async () => {
    const { run, calls } = fakeRun({ response: 'ok' });
    await createWorkersAIProvider({ run, gatewayId: 'gw' }).generate({ prompt: 'p', maxTokens: 8 });
    expect(calls[0]!.opts).toEqual({ gateway: { id: 'gw' }, extraHeaders: NO_LOG_PAYLOAD });
  });
});

describe('workers-ai provider — tool calling', () => {
  it('sends history and tools in OpenAI shape and returns the model tool calls', async () => {
    const { run, calls } = fakeRun({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'c2', function: { name: 'search', arguments: '{"q":"x"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const res = await createWorkersAIProvider({ run }).generate({
      prompt: '',
      maxTokens: 64,
      messages: [
        { role: 'user', content: 'find x' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search', input: {} }] },
        { role: 'tool', toolCallId: 'c1', content: '[]' },
      ],
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
    });
    expect(calls[0]!.input.messages).toEqual([
      { role: 'user', content: 'find x' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '[]' },
    ]);
    expect(calls[0]!.input.tools).toEqual([
      {
        type: 'function',
        function: { name: 'search', description: 'Search', parameters: { type: 'object' } },
      },
    ]);
    expect(res.toolCalls).toEqual([{ id: 'c2', name: 'search', input: { q: 'x' } }]);
  });

  it('reads Workers AI native tool_calls (llama) with object arguments', async () => {
    const { run } = fakeRun({ response: null, tool_calls: [{ name: 'tag', arguments: { t: 1 } }] });
    const res = await createWorkersAIProvider({ run }).generate({
      prompt: 'p',
      maxTokens: 8,
      tools: [{ name: 'tag', inputSchema: { type: 'object' } }],
    });
    expect(res.toolCalls).toEqual([{ id: 'call_0', name: 'tag', input: { t: 1 } }]);
  });
});

describe('workers-ai provider — errors and timeout', () => {
  it("treats finish_reason 'length' as an error, never half an answer", async () => {
    const { run } = fakeRun({
      choices: [{ message: { content: '{"title":' }, finish_reason: 'length' }],
    });
    await expect(
      createWorkersAIProvider({ run }).generate({
        prompt: 'p',
        maxTokens: 8,
        outputSchema: schema,
      }),
    ).rejects.toMatchObject({ name: 'WorkersAIError', reason: 'bad_response' });
  });

  it('rejects with a timeout error after the cap', async () => {
    vi.useFakeTimers();
    const run: WorkersAiRun = () => new Promise(() => {});
    const p = createWorkersAIProvider({ run, timeoutMs: 5_000 }).generate({
      prompt: 'p',
      maxTokens: 8,
    });
    const assertion = expect(p).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('wraps run failures as upstream errors', async () => {
    const { run } = fakeRun(new Error('capacity exceeded'));
    await expect(
      createWorkersAIProvider({ run }).generate({ prompt: 'p', maxTokens: 8 }),
    ).rejects.toMatchObject({ reason: 'upstream', message: expect.stringContaining('capacity') });
  });

  it('passes WorkersAIErrors from run through unchanged', async () => {
    const original = new WorkersAIError('upstream', 'rate limited', 429);
    const { run } = fakeRun(original);
    await expect(
      createWorkersAIProvider({ run }).generate({ prompt: 'p', maxTokens: 8 }),
    ).rejects.toBe(original);
  });
});

describe('workers-ai embeddings', () => {
  const vec = (n: number) => new Array(n).fill(0.1);

  it('embeds with the default bge-base model (768 dims)', async () => {
    const { run, calls } = fakeRun({ shape: [2, 768], data: [vec(768), vec(768)] });
    const emb = createWorkersAIEmbeddings({ run });
    expect(emb.modelId).toBe('@cf/baai/bge-base-en-v1.5');
    expect(emb.dimensions).toBe(768);
    expect(await emb.embed(['a', 'b'])).toHaveLength(2);
    expect(calls[0]!.input).toEqual({ text: ['a', 'b'] });
  });

  it('batches inputs at 100 texts per call', async () => {
    const { run, calls } = fakeRun((input: { text: string[] }) => ({
      data: input.text.map(() => vec(768)),
    }));
    const out = await createWorkersAIEmbeddings({ run }).embed(
      Array.from({ length: 150 }, (_, i) => `t${i}`),
    );
    expect(out).toHaveLength(150);
    expect(calls.map((c) => (c.input.text as string[]).length)).toEqual([100, 50]);
  });

  it('refuses at construction when EMBEDDINGS_DIM disagrees with the model', () => {
    const { run } = fakeRun({});
    expect(() => createWorkersAIEmbeddings({ run, dimensions: 1536 })).toThrow(
      /EMBEDDINGS_DIM=768/,
    );
  });

  it('rejects vectors of the wrong width', async () => {
    const { run } = fakeRun({ data: [vec(384)] });
    await expect(createWorkersAIEmbeddings({ run }).embed(['a'])).rejects.toMatchObject({
      reason: 'bad_response',
    });
  });

  it('returns [] for no input without calling the model', async () => {
    const { run, calls } = fakeRun({});
    expect(await createWorkersAIEmbeddings({ run }).embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
