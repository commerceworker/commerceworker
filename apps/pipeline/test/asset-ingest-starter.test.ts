import {
  type AssetIngestWorkflowBinding,
  CloudflareAssetIngestStarter,
  WORKFLOW_INSTANCE_EXISTS,
} from '@commerceworker/platform/asset-ingest';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { makeTextExtractor } from '@commerceworker/platform/wire';
import type { AssetIngestParams } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';

const params: AssetIngestParams = {
  scope: { spaceId: 's', environmentId: 'main' },
  assetId: 'a1',
  version: 1,
};

/** A Workflows binding whose createBatch answers what the test says. */
function binding(answer: () => WorkflowBatchCreateResult) {
  const calls: unknown[] = [];
  const wf = {
    async createBatch(options: unknown) {
      calls.push(options);
      return answer();
    },
  } as unknown as AssetIngestWorkflowBinding;
  return { wf, calls };
}

describe('CloudflareAssetIngestStarter', () => {
  it('reports a run it created', async () => {
    const { wf, calls } = binding(() => ({ created: [{ id: 'i1' } as never], errors: [] }));
    expect(await new CloudflareAssetIngestStarter(wf).start('i1', params)).toBe(true);
    expect(calls).toEqual([{ instances: [{ id: 'i1', params }] }]);
  });

  it('treats only the duplicate-id code as the run that exists', async () => {
    const { wf } = binding(() => ({
      created: [],
      errors: [{ index: 0, id: 'i1', code: WORKFLOW_INSTANCE_EXISTS, message: 'already exists' }],
    }));
    expect(await new CloudflareAssetIngestStarter(wf).start('i1', params)).toBe(false);
  });

  it('throws every other answer, so the message is retried', async () => {
    // A message that merely mentions "exist" is not the duplicate-id answer.
    const missing = binding(() => ({
      created: [],
      errors: [{ index: 0, id: 'i1', code: 10001, message: 'workflow does not exist' }],
    }));
    await expect(new CloudflareAssetIngestStarter(missing.wf).start('i1', params)).rejects.toThrow(
      /10001 workflow does not exist/,
    );
    const thrown = binding(() => {
      throw new Error('Workflow does not exist');
    });
    await expect(new CloudflareAssetIngestStarter(thrown.wf).start('i1', params)).rejects.toThrow(
      'Workflow does not exist',
    );
  });
});

describe('ingest text extraction wiring', () => {
  const ai = {
    run: async () => ({ text: 'words' }),
    toMarkdown: async () => ({ format: 'markdown', data: '# doc' }),
  };
  const env = { AI: ai } as unknown as EdgeEnv;

  it('reads documents with Workers AI when the model is live', () => {
    expect(makeTextExtractor(env, { ai: { mode: 'live', timeoutMs: 1 } })).toBeDefined();
  });

  it('has no extractor under AI_MODE=mock, which never calls a model', () => {
    expect(makeTextExtractor(env, { ai: { mode: 'mock', timeoutMs: 1 } })).toBeUndefined();
  });
});
