import { ValidationError } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  canvasToEntry,
  createContentType,
  createSpace,
  listAgentRuns,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function makeContext() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx };
}

async function seedArticle(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'wordCount',
        name: 'Word count',
        type: 'Integer',
        localized: false,
        required: false,
        position: 1,
        validations: { range: { min: 0 } },
      },
    ],
  });
}

describe('Canvas: mapping prose into structured fields', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ({ ctx } = makeContext());
  });

  it('maps prose into validated fields and sends the prose + schema to the model', async () => {
    await seedArticle(ctx);
    const ai = new StubAIProvider(() => ({ title: 'Realtime Sync Ships', wordCount: 320 }));

    const result = await canvasToEntry(ctx, ai, scope, {
      contentTypeApiId: 'article',
      prose: 'We just shipped realtime sync. It is fast and reliable, about 320 words follow…',
    });

    expect(result.fields.title?.['en-US']).toBe('Realtime Sync Ships');
    expect(result.fields.wordCount?.['en-US']).toBe(320);
    // The prose is carried in the prompt, and the strict schema is derived from the type.
    expect(ai.requests[0]?.prompt).toContain('realtime sync');
    const schema = ai.requests[0]?.outputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['title', 'wordCount']);
  });

  it('rejects empty prose before calling the model', async () => {
    await seedArticle(ctx);
    const ai = new StubAIProvider(() => ({ title: 'x', wordCount: 1 }));
    await expect(
      canvasToEntry(ctx, ai, scope, { contentTypeApiId: 'article', prose: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(ai.requests).toHaveLength(0);
  });

  it('applies the same content-model validation gate as a human write', async () => {
    await seedArticle(ctx);
    const ai = new StubAIProvider(() => ({ title: 'Bad', wordCount: -5 }));
    await expect(
      canvasToEntry(ctx, ai, scope, { contentTypeApiId: 'article', prose: 'some prose' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('records the mapping in the agent cost ledger', async () => {
    await seedArticle(ctx);
    const ai = new StubAIProvider(() => ({ title: 'T', wordCount: 1 }));
    await canvasToEntry(ctx, ai, scope, { contentTypeApiId: 'article', prose: 'prose' });

    const runs = await listAgentRuns(ctx, scope);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.workflow).toBe('generate');
    expect(runs[0]?.decisions[0]).toContain('Canvas');
  });
});
