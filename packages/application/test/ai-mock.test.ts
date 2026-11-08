import type { AIProvider, CostGuard } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { type AppContext, generateWithBudget } from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
const neverCalled: AIProvider = {
  generate: async () => {
    throw new Error('AI_MODE=mock must not call the model');
  },
};

function ctx(costGuard?: CostGuard): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
    ai: { mode: 'mock', log: () => {} },
    ...(costGuard ? { costGuard } : {}),
  } as AppContext;
}

describe('AI_MODE=mock', () => {
  it('answers every generation without the model, shaped by the output schema', async () => {
    const result = await generateWithBudget(ctx(), neverCalled, scope, {
      prompt: 'translate',
      maxTokens: 100,
      outputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'translated title' },
          tags: { type: 'array', items: { type: 'string' } },
          tone: { type: 'string', enum: ['neutral', 'formal'] },
          meta: { type: 'object', properties: { words: { type: 'integer' } } },
        },
      },
    });
    expect(result.object).toEqual({
      title: 'Sample translated title',
      tags: ['Sample tags'],
      tone: 'neutral',
      meta: { words: 0 },
    });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('answers free text too, and spends nothing from the AI budget', async () => {
    let consumed = 0;
    const guard = {
      consume: async () => {
        consumed++;
        return { allowed: true };
      },
      settle: async () => {},
    } as unknown as CostGuard;
    const result = await generateWithBudget(ctx(guard), neverCalled, scope, {
      prompt: 'summarize',
      maxTokens: 100,
    });
    expect(result.text).toContain('AI_MODE=mock');
    expect(consumed).toBe(0);
  });
});
