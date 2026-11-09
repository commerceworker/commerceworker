import type { AssistantContext } from '@commerceworker/domain';
import { makeAssistantModel } from '@commerceworker/platform/assistant-model';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { describe, expect, it } from 'vitest';
import { assistantModel, type ModelSource } from '../../src/assistant/model';

const workspace = {
  scope: { spaceId: 'acme', environmentId: 'main' },
  page: { kind: 'everything' },
} satisfies AssistantContext;
const ai = { run: async () => ({}) } as unknown as NonNullable<EdgeEnv['AI']>;

describe('which model the assistant gets', () => {
  it('has no real model under AI_MODE=mock or without an AI binding', () => {
    expect(makeAssistantModel({ AI: ai, AI_MODE: 'mock' } as EdgeEnv)).toBeUndefined();
    expect(makeAssistantModel({} as EdgeEnv)).toBeUndefined();
  });

  it('has one when AI is bound and the mode is not mock', () => {
    expect(makeAssistantModel({ AI: ai } as EdgeEnv)).toBeTypeOf('function');
  });

  it('answers with the mock, unmetered, when the composition root supplied none', async () => {
    const used: ModelSource = { source: 'model' };
    await assistantModel(undefined, workspace, used, 'person');
    expect(used.source).toBe('mock');
  });

  it('asks the supplied factory for the person, and keeps the mock behind it', async () => {
    const asked: string[] = [];
    const used: ModelSource = { source: 'model' };
    const mock = await assistantModel(undefined, workspace, { source: 'model' }, 'x');
    await assistantModel(
      async (id) => {
        asked.push(id);
        return mock;
      },
      workspace,
      used,
      'person-1',
    );
    expect(asked).toEqual(['person-1']);
    expect(used.source).toBe('model');
  });
});
