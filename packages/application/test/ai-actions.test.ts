import { NotFoundError } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createAIAction,
  createContentType,
  createEntry,
  createSpace,
  deleteAIAction,
  getEntry,
  listAIActions,
  renderTemplate,
  runAIAction,
  SYSTEM_CALLER,
  templateVariables,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('x') };
  return { ctx };
}

describe('template helpers', () => {
  it('extracts distinct variable names', () => {
    expect(templateVariables('Hi {{name}}, see {{field.title}} and {{name}}')).toEqual([
      'name',
      'field.title',
    ]);
  });
  it('renders known tokens and blanks unknown', () => {
    expect(renderTemplate('A {{x}} B {{y}}', { x: '1' })).toBe('A 1 B ');
  });
});

describe('AI Actions CRUD', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  });

  it('creates an action and derives its variables', async () => {
    const action = await createAIAction(ctx, scope, {
      name: 'SEO title',
      promptTemplate: 'Write an SEO title for {{field.body}} aimed at {{audience}}.',
      targetField: 'title',
    });
    expect(action.variables.sort()).toEqual(['audience', 'field.body']);
    expect(action.tier).toBe('balanced');
    expect(await listAIActions(ctx, scope)).toHaveLength(1);
  });

  it('deletes an action', async () => {
    const a = await createAIAction(ctx, scope, { name: 'X', promptTemplate: 'hi' });
    await deleteAIAction(ctx, scope, a.id);
    expect(await listAIActions(ctx, scope)).toHaveLength(0);
  });
});

describe('runAIAction', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
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
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
  });

  it('renders the entry fields into the prompt and writes the target field on apply', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Draft' }, body: { 'en-US': 'A post about cats.' } },
    });
    const action = await createAIAction(ctx, scope, {
      name: 'Retitle',
      promptTemplate: 'Title for: {{field.body}}',
      targetField: 'title',
    });
    let seenPrompt = '';
    const ai = new StubAIProvider((req) => {
      seenPrompt = req.prompt;
      return 'Cats: A Complete Guide';
    });
    const result = await runAIAction(ctx, ai, scope, action.id, { entryId: entry.id, apply: true });
    expect(seenPrompt).toContain('A post about cats.');
    expect(result.applied).toBe(true);
    const { fields } = await getEntry(ctx, scope, entry.id);
    expect(fields.title?.['en-US']).toBe('Cats: A Complete Guide');
  });

  it('runs standalone with manual variables (no entry)', async () => {
    const action = await createAIAction(ctx, scope, {
      name: 'Slogan',
      promptTemplate: 'Slogan for {{brand}}',
    });
    const ai = new StubAIProvider(() => 'Just do it');
    const result = await runAIAction(ctx, ai, scope, action.id, { variables: { brand: 'Acme' } });
    expect(result.output).toBe('Just do it');
    expect(result.applied).toBe(false);
  });

  it('throws for an unknown action', async () => {
    const ai = new StubAIProvider(() => 'x');
    await expect(runAIAction(ctx, ai, scope, 'nope')).rejects.toThrow(NotFoundError);
  });
});
