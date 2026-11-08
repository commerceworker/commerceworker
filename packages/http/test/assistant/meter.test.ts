import type { CostGuard } from '@commerceworker/ports';
import { jsonSchema, type LanguageModel, stepCountIs, streamText, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { meterTurn } from '../../src/assistant/meter';

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type StreamPart =
  Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: undefined, reasoning: undefined },
});

/** Step one calls `look` (10 tokens); step two starts answering and never finishes on its own. */
function stubModel(): Model {
  let step = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'stub',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      step++;
      if (step === 1) {
        const parts: StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'look', input: '{}' },
          {
            type: 'finish',
            usage: usage(6, 4),
            finishReason: { unified: 'tool-calls', raw: undefined },
          },
        ];
        return {
          stream: new ReadableStream({
            start(c) {
              for (const p of parts) c.enqueue(p);
              c.close();
            },
          }),
        };
      }
      return {
        stream: new ReadableStream<StreamPart>({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 't' });
            c.enqueue({ type: 'text-delta', id: 't', delta: 'Half an ans' });
            // …and nothing more until the turn is cancelled.
          },
        }),
      };
    },
  };
}

function recordingGuard(allowed = () => true) {
  const calls = { consume: 0, settled: [] as number[] };
  const guard: CostGuard = {
    async consume() {
      calls.consume++;
      return allowed()
        ? { allowed: true }
        : { allowed: false, reason: 'requests', retryAfterSeconds: 1 };
    },
    async settle(_scope, tokens) {
      calls.settled.push(tokens);
    },
  } as CostGuard;
  return { guard, calls };
}

const scope = { spaceId: 's1', environmentId: 'main' };

describe('metering a model turn', () => {
  it('settles what the turn used when it is cancelled mid-answer, and releases its wiring', async () => {
    const { guard, calls } = recordingGuard();
    let released!: () => void;
    const done = new Promise<void>((resolve) => {
      released = resolve;
    });
    const meter = meterTurn(
      guard,
      scope,
      () => true,
      () => released(),
    );
    expect(await meter.begin()).toBe(true);
    const cancel = new AbortController();
    const result = streamText({
      model: stubModel(),
      prompt: 'hi',
      tools: {
        look: tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'seen' }),
      },
      stopWhen: stepCountIs(5),
      abortSignal: AbortSignal.any([cancel.signal, meter.signal]),
      prepareStep: (s) => meter.prepareStep(s),
      onStepFinish: (s) => meter.onStepFinish(s),
      onFinish: () => meter.settle(),
      onAbort: () => meter.settle(),
      onError: () => meter.settle(),
    });
    for await (const text of result.textStream) {
      if (text) {
        cancel.abort();
        break;
      }
    }
    await done;
    // Two steps, two requests; the finished step's tokens, settled once.
    expect(calls.consume).toBe(2);
    expect(calls.settled).toEqual([10]);
  });

  it('refuses a turn whose budget is spent before it starts, and settles nothing it didn’t use', async () => {
    const { guard, calls } = recordingGuard(() => false);
    let released = false;
    const meter = meterTurn(
      guard,
      scope,
      () => true,
      () => {
        released = true;
      },
    );
    expect(await meter.begin()).toBe(false);
    await meter.settle();
    await meter.settle();
    expect(calls.settled).toEqual([0]);
    expect(released).toBe(true);
  });

  it('doesn’t meter the mock model', async () => {
    const { guard, calls } = recordingGuard();
    const meter = meterTurn(
      guard,
      scope,
      () => false,
      () => {},
    );
    expect(await meter.begin()).toBe(true);
    await meter.prepareStep({ stepNumber: 1 });
    await meter.settle();
    expect(calls).toEqual({ consume: 0, settled: [] });
  });
});
